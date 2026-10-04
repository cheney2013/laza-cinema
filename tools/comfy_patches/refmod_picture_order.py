"""Local patch to ComfyUI-Fantastic-MiniMaxH3-PromptBuilder (v1.8.1): picture_order on RefMod Text Encode.

Re-run after reinstalling or updating the pack; it is a no-op when already applied and keeps
refmod_nodes.py.orig beside the file. ComfyUI must be restarted to load it.

Media Loader pictures are always labelled before RefMod pictures. `picture_order` lets a RefMod picture
sit between media pictures: "m m r m m" puts the RefMod's picture third. Empty = unchanged behaviour.
"""
import pathlib
import shutil
import sys

path = pathlib.Path(r"D:\ComfyUI-sage3\ComfyUI\custom_nodes\ComfyUI-Fantastic-MiniMaxH3-PromptBuilder\refmod_nodes.py")
backup = path.with_suffix(".py.orig")
if not backup.exists():
    shutil.copy2(path, backup)
src = path.read_text(encoding="utf-8")
if "picture_order" in src:
    print("already patched")
    sys.exit(0)


def swap(old, new, count=1):
    global src
    assert src.count(old) == count, (old[:60], src.count(old))
    src = src.replace(old, new)


swap("import math\nimport time\n", "import math\nimport re\nimport time\n")

func = '''
def reorder_pictures(items, blocks, mapping, order):
    """Local patch: put RefMod pictures between media pictures.

    `order` lists the final picture order, 'm' taking the next media picture and 'r' the next RefMod
    picture ("m m r m m": the RefMod is <Picture 3>). The text encoder's items, the DiT's reference
    blocks and the reference map are permuted together, so the label in the prompt, the picture the
    encoder is shown under it and the latent the DiT receives under it stay the same picture.
    Empty `order` leaves everything as built (media first, then RefMods)."""
    tokens = [t for t in re.split(r"[\\s,]+", (order or "").strip().lower()) if t]
    if not tokens:
        return items, blocks, mapping
    pic_items = [k for k, it in enumerate(items) if it.get("type") == "image"]
    pic_blocks = [k for k, b in enumerate(blocks) if b.get("kind") == "image"]
    pic_map = [k for k, m in enumerate(mapping) if m.startswith("<Picture ")]
    media = sum(1 for k in pic_map if mapping[k].endswith("(media)"))
    total = len(pic_items)
    refs = total - media
    if len(pic_map) != total or len(pic_blocks) not in (0, total):
        raise ValueError("picture_order: the picture items, blocks and labels do not line up.")
    if len(tokens) != total or any(t not in ("m", "r") for t in tokens) \\
            or tokens.count("m") != media or tokens.count("r") != refs:
        raise ValueError(f"picture_order needs {media} 'm' (media pictures) and {refs} 'r' (RefMod pictures), "
                         f"{total} in all, e.g. {' '.join(['m'] * media + ['r'] * refs)}; got {' '.join(tokens) or 'nothing'}.")
    # the combined list is media pictures first, RefMod pictures after, as the node built it
    take, next_media, next_ref = [], 0, media
    for t in tokens:
        if t == "m":
            take.append(next_media)
            next_media += 1
        else:
            take.append(next_ref)
            next_ref += 1
    items, blocks, mapping = list(items), list(blocks), list(mapping)
    for slots, seq in ((pic_items, items), (pic_blocks, blocks)):
        if slots:
            was = [seq[k] for k in slots]
            for pos, k in enumerate(slots):
                seq[k] = was[take[pos]]
    was = [mapping[k] for k in pic_map]
    for pos, k in enumerate(pic_map):
        mapping[k] = re.sub(r"^<Picture \\d+>", f"<Picture {pos + 1}>", was[take[pos]])
    return items, blocks, mapping


'''
swap("\nclass MiniMaxH3FantasticRefModTextEncode:\n", func + "class MiniMaxH3FantasticRefModTextEncode:\n")

swap('''            "stack_pictures_n": ("INT", {"default": 8, "min": 1, "max": 1024,
                "tooltip": "How many pictures 'up to N' shows the text encoder, spread evenly across the stack. "
                           "Only used when stack_pictures is 'up to N'."}),
        }, "hidden": {"extra_pnginfo": "EXTRA_PNGINFO"}}

    def encode(''', '''            "stack_pictures_n": ("INT", {"default": 8, "min": 1, "max": 1024,
                "tooltip": "How many pictures 'up to N' shows the text encoder, spread evenly across the stack. "
                           "Only used when stack_pictures is 'up to N'."}),
            "picture_order": ("STRING", {"default": "",
                "tooltip": "LOCAL PATCH. Final picture order when RefMod pictures must sit between media pictures: "
                           "'m' takes the next media picture, 'r' the next RefMod picture, e.g. 'm m r m m' makes "
                           "the RefMod <Picture 3>. Empty keeps media first, then RefMods."}),
        }, "hidden": {"extra_pnginfo": "EXTRA_PNGINFO"}}

    def encode(''')

swap('''voice_description_at_label=False, stack_pictures="every 4th", stack_pictures_n=8, extra_pnginfo=None):
        try:
            from comfy.text_encoders.minimax import MiniMaxH3Tokenizer''',
     '''voice_description_at_label=False, stack_pictures="every 4th", stack_pictures_n=8, picture_order="",
               extra_pnginfo=None):
        try:
            from comfy.text_encoders.minimax import MiniMaxH3Tokenizer''')

swap('''        del shown
        if blocks:
            # Let the VAE's working memory go before the text encoder loads.''',
     '''        del shown
        items, blocks, mapping = reorder_pictures(items, blocks, mapping, picture_order)
        if blocks:
            # Let the VAE's working memory go before the text encoder loads.''')

path.write_text(src, encoding="utf-8")
print("patched; backup at", backup)
