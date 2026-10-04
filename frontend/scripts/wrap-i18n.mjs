/**
 * AST codemod: wrap display-only Chinese copy in t().
 *
 * A regex pass got the easy shapes (plain JSX text, `title="..."`) but cannot
 * tell a rendered ternary from a prompt fragment. Two things in this codebase
 * make that distinction matter:
 *
 *   * `<d>[Chinese] 台词</d>` inside an H3 snippet looks exactly like JSX text;
 *   * `<图${idx}>` is a reference token the model reads, not a label.
 *
 * So the rules here are structural, and the compiler decides what is JSX:
 *
 *   1. JSX text children.
 *   2. String literals in a whitelist of copy-carrying attributes, including
 *      the branches of a ternary inside one.
 *   3. String literals that are a JSX *child* expression -- `{'文案'}` and
 *      `{cond ? '甲' : '乙'}` -- but not arguments of a call inside one.
 *
 * Everything else, data arrays included, is left alone: those are wrapped at
 * the point they are rendered, or they are not display copy at all.
 *
 * Usage:  node scripts/wrap-i18n.mjs           # report
 *         node scripts/wrap-i18n.mjs --apply
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');

const CN = /[一-鿿]/;
const COPY_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label']);
const APPLY = process.argv.includes('--apply');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** `t` is taken by a local binding in this file; the import is aliased there. */
function callee(src) {
  return src.includes("import { t as tr }") ? 'tr' : 't';
}

function collect(file, src) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = callee(src);
  const edits = [];
  const seen = new Set();

  const alreadyWrapped = (node) => {
    let p = node.parent;
    while (p) {
      if (ts.isCallExpression(p) && ts.isIdentifier(p.expression)
          && (p.expression.text === 't' || p.expression.text === 'tr')) return true;
      p = p.parent;
    }
    return false;
  };

  const pushString = (node) => {
    if (!ts.isStringLiteral(node) || !CN.test(node.text)) return;
    if (node.text.includes("'")) return;          // would need escaping; left by hand
    if (alreadyWrapped(node)) return;
    const key = node.getStart() + ':' + node.getEnd();
    if (seen.has(key)) return;
    seen.add(key);
    edits.push({
      start: node.getStart(), end: node.getEnd(),
      text: fn + "('" + node.text + "')", value: node.text,
    });
  };

  /** Strings that are the value itself, or the branches of a ternary. */
  const pushValue = (node) => {
    if (ts.isStringLiteral(node)) return pushString(node);
    if (ts.isConditionalExpression(node)) {
      pushValue(node.whenTrue);
      pushValue(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)
        && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken
            || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      pushValue(node.left);
      pushValue(node.right);
    }
  };

  const visit = (node) => {
    // 1. JSX text
    if (ts.isJsxText(node) && CN.test(node.text)) {
      const raw = node.text;
      const trimmed = raw.trim();
      if (trimmed && !trimmed.includes("'")) {
        const lead = raw.slice(0, raw.indexOf(trimmed[0]));
        const trail = raw.slice(lead.length + trimmed.length);
        // a line break inside the copy itself is collapsed to one space
        const flat = trimmed.replace(/\s*\n\s*/g, ' ');
        edits.push({
          start: node.getStart(), end: node.getEnd(),
          text: lead + '{' + fn + "('" + flat + "')}" + trail, value: flat,
        });
      }
    }

    // 2. copy-carrying attributes
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText();
      if (COPY_ATTRS.has(name)) {
        if (ts.isStringLiteral(node.initializer)) {
          if (CN.test(node.initializer.text) && !node.initializer.text.includes("'")) {
            edits.push({
              start: node.initializer.getStart(), end: node.initializer.getEnd(),
              text: '{' + fn + "('" + node.initializer.text + "')}",
              value: node.initializer.text,
            });
            seen.add(node.initializer.getStart() + ':' + node.initializer.getEnd());
          }
        } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          pushValue(node.initializer.expression);
        }
      }
    }

    // 3. a JSX child expression: {'文案'} or {cond ? '甲' : '乙'}
    if (ts.isJsxExpression(node) && node.expression
        && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      pushValue(node.expression);
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  edits.sort((a, b) => a.start - b.start);
  const kept = [];
  let last = -1;
  for (const e of edits) {
    if (e.start >= last) { kept.push(e); last = e.end; }
  }
  return kept;
}

function ensureImport(src) {
  if (/from '@\/lib\/i18n'/.test(src)) {
    const m = src.match(/import \{([^}]*)\} from '@\/lib\/i18n';/);
    if (m && !m[1].split(',').map((s) => s.trim()).includes('t')) {
      const names = m[1].split(',').map((s) => s.trim()).filter(Boolean).concat('t').sort();
      return src.replace(m[0], `import { ${names.join(', ')} } from '@/lib/i18n';`);
    }
    return src;
  }
  const imports = [...src.matchAll(/^import .*?;$/gms)];
  const line = "import { t } from '@/lib/i18n';";
  if (!imports.length) return line + '\n' + src;
  const at = imports[imports.length - 1].index + imports[imports.length - 1][0].length;
  return src.slice(0, at) + '\n' + line + src.slice(at);
}

let files = 0;
let total = 0;
const values = new Set();
for (const file of [...walk('components'), ...walk('app')]) {
  const src = readFileSync(file, 'utf8');
  const edits = collect(file, src);
  if (!edits.length) continue;
  files += 1;
  total += edits.length;
  edits.forEach((e) => values.add(e.value));
  console.log(`${file.replace(/\\/g, '/')}: ${edits.length}`);
  if (!APPLY) continue;
  let out = '';
  let cursor = 0;
  for (const e of edits) {
    out += src.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  out += src.slice(cursor);
  writeFileSync(file, ensureImport(out), 'utf8');
}
console.log(`\n${files} files, ${total} sites, ${values.size} distinct strings`
  + (APPLY ? ' (applied)' : ' (dry run)'));
if (process.env.DUMP) {
  writeFileSync(process.env.DUMP, [...values].sort().join('\n'), 'utf8');
}
