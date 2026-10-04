import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ja } from './locales/ja';

/**
 * Every string handed to t() must have a Japanese entry.
 *
 * Without this, a missing entry is invisible: t() falls back to the Chinese it
 * was written as, so a half-translated screen looks like a design choice rather
 * than an omission. That is exactly how the first pass shipped -- the canvas
 * double-click menu stayed Chinese and nothing said so. This test says so.
 */

// lib/ and hooks/ carry copy too -- the QA board's rules and the spec diff
// live there, and leaving them out is how they stayed Chinese for a whole pass.
const SOURCE_DIRS = ['components', 'app', 'lib', 'hooks'];
const CN = /[一-鿿]/;
// t('...') and, in DirectorConsole where `t` is taken, tr('...')
const CALL = /\btr?\('((?:[^'\\]|\\.)*)'/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * A key read out of source text is still escaped: a doubled backslash in the
 * file is one backslash at runtime, and the dictionary is keyed by the runtime
 * value. Without this the backend-offline hint, the one string in the UI that
 * carries a path, reads as missing.
 */
function unescapeLiteral(raw: string): string {
  return raw.replace(/\\(.)/g, (_, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    return ch;
  });
}

/**
 * Words that are spelled the same in both languages. Each one is a decision,
 * not an oversight: 素材 and 未使用 are ordinary Japanese, and 保存中 reads the
 * same way on both sides. Listing them keeps the "not translated" check strict
 * for everything else.
 */
const SAME_IN_BOTH = new Set([
  '素材', '未使用', '保存中…', '管理', '字幕', '音量', '保存', '文', '空',
  '水平', '垂直', '左', '右', '固定', '生成', '正方形',
  // the same words with the punctuation or icon they are rendered with
  '行', '行 ·', '中 ·', '🔒 固定',
  // depth layers: 前景 and 中景 are the Japanese terms as well (後景 is not)
  '前景', '中景',
  // ordinal prefix: 第 N フレーム reads as Japanese too
  '第',
  // a rule citation whose only Chinese word, 光学, is the same in Japanese
  'h3-director §1.9 光学',
  // 字幕 is the Japanese word too; the placeholder carries the rest
  '字幕：{v1}',
  // subject kinds: 人物 and 環境 are Japanese as well (道具 → 小道具 is not)
  '人物',
  // node states written the same way in Japanese
  '生成中', '保存中',
]);

function callSiteKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(CALL)) {
        const key = unescapeLiteral(m[1]);
        if (!CN.test(key)) continue;
        const seen = found.get(key) ?? [];
        if (!seen.includes(file)) seen.push(file);
        found.set(key, seen);
      }
    }
  }
  return found;
}

/**
 * Labels that reach t() as a variable -- `t(chip.label)` over a table of chips
 * -- are invisible to the check above, which can only read literal call sites.
 * Four of them shipped as Chinese in an otherwise Japanese UI and were only
 * found by reading the rendered page.
 *
 * So: in any file that calls t() with something other than a literal, the
 * display fields of its own constant tables must be translated too. `text:` is
 * deliberately not in the list -- that field holds prompt fragments sent to the
 * model, and translating one would change the render, not the interface.
 */
const DISPLAY_FIELDS = /\b(?:label|desc|title|short|hint)\s*:\s*'((?:[^'\\]|\\.)*)'/g;
const DYNAMIC_CALL = /\btr?\(\s*[A-Za-z_$]/;

function tableLabels(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8');
      if (!DYNAMIC_CALL.test(src)) continue;
      for (const m of src.matchAll(DISPLAY_FIELDS)) {
        const key = unescapeLiteral(m[1]);
        if (!CN.test(key)) continue;
        const seen = found.get(key) ?? [];
        if (!seen.includes(file)) seen.push(file);
        found.set(key, seen);
      }
    }
  }
  return found;
}

describe('日语覆盖率', () => {
  it('每个 t() 的文案都有日语词条', () => {
    const missing: string[] = [];
    for (const [key, files] of callSiteKeys()) {
      if (!(key in ja)) missing.push(`${key}   ← ${files.join(', ')}`);
    }
    assert.deepEqual(
      missing, [],
      `${missing.length} 条文案没有日语词条：\n  ` + missing.join('\n  '),
    );
  });

  it('通过变量传给 t() 的表格文案也有词条', () => {
    const missing: string[] = [];
    for (const [key, files] of tableLabels()) {
      if (!(key in ja)) missing.push(`${key}   ← ${files.join(', ')}`);
    }
    assert.deepEqual(
      missing, [],
      `${missing.length} 条表格文案没有日语词条：\n  ` + missing.join('\n  '),
    );
  });

  it('词条不是把中文原样抄一遍', () => {
    const untranslated = Object.entries(ja)
      .filter(([zh, jp]) => zh === jp && CN.test(zh) && !SAME_IN_BOTH.has(zh))
      .map(([zh]) => zh);
    assert.deepEqual(untranslated, [], `原样抄回中文的词条：${untranslated.join('、')}`);
  });
});
