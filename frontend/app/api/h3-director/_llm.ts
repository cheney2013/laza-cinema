/**
 * Shared LLM plumbing for the director console's two narrow endpoints.
 *
 * Neither endpoint is allowed to write a prompt. `field` returns one field's
 * value; `draft` returns a spec. The compiler owns the prompt, always.
 */

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MODEL = 'moonshotai/kimi-k3';

export interface LlmRequest {
  system: string;
  user: string;
  customApiKey?: string;
  customBaseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask the endpoint for a JSON object rather than prose. */
  json?: boolean;
  /**
   * A single field comes back in seconds; a whole draft spec is thousands of
   * tokens of JSON and routinely runs past a minute, so the two cannot share one
   * deadline.
   */
  timeoutMs?: number;
}

export class LlmError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

/**
 * Statuses worth trying again: the provider is throttling us or momentarily
 * unavailable, and the same request a second later usually goes through. Anything
 * else — a bad key, a bad model name, a malformed body — fails the same way twice.
 */
const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `Retry-After` in seconds or as a date; falls back to exponential with jitter. */
function backoffMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15000);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.min(Math.max(0, at - Date.now()), 15000);
  }
  // Jittered, so two consumers throttled at the same moment do not come back in step.
  return Math.round((1200 * 2 ** attempt) * (0.75 + Math.random() * 0.5));
}

export async function callLlm(req: LlmRequest): Promise<string> {
  const apiKey = req.customApiKey?.trim() || process.env.NV_API_KEY?.trim();
  if (!apiKey) {
    throw new LlmError('未检测到 API Key，请在 .env.local 配置 NV_API_KEY 或在设置里填入', 400);
  }

  const baseUrl = req.customBaseUrl?.trim() || DEFAULT_BASE_URL;

  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: req.model || DEFAULT_MODEL,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          temperature: req.temperature ?? 0.3,
          max_tokens: req.maxTokens ?? 900,
          ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(req.timeoutMs ?? 60000),
      });
    } catch (err) {
      const e = err as Error;
      const timedOut = e.name === 'TimeoutError' || /abort|timeout/i.test(e.message);
      const seconds = Math.round((req.timeoutMs ?? 60000) / 1000);
      throw new LlmError(timedOut ? `请求超时（${seconds}s），请检查网络后重试` : e.message, 504);
    }

    if (response.ok) {
      const data = await response.json();
      const content: string = data.choices?.[0]?.message?.content?.trim() || '';
      if (!content) throw new LlmError('LLM 返回内容为空，请重试', 502);
      return content;
    }

    // Throttled: wait out the window here rather than handing the director an
    // error they can only answer by clicking the same button again.
    if (RETRYABLE.has(response.status) && attempt < MAX_RETRIES) {
      await response.body?.cancel().catch(() => undefined);
      await sleep(backoffMs(response, attempt));
      continue;
    }

    const text = await response.text();
    let detail = response.statusText;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.detail || parsed.message || parsed.title || text;
    } catch {
      detail = text || detail;
    }
    if (response.status === 429) {
      throw new LlmError(
        `接口限流（429），已自动重试 ${MAX_RETRIES} 次仍未通过。等十几秒再试，或在设置里换成自己的 API Key。`,
        429,
      );
    }
    throw new LlmError(`LLM 接口失败 (${response.status}): ${detail}`, response.status);
  }
}

/** Strip the code fence a model adds even when told not to. */
export function stripFence(text: string): string {
  return text
    .replace(/^```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

/**
 * The laws each field has to obey, stated as instructions to the model.
 *
 * This is the whole reason a field-scoped call beats a whole-prompt rewrite: the
 * model is told one field's rule and cannot trade it away against another's.
 */
export const FIELD_RULES: Record<string, { label: string; rule: string }> = {
  world: {
    label: '世界块',
    rule: 'A leading style and world block for the whole batch: medium, film stock, colour palette, lighting character, era. It applies to every shot, so put nothing shot-specific in it. Never name a lens, a focal length, an aperture, or any depth-of-field term.',
  },
  summary: {
    label: 'summary',
    rule: 'One or two sentences on what happens in this batch only. No scene numbers, no recap of earlier scenes, no subject who is not active here. Do not restate the shot action in detail — that belongs in the shot body.',
  },
  firstFrameOccupancy: {
    label: '首帧占位',
    rule: 'State plainly who or what occupies frame one and where they are, so the shot cannot open on an empty room or a decorative establishing beat. If a subject must be present from the first moment, say exactly that.',
  },
  blocking: {
    label: '空间调度',
    rule: 'Give measurable positions, never vibes. Write the world direction first and the screen direction second, and write both — screen-only blocking inverts on a reverse angle. Use: screen-left / screen-right, foreground / midground / background, at hip height, within one metre, at the far end.',
  },
  sightLine: {
    label: '视线/构图',
    rule: 'Express the sight line as composition, not orientation: state what lies on one straight line across the frame, and say that the line is held. Never write "he faces the X" or "she turns toward the X" — that phrasing lands poorly. Name the eyes, the intervening object and the target as collinear.',
  },
  action: {
    label: '动作',
    rule: 'Causal, material motion. Weight transfers, contacts and reaction order are explicit; cloth, dust, hair and debris respond to force. Never write an impact as one event: write the impact halting, then write the other body carrying on under its own momentum.',
  },
  'layers.foreground': {
    label: '前景',
    rule: 'The foreground layer: give it a job distinct from the other two layers and an appearance distinct from them. Depth on this model is bought with three visibly different layers, never with a depth-of-field clause.',
  },
  'layers.midground': {
    label: '中景',
    rule: 'The midground layer, where the action usually lives. Give it a job and an appearance distinct from the foreground and background.',
  },
  'layers.background': {
    label: '后景',
    rule: 'The background layer: usually the flattest and least detailed, so it does not compete. Distinct in job and appearance from the other two. No optics terms.',
  },
  'lighting.description': {
    label: '光照',
    rule: 'Name the light sources and the direction they throw from. There must be exactly one stated light-source count for the shot and the description must agree with it — do not introduce a second source in passing.',
  },
  diegetic: {
    label: '现场声',
    rule: 'Sound with a visible cause in this shot, with an attack: a sound event needs a moment it starts. No dialogue here, no music, no mood adjectives.',
  },
  'dialogue.delivery': {
    label: '对白语气',
    rule: 'How the line is said, and nothing else — it completes the verb "says", as in "in a low, tight voice with a clipped pace". Voice timbre, pitch, tone, pace, accent, and "in an off-screen voiceover" for a voiceover. It never contains the spoken words themselves, which stay verbatim inside <d>, and never describes what the body does.',
  },
  'camera.subject': {
    label: '运镜主体',
    rule: 'The one thing the camera move is on, named in a few words. Not a sentence, not the move itself, not the framing.',
  },
  'camera.from': {
    label: '运镜起点',
    rule: 'The framing the move starts on, in a few words: how wide, on what. No move verbs, no lens terms.',
  },
  'camera.to': {
    label: '运镜终点',
    rule: 'The framing the move ends on, in a few words: how wide, on what. No move verbs, no lens terms.',
  },
  'subject.definition': {
    label: '主体定义',
    rule: 'One line completing "<Subject N> ". Minimum critical anchors only: age or role, current state, unique visible identifiers, action-critical body parts or props. The reference image is the source of truth for face, body, costume and texture — do not overwrite it with prose. Write {ref} where the reference picture should be cited. Everything asserted here applies to every shot in the batch.',
  },
  'subject.retentionNote': {
    label: '保留说明',
    rule: 'A short clause explaining the retention marker: what is carried through and what is not. This is an instruction, not a report — if a face must stay hidden, say nothing is legible, because demanding fidelity here defeats every occlusion instruction in the body.',
  },
  'sound.soundscape': {
    label: '整体声景',
    rule: 'One to four sentences on ambience, room tone, weather and the physical foley across the whole video. No dialogue, no music.',
  },
  'sound.music': {
    label: '非叙事音乐',
    rule: 'One to three sentences on audience-only score: instrumentation, tempo, dynamic changes. Concrete, not mood adjectives. Answer exactly "N/A" if there should be none.',
  },
};

export const FIELD_SYSTEM_PROMPT = `You write ONE field of a MiniMax H3 shot specification. You are not writing a prompt.

Hard rules:
- Output ONLY the field's value. No label, no field name, no quotes, no markdown, no commentary, no code fence.
- Write clear cinematic English. Simple direct words. Concrete physical instructions, visible actions, measurable positions, observable outcomes — never abstract or poetic language.
- Never name a lens, focal length, aperture, bokeh, or any depth-of-field term. They do nothing on this model except degrade the frame.
- Never state anything as a prohibition ("no X", "without X", "avoid X"). A named thing is rendered whether or not the sentence negates it. State what IS there instead.
- Never describe camera movement. The camera is set by a token elsewhere; a second camera statement here either gets ignored or fights it.
- Do not restate anything the surrounding context already asserts. One attribute is asserted exactly once in the whole specification.
- Refer to subjects and assets exactly as the context labels them (<Subject 1>, <Picture 2>, <Video 1>). Never invent a label that is not in the context.`;
