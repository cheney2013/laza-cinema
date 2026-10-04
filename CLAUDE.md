# Repository scope: platform code only

Content creation does not go into git. It is kept in the content database.

- **Content** = anything made for a particular film: prompts, storyboards and shot lists, previs scene/shot scripts, set-building scripts, scene configs (`--scene` JSON), character/plate notes, film-specific one-off tools, prompt-writing references. Record it with `python tools/content_archive.py` after every change (full text + version history in `backend/workspaces/content_archive.db`); bring a file back with `--restore <path>`.
- **Generated media** (renders, extracted frames, trimmed clips, normalised audio, built `.blend` sets, backups) goes into neither git nor the database. If the file is still on disk, use it as is -- do not regenerate it. Only when it is gone and something needs it, regenerate it from the recorded content.
- **Temporary test / benchmark / probe scripts** go into neither. Name them `tools/scratch_*`, `tmp_*`, `benchmark_*`, `eval_*` or `watch_*` (or put them at the repo root) so `.gitignore` already covers them. Real regression tests (`backend/test_*.py`, `tools/test_*.py`, `frontend/lib/*.test.ts`) stay in git.
- The boundary lives in `.gitignore` (`# >>> content` and `# >>> generated media` blocks). A new content path that shows up as untracked is added to the content block, never committed. Before every commit, check `git status` for content that slipped through.
- Platform code must not import or hard-code a film's data (sets, cameras, character names, prompt paths). Take it as input -- a config file, an argument, a canvas node -- the way `backend/previs/plate_coverage.py` takes `--scene`.

# Staging: required before any new scene is broken down

**Before writing the shot breakdown for a new scene or a new stretch of script, invoke the
`staging` skill and run its passes in order** -- causality, principle (zone vs man-on-man),
pattern (the line, A/I/L), blocking (anchors, obstacles, levels, distance), space (circle of
action, outside-looking-in vs inside-looking-out) -- and only then choose camera setups.

- This is about the shot breakdown, not the prompt wording: it decides what happens and where
  people stand, which is upstream of every H3 prompt for that scene.
- It applies to a new scene, a restructured one, and any beat whose staging is being redone.
  It does not apply to re-rendering a shot whose staging is already accepted.
- Run the **invention audit** on every element that is not in the source script, and say which
  ones are ours and what they buy.
- Yige compared a breakdown made without it against one made with it (TLOU scene 3, 2026-09-20)
  and the second was plainly better: the first had reused the dialogue sight axis for an action
  beat, packed two entrances into one camera, and left the camera outside the room at the exact
  moment the scene should have gone inside.

# Plates: decide before rendering, then fix in place

A plate is generated once and read by every shot in that space, so the cost of a
bad one is paid many times -- but the cost of *converging* on one is what actually
hurt. TLOU scenes 2-3 took 16 plate renders for four boards (2026-09-20), and
almost every round fixed exactly one thing that could have been decided up front.

**Before the first render of a plate, write down all four.** A plate prompt that
leaves any of them to chance will be re-rendered:

1. **Camera** -- computed, not guessed. Cast rays from the shot cameras the plate
   serves and take the candidate with the highest coverage
   (`tools/scratch_plate_coverage.py`, or `plate_coverage_house.py` for scene 1's
   rig). Add `landmarks` for anything the plate MUST contain -- the spot an actor
   starts from, the prop she picks up -- or the winner will cover 76% of the room
   and miss it. The plate camera is not the shot camera; a good-looking framing is
   a storyboard still, not a plate.
2. **Light state** -- every fitting in frame, named, on or off, and where its light
   falls and stops.
3. **Object state** -- every door and window in frame: shut, ajar, or wide open,
   and which way. Swing direction is not visible in a still, so write the
   occlusion instead (see the door memory) or build the state into the grey model.
4. **Colour** -- the named colour of every piece of furniture the plate shows, from
   the house's look bible, not from whatever an adjacent plate happened to render.

**One appearance authority per plate.** Two photographic boards will overpower the
grey anchor and the framing will drift to theirs; one board plus text holds.

**Fix a finished plate in place rather than re-rendering it.** H3 gives the
photographic look and the night grade; Qwen-Image-2.1 (the `qwenImage` node) holds
structure and edits one thing without disturbing the rest. So: H3 renders the
plate, and a colour, a lamp that should be off, a door state or an unwanted object
is corrected by editing that frame with Qwen, in about a minute. Write the edit
the way the official template does -- name everything that must stay, then the one
thing that changes -- and put the defect in the negative prompt. Re-rendering
re-rolls the whole frame and usually breaks something that was already right.

# H3 prompt writing: required reading

**Before writing or editing any MiniMax H3 prompt, do both of the following, before the first draft:**

1. Invoke the skill `h3-prompt-writing`.
2. Use Read to read **all of** `docs/MiniMax_H3_Singularity_Prompt_Writing_Specification_Enhanced_EN.md`.
   It is content, not in git: if it is missing, `python tools/content_archive.py --restore docs/MiniMax_H3_Singularity_Prompt_Writing_Specification_Enhanced_EN.md`.

These are two separate steps. Neither replaces the other: the skill's `references/ref-en.txt` gives the format, and the specification gives the writing rules (reference roles §4, action chains §8, camera §9, lighting §11, acting §13, failure modes §16).

- This applies to every H3 prompt: new prompts, rewrites, changing a single sentence, and prompts a subagent writes for you (tell the subagent to read the specification too).
- Having read it in an earlier session does not count. If this session has no Read of the file, you have not read it.
- Check the finished prompt against the §17 checklist line by line before linting, syncing to the canvas, or rendering.

# Long runs: finish line, task file, evidence

Adopted 2026-09-23 from the Opus 5.5 guidance, mapped onto how the TLOU film is made.

- **One film, one task file.** Each film keeps a checklist next to its prompts
  (`backend/previs/tlou/TASKS.md` for TLOU; content, so archived, not committed). It
  opens with **需要义哥** (what waits on his review), then in-progress, backlog, done,
  and the stopping rule. Update it in the same step as the canvas label -- after every
  render, acceptance or relabel -- so a compacted or new session resumes from it
  instead of re-reading the whole canvas. The canvas stays the record; the file is
  the index.
- **Name the finish line before a long run.** State what "done" is (e.g. "C15b→C16b
  rendered, self-checked against the spec, labels honest, waiting on Yige"), then keep
  going through every step that needs no input. Stop only for his review, anything
  irreversible, or a version that fixed nothing the previous one did not.
- **End-of-run summary: 需要义哥 first**, then what changed with node ids. Mark
  anything not confirmed and say where you looked (e.g. "cut point measured with
  check_panels" vs "judged from 3 frames").
- **Subagent evidence is checked, not trusted.** When a subagent reports a prompt
  lints, a render matches, or a cut lands, open the node / frame / output it cites
  before relaying it. Fan-out suits audits (e.g. checking every chain of a scene
  for a conflicting global attribute), not writing prompts that depend on each other.

# Canvas prompts bound to a file: edit in place, never unbind

`replace_in_node_text` / `update_node` on a node with `data.promptFile` also writes the
file on the canvas server and records it in the content archive (`prompt_files_written`
in the result), so a cloud session edits exactly like a local one. If the file was
edited behind the node's back, `run_canvas_node` refuses; rerun with
`prompt_source="node"` (the node's text wins and is written to the file) or `"file"`.
Check a finished render with `get_frames(node_id, seconds=[...])` -- one frame after
each cut, or at the beat that changed -- before reporting it to Yige.
