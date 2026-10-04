---
license: other
license_name: minimax-h3-community-license
license_link: https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE
tags:
  - comfyui
  - workflow
  - minimax-h3
  - character-sheet
  - turnaround
  - character-consistency
pipeline_tag: image-to-image
---

## Update - 31st Aug 2026

- Fixed the prompt section for Anime2Real.

## Update - 29th Aug 2026

- Fixed the 4 panel version so now it is actually generating 73 frames rather than the original 124 frames of the 6 panel version (my bad!!)
- Updated the optional speed up nodes so now it performs muuuuuch faster
- Added a note about the step count, use 8 steps instead of 25 steps if using speed ups
- Removed a section of the B prompt which mentioned about hair and skirts, as this was causing issues for some people
- If you wish to try turning a background/room to orbit, [consider checking out the workflow by ethanfel who applies the same logic as this workflow but for a room](https://huggingface.co/ethanfel/H3_Cinematic_Multishot_Coverage)
- The anime2real prompt needs a little bit extra work (I will update this section soon)
- If you have any questions or problems feel free to let me know
---

# H3 Character Sheet Generator

I started this since I was struggling to find good accurate high quality images I can use as reference for H3, so I realised this model has excellent character consistency and the ability to take up to 9 reference images. 

Throw in some rough reference images, get back a character sheet you can reuse forever.

<img src="https://huggingface.co/PoopMan333/H3_Character_Sheet_Generator/resolve/main/examples/CelticKnight%20-%206%20panel.png" alt="Celtic Knight character sheet" width="60%">

Like a lot of you I've been messing about with H3 and got a bit obsessed with the multi-image
reference side of it. You can feed it up to **9 images**, which means you can build a character out
of bits — a face from here, armour from there, a hat from somewhere else — and it'll actually hold
them together.

So this workflow does that, spins the character 360 (or 180 if using 4 panel version), and spits out a reference sheet you can use to
keep them consistent in everything you make afterwards.


<img src="https://huggingface.co/PoopMan333/H3_Character_Sheet_Generator/resolve/main/examples/CelticKnight%20-%20Example.PNG" alt="Celtic Knight inputs" width="100%">

---

## Why bother with a video model for this

If you generate six images of the same character separately, they'll disagree with each other. Jaw
shifts, jacket changes, colours drift. You know the drill.

Six frames from **one** video generation can't do that — they come out of the same pass. That's the
whole trick. The camera does a slow orbit with no hard cuts, the character stands still like a
statue, and then the workflow grabs six frames and stitches them together.

---

## How it works

1. You drop in your images and describe them in the **Input Text (A Prompt)** box
2. That added with a **B Prompt** which handles the spin, pose, lighting etc. 
3. It generates a slow 360 with no hard cuts, so the character stays consistent
4. 6/4 frames get grabbed and stitched into the sheet

You also have the option for a 360 spin video and every individual frame as optional outputs, if you want to pick your
own angles or use single frames as references later.

---

## Two versions

| File | What |
|---|---|
| `H3_CharSheetMaker_6_Panel.json` | Front, both sides, back, plus two face shots |
| `H3_CharSheetMaker_4_Panel__Faster_.json` | Four views, ~40% fewer frames, noticeably quicker |

Same knight, 4-panel:

<img src="https://huggingface.co/PoopMan333/H3_Character_Sheet_Generator/resolve/main/examples/CelticKnight%20-%204%20panel.png" alt="Celtic Knight 4 panel" width="60%">

---

## What you need

**Models** — every loader node has its download link baked in, so ComfyUI should just offer to grab
whatever's missing when you open the workflow.

| Slot | File | Goes in |
|---|---|---|
| Diffusion | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| Text encoder | `qwen3vl_32b_minimax_h3_int8_convrot.safetensors` | `models/text_encoders/` |
| Video VAE | `minimax_h3_video_vae_int8_convrot.safetensors` | `models/vae/` |
| Audio VAE | `minimax_h3_audio_vae_fp32.safetensors` | `models/vae/` |
| Turbo LoRA (optional) | `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` | `models/loras/` |

Those are the INT8 low-VRAM builds. If you've got the headroom, higher precision versions give better
detail — the text encoder especially, that's where prompt adherence lives.

**Custom nodes** — I tried to keep this close to vanilla. The only third-party stuff is in the
optional Speed Ups group:

- [KJNodes](https://github.com/kijai/ComfyUI-KJNodes)
- [rgthree](https://github.com/rgthree/rgthree-comfy) (just the toggle panel)

Delete that group if you want to.

---

## Writing the A Prompt

One line per image. Say what to take, and — this bit matters more than people expect — say what to
**ignore**:

```
<Picture 1> - keep the photo style. Use the bald head, facial hair, physique.
<Picture 2> - keep only the black outfit. Remove the hair, remove accessories.
<Picture 3> - use the shield. It is attached to the man's back.
```

If you don't rule things out by name, backgrounds and the wrong person's hair sneak through.

Also worth describing clothing **in words**, not just showing it. Faces carry across on their own but
wardrobe drifts. "Black high-collared coat with silver buckles" sticks. "The coat from Picture 2"
wanders off.

---


## Anime to Real

Someone asked if it could do anime to realistic, so there's a modified B prompt for that too. It's
surprisingly good at it.

**Haruhi:**

<img src="https://huggingface.co/PoopMan333/H3_Character_Sheet_Generator/resolve/main/examples/Haruhi%20A2R%20-%206%20panel.png" alt="Haruhi anime to real" width="60%">

**Sanji:**

<img src="https://huggingface.co/PoopMan333/H3_Character_Sheet_Generator/resolve/main/examples/Sanji%20A2R%20-%206%20%20panel.png" alt="Sanji anime to real" width="60%">

And here's the actual video that came from, so you can see how the thing works — slow spin, no cuts,
then a couple of face shots at the end:

<video controls width="480" src="https://huggingface.co/PoopMan333/H3_Character_Sheet_Generator/resolve/main/examples/Sanji%20A2R%20-%20Spin%20Video.mp4"></video>

The six panels are just frames pulled out of that.



---


## Objects

The model also does a excellent job of doing objects, however it is advised to show more angles as reference images. 

<img src="https://huggingface.co/PoopMan333/H3_Character_Sheet_Generator/resolve/main/examples/shield%20example.png" alt="random shield picture i found on google" width="60%">


---




## Caveats (being honest here)

**It's lil bit slow.** You're generating 124 frames to use 6. That's the fundamental silliness of the
approach. The 4-panel version helps by only generating 73 frames and taking 4 (40% speed up).

**Speed-ups cost you something.** Turbo LoRAs and caching do make it faster, but prompt adherence and
quality take a slight hit. Worth it most times except final pass. 

**Quality is limited.** It's a video model, it's better at video than stills. Crank the resolution and steps if
you care, and pay for it in generation time.

**The sheet alone might not be enough for close-ups.** Resolution per panel is what it is. For close
work I'd use the sheet *plus* some detail shots — face, clothing texture, whatever matters. And
honestly, for a one-off video you might be better off skipping the sheet and just using your
originals.


---

## Tips

- **More steps** = slightly better quality, if you're willing to wait
- The B prompt says **"neutral A pose"** — delete that bit if you want a specific pose
- **Use several different shots of the same character.** More angles in, better 360 out
- **Works on objects and props too.** You'll want to tweak the B prompt, mainly swapping the face
  close-ups for detail shots
- Frame timings shift between runs. If a panel looks off, turn on the "save all frames" output, find
  a better frame number and plug it into the subgraph. Re-stitching is cached, so it's instant

---

## Licence stuff

The workflow files are mine, do what you like with them.

**The model isn't.** MiniMax H3 has a community licence that excludes the EU, UK, South Korea and the
USA, and it covers *outputs* as well as the weights. If you're planning anything commercial, go read
[the actual licence](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) rather than taking
my word for it. I'm not a lawyer.

---

Built on [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3). Shout if you break it
or improve it.

By C_Nugget
