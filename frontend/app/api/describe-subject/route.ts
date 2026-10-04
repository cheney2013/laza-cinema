import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_VISION_MODEL = 'meta/llama-3.2-11b-vision-instruct';

// NVIDIA NIM rejects inline base64 payloads above ~180 KB. Callers are expected to
// downscale client-side (see lib/imageDownscale.ts); this is the backstop so an
// oversized image produces a clear message instead of an opaque upstream 400.
const MAX_INLINE_IMAGE_BYTES = 180_000;

type SubjectKind = 'person' | 'environment' | 'prop' | 'motion' | 'effect';

/**
 * 读图的提示词按主体类型切换。
 *
 * 原先只有一份"描述画面里的人"的提示词，不管主体是人物、环境还是道具都照发 ——
 * 拿它去读一张空场景图，模型只能凭空编一个人出来，写回定义栏的东西跟画面毫无关系。
 * 每种主体要看的东西本来就不同：人物看长相与衣着，环境看建筑材质与光，
 * 道具看形制与磨损，动作看身体在做什么，效果看那团东西的形态与颜色。
 */
const COMMON_RULES = `Reply with ONE English clause and nothing else. It is slotted directly after "<Subject 1> ", so it MUST begin with "is " and MUST NOT end with a period.

Rules:
- Be concrete and visual. "chunky, ribbed-knit beige/cream crewneck sweater" — not "a nice sweater".
- 40 words maximum.
- Never invent details you cannot see. Omit rather than guess.
- No preamble, no quotes, no markdown, no trailing period.`;

const KIND_PROMPTS: Record<SubjectKind, { system: string; ask: string }> = {
  person: {
    system: `You describe the person in a reference image so a video model can recast them into an existing shot.

${COMMON_RULES}

Cover, in this order, only what you can actually see:
- apparent gender and rough age band (e.g. "a girl", "a young man", "an older woman")
- hair: length, style, color
- wardrobe: garment type, cut, material/knit, and color for each visible piece
- any distinctive, stable visual feature (glasses, beard, prominent accessory)

Describe appearance only. Never mention the pose, action, background, camera, lighting, or image quality.

Example of a valid reply:
is a girl who is wearing a chunky, ribbed-knit beige/cream crewneck sweater and dark charcoal wide-leg pleated trousers`,
    ask: 'Describe the person in this reference image as one clause, following the rules exactly.',
  },
  environment: {
    system: `You describe the place in a reference image so a video model can stage a shot inside it.

${COMMON_RULES}

Cover, in this order, only what you can actually see:
- what kind of place it is (e.g. "a vaulted stone hall", "a rain-slick back alley")
- architecture and layout: structures, openings, depth cues
- materials and surface condition: stone, wood, metal, wear, moisture, dust
- palette and the quality of light already in the place (source, direction, warmth)

Describe the place only. Never mention people, camera moves, shot size, or image quality.

Example of a valid reply:
is a vaulted grey-stone hall with tall arched windows down one side, damp flagstones, and cold blue daylight raking in from the left`,
    ask: 'Describe the place in this reference image as one clause, following the rules exactly.',
  },
  prop: {
    system: `You describe the object in a reference image so a video model can place it in a shot.

${COMMON_RULES}

Cover, in this order, only what you can actually see:
- what the object is, and its rough scale relative to a hand or a body
- form and construction: shape, parts, fittings
- material, finish and colour
- condition: wear, patina, damage, dirt

Describe the object only. Never mention people holding it, the background, the camera, or image quality.

Example of a valid reply:
is a hand-length brass pocket compass with a hinged scratched lid, a cracked glass face and a worn leather lanyard`,
    ask: 'Describe the main object in this reference image as one clause, following the rules exactly.',
  },
  motion: {
    system: `You describe the action a body is performing in a reference image so a video model can reproduce that motion.

${COMMON_RULES}

Cover, in this order, only what you can actually see:
- what the body is doing, as a verb phrase
- the posture: weight, stance, spine, head direction
- what the limbs are doing, each in turn
- the direction of travel or effort, if it is readable

Describe the motion only. Never describe who the person is, what they wear, the setting, or the camera.

Example of a valid reply:
is turning sharply over the left shoulder mid-stride, weight dropped onto the front foot, right arm swinging across the chest and chin leading the turn`,
    ask: 'Describe the action being performed in this reference image as one clause, following the rules exactly.',
  },
  effect: {
    system: `You describe the visual effect in a reference image so a video model can reproduce it.

${COMMON_RULES}

Cover, in this order, only what you can actually see:
- what the phenomenon is (smoke, embers, spray, glow, refraction, debris)
- its form and density: volume, direction, how it breaks up
- its colour, brightness and how it interacts with what is behind it
- its scale relative to the frame

Describe the effect only. Never describe people, the setting, the camera, or image quality.

Example of a valid reply:
is a low sheet of pale grey smoke drifting left to right at knee height, thinning into wisps at the edges and glowing faintly amber where light passes through it`,
    ask: 'Describe the visual effect in this reference image as one clause, following the rules exactly.',
  },
};

function promptsFor(kind: unknown): { system: string; ask: string } {
  return KIND_PROMPTS[(kind as SubjectKind)] ?? KIND_PROMPTS.person;
}

function normalizeClause(raw: string): string {
  let text = raw.trim();
  // Vision models like to wrap the answer in quotes or a code fence.
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
  text = text.replace(/^["'“”]+/, '').replace(/["'“”]+$/, '').trim();
  // Drop a leading "<Subject 1>" if the model echoed the slot back.
  text = text.replace(/^<Subject\s*\d+>\s*/i, '').trim();
  // The clause is slotted after "<Subject 1> ", so it has to start with "is".
  if (text && !/^is\b/i.test(text)) {
    text = `is ${text.replace(/^(a|an|the)\b\s*/i, (m) => m)}`;
  }
  // The template supplies " in <Picture 1>." right after the clause.
  text = text.replace(/[.\s]+$/, '');
  return text;
}

export async function POST(req: NextRequest) {
  try {
    const {
      imageDataUrl,
      kind,
      customApiKey,
      customBaseUrl,
      model = DEFAULT_VISION_MODEL,
    } = await req.json();
    const { system, ask } = promptsFor(kind);

    if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
      return NextResponse.json(
        { error: '需要一个 data:image/... 格式的图片，请先在前端缩放转码' },
        { status: 400 }
      );
    }

    const base64Part = imageDataUrl.slice(imageDataUrl.indexOf(',') + 1);
    if (base64Part.length > MAX_INLINE_IMAGE_BYTES) {
      return NextResponse.json(
        { error: `参考图过大（${Math.round(base64Part.length / 1024)}KB），NVIDIA NIM 内联上限约 176KB，请降低缩放尺寸或画质` },
        { status: 400 }
      );
    }

    const apiKey = customApiKey?.trim() || process.env.NV_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json(
        { error: '未检测到 API Key，请在 .env.local 中配置 NV_API_KEY 或在设置中配置 API Key' },
        { status: 400 }
      );
    }

    const baseUrl = customBaseUrl?.trim() || DEFAULT_NVIDIA_BASE_URL;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: ask,
              },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        temperature: 0.2,
        max_tokens: 160,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const errText = await response.text();
      let errMsg = response.statusText;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.detail || errJson.message || errText;
      } catch {}
      return NextResponse.json(
        { error: `角色特征识别失败 (${response.status}): ${errMsg}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    const description = normalizeClause(data.choices?.[0]?.message?.content || '');

    if (!description) {
      return NextResponse.json({ error: '角色特征识别返回内容为空，请重试' }, { status: 500 });
    }

    return NextResponse.json({ description });
  } catch (error: any) {
    console.error('Describe subject error:', error);
    const isTimeout =
      error.name === 'TimeoutError' ||
      error.message?.includes('timeout') ||
      error.message?.includes('aborted');
    return NextResponse.json(
      {
        error: isTimeout
          ? '角色特征识别超时（60s），请检查网络连接后重试'
          : error.message || 'Subject description failed',
      },
      { status: 500 }
    );
  }
}
