/**
 * The spoken lines of an H3 prompt, in order, with who says them.
 *
 * A line is `<d>[Lang]text</d>`. Its speaker is read from what was written
 * between the previous line and this one:
 *
 * - The last speaker id `(Sx)` there, named by the `<Subject N>` right before
 *   it, else by any `<Subject N> (Sx)` pairing elsewhere in the prompt, else by
 *   the words right before it. An off-screen voice is written "the man on the
 *   phone (S2), off-screen, ... says:" with no Subject label; looking for the
 *   nearest `<Subject N> (Sx)` instead gave his line to whoever spoke before
 *   him (C1: Ben's line shown as Anna's).
 * - No id, and nobody named: the previous speaker going on ("and then he turns
 *   ... and says:", C16b).
 * - No id, but someone named: left blank. C13a's "then Mark, gripping Anna's
 *   hand, calls out: <d>Sam!</d>" has no id of its own; borrowing Anna's
 *   (S1) from the line before named the wrong person.
 *
 * Subject names are the first word after "<Subject N> is" in
 * subject_definitions ("<Subject 1> is Anna, ..." -> "Anna").
 */
export interface DialogueLine {
  speaker: string;
  text: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function promptDialogue(prompt: string | undefined | null): DialogueLine[] {
  if (!prompt) return [];
  const names = new Map<string, string>();
  for (const m of prompt.matchAll(/<Subject (\d+)> is (?:an? |the )?([A-Z][\w'-]*)/g)) {
    if (!names.has(m[1])) names.set(m[1], m[2]);
  }
  // Speaker ids paired with a subject anywhere: "(S2)" -> "Ben".
  const byId = new Map<string, string>();
  for (const m of prompt.matchAll(/<Subject (\d+)>\s*\((S\d+)\)/g)) {
    const name = names.get(m[1]);
    if (name && !byId.has(m[2])) byId.set(m[2], name);
  }
  const namePatterns = [...new Set(names.values())].map((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`));
  const mentionsSomeone = (span: string) => /<Subject \d+>/.test(span) || namePatterns.some((re) => re.test(span));

  const lines: DialogueLine[] = [];
  const re = /<d>([\s\S]*?)<\/d>/g;
  let m: RegExpExecArray | null;
  let prevEnd = 0;
  while ((m = re.exec(prompt))) {
    const before = prompt.slice(Math.max(prevEnd, m.index - 400), m.index);
    prevEnd = m.index + m[0].length;
    const id = [...before.matchAll(/\((S\d+)\)/g)].pop();
    let speaker = '';
    if (id) {
      const lead = before.slice(0, id.index);
      const subject = /<Subject (\d+)>\s*$/.exec(lead);
      const described = /([^:;.<>\]]{2,60})$/.exec(lead)?.[1].replace(/^[\s,]+|[\s,]+$/g, '');
      speaker = (subject && names.get(subject[1])) || byId.get(id[1]) || described || id[1];
    } else if (lines.length && !mentionsSomeone(before)) {
      speaker = lines[lines.length - 1].speaker;
    }
    const text = m[1]
      .replace(/^\s*\[[^\]]*\]\s*/, '')
      .replace(/<\/?[a-z]+>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) lines.push({ speaker, text });
  }
  return lines;
}
