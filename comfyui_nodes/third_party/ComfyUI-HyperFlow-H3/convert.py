"""Convert videorebirth/hyperflow (diffusers PEFT keys) to ComfyUI MiniMax-H3 keys.

Mapping follows the same rules as the ComfyUI turbo LoRA conversion:
  * to_q/to_k/to_v -> fused qkv_proj: concat A, block-diagonal B, alpha x3
  * ff.net.0.proj -> mlp.fc1 with the SwiGLU halves swapped ([value;gate] -> [gate;value])
  * ff.net.2 -> mlp.fc2, to_out.0 -> out_proj, refiner_blocks -> blocks
  * time_embedder.linear_1/2 -> time_embedder.proj_in/proj_out
  * endpoint_time_embedder.* kept apart as hyperflow_endpoint.* (not a model module)

usage: python convert.py <in.safetensors> <out.safetensors>
"""
import json
import re
import sys
from collections import defaultdict

import torch
from safetensors import safe_open
from safetensors.torch import save_file


def main(src, dst):
    f = safe_open(src, "pt")
    meta = f.metadata()
    rank = int(meta["lora_rank"])
    alpha = float(meta["lora_alpha"])
    groups = defaultdict(dict)
    for k in f.keys():
        m = re.match(r"transformer\.(.+)\.lora_([AB])\.weight$", k)
        groups[m.group(1)][m.group(2)] = f.get_tensor(k)

    out = {}

    def put(name, A, B, a):
        out[f"diffusion_model.{name}.lora_A.weight"] = A.contiguous()
        out[f"diffusion_model.{name}.lora_B.weight"] = B.contiguous()
        out[f"diffusion_model.{name}.alpha"] = torch.tensor(a)

    qkv = defaultdict(dict)
    for mod, ab in groups.items():
        A, B = ab["A"], ab["B"]
        if mod.startswith("endpoint_time_embedder."):
            lin = mod.split(".")[1]
            out[f"hyperflow_endpoint.{lin}.lora_A.weight"] = A.float().contiguous()
            out[f"hyperflow_endpoint.{lin}.lora_B.weight"] = B.float().contiguous()
            continue
        if mod.startswith("time_embedder."):
            lin = {"linear_1": "proj_in", "linear_2": "proj_out"}[mod.split(".")[1]]
            put(f"time_embedder.{lin}", A, B, alpha)
            continue
        cm = mod.replace("token_refiner.refiner_blocks.", "token_refiner.blocks.").replace("transformer_blocks.", "blocks.")
        mq = re.match(r"(.+)\.attn\.to_([qkv])$", cm)
        if mq:
            qkv[mq.group(1)][mq.group(2)] = (A, B)
            continue
        if cm.endswith(".attn.to_out.0"):
            put(cm.replace(".attn.to_out.0", ".attn.out_proj"), A, B, alpha)
        elif cm.endswith(".ff.net.0.proj"):
            half = B.shape[0] // 2
            B = torch.cat([B[half:], B[:half]], dim=0)  # [value;gate] -> [gate;value]
            put(cm.replace(".ff.net.0.proj", ".mlp.fc1"), A, B, alpha)
        elif cm.endswith(".ff.net.2"):
            put(cm.replace(".ff.net.2", ".mlp.fc2"), A, B, alpha)
        else:
            raise ValueError(f"unmapped module {mod}")

    for blk, parts in qkv.items():
        if set(parts) != {"q", "k", "v"}:
            raise ValueError(f"{blk}: partial qkv {sorted(parts)}")
        As = [parts[c][0] for c in "qkv"]
        Bs = [parts[c][1] for c in "qkv"]
        A = torch.cat(As, dim=0)
        B = torch.block_diag(*Bs)
        put(f"{blk}.attn.qkv_proj", A, B, alpha * 3)

    meta_out = {k: meta[k] for k in ("hyperflow_sigmas", "hyperflow_gate", "hyperflow_video_shift",
                                     "hyperflow_audio_shift", "hyperflow_version", "lora_rank", "lora_alpha")}
    meta_out["hyperflow_endpoint_alpha"] = str(alpha)
    meta_out["source"] = "videorebirth/hyperflow converted to ComfyUI MiniMax-H3 keys"
    save_file(out, dst, metadata=meta_out)
    print(f"{len(groups)} modules -> {len(out)} tensors, qkv fused in {len(qkv)} blocks, rank {rank}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
