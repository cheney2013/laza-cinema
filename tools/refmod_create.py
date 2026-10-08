"""Bake a RefMod (Fantastic H3 pack, MiniMaxH3FantasticRefModCreate) and keep what it was made from.

A RefMod is an encoded reference: once saved, the picture and the recording are gone from it. So every time one
is made, the sources and the settings are registered with the backend (POST /refmods/sources), which copies them
beside the RefMod; GET /refmods, the MCP list_refmods and the studio's RefMod panel show them.

    python tools/refmod_create.py --name s5_joel3 --subfolder tlou --image qwen21_e9e40973-....png \
        --subject Joel --appearance "a man of thirty-two ..." --notes "wound sheet v2"
    python tools/refmod_create.py --name s5_sarah_voice_clean --subfolder tlou --audio tlou_ref_sarah_c28_clean.wav \
        --subject Sarah --voice "a girl's voice, ..."

--image / --audio are file names under backend/uploads. Needs ComfyUI on :8188 and the backend on :8003.
The RefMod is created in ComfyUI's models/refmods; copy the .safetensors (and .png) into backend/uploads/refmods
when it should travel with the project (the backend also copies it into ComfyUI before a render).
"""
import argparse
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UPLOADS = ROOT / "backend" / "uploads"
COMFY = "http://127.0.0.1:8188"
BACKEND = "http://127.0.0.1:8003"
COMFY_INPUT = Path(r"D:\ComfyUI-sage3\ComfyUI\input")


def post(url, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True)
    ap.add_argument("--subfolder", default="")
    ap.add_argument("--image", nargs="+", help="one or more pictures under backend/uploads (a look). Several are stacked into ONE RefMod, one frame each, the first sets the frame size (the official 'One RefMod from all'); give them all in the same outfit and state")
    ap.add_argument("--audio", help="recording under backend/uploads (a voice)")
    ap.add_argument("--subject", required=True)
    ap.add_argument("--appearance", default="")
    ap.add_argument("--voice", default="")
    ap.add_argument("--description", default="")
    ap.add_argument("--notes", default="", help="why this one was made, what it is for")
    ap.add_argument("--emotion", default="", help="the feeling of the recording (e.g. dazed, frightened, firm); shown in the RefMod panel")
    a = ap.parse_args()
    if not (a.image or a.audio):
        sys.exit("give --image and/or --audio")

    graph = {}
    inputs = {
        "name": a.name, "subfolder": a.subfolder, "mode": "Full Reference", "ref_resolution": 768, "grid": 16,
        "latent_frames": 22, "refinement_steps": 0, "max_tokens": 0, "audio_max_seconds": 30.0,
        "concept_type": "identity" if a.image else "voice",
        "description": a.description or f"{a.subject}", "write_preview": bool(a.image), "source": "",
        "subject_name": a.subject,
    }
    sources = []
    if a.image:
        graph["4"] = {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_int8_convrot.safetensors"}}
        batch = None
        for k, fn in enumerate(a.image):
            shutil.copy2(UPLOADS / fn, COMFY_INPUT / fn)
            graph[f"i{k}"] = {"class_type": "LoadImage", "inputs": {"image": fn, "upload": "image"}}
            if batch is None:
                batch = [f"i{k}", 0]
            else:
                graph[f"b{k}"] = {"class_type": "ImageBatch", "inputs": {"image1": batch, "image2": [f"i{k}", 0]}}
                batch = [f"b{k}", 0]
            sources.append({"role": "image", "url": f"/uploads/{fn}", "note": a.appearance})
        inputs.update({"appearance": a.appearance, "image": batch, "vae": ["4", 0]})
    if a.audio:
        shutil.copy2(UPLOADS / a.audio, COMFY_INPUT / a.audio)
        graph["5"] = {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}}
        graph["a"] = {"class_type": "LoadAudio", "inputs": {"audio": a.audio}}
        inputs.update({"voice_description": a.voice, "audio": ["a", 0], "audio_vae": ["5", 0]})
        sources.append({"role": "audio", "url": f"/uploads/{a.audio}", "note": a.voice})
    if a.image and a.audio:
        inputs["concept_type"] = "identity"
    if "5" in graph:
        inputs["audio_vae"] = ["5", 0]
    graph["c"] = {"class_type": "MiniMaxH3FantasticRefModCreate", "inputs": inputs}

    pid = post(COMFY + "/prompt", {"prompt": graph})["prompt_id"]
    print("queued", pid)
    while True:
        h = json.load(urllib.request.urlopen(f"{COMFY}/history/{pid}"))
        if pid in h:
            st = h[pid]["status"]
            for m in st.get("messages", []):
                if m[0] == "execution_error":
                    sys.exit("ComfyUI: " + str(m[1].get("exception_message")))
            print("baked", st["status_str"])
            break
        time.sleep(2)

    # With both an image and an audio the pack writes <name>_visual and <name>_audio.
    rel = (a.subfolder + "/" if a.subfolder else "") + a.name
    names = [rel + "_visual", rel + "_audio"] if (a.image and a.audio) else [rel]
    for n in names:
        mine = [s for s in sources if s["role"] == ("audio" if n.endswith("_audio") or (not a.image) else "image")]
        done = post(BACKEND + "/refmods/sources", {
            "name": n, "sources": mine or sources, "notes": a.notes,
            "params": {**{k: v for k, v in inputs.items() if not isinstance(v, list)}, **({"emotion": a.emotion} if a.emotion else {})},
        })
        print("sources kept for", n, len(done["sources"]))


if __name__ == "__main__":
    main()
