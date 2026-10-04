import { NextRequest, NextResponse } from 'next/server';

import { callLlm, FIELD_RULES, LlmError, stripFence } from '../_llm';

/**
 * One field, in the other language.
 *
 * This endpoint translates and nothing else. It is the third narrow call in the
 * console and the only one that is not allowed to think: `field` may improve a
 * value, `draft` may invent one, and this one may not touch the content at all.
 * The director reads the Chinese, edits the Chinese, and sends it back — if the
 * translator quietly "fixed" the sentence on either leg, what they edited was not
 * what the prompt says, and the console would be lying to them in both directions.
 *
 * The labels are the hard part. `<Subject 1>`, `{s:…}`, `{a:…}` and `{ref}` are
 * addresses, not words; translated into 「主体1」 they stop resolving and the
 * reference drops out of the prompt with no error. Both directions are told to
 * carry them through byte-for-byte, and the console checks that they did.
 */

const TOKEN_LAW = `Carry these through EXACTLY as written, byte for byte, in the same order and the same number of times: <Subject 1>, <Picture 2>, <Video 1>, <Audio 1>, {s:sub3}, {a:img-a}, {ref}, (S1), <d>…</d>, and any other angle-bracket or brace token. They are addresses, not words: translating one breaks the reference. Text inside double quotation marks is on-screen text — reproduce it verbatim, untranslated, quotation marks included.`;

const EN_TO_ZH = `You translate one field of a film shot specification from English into 简体中文.

You translate. You do not improve, shorten, expand, reorder, explain, or comment.
- Output ONLY the translation. No label, no quotes, no markdown, no code fence, no notes.
- Every clause in the source appears in the output. Nothing is added.
- ${TOKEN_LAW}
- Use plain, concrete Chinese a film director would say on set. Keep the sentence structure close enough that the director can see which Chinese clause is which English clause.`;

const ZH_TO_EN = `You translate one field of a film shot specification from 简体中文 into English.

You translate. You do not improve, shorten, expand, reorder, explain, or comment. The director has already decided what the field says; your job is to say the same thing in the English this model reads.
- Output ONLY the translation. No label, no quotes, no markdown, no code fence, no notes.
- Every clause in the source appears in the output. Nothing is added — no invented detail, no camera move that was not there, no adjective that was not there.
- ${TOKEN_LAW}
- Clear cinematic English, simple direct words, concrete physical statements. Never name a lens, focal length, aperture, bokeh or depth of field, even if the Chinese does — say the visible result instead.
- Write what IS there. If the Chinese states an absence, render it as the state that is actually present rather than as "no X" / "without X": a named thing gets rendered whether or not the sentence negates it.`;

export async function POST(req: NextRequest) {
  try {
    const {
      text = '',
      direction = 'en2zh',
      field = '',
      customApiKey,
      customBaseUrl,
      model,
    } = await req.json();

    const source = String(text);
    if (!source.trim()) {
      return NextResponse.json({ error: '没有可翻译的内容' }, { status: 400 });
    }
    if (direction !== 'en2zh' && direction !== 'zh2en') {
      return NextResponse.json({ error: `未知的翻译方向「${direction}」` }, { status: 400 });
    }
    // A whole hand-written prompt is a legitimate target; a runaway paste is not.
    if (source.length > 12000) {
      return NextResponse.json({ error: '文本过长（上限 12000 字符）' }, { status: 400 });
    }

    const rule = FIELD_RULES[String(field)];
    const lines = [
      // The rule is context for word choice only — it is not a licence to rewrite.
      rule
        ? `The text is the「${rule.label}」field. For wording only, this is what the field is for — do NOT rewrite the content to fit it:\n${rule.rule}`
        : null,
      'TEXT:',
      source,
    ].filter(Boolean);

    const raw = await callLlm({
      system: direction === 'en2zh' ? EN_TO_ZH : ZH_TO_EN,
      user: lines.join('\n\n'),
      customApiKey,
      customBaseUrl,
      model,
      temperature: 0.1,
      // Translation runs about as long as its source; a hand-written override is
      // the long case, and a truncated translation is worse than none.
      maxTokens: Math.min(4000, Math.max(400, Math.ceil(source.length / 2) + 300)),
    });

    const value = stripFence(raw).replace(/^["']|["']$/g, '').trim();
    if (!value) {
      return NextResponse.json({ error: '翻译结果为空，请重试' }, { status: 502 });
    }

    return NextResponse.json({ text: value, direction });
  } catch (e) {
    if (e instanceof LlmError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
