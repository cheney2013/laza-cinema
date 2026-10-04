"""HyperFlow (videorebirth/hyperflow) for ComfyUI MiniMax-H3.

HyperFlowH3Apply   LoRA (converted by convert.py) + two-time (t, r) embedder.
HyperFlowH3Sigmas  the adapter's fixed 8-step grid, video-shifted (use with euler).

The embedder needs the step endpoint r for every distinct timestep in a forward.
ComfyUI's H3 forward embeds a sorted list of distinct t values; r is recovered
from t by matching it against the grid (video t_i -> 1 - sigma_v[i+1], audio
t_i -> 1 - sigma_a[i+1]); anything else (pinned conditioning rows) gets r = t,
the rule of the official HyperFlow plan.
"""
import json
import logging
import math

import torch
from torch import nn

import comfy.lora
import comfy.utils
import folder_paths

log = logging.getLogger("HyperFlowH3")


def _shift(raw, s):
    return [s * b / (1.0 + (s - 1.0) * b) for b in raw]


class TwoTimeEmbedder(nn.Module):
    def __init__(self, base, ep_in_w, ep_in_b, ep_out_w, ep_out_b, gate, t_to_r):
        super().__init__()
        # same attribute names as the base so weight-patch keys still resolve
        self.proj_in = base.proj_in
        self.proj_out = base.proj_out
        self.freq_dim = base.freq_dim
        self.gate = gate
        self.t_to_r = t_to_r  # list of (t, r)
        self.ep = [ep_in_w, ep_in_b, ep_out_w, ep_out_b]
        self._warned = False

    def _sin(self, t):
        half = self.freq_dim // 2
        freqs = torch.exp(-math.log(10000.0) * torch.arange(half, dtype=torch.float32, device=t.device) / half)
        args = t.to(torch.float32)[:, None] * freqs[None]
        return torch.cat([torch.cos(args), torch.sin(args)], dim=-1)

    def forward(self, t):
        t_emb = self.proj_out(nn.functional.silu(self.proj_in(self._sin(t))))
        r = t.clone().float()
        hit = False
        for i, tv in enumerate(t.tolist()):
            for tg, rg in self.t_to_r:
                if abs(tv - tg) < 2e-4:
                    r[i] = rg
                    hit = True
                    break
        if not hit and not self._warned:
            log.warning("HyperFlow: no timestep of this forward is on the HyperFlow grid %s -- "
                        "use HyperFlowH3Sigmas + euler", [round(x, 4) for x in t.tolist()])
            self._warned = True
        w1, b1, w2, b2 = [p.to(t.device) for p in self.ep]
        r_emb = nn.functional.linear(nn.functional.silu(nn.functional.linear(self._sin(r), w1, b1)), w2, b2)
        return (t_emb + self.gate * (r_emb.to(t_emb.dtype) - t_emb))


def _load(lora_name):
    path = folder_paths.get_full_path_or_raise("loras", lora_name)
    sd, meta = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
    if not meta or "hyperflow_gate" not in meta:
        raise ValueError(f"{lora_name} is not a converted HyperFlow file (run convert.py)")
    return sd, meta


class HyperFlowH3Apply:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "lora_name": (folder_paths.get_filename_list("loras"),),
            "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "MiniMax H3/HyperFlow"

    def apply(self, model, lora_name, strength):
        sd, meta = _load(lora_name)
        dm = model.model.diffusion_model
        if not hasattr(dm, "time_embedder") or getattr(dm, "use_adaln_curves", False):
            raise ValueError("HyperFlow needs a checkpoint with time_embedder (unpruned); "
                             "adaln-curve (pruned/fused) checkpoints bake the embedder away")
        gate = float(meta["hyperflow_gate"]) * 1.0
        raw = json.loads(meta["hyperflow_sigmas"])
        sv = _shift(raw, float(meta["hyperflow_video_shift"]))
        sa = _shift(raw, float(meta["hyperflow_audio_shift"]))
        t_to_r = [(1.0 - sv[i], 1.0 - sv[i + 1]) for i in range(len(raw) - 1)]
        t_to_r += [(1.0 - sa[i], 1.0 - sa[i + 1]) for i in range(len(raw) - 1)]

        # endpoint embedder: base weights (pre-LoRA) + its own LoRA, fp32
        rank = int(meta["lora_rank"])
        scale = float(meta["hyperflow_endpoint_alpha"]) / rank * strength
        te = dm.time_embedder
        def merged(lin, key):
            w = te.__getattr__(lin).weight.detach().float().cpu()
            A = sd.pop(f"hyperflow_endpoint.{key}.lora_A.weight").float()
            B = sd.pop(f"hyperflow_endpoint.{key}.lora_B.weight").float()
            return w + scale * (B @ A), te.__getattr__(lin).bias.detach().float().cpu()
        w1, b1 = merged("proj_in", "linear_1")
        w2, b2 = merged("proj_out", "linear_2")

        m = model.clone()
        key_map = comfy.lora.model_lora_keys_unet(m.model, {})
        patches = comfy.lora.load_lora(sd, key_map)
        loaded = m.add_patches(patches, strength)
        missing = set(patches.keys()) - set(loaded)
        if missing:
            raise ValueError(f"HyperFlow: {len(missing)} LoRA targets not in the model, e.g. {sorted(missing)[:3]}")
        m.add_object_patch("diffusion_model.time_embedder",
                           TwoTimeEmbedder(te, w1, b1, w2, b2, gate if strength > 0 else 0.0, t_to_r))
        log.info("HyperFlow %s: %d patches, gate %.3g", meta.get("hyperflow_version"), len(loaded), gate)
        return (m,)


class HyperFlowH3Sigmas:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"lora_name": (folder_paths.get_filename_list("loras"),)}}

    RETURN_TYPES = ("SIGMAS",)
    FUNCTION = "sigmas"
    CATEGORY = "MiniMax H3/HyperFlow"

    def sigmas(self, lora_name):
        _, meta = _load(lora_name)
        raw = json.loads(meta["hyperflow_sigmas"])
        return (torch.tensor(_shift(raw, float(meta["hyperflow_video_shift"])), dtype=torch.float32),)


NODE_CLASS_MAPPINGS = {"HyperFlowH3Apply": HyperFlowH3Apply, "HyperFlowH3Sigmas": HyperFlowH3Sigmas}
NODE_DISPLAY_NAME_MAPPINGS = {"HyperFlowH3Apply": "HyperFlow H3 Apply (LoRA + two-time)",
                              "HyperFlowH3Sigmas": "HyperFlow H3 Sigmas (8-step)"}
