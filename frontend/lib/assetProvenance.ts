import { t } from './i18n';
/**
 * Putting an old shot back on the canvas as the node that made it.
 *
 * The requirement is parity, not improvement: a clip re-placed from the asset
 * library must hand downstream nodes EXACTLY what the node that generated it
 * handed them. An upscale of the same clip has to land on the same
 * micro-detail whether the original node is still on the canvas or was deleted
 * a month ago.
 *
 * So this restores what the generating node held and nothing more. It is
 * tempting to also mount the recovered first frame — the refine pass runs with
 * no image anchoring without it — but a live node does not pass its first frame
 * either, so adding it here would produce a different result from the canvas
 * path, which is the very thing being fixed. That is a separate question about
 * what the refine pass should receive, and it has to be answered for both paths
 * at once or not at all.
 *
 * Deliberately NOT restored:
 *  - `steps`: a setting on the node's UI, not a property of the file. The graph
 *    records the steps actually sampled, which the builder may have derived from
 *    the number the user typed; restoring the derived one invents a mismatch.
 *  - `seed`/`prompt` for the refine pass: the upscale node does not read either
 *    from its source (see VideoUpscaleNode) — they are carried for the reader.
 */

/** What `GET /assets/{name}/provenance` returns. Every field is optional. */
export interface AssetProvenance {
  found: boolean;
  name: string;
  prompt?: string | null;
  seed?: number | null;
  width?: number | null;
  height?: number | null;
  length?: number | null;
  reference_images?: string[];
  reference_videos?: string[];
  reference_audios?: string[];
  first_frame?: string | null;
  last_frame?: string | null;
  latent_filename?: string | null;
  model?: string | null;
  loras?: string[];
}

/**
 * Node data for a restored clip, in the shape the canvas already speaks.
 *
 * `submittedResources` is written the way a generating node writes it — a list
 * of resources each named by its ComfyUI input filename — because the same
 * reader consumes both (`projectConnectedNode`).
 */
export function restoredNodeData(
  found: AssetProvenance,
  probed: { width?: number; height?: number; duration?: number } = {}
): Record<string, unknown> {
  if (!found.found) {
    return { width: probed.width, height: probed.height, duration: probed.duration };
  }
  const references = found.reference_images ?? [];
  const frame = (name?: string | null) => (name ? { comfy_filename: name } : null);
  return {
    // The file's own pixels win over the graph's requested size: a shot that was
    // upscaled or re-encoded since is no longer the size it was asked for.
    width: probed.width ?? found.width ?? undefined,
    height: probed.height ?? found.height ?? undefined,
    duration: probed.duration,
    submittedResources: {
      reference_images: references.map((comfy_filename) => ({ comfy_filename })),
      first_frame: frame(found.first_frame),
      last_frame: frame(found.last_frame),
    },
    // Paired by filename, so it outlives its node. The upscale node's own
    // fallback derives the wrong stem for H3 output (`H3_Video_x` is not
    // `H3_Latent_x`), and getting this wrong silently downgrades the run from
    // the latent refiner to a generic restorer.
    latentFilename: found.latent_filename ?? undefined,
    length: found.length ?? undefined,
    prompt: found.prompt ?? undefined,
    seed: found.seed ?? undefined,
  };
}

/** One line for the toast: what actually came back. */
export function describeRestored(found: AssetProvenance): string {
  if (!found.found) return '';
  const parts = [
    (found.reference_images?.length ?? 0) > 0 ? t('{v1} 张参考图', { v1: found.reference_images!.length }) : '',
    found.latent_filename ? '潜空间' : '',
    found.first_frame ? '首帧' : '',
  ].filter(Boolean);
  return parts.length > 0 ? t(' · 已带回{v1}', { v1: parts.join('、') }) : '';
}
