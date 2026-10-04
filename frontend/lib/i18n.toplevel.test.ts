import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');

/**
 * No t() outside a function.
 *
 * The studio remounts when the language changes, but modules are not
 * re-evaluated. A constant built with t() at import time therefore freezes in
 * whatever language was active on the first load, and switching language leaves
 * it behind -- silently, because the value is still a valid string.
 *
 * Seven tables did exactly that on the first pass: transition names, subject
 * kinds, retention markers, dialog titles, asset kinds, frame sizes, camera
 * tokens. The fix in each case was the same: keep the Chinese source in the
 * table, call t() where the value is read.
 *
 * "Inside a function" is decided by the compiler rather than by counting
 * braces: a default parameter (`title = t('分组')`) and an arrow body
 * (`() => t(...)`) both run per call and are fine, and a regex cannot tell
 * those from a frozen constant.
 */

const SOURCE_DIRS = ['components', 'app', 'lib', 'hooks'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function frozenCalls(file: string, src: string): number[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: number[] = [];

  const insideFunction = (node: any): boolean => {
    let p = node.parent;
    while (p) {
      if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)
          || ts.isArrowFunction(p) || ts.isMethodDeclaration(p)
          || ts.isGetAccessor(p) || ts.isSetAccessor(p)
          || ts.isConstructorDeclaration(p)) return true;
      p = p.parent;
    }
    return false;
  };

  const visit = (node: any) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && (node.expression.text === 't' || node.expression.text === 'tr')
        && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])
        && !insideFunction(node)) {
      hits.push(sf.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return hits;
}

describe('语言切换后不会有残留', () => {
  it('没有在函数之外调用 t()', () => {
    const offenders: string[] = [];
    for (const dir of SOURCE_DIRS) {
      for (const file of walk(dir)) {
        if (file.includes('locales') || file.includes('.test.')) continue;
        for (const line of frozenCalls(file, readFileSync(file, 'utf8'))) {
          offenders.push(`${file}:${line}`);
        }
      }
    }
    assert.deepEqual(
      offenders, [],
      `${offenders.length} 处在函数之外调用 t()，切换语言后不会更新：\n  `
      + offenders.join('\n  '),
    );
  });
});
