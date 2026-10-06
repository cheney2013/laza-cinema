"""Take the regeneration bias of a motion-context seam back out of the new clip.

A continuation regenerates the previous clip's last frames at its own head: the
same picture drawn twice, once by the previous clip and once by this one. The
two are not the same. Measured on 2026-10-06 over 12 seams of two T2V test
chains, the regenerated head comes back with its latent channels shifted in one
and the same direction every time (correlation 0.96-0.99 between seams), which
decodes as warm colour draining out (a cream wall loses about 1 ΔE76 of
yellow per seam, the white door with it). Seven seams of the scene 1 film chain
show the same direction (correlation 0.76-0.88), larger. The new clip carries the
shift forward, the next clip starts from it, and the colour walks.

This node measures that shift on the overlap -- this clip's first `steps`
latent steps against the pinned tail they were generated from -- and removes it
from the whole clip, before it is decoded, saved, or handed to the next link:

  mean   one offset per latent channel (the average of head - tail): position
         free, safe across a cut, takes out about half the shift on a wall.
  field  that offset as a smooth picture (head - tail averaged over the overlap,
         blurred `sigma` latent pixels): takes out about 80 % on a held frame,
         but it is tied to screen position, so it belongs on shots that hold
         their framing.
  auto   field where the picture still has the head's layout, mean where it
         does not: each latent step's coarse layout (6x6-pooled latent) is
         correlated with the head's, and the field's spatial part is weighted
         by (corr - 0.6) / 0.3, clamped to 0-1. A held or handheld frame stays
         at 0.9-1.0; the scene 1 cuts drop to 0.3-0.6.

The regenerated head also comes back with more texture than the tail it copies:
on the scene 1 chain every channel, at every seam, by 1.9-3.7 % in the 2-8
latent-pixel band (30-130 px blotches) and 2.2-4.7 % finer than that. `texture`
divides the blotch band of the whole clip, per channel, by the gain measured on
the overlap (1 = all of it, 0 = off): on the 30 s T2V chain it held that band
flat (0.99-1.00 of the first clip after six seams, against 1.05 uncorrected).
The finer band is left alone on purpose: dividing it out too measured as a
creeping softness (lamp-shade detail -8 % after six seams, faces visibly
softer), while the uncorrected chain sharpens (+13 %).

How much of the overlap's offset to take out depends on the video, so it is
measured per seam (`adaptive`, needs `vae`). The overlap shows the bias b (the
last 5 overlap frames against the previous clip's last 5, the same moments drawn
twice); the frames right after it show the step a viewer sees, s (delivered
frames n..n+7 against those same 5 previous frames, one frame apart). A latent
correction of gain g moves every frame by about -g*b, so the step vanishes at
g = (s.b)/(b.b), fitted over a 6x10 grid of block colours (blocks whose b points
against the common direction, i.e. something moving there, are left out). Measured
on decoded clips: about 1.0 on the T2V test chains (R2 0.77-0.96), 0.64-0.84 on
the scene 1 film chain (Ref2VA, plates on every clip, which pull the picture back
toward them), and R2 0 on a seam where Sarah is rising through the frame -- an
unreliable fit (R2 < 0.5, g outside 0-2, or a bias too small to measure) falls
back to `gain`. The same fit on frames n+17..n+24 (about a second on) follows a
further slide where it is reliable (R2 >= 0.6 and the layout still the overlap's,
which on the tests meant held shots only, 1.0-1.3 on the T2V chain): the gain
eases from the near value to that one over the 20 frames between. Without
`adaptive`, `gain` applies throughout and `post_gain` scales it after the overlap.

A head that does not follow the pinned tail (a change asked for inside the
overlap, a failed join) is not a bias to remove: above `max_mismatch`
(rms(head - tail) / std(tail); ordinary seams measure 0.04-0.10) the clip passes
through untouched and the report says so.
"""
from __future__ import annotations

import logging

import torch
import torch.nn.functional as F

_LOG = logging.getLogger("aicinema_chain")
FRAME_PER_TOKEN = (1, 4, 4, 4, 4)


def steps_for_frames(n: int) -> int:
    k = covered = 0
    while covered < n:
        covered += FRAME_PER_TOKEN[k % 5]
        k += 1
    if covered != n:
        raise ValueError(f"a {n}-frame context is not a whole number of latent steps (5, 22, 39, 56)")
    return k


def streams(latent: dict) -> list:
    s = latent["samples"]
    if hasattr(s, "unbind"):
        return list(s.unbind())
    if isinstance(s, (list, tuple)):
        return list(s)
    raise ValueError("expected a MiniMax H3 audio-video latent")


def _video(t: torch.Tensor) -> torch.Tensor:
    return t.unsqueeze(0) if t.ndim == 4 else t


def blur(x: torch.Tensor, sigma: float) -> torch.Tensor:
    """Separable gaussian over the last two dims of [B, C, H, W], reflected at the edges."""
    r = max(1, int(3 * sigma))
    r = min(r, x.shape[-1] - 1, x.shape[-2] - 1)
    k = torch.arange(-r, r + 1, dtype=x.dtype, device=x.device)
    k = torch.exp(-k ** 2 / (2 * sigma ** 2))
    k = k / k.sum()
    c = x.shape[1]
    x = F.conv2d(F.pad(x, (r, r, 0, 0), mode="reflect"), k.view(1, 1, 1, -1).repeat(c, 1, 1, 1), groups=c)
    return F.conv2d(F.pad(x, (0, 0, r, r), mode="reflect"), k.view(1, 1, -1, 1).repeat(c, 1, 1, 1), groups=c)


def layout_weights(video: torch.Tensor, head: torch.Tensor) -> torch.Tensor:
    """Per latent step, how much the picture still has the head's layout: [T] in 0..1."""
    pool = lambda z: F.avg_pool2d(z, 6, ceil_mode=True)
    ref = pool(head.mean(2)).flatten()
    ref = ref - ref.mean()
    t = video.shape[2]
    lay = pool(video.permute(0, 2, 1, 3, 4).reshape(-1, video.shape[1], *video.shape[3:]).float())
    lay = lay.reshape(t, -1)
    lay = lay - lay.mean(1, keepdim=True)
    corr = (lay @ ref) / (lay.norm(dim=1) * ref.norm()).clamp(min=1e-6)
    return ((corr - 0.6) / 0.3).clamp(0.0, 1.0)


def correction(head: torch.Tensor, tail: torch.Tensor, mode: str, sigma: float,
               video: torch.Tensor | None = None) -> torch.Tensor:
    """What to add to the clip: [B, C, 1 or T, H, W] or [B, C, 1, 1, 1]."""
    diff = (tail - head).mean(2)                                   # [B, C, H, W]
    mean = diff.mean((2, 3), keepdim=True).unsqueeze(2)
    if mode == "mean":
        return mean
    field = blur(diff, sigma).unsqueeze(2)
    if mode == "field":
        return field
    if mode == "auto":
        w = layout_weights(video, head).to(field.dtype).view(1, 1, -1, 1, 1)
        return mean + w * (field - mean)
    raise ValueError(f"unknown mode {mode!r}")


BANDS = (0.7, 3.0)      # latent-pixel blurs splitting fine / blotch band / low


def split(v: torch.Tensor) -> list[torch.Tensor]:
    """[B, C, T, H, W] -> fine, blotch band, low; they sum back to v."""
    b, c, t, h, w = v.shape
    y = v.permute(0, 2, 1, 3, 4).reshape(b * t, c, h, w)
    b1, b2 = blur(y, BANDS[0]), blur(y, BANDS[1])
    return [z.reshape(b, t, c, h, w).permute(0, 2, 1, 3, 4) for z in (y - b1, b1 - b2, b2)]


def texture_gains(head: torch.Tensor, tail: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Per channel, tail rms / head rms of the fine and the blotch band: [C] each."""
    rms = lambda z: z.pow(2).mean((0, 2, 3, 4)).sqrt().clamp(min=1e-6)
    fh, mh, _ = split(head)
    ft, mt, _ = split(tail)
    return rms(ft) / rms(fh), rms(mt) / rms(mh)


def post_profile(t: int, steps: int, post_gain: float, ramp: int = 6) -> torch.Tensor:
    """Per latent step: 1 over the overlap, easing up to post_gain over `ramp` steps after it."""
    k = torch.arange(t, dtype=torch.float32)
    x = ((k - (steps - 1)) / ramp).clamp(0.0, 1.0)
    ease = x * x * (3 - 2 * x)
    return 1.0 + (post_gain - 1.0) * ease


GRID = (6, 10)


def block_colours(frames: torch.Tensor) -> torch.Tensor:
    """[N, H, W, 3] pixels -> [blocks, 3]: each block's mean colour over the frames."""
    m = frames.float().mean(0).permute(2, 0, 1).unsqueeze(0)           # [1, 3, H, W]
    return F.adaptive_avg_pool2d(m, GRID)[0].permute(1, 2, 0).reshape(-1, 3)


def fit_gain(prev: torch.Tensor, regen: torch.Tensor, after: torch.Tensor) -> tuple[float, float, float]:
    """g with after - prev ~= g * (regen - prev) over grid blocks; returns (g, R2, |bias|)."""
    b = block_colours(regen) - block_colours(prev)
    s = block_colours(after) - block_colours(prev)
    gb = b.mean(0)
    keep = (b @ gb) > 0.5 * (gb @ gb)
    if int(keep.sum()) < 6:
        keep = torch.ones_like(keep)
    b, s = b[keep], s[keep]
    g = float((s * b).sum() / (b * b).sum().clamp(min=1e-9))
    r2 = 1.0 - float(((s - g * b) ** 2).sum() / (s ** 2).sum().clamp(min=1e-12))
    return g, r2, float(gb.norm())


def gain_profile(t: int, steps: int, near: float, far: float, ramp: int = 5) -> torch.Tensor:
    """Per latent step: `near` through the overlap and the step after it, easing to `far`."""
    k = torch.arange(t, dtype=torch.float32)
    x = ((k - (steps + 1)) / ramp).clamp(0.0, 1.0)
    return near + (far - near) * (x * x * (3 - 2 * x))


def decode_frames(vae, latent: torch.Tensor) -> torch.Tensor:
    imgs = vae.decode(latent)
    return imgs.reshape(-1, *imgs.shape[-3:])[..., :3]


def measure_gain(vae, video: torch.Tensor, tail_latent: torch.Tensor | None, steps: int, n: int,
                 fallback: float, prev_frames: torch.Tensor | None = None) -> tuple[float, float, str]:
    """(near, far, report) for this seam; falls back to `fallback` where the fit is not reliable."""
    if video.shape[2] < steps + 7:
        return fallback, fallback, f"adaptive: clip too short to measure, gain {fallback:g}"
    if prev_frames is None:
        # the previous clip's last 5 frames. Its last 2 steps decoded on their own come out 0.2-0.6
        # levels brighter than the same frames in the full decode (measured 2026-10-06), which hid
        # half the bias and sent low-bias seams to the fallback; one more 5-step group of context
        # decodes them as the clip has them. A slice must start a 1,4,4,4,4 group or it decodes as
        # garbage: a 17k+5-frame clip has 5k+2 steps, so -7 (like -2) starts one.
        t = tail_latent.shape[2]
        prev_frames = decode_frames(vae, tail_latent[:, :, -7:] if t >= 7 and t % 5 == 2 else tail_latent[:, :, -2:])
    prev = prev_frames[-5:]
    new = decode_frames(vae, video[:, :, steps - 2:steps + 7])           # frames n-5 .. n+24
    regen, near_f, far_f = new[0:5], new[5:13], new[22:30]
    g, r2, mag = fit_gain(prev, regen, near_f)
    if mag < 0.002 or r2 < 0.5 or not 0.0 <= g <= 2.0:
        return fallback, fallback, (f"adaptive: near fit not reliable (g {g:+.2f}, R2 {r2:.2f}, bias {mag:.4f}), "
                                    f"gain {fallback:g}")
    gf, r2f, _ = fit_gain(prev, regen, far_f)
    w = float(layout_weights(video[:, :, steps + 4:steps + 7], video[:, :, :steps].float()).min())
    if r2f >= 0.6 and w >= 0.8 and 0.0 <= gf <= 2.0:
        return g, gf, f"adaptive: gain {g:.2f} (R2 {r2:.2f}) easing to {gf:.2f} (R2 {r2f:.2f})"
    return g, g, f"adaptive: gain {g:.2f} (R2 {r2:.2f}); later window not used (R2 {r2f:.2f}, layout {w:.2f})"


def match(video: torch.Tensor, tail: torch.Tensor, steps: int, mode: str, gain: float,
          sigma: float, max_mismatch: float, texture: float = 0.0,
          post_gain: float = 1.0, profile: torch.Tensor | None = None) -> tuple[torch.Tensor, str]:
    video, tail = _video(video), _video(tail)
    if video.shape[1] != tail.shape[1] or video.shape[3:] != tail.shape[3:]:
        raise ValueError(f"context latent {tuple(tail.shape)} does not match this clip {tuple(video.shape)}")
    if tail.shape[2] < steps or video.shape[2] <= steps:
        raise ValueError(f"need {steps} latent steps of overlap; context has {tail.shape[2]}, clip {video.shape[2]}")
    tail = tail[:, :, -steps:].to(video.device, torch.float32)
    head = video[:, :, :steps].to(torch.float32)
    mismatch = float((head - tail).pow(2).mean().sqrt() / tail.std().clamp(min=1e-6))
    if mismatch > max_mismatch:
        return video, (f"seam match skipped: the head differs from the pinned tail by {mismatch:.3f} "
                       f"(> {max_mismatch:.3f}), which is a change, not a bias")
    add = correction(head, tail, mode, sigma, video)
    if profile is not None:                      # adaptive: a measured gain per latent step
        add = add * profile.to(add.device, add.dtype).view(1, 1, -1, 1, 1)
    else:
        add = add * gain
        if post_gain != 1.0:
            add = add * post_profile(video.shape[2], steps, post_gain).to(add.device).view(1, 1, -1, 1, 1)
    out = video.to(torch.float32) + add
    tex = ""
    if texture > 0:
        _, g_band = texture_gains(head, tail)
        # never sharpen: a head softer than its tail is left as it is
        g_band = g_band.clamp(0.8, 1.0) ** texture
        fine, band, low = split(out)
        out = low + band * g_band.view(1, -1, 1, 1, 1) + fine
        tex = f", texture x{texture:g}: blotch band /{float(1 / g_band.mean()):.3f}"
    after = float((out[:, :, :steps] - tail).pow(2).mean().sqrt() / tail.std().clamp(min=1e-6))
    post = f", after the overlap x{post_gain:g}" if post_gain != 1.0 and profile is None else ""
    how = "measured gain" if profile is not None else f"x{gain:g}{post}"
    return out.to(video.dtype), (f"seam match {mode} {how}: head vs pinned tail {mismatch:.4f} -> {after:.4f}, "
                                 f"mean offset {float(add.mean((0, 2, 3, 4)).norm()):.4f}{tex}")


class AicinemaSeamMatch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT", {"tooltip": "This clip's sampler output (H3 audio-video latent)."}),
                "context_length": ("INT", {"default": 22, "min": 5, "max": 56,
                                           "tooltip": "The Motion Context window: 5, 22, 39 or 56 frames."}),
                "mode": (["auto", "field", "mean"], {"default": "auto"}),
                "adaptive": ("BOOLEAN", {"default": True,
                                         "tooltip": "Measure each seam's gain on decoded frames (needs vae); "
                                                    "gain is then only the fallback."}),
                "gain": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 2.0, "step": 0.05}),
                "sigma": ("FLOAT", {"default": 3.0, "min": 0.5, "max": 24.0, "step": 0.5,
                                    "tooltip": "field mode: blur of the offset picture, in latent pixels (16 px each)."}),
                "max_mismatch": ("FLOAT", {"default": 0.15, "min": 0.01, "max": 1.0, "step": 0.01}),
                "texture": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                                      "tooltip": "Take back the texture each seam adds (1 = all, 0 = off)."}),
                "post_gain": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 2.5, "step": 0.05,
                                        "tooltip": "Correction after the overlap, for the drift that follows it."}),
            },
            "optional": {
                "context_latent": ("LATENT", {"tooltip": "The previous clip's latent, as wired into Motion Context."}),
                "context_frames": ("IMAGE", {"tooltip": "Or its decoded frames (needs vae); the tail is encoded once."}),
                "vae": ("VAE",),
            },
        }

    RETURN_TYPES = ("LATENT", "STRING")
    RETURN_NAMES = ("samples", "report")
    FUNCTION = "apply"
    CATEGORY = "LAZA/MiniMax H3"
    DESCRIPTION = "Remove the colour bias a motion-context seam adds, measured on the regenerated overlap."

    def apply(self, samples, context_length, mode, adaptive, gain, sigma, max_mismatch, texture=1.0,
              post_gain=1.0, context_latent=None, context_frames=None, vae=None):
        steps = steps_for_frames(int(context_length))
        parts = streams(samples)
        if context_latent is not None:
            tail = _video(streams(context_latent)[0])
        elif context_frames is not None and vae is not None:
            # the Motion Context node's own pixel path: the last n frames, at this clip's size
            import comfy.utils
            n = int(context_length)
            video = _video(parts[0])
            w, h = int(video.shape[4]) * 16, int(video.shape[3]) * 16
            frames = context_frames[-n:, :, :, :3]
            if frames.shape[1] != h or frames.shape[2] != w:
                frames = comfy.utils.common_upscale(frames.movedim(-1, 1), w, h, "lanczos",
                                                    "disabled").movedim(1, -1)
            tail = vae.encode(frames)
        else:
            raise ValueError("wire context_latent, or context_frames with vae")
        if gain == 0 and texture == 0 and not adaptive:
            return samples, "seam match off"
        video = _video(parts[0])
        profile, measured = None, ""
        if adaptive and vae is not None:
            try:
                prev_frames = context_frames.float() if context_latent is None else None
                near, far, measured = measure_gain(vae, video, tail, steps, int(context_length), gain, prev_frames)
                profile = gain_profile(video.shape[2], steps, near, far)
            except Exception as e:          # a measurement problem must not cost the render
                measured = f"adaptive: could not measure ({type(e).__name__}: {e}), gain {gain:g}"
        elif adaptive:
            measured = f"adaptive: no vae wired, gain {gain:g}"
        video, report = match(video, tail, steps, mode, gain, sigma, max_mismatch, texture, post_gain, profile)
        if measured:
            report = f"{report}; {measured}"
        _LOG.info("aicinema_chain: %s", report)
        out = dict(samples)
        if hasattr(samples["samples"], "unbind"):
            import comfy.nested_tensor
            out["samples"] = comfy.nested_tensor.NestedTensor(tuple([video] + parts[1:]))
        else:
            out["samples"] = [video] + parts[1:]
        return out, report
