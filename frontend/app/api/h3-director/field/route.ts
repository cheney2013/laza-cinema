import { NextRequest, NextResponse } from 'next/server';

import { callLlm, FIELD_RULES, FIELD_SYSTEM_PROMPT, LlmError, stripFence } from '../_llm';

/**
 * Rewrite exactly one field of a shot specification.
 *
 * Scope is the point. The model is handed one field, that field's law, and the
 * minimum neighbouring context — never the whole spec — so it cannot quietly
 * restate a neighbour's job or trade one field's rule against another's. The
 * response is one value; the console previews it as a diff and the director
 * accepts or discards it.
 */
export async function POST(req: NextRequest) {
  try {
    const {
      field = '',
      value = '',
      intent = '',
      context = {},
      customApiKey,
      customBaseUrl,
      model,
    } = await req.json();

    const rule = FIELD_RULES[field];
    if (!rule) {
      return NextResponse.json(
        { error: `未知字段「${field}」。字段级改写只接受规则表里已登记的字段。` },
        { status: 400 },
      );
    }

    if (!String(intent).trim() && !String(value).trim()) {
      return NextResponse.json({ error: '既没有现有内容也没有意图，无从改写' }, { status: 400 });
    }

    // Only the neighbours that genuinely inform this field. Handing over the whole
    // spec is what lets a "polish" turn into an unrequested rewrite of the rest.
    const lines: string[] = [
      `FIELD: ${field} (${rule.label})`,
      `RULE FOR THIS FIELD: ${rule.rule}`,
    ];
    if (context.mode) lines.push(`MODE: ${context.mode}`);
    if (context.labels) lines.push(`AVAILABLE LABELS: ${context.labels}`);
    if (context.world) lines.push(`WORLD BLOCK (already written, do not repeat it): ${context.world}`);
    if (context.shotIndex) lines.push(`THIS IS SHOT ${context.shotIndex}`);
    if (context.neighbours) {
      lines.push('OTHER FIELDS OF THIS SHOT (already asserted — do not restate any of it):');
      lines.push(String(context.neighbours));
    }
    lines.push(
      String(value).trim()
        ? `CURRENT VALUE:\n${value}`
        : 'CURRENT VALUE: (empty — write it from the intent below)',
    );
    lines.push(
      String(intent).trim()
        ? `DIRECTOR'S INTENT (may be Chinese — translate it, do not answer in Chinese):\n${intent}`
        : "DIRECTOR'S INTENT: tighten the current value so it obeys the rule above, changing as little as possible.",
    );

    const raw = await callLlm({
      system: FIELD_SYSTEM_PROMPT,
      user: lines.join('\n\n'),
      customApiKey,
      customBaseUrl,
      model,
      temperature: 0.3,
      maxTokens: 400,
    });

    // A field is a value, not a document. A model that answers with a section
    // header has misunderstood the request, and accepting it would push prose
    // into a slot the compiler treats as one clause.
    const cleaned = stripFence(raw).replace(/^["']|["']$/g, '').trim();
    if (/^(subject_definitions|summary|retention_analysis|detailed_description):/im.test(cleaned)) {
      return NextResponse.json(
        { error: '模型返回了整段提示词而不是单个字段值，已拒绝。请重试。' },
        { status: 502 },
      );
    }

    return NextResponse.json({ value: cleaned, field });
  } catch (error) {
    if (error instanceof LlmError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const e = error as Error;
    console.error('h3-director/field error:', e);
    return NextResponse.json({ error: e.message || '字段改写失败' }, { status: 500 });
  }
}
