> **2026-10-03:** `produce_film.py`, `make_refs.py` and the `/generate-gaussian-image` endpoint (with its
> workflow template and job type) were removed: nothing had run them since 2026-09-04, they submit renders
> past the canvas, and the sections below that describe them are history. To read them,
> `git show e438a0f:tools/produce_film.py` (and `make_refs.py`, `backend/workflows/gaussian_image.json`).

# Batch film production

`produce_film.py` drives the LAZA CINEMA STUDIO backend through a whole shot list unattended.
The canvas UI is built for shot-at-a-time work; a one-minute film is 12+ shots and 35+
generation jobs, which needs sequencing, resume-after-crash, and stable per-shot seeds.

## Usage

```powershell
# ComfyUI on :8188 and the backend on :8003 first (see ..\start.ps1)
backend\.venv\Scripts\python tools\produce_film.py productions\rooftop_explorer --stage all
```

Stages run in order; each is independently runnable and resumable.

| Stage | What it does | Output |
| --- | --- | --- |
| `keyframes` | FLUX.2 still per shot, conditioned on the character reference | `keyframes/shot_NN_slug.png` |
| `clips` | Wan2.2 I2V from each keyframe | `clips/shot_NN_slug.mp4` |
| `interpolate` | RIFE 16fps → `target_fps` | `smooth/shot_NN_slug.mp4` |
| `upscale` | Deterministic ESRGAN to delivery resolution | `upscaled/shot_NN_slug.mp4` |
| `grade` | Per-act colour correction to `grade_targets` | `graded/shot_NN_slug.mp4` |
| `score` | ACE-Step music bed + Stable Audio ambience beds | `audio/score.flac`, `audio/amb_*.flac` |
| `assemble` | ffmpeg cut, prefers `graded/` > `upscaled/` > `smooth/` > `clips/` | `final.mp4` (silent) |
| `mix` | Mixes score + ambience onto `final.mp4` | `final_sound.mp4` |

Useful flags: `--stage clips`, `--shots 3,7,9` (limit to specific shots).

**Resume is by file existence plus a staleness check.** A shot whose output already exists is
skipped — unless its input is newer, in which case it re-runs:

```
[clip 03] stale (keyframe is newer) — re-rendering
[smooth 03] stale (clip is newer) — re-interpolating
```

This matters more than it sounds. Regenerating a keyframe leaves the clip built from the
*previous* keyframe sitting on disk, and an existence-only check reports "cached" and keeps
it — so the fix never reaches the screen while every log line says success. Clearing the
`manifest.json` entry does **not** rescue you, because the file check runs first and wins.
Three shots in this production shipped a whole pass with their pre-fix clips this way,
including one with the screen direction still reversed.

To force a redo anyway, delete the output file (`touch` on the keyframe also works, since
staleness is a timestamp comparison).

## A production folder

```
productions/<name>/
  shots.json        # the screenplay — see below
  manifest.json     # character reference + per-stage outputs (written by the tool)
  keyframes/        clips/        smooth/        final.mp4
```

`manifest.json` must carry a `reference` pointing at the character still before the
`keyframes` stage will run:

```json
{ "reference": "/uploads/scene_<id>.png", "keyframes": {}, "clips": {} }
```

`shots.json` holds `character`, `style`, and a `shots` array of `{id, slug, duration,
keyframe, motion}`. `character` and `style` are appended to every shot prompt verbatim —
repeating the character description alongside the image reference is belt-and-braces
against identity drift across a long shot list. Optional top-level keys: `fps`,
`target_fps`, `width`, `height`, `keyframe_steps`, `keyframe_guidance`, `clip_steps`,
`accelerate`, `base_seed`, `subject_noun`.

Seeds are `base_seed + shot_id * 17` — deterministic per shot, so a re-run reproduces and
no two shots share noise.

## Measured on an RTX 5090 (32GB), 1360x768 / 81 frames / 16fps

| Job | Time |
| --- | --- |
| FLUX.2 keyframe, 28 steps, 1280x720 | ~75 s |
| Wan2.2 I2V, **20 steps** two-stage | **~1475 s (24.6 min)** |
| Wan2.2 I2V, **4-step Lightning LoRA** (`accelerate: true`) | **~169 s (2.8 min)** |
| RIFE 16→32 fps | ~60-90 s |
| ACE-Step score, 62 s @ 60 steps | ~150 s |
| Stable Audio ambience bed, 16-20 s @ 50 steps | ~7 s |

**Set `accelerate: true` unless you have a specific reason not to.** It is ~8.7x faster,
and in the one A/B we ran it was also *more* prompt-faithful: on a "sleeping cat" shot the
20-step render opened the cat's eyes while the 4-step render kept them shut. The 20-step
output does hold slightly finer fur micro-detail, which is mostly invisible at playback
speed. At 20 steps a 12-shot film is ~5 hours; at 4 steps it is ~35 minutes.

## SageAttention — ~35% faster sampling, free

Set `"sage_attention": "auto"` in shots.json. Measured on one i2v clip, same keyframe and
seed: **183s → 119s (-35%)**, with output visually identical (brightness 112.2 vs 112.0, no
black frames, only sub-pixel trajectory drift from the attention approximation).

Two things make this work, and both are easy to get wrong:

- **Apply it as a node, not the launch flag.** ComfyUI's `--use-sage-attention` produces
  black output on Wan and Qwen. The builder instead routes each model through KJNodes'
  `PathchSageAttentionKJ` at the end of the model chain, before `KSamplerAdvanced`.
- **Only `auto` works with SageAttention 1.x.** The commonly-recommended
  `sageattn_qk_int8_pv_fp16_cuda` is a **2.x** API and fails outright here with
  `cannot import name 'sageattn_qk_int8_pv_fp16_cuda' from 'sageattention'` — a 5-second
  error that looks like a 98% speedup if you only read the wall clock. `auto` falls back to
  1.x's generic `sageattn`. Upgrading to SageAttention 2.x on Windows needs a source build
  (VS 2022 Build Tools plus a PyTorch header patch), so `auto` is the cheap win.

Verify picture after enabling: a failed or degenerate attention path shows up as black or
washed frames, which a timing measurement alone will not catch.

## Audio models

The audio stages need two checkpoints that don't ship with the rest of the setup:

| File | Location | Size |
| --- | --- | --- |
| [`ace_step_v1_3.5b.safetensors`](https://huggingface.co/Comfy-Org/ACE-Step_ComfyUI_repackaged/resolve/main/all_in_one/ace_step_v1_3.5b.safetensors) | `ComfyUI/models/checkpoints/` | 7.7 GB |
| [`stable-audio-open-1.0.safetensors`](https://huggingface.co/Comfy-Org/stable-audio-open-1.0_repackaged/resolve/main/stable-audio-open-1.0.safetensors) | `ComfyUI/models/checkpoints/` | 4.9 GB |
| [`t5-base.safetensors`](https://huggingface.co/ComfyUI-Wiki/t5-base/resolve/main/t5-base.safetensors) | `ComfyUI/models/text_encoders/` | 0.9 GB |

All the nodes they use are native to ComfyUI — no custom nodes required. ComfyUI picks up
new checkpoints without a restart.

Sound design lives in `shots.json` under `music` (ACE-Step `tags` / `lyrics` / `seconds`)
and `ambience` (a list of `{slug, prompt, start, seconds}` beds placed on the timeline).

## Reference images dictate colour, and no wording overrides it

A character reference carries its **colour temperature** into the latent along with the
subject's identity, and a prompt cannot argue with it. Measured on this project:

| | mean R-B |
| --- | --- |
| `cat_wet` reference sheet (ginger cat on grey) | **+23.0** |
| Every shot using it — across two different acts | **+23.0** |
| Same lighting sentence, **no** character reference | **-27.6** |

A 50-point swing decided by whether a shot happens to carry a character reference. The
lighting sentence said *"cold blue-grey storm light … deeply desaturated, no warm tones"*
and the referenced shots came out warm anyway. Adding an explicit instruction —
*"take ONLY identity from the reference, do NOT take colour temperature"* — changed nothing:
still exactly +23.0, on a fresh seed. References enter through `VAEEncode` →
`ReferenceLatent`, so their colour is latent-space information that text does not compete with.

**A character reference outranks everything else on colour.** BFL's own guidance is to give
colour its own reference — *"Image 3: style/aesthetic reference"*, *"using the warm lighting
style from image 5"*, *"apply only the colour palette from image 2"*. Tested here, that
approach is sound **but only while no character reference is present**:

| | mean R-B | saturation | high-freq detail |
| --- | --- | --- | --- |
| no style reference | +72.2 | 72.4 | 2.37 |
| **style ref only** (oil painting) | **+25.0** | **39.5** | **4.68** |
| **style ref only** (black & white) | **+8.4** | 47.7 | 3.94 |
| character ref alone | +23.0 | | |
| **character ref + cold style ref** | **+23.0** | | |

A style reference on its own moves colour hard — a black-and-white reference dragged R-B from
+72 to +8. Add a character reference and a style reference measured at -20.5 shifts the result
by **0.007**, which is nothing. Both runs produced different images (different md5), so the
style reference is being applied — it simply loses on this one axis.

So the accurate statement is not "references force their colour" and not "the style channel is
broken": **when a character reference is present it takes absolute priority on colour
temperature, and later references are overridden on that axis while still affecting texture and
saturation.** Note this is measured on the local ComfyUI `ReferenceLatent` chain with
`flux2_dev_fp8mixed`; BFL's documentation describes the cloud API's `input_image_2`, which may
behave differently and has not been tested here.

**So fix it in the grade** — not because nothing else exists, but because the documented
approach is unavailable whenever a character has to stay recognisable. `--stage grade` measures
each shot and pushes it to its act's target with a clamped per-channel gain:

```json
"grade_targets": { "1": -22, "4": -26, "10": -14, "17": -16, "default": -20 }
```

`assemble` then prefers `graded/` over `upscaled/` over `smooth/` over `clips/`.

**Split the correction by luma weight, not evenly.** R carries 0.299 of luma against B's
0.114, so shifting both by half the needed amount darkens the picture — measured at -4.3%
luma on a 44-point correction. Weighting the split keeps brightness flat (-1%) for the same
colour move. `stage_grade` does this; don't simplify it back.

Pick targets from what the lighting description produces *without* a character reference —
that is the look the prompt actually describes. Note this is the opposite conclusion to a
global grade being useless: that was true when shots differed by local lighting, and this is
a uniform global cast, which is exactly what a global correction fixes.

### It is not only colour — the reference sets contrast and black point too

The same mechanism runs on the tonal axis, and it is easier to miss because it reads as
"the film looks a bit flat" rather than as a wrong colour. Measured on *The Downpour* with
`deep black shadows … never flat or hazy` explicitly in the style string:

| reference sheet | black point | contrast (luma σ) | R-B |
| --- | --- | --- | --- |
| `cat_dry` | 82.4 | **27.9** | **+23.0** |
| `cat_wet` | 76.5 | **30.1** | **+23.0** |
| `crow_dry` | 8.5 | **71.5** | **−1.3** |
| `crow_wet` | 0.0 | **71.4** | **−1.2** |

| interior shot | black point | contrast | R-B |
| --- | --- | --- | --- |
| the six carrying `cat_wet` (10, 11, 12, 14, 15, 16) | 122–125 | **29.0–30.4** | **+22.8…+24.1** |
| carrying only `crow_wet` (13, 18) | 104 / 77 | **45.5 / 61.9** | **−1.6 / −0.0** |
| carrying no character reference (17) | **0.0** | **60.1** | −7.3 |

Six shots on the cat sheet land inside a 1.4-wide contrast band and a 1.3-wide R-B band. The
style string moved contrast from the sheet's 27.9 to 30.6 — i.e. not at all, exactly as text
loses on hue.

**It is the sheet's own measured tonality that propagates, not a property of "reference sheets".**
Both sheets were written from the *same* template — *"plain flat neutral grey studio background,
even soft frontal lighting, no cast shadows"* — and came out 28 vs 71.5. A pale ginger cat on
mid-grey is inherently low-contrast and warm; a glossy black crow on mid-grey is inherently
high-contrast and neutral. So the useful rule is predictive: **measure a reference sheet's black
point, contrast and R-B, and that is where every shot carrying it will land**, before rendering
a single shot. The set sheets (`roof_ext` 82.0, `shed_int` 62.1, both at black point 0) say the
same thing from the other direction.

When a shot carries **two** references the result tracks the cat sheet rather than blending —
shots 11, 12, 14, 15 and 16 all list `["cat_wet", "crow_wet"]` and all land on the cat's numbers.
Whether that is "first entry wins" or "the flatter one wins" is untested here.

**Don't fix it by relighting the sheets** — a previous wet sheet already lost the markings once.
Fix it in the grade, like the colour. `"grade_levels": {"keep": 4, "max_gain": 2.5}` opts a
production in; on shot 1 it took black point 114 → 8 and contrast 31 → 66.

**The two corrections interact, and the order is not interchangeable.** A levels stretch scales
R-B by its own gain — subtracting the black point leaves the difference untouched, multiplying
does not. Correct colour first and the stretch overshoots; stretch first and the colour error
lands outside what the ±25% clamps can pull back. So the colour is corrected to `target / gain`
and the stretch lands it on `target`.

**And predicting the result open-loop lands short**, because the stretch drives some highlights
to 255 where R and B are equal by definition and contribute nothing to R-B: shot 1 predicted
−22.0 and delivered −14.9. `stage_grade` therefore renders, measures and corrects the residual
once (−14.9 → −20.4, inside a ±2 tolerance). The grade is ffmpeg-only, so the second pass costs
seconds — don't replace it with a single predicted correction.

## Compare shots against each other, not just one at a time

Three separate faults survived a keyframe review that passed every image individually,
because each is only visible when shots are laid side by side:

- **One camera for the whole scene.** Seven of nine interior shots came back on an identical
  framing — pots left, doorway centre, bench right. Each was a fine image; together they were
  a locked-off camera pointed at a stage. Cause: the prompts said "medium shot inside the
  shed" without naming a camera, so the scene reference supplied its own composition. A
  controlled test proved the reference does *not* lock the camera — **name the angle in
  capitals** (`EXTREME LOW ANGLE`, `HIGH ANGLE LOOKING DOWN`, `OVER-THE-SHOULDER`) and it
  moves while the set still carries over.
- **Characters and set dressing jumping between cuts.** A scene reference carries style and
  rough layout, not exact placement, so every shot re-invented where things were. Fix with a
  short *layout* sentence and a *blocking* sentence repeated verbatim: pots LEFT, doorway
  CENTRE, bench RIGHT; cat always LEFT, crow always RIGHT. That also holds the 180-degree line.
- **Subjects changing size.** Measured against the pot stack, the cat was nearly as tall as
  the whole stack in one shot and a third of it in another — same animal, similar framing,
  2-3x apart. The model has no physical scale, so size gets chosen by what composes well.
  Fix by expressing size as a **ratio to a prop already in frame**: *"at the shoulder the cat
  is about as tall as ONE terracotta pot; the stack is roughly three times that"*. An
  adjective like "a small cat" is not actionable; a comparison to a visible object is.

Add these to the review pass: **is every framing distinct, does the set stay put, do the
characters hold their sides, is anyone changing size?**

## Prompts have an attention budget

Fixing continuity by appending 620 characters of layout and blocking text fixed continuity —
and broke two other things: the close-ups reverted to mid shots and one shot rendered two
crows where there should be one. Added text competes with what is already there, and the
camera and subject-count instructions lost.

Compressing the same rules to ~130 characters, and **omitting them where they don't apply**
(no layout sentence on a close-up that shows no geography; no scale rule on a macro with no
animal), kept the continuity fix and got the framing back.

**Contradictory placement produces duplicates, not compromise.** The two-crow shot was not a
counting failure — the blocking rule said *"the crow is always on the RIGHT beneath the
bench"* while that shot's action was *"walking to the doorway"*. Two mutually exclusive
positions, so the model drew a bird at each. No amount of `EXACTLY ONE` fixes that; the shot
where a character moves has to be **exempt from the blocking rule**.

## Quality gates — approve generated assets before building on them

Three stages produce contact sheets and refuse to let the next stage run until their output
is signed off in shots.json:

| Stage | Sheet | Approval list | Blocks |
| --- | --- | --- | --- |
| `review-refs` | `review/refs.png` | `approved_refs` | `keyframes` |
| `review` | `review/contact.png` | `approved_keyframes` | `clips` |
| `review-clips` | `review/clips.png` (3 frames/clip) | `approved_clips` | `interpolate` |

Faults propagate and multiply. A reference sheet costs ~90s to redo at its own stage; the
same fault found after nineteen shots have inherited it costs hours. Omit an approval list
entirely and that gate is simply off.

**Only gate the non-deterministic output.** RIFE interpolation, ESRGAN upscaling, and the
ffmpeg cut/grade are deterministic or already quantified — they produce what you expect on
every run, so re-inspecting their output each time is wasted effort. They still require an
approved *input*. Gates belong where a model invents something, not where a known transform
is applied.

`review-clips` samples three frames per clip (15% / 50% / 85%) rather than one, because the
failures that matter are failures of *motion* — hovering instead of landing, subjects fusing
part-way through, a state change that never happens — and a single still shows none of them.

## Review keyframes before rendering clips

`--stage review` tiles every keyframe into `review/contact.png` and **blocks `clips` until
each shot id appears in `approved_keyframes`** in shots.json. Keyframes are the cheapest
place to catch a defect: ~90s to regenerate, versus ~4 minutes to discover after the clip
renders — and everything downstream inherits the fault.

The failures are structural, not subtle, and no numeric check finds them. Look for:

- **Incoherent geometry.** "A sash window propped open a few inches" rendered as a floating
  diagonal pane belonging to no frame.
- **Fused subjects.** Two subjects overlapping in the keyframe merge into one body.
- **Wrong screen direction.** A cat shot from inside the room read as walking *in* along the
  sill when the story needed it going *out*.
- **The end state already showing.** "Eyes just opening" rendered fully open, so the waking
  beat had nowhere to go.
- **Jump cuts.** Two consecutive shots on the same axis at nearly the same size cut as a
  glitch. A scene reference makes this *more* likely, because it pulls the next shot toward
  the reference's composition. Change image size decisively and say so — "a very tight macro
  close-up, the head filling almost the entire frame ... no window frame visible".
- **Same-scene disagreement** in set dressing or lighting.

## New camera angles on an established set — reconstruct, don't re-prompt

Moving the camera is the hard case. Re-prompting a location from a different angle
*re-invents* it: flipping one shot to a reverse angle in this production returned a
different window, no props, and inverted lighting. A scene reference can't save you either,
because the new angle genuinely looks different — and it actively drags the new shot toward
the reference's framing, which is how two shots ended up as a jump cut.

Reconstructing the shot into 3D and moving the camera keeps the geometry identical *by
construction*. Declare it on the shot:

```json
{ "id": 3, "angle_from": { "shot": 1, "yaw": -35, "pitch": 3, "dolly": 2.2 } }
```

The pipeline then, caching every step:

1. **SHARP** reconstructs shot 1's keyframe into a Gaussian splat (`/generate-gaussian-model`,
   ~1.2M gaussians, cached per source shot in `splats/`)
2. `tools/splat_render.py` renders that `.ply` at the requested yaw/pitch — headless, so a
   batch run needs no browser (the canvas GaussianNode is the interactive equivalent)
3. **`/generate-gaussian-image`** repairs it: Qwen-Image-Edit 2511 with the dedicated
   `Gaussian.safetensors` LoRA, given the rough render *and* the original still, fixes the
   perspective and fills the holes — *"参考图2的场景图，修复图1的场景图透视并修复空白区域"*
4. The repaired still becomes the shot's scene reference, so the prompt is free to change
   the action while the set stays put

Step 3 is the part that matters and is easy to underestimate: the raw splat render is noisy
and full of gaps, and the repair returns a genuinely photographic image — same window,
mullions, peeling frame, withered plant, enamel mug, same light — from the new angle, in
about 50s. Don't treat the splat render as the output; it is an intermediate.

`angle_from` supersedes `scene_ref` on the same shot. Reconstruction only has geometry for
what the source image saw, so modest orbits (roughly ±40°) hold up while extreme ones swing
into unreconstructed space.

## First/last-frame video — for state changes that otherwise never happen

Give a shot an `end_keyframe` and it renders through `WanFirstLastFrameToVideo` instead of
plain i2v, pinning both t=0 and t=1 so the model interpolates between two known states:

```json
{ "id": 3, "keyframe": "...looking up, dry, eyes wide",
           "end_keyframe": "...same framing, a raindrop has burst on its nose, flinching" }
```

This is the fix for the single most common failure in these films: a motion prompt asking
for a change that simply never arrives. "Eyes just opening" played out as a cat that stayed
asleep; "ears relax" stayed tense. Pinning the end state removes the guesswork, and it
worked first time on the raindrop shot — the strike and flinch both land.

**The end frame must share the start frame's framing.** Tested with a wide shot as start and
an unrelated close-up as end, FLF **ignored the end frame entirely** and the cat never opened
its eyes — it cannot interpolate between two different camera setups. So the driver generates
each end frame with its own start frame as the `scene_ref`: same lens, same light, same set,
only the subject's state differs. End frames are inspected next to their start frames in the
review sheet for the same reason.

Note the official flf2v template's non-accelerated settings differ from plain i2v —
**cfg 4 and shift 8**, not 3.5 and 5. Lightning (4 steps, cfg 1, shift 5) is unchanged.

## Geometry proxies — when prose can't place a thing

FLUX.2 takes reference latents, so a crude grey render of a layout steers structure that
words repeatedly fail to pin down. `tools/scene_proxy.py` renders these:

```bash
python tools/scene_proxy.py sash-window productions/<name>/proxies/window_gap.png --gap 0.15
```

Then point a shot at it with `"depth_ref": "proxies/window_gap.png"`. The driver uploads it
as a `depth_reference_filenames` entry — structural conditioning that consumes an image
number but is never named in the prompt.

Worth reaching for after prose has failed twice. Three attempts at wording an open window
produced, in order: an incoherent tilted pane; a clean window with no opening at all; and a
correct window whose opening still wasn't visible. The proxy put an opening in the frame on
the first try.

It is guidance, not control: the model honoured *that there is an opening* but placed it
higher than the proxy specified. Use it to establish that something exists and roughly where —
not to dictate exact position. Flat blocks are enough; the prompt supplies material and light.

## Character reference sheets — build them before any shot

A film's consistency is decided before the first shot renders. In the first production the
cat had one reference still and the crow had **none**, and the crow came back as four
different birds — different size, beak, tail and gloss. The cat, which had a reference, held.

`tools/make_refs.py` generates a production's assets from `refs.json` into `refs/`, and
records them in `manifest.json` under `characters`. Shots then select from that cast:

```json
{ "id": 11, "refs": ["cat_wet", "crow_wet"], "scene_ref": "shed_int" }
```

**Use turnaround sheets, not single stills.** One image carrying four angles gives the model
every view a shot might need. Pin the angles down individually and give each a test the model
can fail — *"(3) in FULL SIDE PROFILE facing left, with only ONE eye visible"*. Asked loosely
for "four views", two of them came back as the same front view.

**Derive variants, never regenerate them.** A soaked cat and a dry cat written independently
are simply two different cats. `"derive_from": "cat_dry"` feeds the base sheet in as a
reference so only the state changes. And state that identifying marks must survive the
variant — the first wet sheet buried the white chest, socks and tail tip under dark fur,
which is physically true and useless for recognising the character.

**Keep distinguishing features robust.** "A small notch in the left ear tip" rendered as
large chunks missing from *both* ears at sheet scale. It needed clamping —
*"a TINY shallow nick in the LEFT ear only; the right ear is perfectly smooth"* — plus a
sturdier second marker (a white tail tip) that reads at any angle.

Sets are assets too: `scene_ref` accepts a set slug (`"shed_int"`), which held seven interior
shots to the same pots, bench and doorway.

## Shot logic — plant what a later shot depends on

Shots are prompted independently, so nothing stops shot 3 from relying on a state no earlier
shot established. This film shipped with a cat squeezing out under a raised sash window that
shots 1 and 2 had shown firmly shut — and a cat cannot open a sash. Neither the character
reference nor the scene reference catches this, because each shot is individually plausible.

Before rendering clips, read the shot list as a causal chain and ask of each shot: *what does
this require to already be true, and which earlier shot makes it true?* Anything a later shot
needs — a door ajar, a prop in reach, an injury, a time of day — has to be visible in the shot
that precedes it. Here the fix was to prop the window open a few inches in shot 1's keyframe
and motion, keep the gap visible in shot 2, and have shot 3 pay it off.

Two related traps:

- **Don't play the same beat twice.** Shot 9 ended with the cat landing on the far roof and
  shot 10 opened by landing again. Later shots inherit their opening state from the cut before.
- **Don't let a character vanish and reappear changed.** The crow chases in shot 8, is absent
  in 9-10, then shares water peacefully in 11. That reads as an ellipsis rather than an error,
  but it is the seam a viewer is most likely to notice.

A logic change to an early shot cascades: shot 1's keyframe changing invalidated shots 2 and 3
because they reference it. Fix logic *before* rendering clips, not after.

## Scene continuity — shots sharing a location need a scene reference

A character reference keeps the *subject* consistent and does nothing for the *set*. Two
shots written as the same windowsill came back with different set dressing: shot 1 had a
withered plant and a chipped enamel mug on peeling paint, shot 2 had a clean bare sill.
Each keyframe had invented its own room.

Point a shot at an earlier shot's location with `scene_ref`:

```json
{ "id": 2, "slug": "awake", "scene_ref": 1, "keyframe": "...the same cluttered, paint-chipped
  wooden windowsill, the withered dead plant still just in frame, the chipped enamel mug behind..." }
```

The tool uploads shot 1's keyframe as a `scene_reference_filenames` entry, and the backend
adds *"in the exact same location as image 2, matching its set dressing, props, furniture and
lighting exactly"*. Name the props in the prompt as well — the reference anchors them and the
words tell the model which ones matter.

Anchor shots must be rendered first; `keyframes` runs in shot order, and a shot whose
`scene_ref` target has no keyframe yet renders without it and says so.

**Image numbering is positional.** References are chained as
`subject → scene → style → depth → pose`, and "image N" resolves to the Nth entry, so a
clause silently points at the wrong picture if the order and the numbering disagree. Depth
refs consume a number without ever being named. `_build_prompt` has a small test in its
docstring cases — check numbering there before adding a new reference kind.

## Editorial timing — don't ship equal-length shots

Every shot the same length is the loudest tell of an unedited assembly. `assemble` cuts with
a filter graph rather than the concat demuxer so each shot carries its own screen time:

| Key | Meaning |
| --- | --- |
| `duration` | render length handed to Wan (what gets generated) |
| `edit_duration` | screen time in the cut (what the viewer sees) |
| `edit_in` | in-point into the take — the best moment is rarely the first frame |
| `edit_speed` | `<1` slows a shot; `0.78` turns a 7s take into 9s of screen time |

Render generously and cut down: a take is cheap to trim and expensive to re-render. Only
raise `duration` when a shot needs *more* screen time than the take holds.

The rhythm used for *The Rooftop Explorer* (59.6s over 12 shots) accelerates into the chase
and decelerates into the ending:

```
 1 dawn         6.4s   settle the audience in
 2 awake        3.5s   inciting beat, quicker
 3 escape       4.0s
 4 the-world    7.4s   the "wow" establishing shot needs to breathe
 5 the-pipe     5.0s   sustained tension
 6 the-slip     2.5s   shock
 7 the-crow     4.0s   held standoff
 8 the-chase    2.4s   fastest cut in the film
 9 the-leap     5.0s   climax, let it land
10 the-garden   5.4s   wonder
11 truce        5.0s
12 golden-hour  9.0s   longest, at 0.78x — the film has to end, not stop
```

`fade_in` / `fade_out` bracket the film in black. Sound follows the cut automatically:
`shot_timeline()` measures the *edited* boundaries, so shot-anchored ambience beds re-align
whenever a trim changes and never need hand-adjusting.

Frame-count note: Wan renders `int(duration*fps)+1` frames, and quality holds best at or
below ~121 frames (7.5s at 16fps). Past that, prefer rendering shorter and using
`edit_speed` to buy screen time — which is also why shot 12 is a 7s take slowed to 9s.

## H3 clips upscale in latent space, and the refine pass is one step at sigma 0.6

An H3 shot that still has its `H3_Latent_*.safetensors` takes a different path from
everything else: the latent is upscaled by the learned 3D upscaler and re-sampled once
at the new size, never decoded to pixels in between. `method: "h3_latent"` on
`/upscale-video`; a clip without a saved latent is encoded by the backend first.

The shipped configuration, measured on a 1376x768 ref2va shot upscaled 2x to 2752x1536:

```
MMH3UltimateUpscale        ONE span: no temporal chunking (temporal_split_param unconnected), NO spatial tiling; API temporal_chunk/spatial_tile default 0 (2026-09-06)
MMH3LatentUpscaleWithModelParams   minimax_h3_latent_upscaler_3d_bf16
sampler / sigmas           sa_solver, ManualSigmas "0.6, 0"   (one step)
MiniMaxH3SigmaShift        6 / 3      (generation uses 12)
conditioning               MiniMaxH3ReferenceToVideo re-encoded at 2752x1536,
                           ref_image_size='max', the shot's own reference images,
                           prompt = "...sharp focus, clear details"
```
210s warm. Requires `Comfyui-MMH3-UltimateUpscale` and `comfyui-h3-motion-context` in
`custom_nodes/`, and the upscaler checkpoint in `models/latent_upscale_models/`.

### The three things that are easy to get wrong

**`denoise` is not sigma.** `BasicScheduler(steps=1, denoise=0.2)` takes the tail 20% of
a curve that flow shift has already pushed to the top: it starts at **0.6** under shift 6
and **0.75** under shift 12, not 0.2. Every strength discussion here should quote sigma.

**One step is not a weak version of three steps.** A single euler step to zero is the
model's x0 prediction taken in one jump -- strongly regularised, it cleans the upscaler's
output. Spending the same span over two or three steps gives the model room to reimagine
instead, and it does.

**Neither PSNR nor bitrate can judge this.** PSNR against the source measures *how much
changed*, so a pass that adds real detail scores worse. Bitrate counts high-frequency
energy, and a refine pass that removes upscaler noise scores worse for doing its job.
Both were used here to conclude the refine pass was a net loss; watching the clips said
the opposite, and the clips were right. Use PSNR only to detect composition drift (which
it does detect: at sigma 0.9 the shot visibly rewrites, and PSNR falls off a cliff).

### What was tried and rejected

| Approach | Why not |
| --- | --- |
| Refine at sigma 0.9 (the official templates' value) | Rewrites the shot. That value is a *handoff point* in their pipeline, where the latent was only half-sampled; ours is finished, so 0.9 means repainting it. |
| Splitting generation to save a half-finished latent (`split_at`) | The handoff carries only (1-sigma) of the signal -- 7.7% at their split point -- so the "approved preview" does not determine the result. Measured: the normal pipeline's own second half already lands 25 dB from that preview. |
| The official one-shot pipeline (generate small, upscale, finish big) | 19-46% faster and it reaches resolutions the generator's own 1536 clamp forbids, but the picture was judged worse than generating at native size. Their design targets speed on their own checkpoints. |
| Upscaling with no re-sample at all | Cannot change the picture, but cannot add detail either. Side by side against the refined pass it lost, so the branch was removed. |
| Spatial tiling | Only bounds VRAM, which a 34GB card does not need here. 512px tiles: 787s. 1024px: 405s. None: 285s -- every tile pays a ~10s model re-stage for a 20GB int8 checkpoint carrying LoRA patches. |
| Feeding the shot's own prompt to the refine pass | Worth 0.13 dB over a generic one, and it invites a sharpening pass to paint the described scene back in. |

H3-Base generates at a 768 short edge; 864 still holds detail density, 1024 starts to
drop. The real 2K path is **H3-Regenerate-2K**, which regenerates from the 768p result
plus the original context rather than upscaling it -- MiniMax has said it will be
open-sourced "once this set of technologies becomes stable" but has not released it.
When it lands, this whole section is worth revisiting.

## Upscaling — use ESRGAN for resolution, not a generative restorer

`--stage upscale` runs a deterministic ESRGAN pass (`method: "esrgan"` on `/upscale-video`),
enabled per production:

```json
"upscale": { "method": "esrgan", "model": "RealESRGAN_x2.pth", "width": 1920, "height": 1080 }
```

`assemble` then prefers `upscaled/` over `smooth/` over `clips/` automatically.

Measured on shot 6 (1360x768 -> 1912x1080, gravel/tile crop at native resolution, mean
absolute second difference of the high-frequency residual — second difference because real
motion is locally linear while per-frame hallucination is not):

| | flicker | detail | time |
| --- | --- | --- | --- |
| source | 5.30 | 6.22 | — |
| lanczos | 6.25 | 5.55 | instant |
| SeedVR2 | **8.93** | **7.12** | 448s |
| **RealESRGAN_x2** | **6.16** | 5.41 | **~90s** |
| FlashVSR (Balanced) | 6.85 | 6.73 | 450s |

SeedVR2 was removed from the studio on 2026-10-02 (weights, workflow and code); its row stays as the
measurement ESRGAN was chosen against.

**Pick by whether detail must be invented.** For raising resolution on footage that is
already correct, ESRGAN wins outright: being deterministic, identical input patches map to
identical output, so it *cannot* produce different texture on successive frames — it scored
the most stable of everything tested, below even lanczos, at a quarter of SeedVR2's cost.
It adds no detail (5.41 vs lanczos 5.55; it denoises, and a x2-then-downscale softens
further), which is exactly right when there is nothing to restore.

Reach for a generative model only to *invent* detail. SeedVR2 buys ~28% more detail for ~43%
more flicker — gravel and grit visibly reshuffle, fur reads over-sharpened. FlashVSR
(Wan2.1 3B, temporal-aware) is the better generative option: near SeedVR2's detail at 23%
less flicker. **But its output is time-shifted ~3 frames against the source and does not
realign by shifting** — it reconstructs the sequence, so it cannot be dropped into a cut
without alignment work. Verify before using it in an edit.

## Superseded conclusions worth remembering

The SeedVR2 investigation (its `batch_size` temporal window was not the flicker fix; `denoise_strength` and
`steps` did nothing on that path) ended with SeedVR2's removal. Do not generalise from one model: "SeedVR2
flickers, so skip upscaling" was wrong, ESRGAN and FlashVSR both beat it on stability.

## Reviewing a cut (do this before calling it finished)

Sample one mid-shot frame per shot into a contact sheet and look at the whole film at once —
consistency and continuity problems are invisible shot-by-shot but obvious in a grid:

```bash
# one frame per shot, then tile 3x4
ffmpeg -y -i clips/shot_01_dawn.mp4 -vf 'select=eq(n\,40),scale=460:-1' -vframes 1 sheet/01.png
ffmpeg -y -i 'sheet/%02d.png' -filter_complex 'tile=3x4:margin=8:padding=6' -frames:v 1 sheet/contact.png
```

For a suspect shot, stack three frames (early / mid / late) to judge motion rather than pose.
ffmpeg needs **native Windows paths** here — it cannot write to Git Bash `/tmp/...`.

Three i2v failure modes this production hit, all fixable in the keyframe:

- **Two subjects overlapping in the keyframe fuse into one body.** The chase shot had the
  crow drawn over the cat's back; i2v merged them into a chimera for all 81 frames. Fix by
  composing clear empty space between subjects and saying so ("clearly separated ... not
  touching and not overlapping").
- **A subject already airborne in the keyframe hovers.** The leap shot had the cat mid-air,
  so i2v had no ground contact to push against and produced a walking-on-air drift. Fix by
  keyframing the *instant before* — paws still planted, coiled to launch — and letting the
  motion prompt carry it through.
- **A state change won't happen if the keyframe already shows the end state.** "Eyes just
  opening" rendered as eyes fully open, so the waking beat was lost and the shot merely
  blinked. Keyframe the *start* state (eyes shut) and describe the transition in `motion`.

Use `seed_override` on a shot to re-roll just that shot; the other shots keep their seeds.
Archive rejects to `alternates/` rather than deleting, so a regression can be compared.

## MiniMax H3 — a different pipeline, not a different clip model

`produce_h3.py` drives an H3 production. It is deliberately *not* a stage inside
`produce_film.py`, because H3 collapses most of that pipeline: one generation carries its
own cuts, its own dialogue and its own foley, so there is no keyframe stage, no i2v stage
and no separate score/ambience/mix stage. What replaces them is reference discipline.

| Tool | Does |
| --- | --- |
| `h3_smoke.py` | one T2V generation with timing and VRAM instrumentation — run this first after any model or setting change |
| `produce_h3.py` | `voices` → `scenes` → `assemble`, resumable, staleness-checked |
| `h3_review.py` | picture *and sound* gate: 3-frame sheet plus onset detection |

Settings are the official template's, verified: `res_multistep` / `beta` / 20 steps /
`BasicGuider` (no CFG) / 24fps, decoding the one packed latent twice (`VAEDecode` takes the
video half, `VAEDecodeAudio` the audio half). Frames snap to a **17k+5 grid**, trained range
124-362 (5.2-15.1s). Native canvas is a 768px short edge capped at 768x1344 — so a 9:16
vertical short renders at native resolution with no scaling.

### Measured on an RTX 5090 (32GB), 1344x768 / 124 frames / 20 steps

| | |
| --- | --- |
| 5.17s of film | **293-306s → ~58s of compute per second of film** |
| VRAM | peak **27.4-27.9 GB**, median 21.8-23.1 GB — fits one card, no OOM |
| Output | 24fps H.264 + **AAC stereo 32kHz**, L/R correlation 0.53-0.81 (genuinely stereo) |

### Dialogue outranks foley by ~20 dB, and you cannot fix it afterwards

Measured across three takes of the same set:

| take | dialogue | foley peak |
| --- | --- | --- |
| "quiet room tone, a faint hum" | none | **-19.4 dBFS** |
| loud foley **+ one spoken line** | -24 dBFS | **-13.0 dBFS**, footsteps down at -50…-43 |
| loud foley, **no speech at all** | none | **-0.6 dBFS** |

H3 normalises around the loudest element and hands it the headroom. Both are generated
either way — the footsteps in take 2 are clearly audible — but they sit far back. Picture
and sound are baked into one stereo track, so the balance cannot be re-mixed later.

**So schedule it: the shot that needs a sound event to land is the shot that gets no
dialogue.** That is a blocking constraint on the shot list, not a mixing note.

### Ask for present sound, never for quiet sound

*"quiet room tone, a faint air-conditioning hum"* produced a flat -39 dBFS floor.
Rewritten as *"LOUD close-miked … recorded hot … dominating the mix"*, the same set and
seed gave 24.3 dB of envelope swing and a -13.0 dBFS peak. Same failure as Stable Audio,
same fix.

### Count sound events, don't measure loudness

The first version of `h3_review.py` gated on RMS plus envelope swing and **failed a take
whose footsteps were perfectly audible**. With a 20 dB built-in gap between dialogue and
foley, no level threshold can separate "quiet foley" from "silent". It now uses spectral
flux: dialogue reads as a tight run of onsets 120-150ms apart (one per syllable — the four
onsets at 4.30/4.42/4.56/4.68s were 「谁在那儿」), foley as isolated impacts. The only
blocking failure is *no event at all*.

### SageAttention: -34%, and it eats the VRAM headroom

Same prompt and seed, T2V, `"sage_attention": "auto"`:

| | time | peak VRAM | luma mean | contrast σ | black / blown frames |
| --- | --- | --- | --- | --- | --- |
| baseline | 306s | 27.4 GB | 55.81 | 52.20 | 0 / 0 |
| **sage auto** | **203s (-34%)** | **31.2 GB** | 56.14 | 53.80 | 0 / 0 |

Picture is clean — no black frames, tone and contrast within 3%. But peak VRAM went from
27.4 to **31.2 of 31.8 GB**, and R2V carries reference tokens through every sampling step
on top of that. Verify the R2V path separately before enabling it on a production; the
speedup is worthless if the scene OOMs.

Not the ~2x the docs advertise. `auto` is SageAttention 1.x's generic Triton path, which
is the only thing the installed 1.0.6 can do — see below.

### The three attention paths pull in different directions

All measured on the same prompt and seed, 5.17s T2V, 1344x768:

| | time | peak VRAM | luma | contrast σ | black/blown | mean abs diff vs baseline |
| --- | --- | --- | --- | --- | --- | --- |
| none | 306s | 27.4 GB | 55.81 | 52.20 | 0/0 | — |
| sage 1.x `auto` | **203s (-34%)** | **31.2 GB** | 56.14 | 53.80 | 0/0 | 13.51/255 |
| `MiniMaxH3MemoryEfficientSageAttentionPatch` (needs sage 2.x) | 585s (+91%) | **20.9 GB (-6.5)**, median 16.6 | 57.04 | 53.66 | 0/0 | **9.65/255** |
| **Sol-Attn** (`tau=1.3, int8_qk`) | **133s (-56.5%, -34.5% vs sage)** | **28.7 GB** | 56.20 | 53.72 | 0/0 | clean, 6 onsets |
| **Sol-Attn + ChunkFFN 2** | **119s (-61.1%, -41.4% vs sage)** | **29.4 GB** | 56.18 | 53.69 | 0/0 | clean, 6 onsets |

**Sol-Attn breaks the speed-vs-VRAM compromise.** Where Sage 1.x bought 34% speedup at the
cost of pushing VRAM to 31.2GB (leaving only 0.6GB headroom on RTX 5090 32GB), Sol-Attn
cuts compute time to **119-133s** (~23-26s of compute per second of film) while keeping peak
VRAM safely under 29.4GB (leaving 2.4-3.1GB headroom). Exact KV sink preservation protects
audio sync (32kHz stereo onset detection verified 6/6 events) and prompt adherence.

So pick by which wall you are against, and note that R2V + sage 1.x measured 28.4GB peak —
it fits, with 4GB to spare, for 768p at 277 frames. Reach for the memory-efficient patch
only when that stops being true: 2K output, a full 15s take (362 frames), or R2V carrying
its full nine reference images. It does not make the same film faster; it makes a film
possible that otherwise OOMs. And it costs a torch downgrade on whichever instance runs it
(2.10.0+cu130 → 2.9.0+cu128), which is a reason to keep it in a sandbox rather than
migrate production to it.

### Why the 2.x kernel names in the KJNodes dropdown don't work

SageAttention **1.x is pure Triton**: the installed package is all `.py`, no compiled
extension, and it exports exactly `sageattn`, `sageattn_varlen`,
`attn_qk_int8_per_block*`, `quant_per_block*`. Every other entry in the node's dropdown —
`sageattn_qk_int8_pv_fp16_cuda`, `..._fp8_cuda`, `sageattn3` — is a **2.x/3** entry point,
introduced when the library was rewritten around hand-written CUDA kernels with one export
per Q/K + P/V precision pairing. Selecting one runs `from sageattention import <name>` and
raises ImportError in about five seconds, which on a stopwatch looks like a 98% speedup.

**PyPI only ever had 1.x.** Latest is 1.0.6, published as a `py3-none-any` wheel — pure
Python by construction, which is why it cannot contain a CUDA kernel. 2.x and 3 were never
published there at all, so `pip install -U sageattention` can only ever give you 1.0.6.

### Three different packages, three different KJNodes paths

Reading `comfyui-kjnodes/nodes/model_optimization_nodes.py` settles what needs what — and
they are **not** one dependency:

| KJNodes path | imports | package needed |
| --- | --- | --- |
| `PathchSageAttentionKJ` → `auto` | `from sageattention import sageattn` | sageattention **1.x** (PyPI) |
| → `sageattn3`, `sageattn3_per_block_mean` | `from sageattn3 import sageattn3_blackwell` | **`sageattn3`** — a separate package |
| → `sageattn_qk_int8_pv_*` | `from sageattention import sageattn_qk_int8_pv_*` | sageattention **2.x**, compiled |
| `MiniMaxH3MemoryEfficientSageAttentionPatch` | `sageattention.core.get_cuda_arch_versions` | sageattention **2.x**, compiled |

So "install SageAttention 2.x/3" is the wrong frame. The available prebuilt Blackwell wheel
is `sageattn3` — a *different distribution* that unlocks only the FP4 path. The H3-specific
memory-efficient node (KJNodes added it the day H3 dropped, and it targets exactly the VRAM
ceiling above) is gated behind **2.x**, which has no prebuilt wheel for this stack. Getting
it still means MSVC + CUDA toolkit and a source build.

### The sandbox instance, and what it proved

Testing this without risking the working install: a plain isolated tree, not a Desktop
instance.

```
D:\ComfyUI-sage3\
  ComfyUI\                 official repo at v0.30.1 (same version as production)
  ComfyUI\extra_model_paths.yaml   -> D:\ComfyUI\models   (share the 59GB, download nothing)
  .venv\                   py3.12 + torch 2.12.1+cu130 from download.pytorch.org
```

Findings worth keeping:

- **`download.pytorch.org/whl/cu131` does not exist (403).** `cu130` does have torch
  2.12.0/2.12.1 for cp312-win, and that is the half that matters.
- **A cu131-built extension imports fine on torch 2.12.1+cu130.** The binding constraint is
  the *torch* ABI, not the CUDA minor version — worth knowing before rejecting a wheel on
  its filename.
- **ComfyUI's `requirements.txt` did not clobber the pinned torch.** Check anyway; it lists
  `torch`, and a CPU build landing there would silently ruin the environment.
- **Pin all three of torch/torchvision/torchaudio, every time.** Pinning only `torch==` and
  letting the other two float across repeated index switches ended up installing
  **torchvision 0.1.6** — a 2017 release — because the `cu129` index publishes torch 2.9.0
  but no matching torchvision for cp312-win, so the resolver wandered off. It surfaces as
  `ModuleNotFoundError: No module named 'torchvision.ops'` during ComfyUI startup, which
  reads like a ComfyUI bug. Check the index actually carries the whole set before choosing
  it: `cu129` has torch 2.8.0/2.9.0 but only torchvision 0.23.0, while `cu128` carries
  torch 2.9.0 + torchvision 0.24.0 + torchaudio 2.9.0 together. CUDA 12.8 and 12.9 both
  present as `cudart64_12.dll`, so an extension built against 12.9 loads fine on a cu128
  stack — the *torch* ABI is the part that has to match exactly.
- **The FP4 kernel computes real attention**: cosine 0.981 against SDPA at both
  1x8x1024x128 and 1x4x2048x128, relative L2 ~0.19 — the error a 4-bit format implies.
  Whether 20 diffusion steps accumulate that into visible damage is a separate question and
  has to be answered on rendered frames, not on a cosine.
- The wheel is a plain zip: two `.pyd` extensions plus thin wrappers carrying the upstream
  SageAttention Apache-2.0 header, no `.pth` startup hook, nothing executed at install time.

Neither existing Desktop instance could have taken the wheel anyway — the adopted `ComfyUI`
is py3.12 but torch 2.10, and `ComfyUI-Scail2` is **py3.13** against a `cp312` wheel.

Worth knowing before spending the time: SageAttention 3's FP4 win is bandwidth-bound and
shows up at long sequences; at short ones the quantisation overhead can exceed the saving.

### Continuity between scenes is carried by a frame, not by words

This is the single most useful thing learned about H3, and it took four attempts to get
to because the first three all tried to fix it with better text.

Each scene is an independent generation. Scene 2's prompt has no idea what scene 1
actually rendered, so "the windows are on the right" is re-interpreted from scratch every
time. Escalating the text does not fix it:

| attempt | what changed | outcome |
| --- | --- | --- |
| 1 | added a population + wall-side sentence | population fixed, character sides still drifted |
| 2 | added "哥 always LEFT, 皮哥 always RIGHT" | sides fixed, but still three unrelated generations |
| 3 | rewrote everything into the official six-section format | the cut and the performance landed; **space still drifted** |
| 4 | **fed scene 1's rendered frame in as a `<Picture N>` composition anchor** | scene 2 opened on scene 1's staging |

Measured against the anchor frame, scene 2's opening:

| | mean abs diff |
| --- | --- |
| with the anchor | **8.00 / 255** |
| without it | 79.25 / 255 |

Eight is *lower* than the difference between two renders of the same prompt under
different attention kernels (9.65-13.51) — the anchored scene opens closer to the previous
scene's staging than a scene does to itself re-rendered. Background students, the books on
the desk and the camera's side of the two characters all carried over.

Use `anchors: [{"slug": ..., "from": <scene slug>, "at": 0.45}]` in `scenes.json`; the
frame is extracted from the named scene, appended to that scene's image references, and
addressed as any other `<Picture:slug>`. Staleness follows the source clip, so re-rendering
scene 1 invalidates everything anchored to it, and the chain resolves in scene order.

Declare it as a standalone `<Picture N>` — the guide's shot-planning anchor — not inside a
`<Subject N>`. The two do different jobs: a `<Subject N>` says what someone looks like, a
standalone `<Picture N>` says where the camera is and who stands where.

### Scout the location with H3 first: one orbit, then take the setups out of it

The strongest answer to "the same room from several camera positions", and the one to
reach for first. Generate a single continuous camera move through the **empty** set, then
pull each shot's `<Picture N>` anchor out of it as a still. Every frame is the same room
because one generation produced them all — consistency comes from temporal coherence, not
from hoping separate generations agree.

`productions/niutui_scout/` is the worked example: 11.5s, no people, one unbroken move from
behind the back desk, trucking right past the windows, arcing left onto the chalkboard.
277 mutually consistent frames covering three walls, for one 811s generation.

Two things the prompt has to say, because H3 is a video model and its default is for
something in frame to move:

```
retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - ... every part of the room stays
  physically fixed while only the camera moves.

detailed_description:
... Nothing in the room moves; no chair shifts, no page turns, no door opens. There is no
cut anywhere in this video — it is one continuous take.
```

This is also the one job where H3's documented camera vocabulary earns its keep, since
nothing else is happening: `trucks right with large amplitude at slow speed`,
`arcs left with large amplitude at slow speed`.

**What was tried first and does not work**, in the order the session burned through it:

| approach | why it fails |
| --- | --- |
| describing the camera position in prose | the angle exists only as adjectives and loses to the latent |
| `derive_from` a room still, once per angle | derived stills share a *look*, not a *set* — the same noticeboard came back framed in one angle and taped flat to the wall in another |
| `/generate-panorama` → `/reconstruct-panorama` → splat | a generated equirect is a *painting* of a room, not a capture of one: no true parallax, so there is no geometry to recover. The renders were smeared streaks, and `/generate-gaussian-image` could not repair them — it invented an industrial hall instead |
| all setups in one multi-panel sheet | genuinely one room (the turnaround-sheet trick works for locations too), but the individual camera positions come out approximate, and set signage renders as garbled text at that scale |

`/generate-panorama` (FLUX.2 Klein + a 360 LoRA) has been removed from the backend, for
the reason in the table above and because stills now come from H3 renders plus frame
grabs only. The finding it left is still worth its own line: **passing ordinary perspective
stills as references to a 360 model destroys the projection.** The 360 LoRA's
equirect prior loses to them and you get a wide perspective photo that the reconstruction
then treats as an equirect. Same prompt and seed with no references produced a correct
2:1 equirect in 28s. A reference had to be projected into an ERP canvas first to survive.

### Never anchor a shot where someone moves

The corollary, and it is expensive to learn the hard way. Scene 3 was anchored to a frame
that fixed the protagonist seated, while the shot required him to stand and walk into the
aisle. That is a contradiction, and — exactly as with the placement rule further up this
document — the model resolved it by **drawing him twice**: one seated in the anchor's
position, one standing doing the action. The audience then reads the *other* boy as the
protagonist, because the one in the protagonist's established position never moves.

Anchor the shots that hold still. Leave the shot where someone moves unanchored, and state
the count explicitly in it: `There is EXACTLY ONE <Subject 1> in this video and he is the
boy seated at the desk on the LEFT of frame.`

And keep the spatial *relation* identical in words across scenes, not just the screen
sides. Scene 3 originally said `<Subject 2>` stands "beside him" where scenes 1-2 had the
two boys across a desk from each other — that one changed preposition was enough to let
the model reassign which boy was which.

### Beats land late

Across every take, an event specified for `[2.5s]` arrived at 4.3-4.5s. Treat per-cut
timings in a prompt as hints and fix the rhythm with `edit_in` / `edit_duration`.

### `<Picture N>` numbering is per-kind — the opposite of the FLUX.2 chain

`comfy/text_encoders/minimax.py` counts each kind separately: `<Picture N>` counts images
only, `<Audio N>` audio only, `<Video N>` video only. With four images and one audio
reference the audio is `<Audio 1>`, not `<Audio 5>`. This is the reverse of the positional
`image N` rule further up this document, and getting it wrong points a clause at the wrong
reference with no error. `produce_h3.py` therefore takes `<Picture:slug>` / `<Audio:slug>`
in prompts and resolves the numbers itself.

### Autogrow inputs are addressed by dotted path

Reference slots are `ref_images.ref_image_0`, not `ref_image_0`. The bare name **passes
validation** — the schema really does list those names — but never gets regrouped into the
dict the node expects, and surfaces as
`execute() got an unexpected keyword argument 'ref_image_0'` after the graph has already
started running. Slots are zero-based while `<Picture N>` is one-based: `ref_image_0` is
`<Picture 1>`.

### Feed H3 single-subject stills, not turnaround sheets

The official R2V examples pass in-scene stills of one character. A four-view sheet risks
the model reproducing the sheet's layout. Keep the sheet as the internal source of truth
and *derive* a single hero still from it — that is what goes to `ref_images`.

And give the still a **scale cue**, because an isolated studio portrait cannot encode
height at all: a character written as "a full head taller" came back looking ordinary until
he was placed in a doorway with "the top of his head about a hand's width below the top of
the door frame". Same rule as sizing a subject against a prop, one stage earlier.

### Mint voice references from solo takes

`ref_audios` locks a character's voice, but only if the reference contains one voice. Cut
from a two-hander it carries both, and asking the model to reproduce "this voice" then means
something incoherent. `--stage voices` generates a short solo clip per speaking character
and strips its audio.

### Let H3 do sound, keep music yourself

Independent generations invent independent scores, which cut together badly. End every
scene prompt with `no score, no music` and lay one ACE-Step bed over the finished cut.

## Gotchas

- **`No output images produced. History outputs: {}` is a timeout, not a failure.** The
  backend's `_run_image_workflow` had `timeout=180` while video workflows got 1800-3600s.
  ComfyUI's queue is serial, so a 90-second FLUX.2 still still sitting behind a 14-minute
  H3 render blew that ceiling every time — and ComfyUI went on to finish the job
  successfully seconds later, which is why `/history` showed nothing but `success` while
  the driver reported four dead assets. **The timeout has to cover queue wait, not just
  render time.** Now 1800s.

  It cascades, which is what makes it look like a bad batch rather than one bad number:
  the driver treats the timeout as a failed asset, immediately submits the next one, and
  that one now queues behind the job still running — so each asset fails sooner than the
  last. Three reference sheets died this way in one run.

  An earlier version of this note said "don't submit a FLUX.2 job while an H3 job is
  running". That was the symptom, not the cause: the same failure came back with nothing
  on the GPU at all, just three torch downloads competing for I/O. Anything that slows the
  machine triggers it.
- **`_build_prompt` used to hardcode "animal".** The turnaround-sheet and identity clauses
  read *"the same single animal … exactly one of each animal in the scene"*, written when
  the entire cast of this project was a cat and a crow. Pointed at a human character it
  told FLUX.2 to render animals, and it did — four cats standing around the student. Now
  taken from `subject_labels` (or `subject_noun`); pass `subject_noun: "animal"` to get the
  old wording back on an animal film.
- **`uvicorn --reload` kills in-flight jobs.** The backend runs with `--reload`, so saving
  any file under `backend/` restarts it, and queued/active jobs are lost — request payloads
  aren't persisted, so they cannot be resumed. Don't edit backend files mid-run. The tool
  survives this (the shot is logged as failed and the batch continues), but the shot is
  wasted. Re-run the stage to pick it up.
- **ComfyUI caches identical workflows.** A re-submitted shot with an unchanged prompt and
  seed returns instantly. Change the prompt or the seed to force a real re-render.
- **Jobs are strictly serial.** The backend runs one job at a time, so anything you submit
  from the canvas while a batch runs queues behind it (and vice versa).
- **Generated audio arrives at wildly inconsistent levels.** In this production the crow
  bed peaked at 0.0 dBFS while a wind bed sat at -39 dB — a 39 dB spread. `mix` therefore
  loudnorms every track to an explicit LUFS target (`score_lufs`, `ambience_lufs`, or
  per-bed `lufs`) instead of applying fixed gains. Don't replace that with `volume=`.
- **Stable Audio goes near-silent if you ask for quiet.** Prompts containing "very soft",
  or long durations, returned beds at -45 to -55 dB mean. Describe *present, clearly
  recorded* sound ("strong gusting wind ... clearly audible close-miked field recording")
  and keep beds under ~20s. Stable Audio Open caps out near 47.6s regardless.
- **`aresample=48000` in the mix is deliberate.** `loudnorm` runs at a high internal rate
  and otherwise leaves the AAC output at 96kHz.
