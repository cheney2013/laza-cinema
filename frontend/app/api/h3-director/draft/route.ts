import { NextRequest, NextResponse } from 'next/server';

import { callLlm, LlmError, stripFence } from '../_llm';

/**
 * Scene sketch → draft shot specification.
 *
 * The one call that fills more than a field, and it is allowed to because what it
 * returns is a spec, not a prompt: every value lands in a typed slot the director
 * can see and change, and the compiler still owns the prompt. The response is
 * validated by `lib/h3/draft.ts` on the client, against the live wiring.
 */

const DRAFT_SYSTEM_PROMPT = `You are a film director breaking a scene down into a MiniMax H3 shot specification.

You output JSON only. No prose, no markdown, no code fence, no commentary. The JSON must have exactly this shape:

{
  "taskType": "[reference generation]",
  "summary": "one or two sentences on what happens in THIS batch",
  "world": "leading style and world block for the whole batch: medium, film stock, colour palette, lighting character",
  "subjects": [
    {
      "kind": "person" | "environment" | "prop" | "motion" | "effect",
      "picture": 1,
      "definition": "is the ... in <Picture 1>, ...",
      "retention": "fully_preserved" | "partially_preserved" | "attribute_transfer" | "weak_reference",
      "retentionNote": "what carries through and what does not",
      "appearsIn": [1, 2]
    }
  ],
  "shots": [
    {
      "frames": 124,
      "firstFrameOccupancy": "who occupies frame one and where (first shot only)",
      "blocking": "measurable positions, world direction first then screen direction",
      "sightLine": "what lies on one straight line across the frame, and that the line is held",
      "camera": {
        "token": "one of the closed set below",
        "amplitude": "small" | "large",
        "speed": "slow" | "fast",
        "subject": "what the move is on",
        "from": "start framing",
        "to": "end framing"
      },
      "layers": { "foreground": "...", "midground": "...", "background": "..." },
      "action": "causal, material motion",
      "lighting": { "sourceCount": 1, "description": "sources and the direction they throw from" },
      "diegetic": "sound with a visible cause in this shot",
      "dialogue": [{ "subject": 1, "delivery": "in a low, tight voice with a clipped pace", "lang": "Chinese", "line": "..." }]
    }
  ],
  "sound": { "soundscape": "ambience across the whole video", "music": "score, or N/A" }
}

CAMERA TOKENS — this is a closed set. Anything else is discarded:
Zoom In, Zoom Out, Push In, Pull Out, Pan Left, Pan Right, Truck Left, Truck Right, Tilt Up, Tilt Down, Pedestal Up, Pedestal Down, Arc Shot, Tracking Shot, Static Shot, Shake Slightly, Shake Strongly, POV, Roll Clockwise, Roll Counterclockwise.
One dominant move per shot.

LAWS — these are measured behaviours of this model, not style preferences:
1. Reference labels are <Picture N>, <Video N>, <Audio N>, <Subject N>. Use ONLY numbers that exist in the wiring given below. Never invent one.
2. An image that only defines a subject is cited INSIDE that subject's definition, never given a standalone entry.
3. Say what IS there. Never write "no X", "without X", "avoid X" — a named thing is rendered whether or not the sentence negates it.
4. Never name a lens, focal length, aperture, bokeh or depth of field. Depth comes from three visibly distinct layers, nothing else.
5. Express orientation as composition — things lying on one line across the frame — never as "he faces the X".
6. An impact is two events: the impact halts, then the other body carries on under its own momentum. Never one clause.
7. State the first shot's frame-one occupancy explicitly, or the video opens on an empty establishing beat.
8. Assert any one attribute exactly once across the whole specification.
9. Exactly one light-source count per shot, and the description must agree with it.
10. Everything is written in clear cinematic English with simple direct words, except dialogue lines, which stay in their spoken language.
11. A dialogue line's "delivery" carries everything about HOW it is said — voice timbre, pitch, tone, pace, accent — and completes the verb "says". Write it in English on every line, and above all on a speaker's first line: that is where the voice is fixed for the whole batch, and left empty the timbre drifts between shots. Use "in an off-screen voiceover" for a voiceover. "line" holds only the spoken words, verbatim, punctuation included.`;

export async function POST(req: NextRequest) {
  try {
    const {
      sketch = '',
      mode = 'ref2va',
      images = 0,
      videos = 0,
      audios = 0,
      totalFrames = 124,
      fps = 24,
      shotCount = 0,
      customApiKey,
      customBaseUrl,
      model,
    } = await req.json();

    if (!String(sketch).trim()) {
      return NextResponse.json({ error: '没有场景速写，无从起草' }, { status: 400 });
    }

    const labels = [
      images > 0
        ? `${images} reference image(s): ${Array.from({ length: images }, (_, i) => `<Picture ${i + 1}>`).join(', ')}`
        : 'NO reference images — never write <Picture N>',
      videos > 0
        ? `${videos} reference video(s): ${Array.from({ length: videos }, (_, i) => `<Video ${i + 1}>`).join(', ')}`
        : 'NO reference videos — never write <Video N>',
      audios > 0
        ? `${audios} reference audio(s): ${Array.from({ length: audios }, (_, i) => `<Audio ${i + 1}>`).join(', ')}`
        : 'NO reference audios — never write <Audio N>',
    ];

    const totalReferences = Number(images) + Number(videos) + Number(audios);
    const seconds = (Number(totalFrames) / (Number(fps) || 24)).toFixed(2);

    const user = [
      `SCENE SKETCH (may be Chinese — the specification itself must be English):\n${sketch}`,
      `MODE: ${mode}`,
      `WIRING — the only labels that exist:\n${labels.map((l) => `- ${l}`).join('\n')}`,
      totalReferences > 3
        ? `WARNING: ${totalReferences} references are wired. Beyond three, this model renders the wrong reference for a subject. Keep the design to the three that matter and say so in "summary".`
        : '',
      `BATCH LENGTH: ${totalFrames} frames at ${fps} fps (${seconds} seconds). Shot "frames" values must add up to ${totalFrames}.`,
      shotCount > 0
        ? `Use exactly ${shotCount} shots.`
        : 'Use as few shots as the scene needs; a cut is only worth it when the framing genuinely has to change.',
      'Return the JSON object and nothing else.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const raw = await callLlm({
      system: DRAFT_SYSTEM_PROMPT,
      user,
      customApiKey,
      customBaseUrl,
      model,
      temperature: 0.5,
      maxTokens: 3000,
      json: true,
      timeoutMs: 180000,
    });

    const text = stripFence(raw);
    let draft: unknown;
    try {
      draft = JSON.parse(text);
    } catch {
      // Do not "best effort" this. A half-parsed draft becomes a spec that looks
      // structured and is not, and the console would then present it as authored.
      return NextResponse.json(
        { error: '模型没有返回可解析的 JSON，草稿已丢弃。请重试。', raw: text.slice(0, 2000) },
        { status: 502 },
      );
    }

    return NextResponse.json({ draft });
  } catch (error) {
    if (error instanceof LlmError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const e = error as Error;
    console.error('h3-director/draft error:', e);
    return NextResponse.json({ error: e.message || '草稿生成失败' }, { status: 500 });
  }
}
