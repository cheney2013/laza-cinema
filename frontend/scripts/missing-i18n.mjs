/**
 * List every string handed to t() that has no Japanese entry yet.
 *
 * The same check runs as a test (lib/i18n.coverage.test.ts); this is the form
 * you want while filling the dictionary, because it prints the bare list.
 *
 * Usage:  node scripts/missing-i18n.mjs [outfile]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// lib/ and hooks/ carry copy too -- the QA board's rules and the spec diff
// live there, and leaving them out is how they stayed Chinese for a whole pass.
const SOURCE_DIRS = ['components', 'app', 'lib', 'hooks'];
const CN = /[一-鿿]/;
const CALL = /\btr?\('((?:[^'\\]|\\.)*)'/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function unescapeLiteral(raw) {
  return raw.replace(/\\(.)/g, (_, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
}

const dict = readFileSync('lib/locales/ja.ts', 'utf8');
const have = new Set();
for (const line of dict.split('\n')) {
  const s = line.trim();
  // the dictionary is source text too, so its keys need the same unescaping
  if (s.startsWith("'") && s.includes("':")) have.add(unescapeLiteral(s.slice(1, s.indexOf("':"))));
}

const keys = new Set();
for (const dir of SOURCE_DIRS) {
  for (const file of walk(dir)) {
    for (const m of readFileSync(file, 'utf8').matchAll(CALL)) {
      const key = unescapeLiteral(m[1]);
      if (CN.test(key)) keys.add(key);
    }
  }
}

const missing = [...keys].filter((k) => !have.has(k)).sort();
console.log(`missing: ${missing.length} of ${keys.size}`);
const out = process.argv[2];
if (out) writeFileSync(out, missing.join('\n'), 'utf8');
else missing.forEach((k) => console.log(k));
