"""CPU decoder for live previews. Reads "latent.pt<TAB>out.mp4" lines on stdin,
writes the clip and answers "ok" (or "err") on stdout, one line per request.

Memory, not speed, is the constraint: the render beside it stages ~38 GB of
weights in RAM. taeh3's own decode keeps every output frame in float32 and
then copies the clip several times for clamping and trimming (5 GB peak for
362 frames). Here the same frame-by-frame loop streams each kept frame to
ffmpeg as uint8 the moment it exists, so only a few frames are ever held.
The output is identical to TAEHV.decode (checked frame for frame).
"""
import os
import subprocess
import sys
from collections import deque

sys.path.insert(0, os.getcwd())
sys.argv = [sys.argv[0], "--cpu"]
os.environ["CUDA_VISIBLE_DEVICES"] = ""

import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402

import comfy.sd  # noqa: E402
import comfy.utils  # noqa: E402
import folder_paths  # noqa: E402
from comfy.taesd.taehv import MemBlock, TGrow, TPool, TWorkItem  # noqa: E402

# Few threads: slower, but the render and the rest of the machine come first.
torch.set_num_threads(8)
FPS = 24


def load():
    name = next(f for f in folder_paths.get_filename_list("vae_approx") if f.startswith("taeh3"))
    vae = comfy.sd.VAE(comfy.utils.load_torch_file(folder_paths.get_full_path("vae_approx", name)))
    m = vae.first_stage_model.float().eval()
    m.show_progress_bar = False
    return m


def raw_frames(model, lat):
    """TAEHV's sequential decode loop, yielding each output frame [C, H, W]."""
    blocks, patch = model.decoder, model.patch_size
    x = lat.movedim(1, 2)                                    # [B, T, C, H, W]
    queue = deque([TWorkItem(xt.squeeze(1), 0) for xt in x.chunk(x.shape[1], dim=1)])
    mem = [None] * len(blocks)
    while queue:
        xt, i = queue.popleft()
        if i == len(blocks):
            yield F.pixel_shuffle(xt, patch)[0] if patch > 1 else xt[0]
            continue
        b = blocks[i]
        if isinstance(b, MemBlock):
            new = b(xt, xt * 0 if mem[i] is None else mem[i])
            mem[i] = xt.detach().clone()
            queue.appendleft(TWorkItem(new, i + 1))
        elif isinstance(b, TPool):
            mem[i] = (mem[i] or []) + [xt.detach().clone()]
            if len(mem[i]) == b.stride:
                B, C, H, W = xt.shape
                queue.appendleft(TWorkItem(b(torch.cat(mem[i], 1).view(B * b.stride, C, H, W)), i + 1))
                mem[i] = []
        elif isinstance(b, TGrow):
            y = b(xt)
            B = xt.shape[0]
            for nxt in reversed(y.view(B, b.stride * xt.shape[1], *y.shape[-2:]).chunk(b.stride, 1)):
                queue.appendleft(TWorkItem(nxt, i + 1))
        else:
            queue.appendleft(TWorkItem(b(xt), i + 1))


def h3_frames(model, lat):
    """Frames exactly as TAEHV.decode returns them for H3, as uint8 [H, W, 3]:
    each 5-latent chunk drops its first frames_to_trim frames, the clip is padded
    with black to whole chunks, and the last 3 * t_upscale kept frames go."""
    t_up, trim = model.t_upscale, model.frames_to_trim
    chunk = 5 * t_up
    n_raw = lat.shape[2] * t_up
    n_pad = -(-n_raw // chunk) * chunk
    total = n_pad // chunk * (chunk - trim) - 3 * t_up
    frames = raw_frames(model, lat)
    kept, last = 0, None
    for k in range(n_pad):
        frame = next(frames) if k < n_raw else torch.zeros_like(last)
        last = frame
        if k % chunk < trim:
            continue
        if kept >= total:
            break
        kept += 1
        yield (frame.clamp(0, 1) * 255).to(torch.uint8).permute(1, 2, 0)


def encode(model, lat, out):
    h, w = lat.shape[-2] * 16, lat.shape[-1] * 16
    tmp = out + ".part.mp4"
    p = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{w}x{h}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "ultrafast",
         "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-threads", "2", tmp],
        stdin=subprocess.PIPE, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        for f in h3_frames(model, lat):
            p.stdin.write(f.contiguous().numpy().tobytes())
    finally:
        p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError("ffmpeg failed")
    os.replace(tmp, out)


def prepare(lat):
    lat = F.avg_pool3d(lat.float(), (1, 2, 2))               # half resolution
    h, w = lat.shape[-2] - lat.shape[-2] % 2, lat.shape[-1] - lat.shape[-1] % 2
    return lat[..., :h, :w]


def main():
    model = load()
    for line in sys.stdin:
        try:
            src, out = line.rstrip("\n").split("\t")
            with torch.no_grad():
                encode(model, prepare(torch.load(src)), out)
            print("ok", flush=True)
        except Exception as e:  # noqa: BLE001
            print("err", flush=True)
            sys.stderr.write(f"{e}\n")


if __name__ == "__main__":
    main()
