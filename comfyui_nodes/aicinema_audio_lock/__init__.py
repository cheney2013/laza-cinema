"""LAZA CINEMA STUDIO: lock chosen time ranges of a MiniMax H3 audio stream.

An H3 audio-video latent carries a second, audio stream. Sampling normally
regenerates all of it. This node swaps chosen stretches of that stream for an
encoded recording and gives the stretch a noise mask below 1, so the sampler
keeps it (mask 0 = kept exactly, 1 = free) while the rest of the soundtrack, and
the picture, are still generated around it. The mouth that speaks a locked line
follows the locked sound, which is the point: a line lands on the second it was
placed on.

Other packs lock the WHOLE audio stream (ComfyUI-MiniMaxH3-TimelineDirector's
MiniMaxH3LockAudioLatent, the LongMedia pack's LipSync Latent Setup). The idea of
replacing the audio stream's content and masking it comes from there; this
node is separate code whose only difference is that it works on ranges.

Wire:  ReferenceToVideo latent ─┐
       VAEEncodeAudio(track) ───┴─► AicinemaLockAudioRanges ─► SamplerCustomAdvanced.latent_image

ranges = "start-end:strength;start-end:strength", seconds on the generation
timeline (a chained clip's first frames are the motion-context overlap, so these
seconds run that much ahead of the delivered clip). strength 1 keeps the range
exactly; 0.5 measured as near-complete preservation with the level a few dB
down; 0 leaves it free. Where ranges overlap the lower mask wins. feather_seconds
ramps the mask from free to the range value outside each edge.
"""
import torch
from comfy.nested_tensor import NestedTensor

NODE_VERSION = 3


class AicinemaLockAudioRanges:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "target_latent": ("LATENT",),
            "audio_latent": ("LATENT", {"tooltip": "The encoded track, same length as the clip."}),
            "ranges": ("STRING", {"default": "", "multiline": False}),
            "feather_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 5.0, "step": 0.01}),
            "duration_seconds": ("FLOAT", {"default": 5.0, "min": 0.1, "max": 600.0, "step": 0.001,
                                           "tooltip": "Length of the generated clip (frames / 24)."}),
        }}

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("Range-locked AV Latent",)
    FUNCTION = "lock"
    CATEGORY = "LAZA/MiniMax H3"
    DESCRIPTION = f"Lock time ranges of the H3 audio stream (v{NODE_VERSION}). See the module docstring."

    @staticmethod
    def parse(ranges: str):
        out = []
        for part in [p.strip() for p in ranges.split(";") if p.strip()]:
            span, _, strength = part.partition(":")
            a, _, b = span.partition("-")
            a, b, s = float(a), float(b), float(strength) if strength else 1.0
            if not (0.0 <= a < b):
                raise ValueError(f"lock range '{part}': start must be >= 0 and before end")
            if not (0.0 <= s <= 1.0):
                raise ValueError(f"lock range '{part}': strength must be between 0 and 1")
            out.append((a, b, s))
        return out

    def lock(self, target_latent, audio_latent, ranges, feather_seconds, duration_seconds):
        target_samples = target_latent["samples"]
        if not getattr(target_samples, "is_nested", False):
            raise ValueError("AicinemaLockAudioRanges needs a nested MiniMax H3 AV latent")
        video, target_audio = list(target_samples.unbind())
        source_audio = audio_latent["samples"].to(device=target_audio.device, dtype=target_audio.dtype)
        steps = int(target_audio.shape[-1])
        source_steps = int(source_audio.shape[-1])
        # The audio latent runs at 40 steps a second; a duration that does not match
        # the stream length puts every range off by a proportional amount.
        if abs(steps / 40.0 - duration_seconds) > 1.0 / 40.0:
            print(f"[AicinemaLockAudioRanges] WARNING: audio stream is {steps} steps "
                  f"({steps / 40.0:.3f}s at 40/s) but duration_seconds={duration_seconds:.3f}")

        parsed = self.parse(ranges)
        dt = duration_seconds / steps
        t = torch.arange(steps, dtype=torch.float32, device=target_audio.device) * dt
        mask = torch.ones(steps, dtype=torch.float32, device=target_audio.device)
        touched = torch.zeros(steps, dtype=torch.bool, device=target_audio.device)
        for a, b, s in parsed:
            # A step is inside a range when its [t, t+dt) overlaps it, so the step
            # that straddles the start is locked rather than left to the sampler.
            core = ((t + dt > a) & (t < b)).float()
            if feather_seconds > 0:
                ramp = torch.clamp(torch.minimum((t - (a - feather_seconds)) / feather_seconds,
                                                 ((b + feather_seconds) - t) / feather_seconds), 0.0, 1.0)
                w = torch.maximum(core, ramp)
            else:
                w = core
            mask = torch.minimum(mask, 1.0 - s * w)
            touched |= (s * w) > 0
        # A step beyond the recording has nothing to lock to, and zero latents are not
        # silence: refuse rather than pad them into the locked range.
        if source_steps < steps:
            if bool(touched[source_steps:].any()):
                raise ValueError(f"AicinemaLockAudioRanges: a locked range reaches step "
                                 f"{int(touched.nonzero().max())} but audio_latent has only "
                                 f"{source_steps} steps ({source_steps / 40.0:.2f}s)")
            source_audio = torch.cat([source_audio, source_audio[..., -1:].expand(*source_audio.shape[:-1], steps - source_steps)], dim=-1)
        source_audio = source_audio[..., :steps]

        existing = target_latent.get("noise_mask")
        video_mask = None
        if existing is not None and getattr(existing, "is_nested", False):
            video_mask, prior = existing.unbind()[:2]
            # A lock upstream already protects some steps: keep the stricter mask, and
            # replace the content only where this node is the one holding the step.
            if prior.shape[-1] != steps:
                raise ValueError(f"AicinemaLockAudioRanges: incoming audio mask has "
                                 f"{int(prior.shape[-1])} steps, the audio stream has {steps}")
            prior_1d = prior.to(device=mask.device, dtype=torch.float32).reshape(-1, steps).amin(0)
            touched &= mask < prior_1d
            mask = torch.minimum(mask, prior_1d)
        elif torch.is_tensor(existing):
            video_mask = existing
        if video_mask is None:
            video_mask = torch.ones((video.shape[0], 1, video.shape[2], 1, 1), dtype=torch.float32,
                                    device=video.device)
        print(f"[AicinemaLockAudioRanges v{NODE_VERSION}] steps={steps} duration={duration_seconds:.3f}s "
              f"ranges='{ranges}' feather={feather_seconds}s mask_min={float(mask.min()):.2f} "
              f"touched={int(touched.sum())}/{steps}")

        samples = torch.where(touched.view(1, 1, 1, steps), source_audio, target_audio)
        audio_mask = mask.view(1, 1, 1, steps).expand(target_audio.shape[0], 1, 1, steps).contiguous()
        out = dict(target_latent)
        out["samples"] = NestedTensor((video, samples))
        out["noise_mask"] = NestedTensor((video_mask, audio_mask))
        return (out,)


class AicinemaPackSavedLatent:
    """Turn a latent saved by MiniMaxH3MotionContextSaveLatent back into a packed AV latent.

    MiniMaxH3MotionContextLoadLatent returns {"samples": [video, audio]} on purpose: a plain
    list cannot be mistaken for a decodable latent. To re-sample or refine the audio of an
    EXISTING render (H3AudioRefineMask, AicinemaLockAudioRanges) it has to be the nested
    video+audio tensor again, which is all this does.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"latent": ("LATENT",)}}

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("AV Latent",)
    FUNCTION = "pack"
    CATEGORY = "LAZA/MiniMax H3"

    def pack(self, latent):
        samples = latent["samples"]
        if getattr(samples, "is_nested", False):
            return (latent,)
        if not isinstance(samples, (list, tuple)) or len(samples) != 2:
            raise ValueError("AicinemaPackSavedLatent expects the [video, audio] pair that "
                             "MiniMaxH3MotionContextLoadLatent returns")
        out = dict(latent)
        out["samples"] = NestedTensor((samples[0], samples[1]))
        return (out,)


NODE_CLASS_MAPPINGS = {"AicinemaLockAudioRanges": AicinemaLockAudioRanges,
                       "AicinemaPackSavedLatent": AicinemaPackSavedLatent}
NODE_DISPLAY_NAME_MAPPINGS = {"AicinemaLockAudioRanges": "LAZA Lock Audio Ranges",
                              "AicinemaPackSavedLatent": "LAZA Pack Saved Latent"}
