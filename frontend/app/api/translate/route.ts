import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_LLM_MODEL, LLM_NOT_CONFIGURED, resolveLlmApiKey, resolveLlmBaseUrl } from '../_llm-config';

const DEFAULT_MODEL = DEFAULT_LLM_MODEL;

export async function POST(req: NextRequest) {
  try {
    const {
      text,
      customApiKey,
      customBaseUrl,
      model = DEFAULT_MODEL,
      targetLang = 'auto',
      mode = 'translate', // 'translate' | 'optimize'
    } = await req.json();

    if (!text || !text.trim()) {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }

    const apiKey = resolveLlmApiKey(customApiKey);

    // ── Optimize mode: intelligent, scope-respecting prompt enhancement ──────
    if (mode === 'optimize') {
      if (!apiKey) {
        return NextResponse.json({ error: '需要配置 API Key 才能使用提示词优化功能' }, { status: 400 });
      }
      const baseUrl = resolveLlmBaseUrl(customBaseUrl);
      if (!baseUrl) return NextResponse.json({ error: LLM_NOT_CONFIGURED }, { status: 400 });
      const optimizeSystem = `You are an expert AI prompt optimization engineer for modern image and video generation models (FLUX.2, MiniMax H3, Midjourney, SDXL).
Your task is to refine and elevate the user's prompt by adding precise visual attributes (materials, lighting, composition, textures) WHILE STRICTLY RESPECTING THE USER'S INTENDED SUBJECT AND SCOPE.

CRITICAL RULES:
1. STRICT SUBJECT & INTENT FIDELITY (DO NOT INVENT UNREQUESTED CHARACTERS/SCENES):
   - If the user inputs a standalone OBJECT, GARMENT, PROP, or PRODUCT (e.g. "比基尼" / bikini, "跑车" / sports car, "武士刀" / katana, "球鞋" / sneakers):
     Focus EXCLUSIVELY on that object itself (e.g., commercial/product photography, exquisite material/fabric textures, clean studio lighting, elegant composition).
     NEVER invent human models, persons, bodies, beaches, or complex narrative scenes unless the user explicitly requested them!
   - If the user inputs a PERSON/CHARACTER (e.g. "穿比基尼的女人", "赛博朋克刺客"): Enhance character appearance, attire, expression, and portrait lighting.
   - If the user inputs a SCENE/ENVIRONMENT (e.g. "雨夜街道", "太空站"): Enhance atmospheric depth, architectural details, and cinematography.

2. PROPORTIONAL ENHANCEMENT (NO OVER-EXPANSION):
   - Single noun or short phrase (1-3 words) -> Output a compact, refined prompt (20-40 words). NEVER write a multi-paragraph essay!
   - Full sentence or complex scene -> Output a richly cinematic prompt (40-80 words).

3. CINEMATIC QUALITY:
   - Always output in English.
   - Use precise visual language (textures, lighting direction, color harmony, camera framing).
   - Preserve reference tokens like <Picture 1>, <Audio 1>, <Video 1> exactly as-is.

4. OUTPUT FORMAT:
   - Output ONLY the final optimized prompt. No preamble, no explanation, no quotes.`;

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          messages: [
            { role: 'system', content: optimizeSystem },
            { role: 'user', content: text.trim() },
          ],
          temperature: 0.3,
          max_tokens: 512,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return NextResponse.json({ error: `Optimize API error: ${errText}` }, { status: response.status });
      }
      const data = await response.json();
      let optimized = data.choices?.[0]?.message?.content?.trim() || '';
      optimized = optimized.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      if ((optimized.startsWith('"') && optimized.endsWith('"')) || (optimized.startsWith('“') && optimized.endsWith('”'))) {
        optimized = optimized.slice(1, -1);
      }
      return NextResponse.json({ translatedText: optimized });
    }

    // ── Translate mode (default): faithful, accurate translation ─────────────
    if (apiKey) {
      const baseUrl = resolveLlmBaseUrl(customBaseUrl);
      if (!baseUrl) return NextResponse.json({ error: LLM_NOT_CONFIGURED }, { status: 400 });
      const isChinese = /[\u4e00-\u9fa5]/.test(text);
      const target = targetLang === 'auto' ? (isChinese ? 'English' : 'Chinese') : targetLang === 'zh' ? 'Chinese' : 'English';

      const promptSystem = `You are a precise, faithful AI Prompt Translator for text-to-image and text-to-video models.
Translate the input text between Chinese and English accurately and concisely.

CRITICAL RULES:
1. FAITHFUL 1:1 TRANSLATION (DO NOT HALLUCINATE OR EXPAND):
   - Translate ONLY what the user wrote. DO NOT add unrequested characters, models, backgrounds, camera essays, or story elements!
   - Word/phrase in -> Word/phrase out (e.g. "比基尼" -> "A bikini", "红色跑车" -> "A red sports car", "夜雨街道" -> "Rainy street at night with neon reflections").
   - Maintain exact scope, subject, and meaning without embellishment.

2. PRECISE VISUAL TERMINOLOGY:
   - Use standard computer graphics, photography, and art terminology where appropriate.

3. PRESERVE SPECIAL TOKENS:
   - Preserve reference tokens like <Picture 1>, <Audio 1>, <Video 1> exactly as-is.

4. OUTPUT FORMAT:
   - Output ONLY the translated ${target} text. No preamble, no quotes, no explanation.`;

      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model || DEFAULT_MODEL,
            messages: [
              { role: 'system', content: promptSystem },
              { role: 'user', content: text.trim() },
            ],
            temperature: 0.1,
            max_tokens: 512,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          let translated = data.choices?.[0]?.message?.content?.trim() || '';
          translated = translated.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
          if ((translated.startsWith('"') && translated.endsWith('"')) || (translated.startsWith('“') && translated.endsWith('”'))) {
            translated = translated.slice(1, -1);
          }
          if (translated) {
            return NextResponse.json({ translatedText: translated });
          }
        }
      } catch (nimError) {
        console.warn('NIM translation request failed, trying fallback:', nimError);
      }
    }

    // 2. Fallback: Public translation service
    const isChinese = /[\u4e00-\u9fa5]/.test(text);
    const langPair = isChinese ? 'zh|en' : 'en|zh';
    const fallbackRes = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.trim())}&langpair=${langPair}`
    );
    if (fallbackRes.ok) {
      const fallbackData = await fallbackRes.json();
      const match = fallbackData.responseData?.translatedText;
      if (match) {
        return NextResponse.json({ translatedText: match });
      }
    }

    return NextResponse.json({ translatedText: text });
  } catch (error: any) {
    console.error('Translation error:', error);
    return NextResponse.json({ error: error.message || 'Translation failed' }, { status: 500 });
  }
}
