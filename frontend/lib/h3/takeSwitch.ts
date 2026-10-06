import type { H3Take, H3TakeInput } from './takes';

/**
 * Switching a node between its generated versions (takes).
 *
 * The version on display is the take whose url is the node's generatedUrl --
 * there is no separate pointer to keep in step. Switching writes that take's
 * parameters and outputs back onto the node, so the node's fields always
 * describe the clip it shows, and the next run starts from them. Takes are
 * never edited: changing a parameter after switching makes the node "dirty",
 * and running it adds a new take on top.
 */

/** Node fields a take snapshots and a switch restores. */
export const TAKE_PARAM_KEYS = [
  'prompt', 'seed', 'seedMode', 'width', 'height', 'length', 'steps',
  'motionPreset', 'accelLora', 'styleLoras', 'styleLoraStrengths',
  'shiftVideo', 'shiftAudio', 'motionContextLength', 'motionContextAudio',
  'refImageOrder', 'useFirstFrame', 'promptSource', 'directorSpec',
  'audioLocks', 'audioLockFeather', 'seamMatch', 'seamMatchAdaptive', 'seamMatchGain', 'seamMatchTexture', 'seamMatchPostGain',
] as const;

/** Node fields that describe the rendered clip rather than the next run. */
export const TAKE_OUTPUT_KEYS = [
  'latentFilename', 'untrimmedUrl', 'contextFrames', 'compiledPrompt', 'compiledPromptMode', 'promptWasModified',
  'submittedResources', 'generatedSteps', 'seamMatchApplied',
] as const;

type Data = Record<string, unknown>;

export function snapshotParams(data: Data): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TAKE_PARAM_KEYS) if (data[k] !== undefined) out[k] = data[k];
  return out;
}

export function snapshotOutputs(data: Data): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TAKE_OUTPUT_KEYS) if (data[k] !== undefined) out[k] = data[k];
  return out;
}

export function snapshotInputs(
  connected: Array<{ id: string; targetHandle?: string | null; url?: string; generatedUrl?: string; latentFilename?: string }>,
): H3TakeInput[] {
  return connected.map((n) => ({
    source: n.id,
    targetHandle: n.targetHandle || '',
    url: (n.targetHandle === 'in-motion-context'
      ? (n.latentFilename || n.generatedUrl || n.url)
      : (n.url || n.generatedUrl)) || null,
  }));
}

/** Parameters of a take, including the fields older takes kept at top level. */
export function takeParams(take: H3Take): Record<string, unknown> {
  const legacy: Record<string, unknown> = {};
  for (const k of ['prompt', 'seed', 'width', 'height', 'length', 'steps', 'motionPreset'] as const) {
    if (take[k] !== undefined && take[k] !== null) legacy[k] = take[k];
  }
  return { ...legacy, ...(take.params || {}) };
}

/**
 * The latent a take's clip was saved with. Older takes did not record it; the
 * backend names the latent after the clip's run tag (H3_Video_<tag> /
 * H3_Chunk_<tag> -> H3_Latent_<tag>), so it can be recovered from the url.
 */
export function takeLatent(take: H3Take): { name: string | null; inferred: boolean } {
  const recorded = take.outputs?.latentFilename;
  if (typeof recorded === 'string' && recorded) return { name: recorded, inferred: false };
  if (take.outputs && 'latentFilename' in take.outputs) return { name: null, inferred: false };
  const m = /\/(?:H3_Video|H3_Chunk)_([0-9a-f]+_\d+_)\.mp4$/.exec(take.url || '');
  return m ? { name: `H3_Latent_${m[1]}.safetensors`, inferred: true } : { name: null, inferred: false };
}

export function currentTakeIndex(takes: H3Take[], generatedUrl: unknown): number {
  if (!generatedUrl) return -1;
  return takes.findIndex((t) => t.url === generatedUrl);
}

/**
 * A take for the clip on display when none records it -- a render started over
 * the MCP or by another tab, consumed here before anything wrote its take.
 * Switching away without this would leave the clip referenced by nothing.
 */
export function takeForDisplayed(data: Data, id: string): H3Take | null {
  const url = data.generatedUrl;
  if (typeof url !== 'string' || !url) return null;
  const params = snapshotParams(data);
  return {
    id,
    createdAt: Date.now(),
    spec: null,
    prompt: (data.compiledPrompt as string) || (data.prompt as string) || '',
    seed: Number(data.seed) || 0,
    width: Number(data.width) || 0,
    height: Number(data.height) || 0,
    length: Number(data.length) || 0,
    steps: (data.generatedSteps as number | undefined) ?? (data.steps as number | undefined),
    motionPreset: data.motionPreset as string | undefined,
    url,
    params,
    outputs: snapshotOutputs(data),
  };
}

/** The node fields to write when switching to `take`. */
export function switchPatch(take: H3Take, data: Data): Data {
  const params = takeParams(take);
  const patch: Data = { ...params, generatedUrl: take.url };
  // Outputs: what was recorded, else cleared so a field from another take does
  // not survive the switch and describe the wrong clip.
  for (const k of TAKE_OUTPUT_KEYS) patch[k] = take.outputs?.[k] ?? undefined;
  const latent = takeLatent(take);
  patch.latentFilename = latent.name ?? undefined;
  if (patch.generatedSteps === undefined && take.steps) patch.generatedSteps = take.steps;
  // A prompt that no longer matches its file must not keep claiming the file.
  if (data.promptFile && params.prompt !== undefined && params.prompt !== data.prompt) {
    patch.promptFile = undefined;
  }
  return patch;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Parameter names the node has changed since the take on display. */
export function dirtyKeys(take: H3Take | undefined, data: Data): string[] {
  if (!take) return [];
  // Older takes kept only a few fields, and their prompt is the compiled one
  // sent to the model, which never equals the node's own prompt field.
  const params: Record<string, unknown> = take.params
    ?? Object.fromEntries((['seed', 'width', 'height', 'length'] as const)
      .filter((k) => take[k] != null).map((k) => [k, take[k]]));
  return Object.keys(params).filter((k) => !same(params[k], data[k]));
}

export interface InputIssue {
  kind: 'missing-node' | 'changed' | 'removed' | 'added' | 'unrecorded' | 'no-latent';
  handle: string;
  source?: string;
}

/**
 * How the node's current wiring differs from the inputs the take was made with.
 * `nodeIds` is every node on the canvas, to tell a deleted source from an
 * unwired one.
 */
export function inputIssues(
  take: H3Take | undefined,
  current: H3TakeInput[],
  nodeIds: Set<string>,
): InputIssue[] {
  if (!take) return [];
  const issues: InputIssue[] = [];
  if (!take.inputs) {
    issues.push({ kind: 'unrecorded', handle: '' });
  } else {
    const cur = [...current];
    for (const want of take.inputs) {
      const i = cur.findIndex((c) => c.source === want.source && c.targetHandle === want.targetHandle);
      if (i < 0) {
        issues.push({ kind: nodeIds.has(want.source) ? 'removed' : 'missing-node', handle: want.targetHandle, source: want.source });
        continue;
      }
      const got = cur.splice(i, 1)[0];
      if (want.url && got.url !== want.url) issues.push({ kind: 'changed', handle: want.targetHandle, source: want.source });
    }
    for (const extra of cur) issues.push({ kind: 'added', handle: extra.targetHandle, source: extra.source });
  }
  if (!takeLatent(take).name) issues.push({ kind: 'no-latent', handle: '' });
  return issues;
}
