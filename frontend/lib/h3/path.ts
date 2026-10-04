/**
 * Address one field of a spec by string path — `world`, `shots.0.blocking`,
 * `subjects.1.definition`, `sound.soundscape`.
 *
 * Paths are what make a field-scoped edit previewable: the console can apply a
 * suggested value to a clone, compile it, and show exactly which prompt lines
 * move, without either the editor or the LLM plumbing knowing the spec's shape.
 * They are the same paths `diffSpecs` reports, so a preview and a take diff name
 * the same thing.
 */

import type { H3DirectorSpec } from './spec';

type Bag = Record<string, unknown>;

export function getByPath(spec: H3DirectorSpec, path: string): string {
  const parts = path.split('.');
  let cursor: unknown = spec;
  for (const part of parts) {
    if (cursor == null) return '';
    cursor = Array.isArray(cursor) ? cursor[Number(part)] : (cursor as Bag)[part];
  }
  return cursor == null ? '' : String(cursor);
}

/** Returns a new spec; the original is never touched. */
export function setByPath(spec: H3DirectorSpec, path: string, value: string): H3DirectorSpec {
  const next: H3DirectorSpec = structuredClone(spec);
  const parts = path.split('.');
  const last = parts.pop();
  if (!last) return next;

  let cursor: unknown = next;
  for (const part of parts) {
    if (cursor == null) return next;
    cursor = Array.isArray(cursor) ? cursor[Number(part)] : (cursor as Bag)[part];
  }
  if (cursor == null) return next;

  if (Array.isArray(cursor)) cursor[Number(last)] = value;
  else (cursor as Bag)[last] = value;
  return next;
}

/**
 * The `FIELD_RULES` key for a path, so the LLM gets the right law for it.
 *
 * Indices are dropped: which shot, which subject and which line of dialogue are
 * all the same field as far as the law is concerned — `shots.2.dialogue.1.delivery`
 * obeys the rule written for `dialogue.delivery`.
 */
export function ruleKeyForPath(path: string): string {
  const drop = (parts: string[]) => parts.filter((p) => !/^\d+$/.test(p)).join('.');
  if (path.startsWith('shots.')) return drop(path.split('.').slice(2));
  if (path.startsWith('subjects.')) return `subject.${drop(path.split('.').slice(2))}`;
  return drop(path.split('.'));
}
