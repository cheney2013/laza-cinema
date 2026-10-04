# Working rules for AI agents

These rules apply to any agent working in this repository (Claude Code, Codex, and so on). `AGENTS.md`
covers multi-agent coordination; this file covers how the project is built and how films are made with it.

## Repository scope: platform code only

Content creation does not go into git. It is kept in the content database.

- **Content** = anything made for a particular film: prompts, storyboards and shot lists, previs scene/shot scripts, set-building scripts, scene configs (`--scene` JSON), character/plate notes, film-specific one-off tools, prompt-writing references. Record it with `python tools/content_archive.py` after every change (full text and version history in `backend/workspaces/content_archive.db`); bring a file back with `--restore <path>`.
- **Generated media** (renders, extracted frames, trimmed clips, normalised audio, built `.blend` sets, backups) goes into neither git nor the database. If the file is still on disk, use it as is; do not regenerate it. Only when it is gone and something needs it, regenerate it from the recorded content.
- **Temporary test, benchmark and probe scripts** go into neither. Name them `tools/scratch_*`, `tmp_*`, `benchmark_*`, `eval_*` or `watch_*` (or put them at the repository root) so `.gitignore` already covers them. Real regression tests (`backend/test_*.py`, `tools/test_*.py`, `frontend/lib/*.test.ts`) stay in git.
- The boundary lives in `.gitignore` (the `# >>> content` and `# >>> generated media` blocks). A new content path that shows up as untracked is added to the content block, never committed. Before every commit, check `git status` for content that slipped through.
- Platform code must not import or hard-code a film's data (sets, cameras, character names, prompt paths). Take it as input: a config file, an argument, a canvas node. `backend/previs/plate_coverage.py` takes `--scene` this way.

## Required skills and reference: install these first

Two things are needed before writing any video prompt. **The skill does not ship in this repository**; install it into your agent's skills folder yourself. The H3 skill is official: `npx skills add https://github.com/MiniMax-AI/MiniMax-H3 --skill h3-prompt-writing` (source: https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills/h3-prompt-writing). the Enhanced specification is by WarmBloodAban, published with the Singularity weights (https://huggingface.co/WarmBloodAban/Minimax-h3_Singularity/tree/main, Apache-2.0 on the model page), with a copy in this repository; it is not an official MiniMax document.

| What | Where it goes | Used for |
|---|---|---|
| `h3-prompt-writing` skill (`SKILL.md`, `references/base-en.txt`, `references/ref-en.txt`) | `~/.claude/skills/h3-prompt-writing/` (or `<project>/.claude/skills/`) | the MiniMax H3 prompt format: field names, section order, labels, timing notation |
| the Enhanced specification | `docs/MiniMax_H3_Singularity_Prompt_Writing_Specification_Enhanced_EN.md` (in this repository) | the writing rules: reference roles, action chains, camera, lighting, acting, failure modes, and the final checklist |

- Check that a skill is installed by listing the folder (`ls ~/.claude/skills`). An agent that cannot load skills can read the `SKILL.md` files and the files under `references/` directly.
- The specification is content: if it is missing from `docs/`, run `python tools/content_archive.py --restore docs/MiniMax_H3_Singularity_Prompt_Writing_Specification_Enhanced_EN.md`.
- Without the skill the rules below cannot be followed, so stop and ask the owner for them rather than improvising a format.

## Plates: decide before rendering, then fix in place

A plate is generated once and read by every shot in that space, so a bad one costs many times over. The larger cost is converging on one by re-rendering: nearly every round fixes exactly one thing that could have been decided up front.

**Before the first render of a plate, write down all four.** A plate prompt that leaves any of them to chance will be re-rendered:

1. **Camera**: computed, not guessed. Cast rays from the shot cameras the plate serves and take the candidate with the highest coverage (`backend/previs/plate_coverage.py`, with a `--scene` config). Add `landmarks` for anything the plate must contain (the spot an actor starts from, the prop that gets picked up), or the winner will cover most of the room and miss it. The plate camera is not the shot camera; a good-looking framing is a storyboard still, not a plate.
2. **Light state**: every fitting in frame, named, on or off, and where its light falls and stops.
3. **Object state**: every door and window in frame: shut, ajar or wide open, and which way. Swing direction is not visible in a still, so write the occlusion instead, or build the state into the grey model.
4. **Colour**: the named colour of every piece of furniture the plate shows, taken from the project's look bible, not from whatever an adjacent plate happened to render.

**One appearance authority per plate.** Two photographic boards will overpower the grey anchor and the framing drifts to theirs; one board plus text holds.

**Fix a finished plate in place rather than re-rendering it.** H3 gives the photographic look and the night grade; Qwen-Image 2.1 (the `qwenImage` node) holds structure and edits one thing without disturbing the rest. So H3 renders the plate, and a colour, a lamp that should be off, a door state or an unwanted object is corrected by editing that frame with Qwen, in about a minute. Write the edit the way the official template does: name everything that must stay, then the one thing that changes, and put the defect in the negative prompt.

## H3 prompt writing: required reading

**Before writing or editing any MiniMax H3 prompt, do both of the following, before the first draft:**

1. Invoke the skill `h3-prompt-writing`.
2. Use Read to read **all of** `docs/MiniMax_H3_Singularity_Prompt_Writing_Specification_Enhanced_EN.md`.

These are two separate steps. Neither replaces the other: the skill's `references/ref-en.txt` gives the format, and the specification gives the writing rules.

- This applies to every H3 prompt: new prompts, rewrites, changing a single sentence, and prompts a subagent writes for you (tell the subagent to read the specification too).
- Having read it in an earlier session does not count. If this session has no read of the file, you have not read it.
- Check the finished prompt against the specification's final checklist line by line before linting (`python tools/check_h3_prompt.py`), syncing to the canvas, or rendering.

## The canvas is the record

Review of a film happens through the canvas and nowhere else. A canvas that does not match what was rendered is a failed project, however good the renders are.

- **Every change to a project goes through the `ai-cinema-canvas` MCP** (see the README for connecting it): prompts through `prompt_file`, reference wiring as edges (insertion order is `<Picture N>`), renders through `run_canvas_node` then `refresh_canvas_node`.
- **No production render is submitted to ComfyUI directly.** The backend builds the same graph, so nothing is gained by bypassing it and the canvas is lost.
- A clip that was rendered elsewhere is brought in with `adopt_render`, which reads the ComfyUI graph embedded in the mp4 and writes prompt, steps, seed, length, reference order and latent onto the node. Never hand-type those fields.
- Read with `get_canvas(summary=True)` first (one line per node); `node_ids=[...]` for one node in full. Without either, the full canvas is written to a temp directory and only its path comes back; grep or read the files there instead of pulling 100 KB inline.
- **The save lock.** Every MCP write takes the project lock for its own duration. For a longer stretch of edits call `lock_project` first and `unlock_project` after; locks expire on their own. A 409 on a canvas write means: read the live canvas and re-apply only your node's fields.
- After adding nodes, run `arrange_canvas`. Wire every plate generator to the frame extracted from it, or the layout files it as a segment; that is the rule catching a missing provenance edge, not a bug.
- If the MCP cannot express what the work needs, **extend `backend/canvas_mcp_server.py` first**, then do the work through it. Editing files under `backend/` does not reach a running backend: restart uvicorn (`.\restart-backend.ps1`), and restart the MCP server (`.\restart-mcp.ps1`), then confirm with `/openapi.json` before relying on the change. A restart does not interrupt running jobs.
- A node's `prompt` is the next thing to run; `compiledPrompt` and `takes[0]` are what produced the clip on display. The label says which file the clip is and whether it has been accepted. Keep those honest: a stale label is the same failure as a stale prompt.
- **A regenerated clip retires its post-edit chain.** When a segment is re-rendered and the new take no longer needs the fixes layered on the old one (edit windows, reshoots, bridges, audio overlays), remove those edit nodes, their source-clip nodes and any reference that fed only them, in the same pass that relabels the new take. Rewire downstream motion context to the segment itself, then `arrange_canvas`.
- Set-building scripts are the source of a set's `.blend` file. After changing a script, rebuild the `.blend` in the same commit; a script newer than its `.blend` is the same failure as a stale canvas.

## Canvas prompts bound to a file: edit in place, never unbind

`replace_in_node_text` and `update_node` on a node with `data.promptFile` also write the file on the canvas server and record it in the content archive (`prompt_files_written` in the result). If the file was edited behind the node's back, `run_canvas_node` refuses; rerun with `prompt_source="node"` (the node's text wins and is written to the file) or `"file"`. Check a finished render with `get_frames(node_id, seconds=[...])`: one frame after each cut, or at the beat that changed, before reporting it.

## Long runs: finish line, task file, evidence

- **One film, one task file.** Each film keeps a checklist next to its prompts (for example `backend/previs/<film>/TASKS.md`; content, so archived, not committed). It opens with **what waits on the owner's review**, then in-progress, backlog, done, and the stopping rule. Update it in the same step as the canvas label, after every render, acceptance or relabel, so a new session resumes from it instead of re-reading the whole canvas. The canvas stays the record; the file is the index.
- **Name the finish line before a long run.** State what "done" is (for example "C15b to C16b rendered, self-checked against the specification, labels honest, waiting on review"), then keep going through every step that needs no input. Stop only for the owner's review, anything irreversible, or a version that fixed nothing the previous one did not.
- **End-of-run summary: what waits on the owner first**, then what changed with node ids. Mark anything not confirmed and say where you looked (for example "cut point measured with `check_panels`" versus "judged from three frames").
- **Subagent evidence is checked, not trusted.** When a subagent reports that a prompt lints, a render matches or a cut lands, open the node, frame or output it cites before relaying it. Fan-out suits audits, not writing prompts that depend on each other.
- **Claims carry evidence.** "Fixed" states what was verified: the command run, the output seen, the line changed. Without verification, say "ready for review", never "done".
- **No unattended irreversible actions**: no deleting files, no touching authentication or keys, no force push.
