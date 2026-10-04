import type { H3DirectorSpec } from './spec';

/**
 * One generation, with the shot design that produced it.
 *
 * Storing the spec rather than only the prompt is what makes "what did I actually
 * change between take 3 and take 5" answerable at field level instead of by
 * diffing two walls of prose.
 */
export interface H3Take {
  id: string;
  createdAt: number;
  /** Snapshot at submit time. */
  spec: H3DirectorSpec | null;
  /** Exact prompt sent to the backend. */
  prompt: string;
  seed: number;
  width: number;
  height: number;
  length: number;
  /** Sampler steps this take was rendered at. */
  steps?: number;
  /**
   * Which checkpoint/LoRA/scheduler trio produced this take. Recorded at submit
   * because the node's selector can be changed afterwards, and "why does #3
   * move more than #5" is otherwise unanswerable from the take list.
   */
  motionPreset?: string;
  /** Filled in when the job finishes. */
  url: string | null;
  /** Every generation parameter on the node at submit (takeSwitch.TAKE_PARAM_KEYS). */
  params?: Record<string, unknown>;
  /** The node's wired inputs at submit, in edge order (= <Picture N> order). */
  inputs?: H3TakeInput[];
  /** What the render returned: latent, compiled prompt, submitted resources. */
  outputs?: Record<string, unknown>;
  /** Set by the director when a take is the keeper. */
  adopted?: boolean;
}

export interface H3TakeInput {
  source: string;
  targetHandle: string;
  /** The source's media url (a latent filename for in-motion-context) at submit. */
  url: string | null;
}

export const MAX_TAKES = 200;

/** Newest first, capped. Adopted takes are never evicted. */
export function pushTake(takes: H3Take[] | undefined, take: H3Take): H3Take[] {
  const next = [take, ...(takes || [])];
  if (next.length <= MAX_TAKES) return next;
  const kept: H3Take[] = [];
  const overflow: H3Take[] = [];
  for (const t of next) (t.adopted || kept.length < MAX_TAKES ? kept : overflow).push(t);
  return kept.slice(0, Math.max(MAX_TAKES, kept.filter((t) => t.adopted).length));
}
