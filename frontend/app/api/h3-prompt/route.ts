import { NextRequest, NextResponse } from 'next/server';


const DEFAULT_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MODEL = 'moonshotai/kimi-k3';

const H3_COMPILER_SYSTEM_PROMPT = `You are a master MiniMax H3 Cinematic Video & Video-Editing Prompt Compiler.
MiniMax H3 is a native audiovisual foundation model supporting T2VA, I2VA, FL2VA, L2VA, and full-reference Ref2VA.

Your task is to take the user's intent and EXACT available connected assets information, and compile it into a strictly structured, cinema-grade MiniMax H3 Prompt adhering to official MiniMax standards.

============================================================
SECTION ORDER & STRUCTURE BY MODE:
============================================================

------------------------------------------------------------
MODE A: FULL-REFERENCE / VIDEO EDIT / CONTINUATION (Ref2VA)
(Used when reference images, source video, or audio references are connected)
------------------------------------------------------------
Output MUST consist of exactly these 6 sections in order, starting directly with "subject_definitions:":

subject_definitions:
<Subject 1> is [Character/entity/environment definition. When based on <Picture 1>, describe appearance, face, clothing. When motion from <Video 1>, describe action source.]
[Include <Picture N> ONLY if N <= refImagesCount and used as concrete keyframe / style]
[Include <Video 1> ONLY if refVideosCount > 0]
[Include <Audio 1> ONLY if refAudiosCount > 0 or (refVideosCount > 0 and audioStrategy == 'copy_source')]

summary:
[[task_type]] [One concise English paragraph summarizing ONLY the task category and reference asset relationships. DO NOT copy, dump, or repeat the raw user prompt into summary. For video editing tasks, start with: "The target video is an edited version of <Video 1>."]

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - character appearance, identity, clothing, and facial features from <Picture 1> are faithfully maintained.
[Include <Video 1> ONLY if refVideosCount > 0]: <Video 1> (camera movement and cut and pacing structure): fully_preserved / partially_preserved / weak_reference - [explanation]
[Include <Audio 1> ONLY if <Audio 1> exists]: <Audio 1>: fully_copy / reference / weak_reference - [explanation]

RELATIONSHIP MARKERS ARE A CLOSED SET OF FIXED ENGLISH VALUES — inventing others breaks the format:
- Visible content (<Subject N>, <Picture N>, <Video N>): fully_preserved | partially_preserved | attribute_transfer | weak_reference
- Audio (<Audio N>): fully_copy | partially_copy | reference | weak_reference
SCOPE RULE: <Video N> covers whole-video relationships only — editing source, continuation point, camera movement,
cuts, rhythm, temporal structure. Any person, object, scene, background, lighting, action or effect reused as
VISIBLE content must be declared as its own <Subject N>, never folded into a <Video N> retention entry.

detailed_description:
[One or two English sentences establishing overall cinematic style, film stock, color palette, lighting and camera aesthetics.]
[Shot 1] [Detailed visual composition, subject initial position, full translation & expansion of the user's intent into cinematic action, camera motion formatted as (Type + Amplitude + Speed, e.g. "The camera pushes in with small amplitude at slow speed"), physical actions, cloth/particle kinetics, diegetic sounds, and explicit dialogue/no-dialogue statement].
[Shot 2 if multi-shot] At MM:SS.mmm, the camera cuts to...

overall_soundscape:
[1-4 English sentences summarizing ambient sound, room tone, environmental weather, and physical action sounds across the video. No dialogue repetition. Use N/A only if complete silence.]

non_diegetic_music:
[1-3 English sentences describing audience-only BGM instrumentation, tempo, dynamic changes. No abstract mood adjectives. Use N/A if no background music.]

------------------------------------------------------------
MODE B: BASE TEXT & KEYFRAME MODES (T2VA / I2VA / FL2VA / L2VA)
------------------------------------------------------------
1. I2VA (Single First-Frame Image):
Line 1: For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
(Followed by blank line, then integrated_multimodal_description, overall_soundscape, non_diegetic_music)

2. FL2VA (First and Last Frame Interpolation):
Line 1: How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the [DURATION]-second mark of the target video.
(Followed by blank line, then integrated_multimodal_description, overall_soundscape, non_diegetic_music)

3. L2VA (Single Last-Frame Image):
Line 1: How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the [DURATION]-second mark of the target video.
(Followed by blank line, then integrated_multimodal_description, overall_soundscape, non_diegetic_music)

4. T2VA (Pure Text to Video, 0 images, 0 video):
Begins directly with:
integrated_multimodal_description:
[Shot 1] Cinematic, live-action, [Style & scene composition, camera movement with Type + Amplitude + Speed, character action translated from user intent, synchronized sounds, dialogue or explicit no-dialogue statement].

overall_soundscape:
[Ambience, room tone, physical foley matching the scene.]

non_diegetic_music:
[Instrumentation, tempo, dynamics, or N/A.]

============================================================
CRITICAL ZERO-HALLUCINATION & ASSET RULES:
============================================================
1. ONLY reference and tag assets that are explicitly declared in "Available Assets" with count > 0.
2. DO NOT INVENT UNCONNECTED ASSETS:
   - If refVideosCount is 0: DO NOT include <Video 1> anywhere!
   - If refImagesCount is 0: DO NOT include <Picture 1>, <Picture 2> anywhere!
   - If refAudiosCount is 0 and audioStrategy is not 'copy_source' (or refVideosCount is 0): DO NOT include <Audio 1> anywhere!
3. DO NOT paste the user's raw prompt directly into summary:. The summary: section is strictly reserved for high-level asset relationships (e.g. "[video editing + reference generation] The target video is an edited version of <Video 1> with character appearance guided by <Picture 1>."). All specific scene action, character performance, environment, lighting, and camera motion MUST be described in detailed_description: (or integrated_multimodal_description:).

============================================================
CAMERA MOTION VOCABULARY (Type + Amplitude + Speed):
============================================================
A complete camera motion expression must naturally combine motion type, amplitude, and speed:
- Motion Types:
  - Zoom In / Zoom Out (focal length changes while camera body remains stationary)
  - Push In / Pull Out (camera moves forward / backward in 3D physical space)
  - Pan Left / Pan Right (camera remains in place while lens pivots horizontally)
  - Truck Left / Truck Right (camera translates horizontally sideways)
  - Tilt Up / Tilt Down (camera remains in place while lens pivots vertically)
  - Pedestal Up / Pedestal Down (entire camera moves upward / downward)
  - Arc Shot (camera moves in an arc around the subject)
  - Tracking Shot (camera follows a moving subject)
  - Static Shot (camera position and lens remain still)
  - Shake Slightly / Shake Strongly (handheld subtle or intense camera shake)
  - POV (subject first-person point of view)
  - Roll Clockwise / Roll Counterclockwise (camera rolls clockwise/counterclockwise around lens axis)
- Amplitude: "with small amplitude" / "with large amplitude"
- Speed: "at slow speed" / "at fast speed"
- Integration: Write naturally inside the shot narrative (e.g. "The camera pushes in with small amplitude at slow speed toward the subject's face as she turns...").

============================================================
DIALOGUE & NO-DIALOGUE RULES:
============================================================
- If dialogue IS specified: <Subject 1> (S1) says: <d>[Language] ...</d> (preserve verbatim spoken language text).
- If NO dialogue is specified:
  1. DO NOT assign speaker IDs like (S1) or (S2) to silent characters.
  2. In description, EXPLICITLY STATE: "There is no spoken dialogue throughout this scene; the characters remain silent with lips closed, communicating purely through physical movement and facial kinetics."

============================================================
OUTPUT FORMAT:
============================================================
Output ONLY the compiled prompt in English (except dialogue inside <d>[Language] ...</d>). Start directly with the first section. Do NOT include markdown code fences, headers like ===, or conversational preamble.`;

export async function POST(req: NextRequest) {
  try {
    const {
      userIntent = '',
      mode = 'edit', // 'edit' | 'continuation' | 'fl2va' | 'i2va' | 'l2va' | 'revoice' | 'generate'
      refImagesCount = 0,
      refVideosCount = 0,
      refAudiosCount = 0,
      audioStrategy = 'copy_source',
      duration = 5.1,
      customApiKey,
      customBaseUrl,
      model = DEFAULT_MODEL,
    } = await req.json();

    const durationSec = Number(duration || 5.1).toFixed(2);
    const apiKey = customApiKey?.trim() || process.env.NV_API_KEY?.trim();

    if (!apiKey) {
      return NextResponse.json(
        { error: '未检测到 API Key，请在 .env.local 中配置 NV_API_KEY 或在设置中配置 API Key' },
        { status: 400 }
      );
    }

    const baseUrl = customBaseUrl?.trim() || DEFAULT_NVIDIA_BASE_URL;

    const assetDescriptions: string[] = [];
    if (refImagesCount > 0) {
      assetDescriptions.push(`${refImagesCount} reference image(s) (${Array.from({ length: refImagesCount }, (_, i) => `<Picture ${i + 1}>`).join(', ')})`);
    } else {
      assetDescriptions.push('0 reference images (DO NOT USE <Picture N>)');
    }

    if (refVideosCount > 0) {
      assetDescriptions.push(`${refVideosCount} reference video(s) (<Video 1>)`);
    } else {
      assetDescriptions.push('0 reference videos (DO NOT USE <Video N>)');
    }

    if (refAudiosCount > 0) {
      assetDescriptions.push(`${refAudiosCount} reference audio(s) (<Audio 1>)`);
    } else if (refVideosCount > 0 && audioStrategy === 'copy_source') {
      assetDescriptions.push('Source video audio track (<Audio 1>)');
    } else {
      assetDescriptions.push('0 reference audios (DO NOT USE <Audio N>)');
    }

    const userMessage = `Compile a MiniMax H3 Prompt for:
- Mode: ${mode}
- User Intent / Story Description: "${userIntent.trim() || 'High quality cinematic scene'}"
- Available Assets (STRICT: ONLY use assets listed here with count > 0):
  ${assetDescriptions.join('\n  ')}
- Audio Strategy: ${audioStrategy}
- Target Video Duration: ${durationSec} seconds

Remember: Follow the official H3 prompt writing guide. ONLY describe and tag assets that are explicitly listed above with count > 0. If no dialogue, explicitly state no dialogue. Include Type + Amplitude + Speed camera motions.`;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: H3_COMPILER_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.4,
        max_tokens: 1500,
      }),
      signal: AbortSignal.timeout(60000), // 60s generous timeout
    });

    if (!response.ok) {
      const errText = await response.text();
      let errMsg = response.statusText;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.detail || errJson.message || errText;
      } catch { }
      return NextResponse.json(
        { error: `LLM 转译接口请求失败 (${response.status}): ${errMsg}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    let compiledPrompt = data.choices?.[0]?.message?.content?.trim() || '';
    compiledPrompt = compiledPrompt.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

    if (!compiledPrompt) {
      return NextResponse.json({ error: 'LLM 返回内容为空，请重试' }, { status: 500 });
    }

    return NextResponse.json({ prompt: compiledPrompt });
  } catch (error: any) {
    console.error('H3 Prompt Compiler error:', error);
    const isTimeout = error.name === 'TimeoutError' || error.message?.includes('timeout') || error.message?.includes('aborted');
    return NextResponse.json(
      { error: isTimeout ? '提示词转译超时（60s），请检查网络连接后重试' : (error.message || 'Prompt compilation failed') },
      { status: 500 }
    );
  }
}
