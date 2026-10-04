/**
 * The Chinese side of an English spec.
 *
 * Every field of a DirectorSpec is written in English because that is what H3
 * reads. The director does not think in English, so each field can be shown as
 * Chinese, edited there, and translated back. What makes that round trip safe is
 * that the important parts of a field are not words at all: `{s:…}`, `{a:…}`,
 * `{ref}` and `<Subject 1>` are addresses. A translator that renders `<Subject 1>`
 * as 「主体1」 does not produce a worse sentence — it produces a sentence whose
 * reference silently stops resolving, and the prompt loses the subject with no
 * error anywhere.
 *
 * So the round trip is checked, not trusted: the tokens that went in have to come
 * back, unchanged and in the same number.
 */

/** `{s:sub1}`, `{a:img-a}`, `{ref}`, `<Subject 2>`, `<Picture 1>`. */
const TOKEN_RE = /\{s:[^}]+\}|\{a:[^}]+\}|\{ref\}|<[A-Za-z][^<>]*>/g;

export function extractTokens(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

export interface TokenDrift {
  /** In the source, gone from the translation. */
  missing: string[];
  /** In the translation, never in the source. */
  added: string[];
}

/**
 * Compared as a multiset: two `{s:x}` in and one out is drift, because the second
 * mention is a second place the subject was named.
 */
export function tokenDrift(before: string, after: string): TokenDrift {
  const counts = new Map<string, number>();
  for (const t of extractTokens(before)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const added: string[] = [];
  for (const t of extractTokens(after)) {
    const n = counts.get(t) ?? 0;
    if (n > 0) counts.set(t, n - 1);
    else added.push(t);
  }
  const missing: string[] = [];
  counts.forEach((n, t) => {
    for (let i = 0; i < n; i += 1) missing.push(t);
  });
  return { missing, added: [...new Set(added)] };
}

export function hasDrift(drift: TokenDrift): boolean {
  return drift.missing.length > 0 || drift.added.length > 0;
}

/**
 * True when the text is already Chinese — a field the director wrote in Chinese,
 * or one the console has not translated yet. Tokens are stripped first: a value
 * that is nothing but `<Subject 1>` is neither language.
 */
export function looksChinese(text: string): boolean {
  const stripped = text.replace(TOKEN_RE, '');
  const cjk = stripped.match(/[一-鿿]/g)?.length ?? 0;
  const letters = stripped.match(/[A-Za-z]/g)?.length ?? 0;
  if (cjk === 0) return false;
  return cjk * 2 >= letters;
}
