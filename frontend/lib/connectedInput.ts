/**
 * What a downstream node is allowed to see of an upstream one.
 *
 * Kept apart from the hook that reads it out of the store, and free of any
 * import, so it can be asserted on directly. One thing it has to guarantee is
 * invisible from inside a component: a shot re-placed from the asset library
 * must project to EXACTLY what the node that generated it projected. Any field
 * read here that the restore path does not rebuild is a silent difference in
 * the next upscale — same clip, different micro-detail.
 */

export interface ConnectedInput {
  id: string;
  type?: string;
  targetHandle?: string | null;
  text?: string;
  url?: string;
  generatedUrl?: string;
  comfyFilename?: string;
  poseImageUrl?: string;
  depthImageUrl?: string;
  width?: number;
  height?: number;
  mediaType?: string;
  fps?: number;
  duration?: number;
  label?: string;
  steps?: number;
  length?: number;
  alias?: string;
  latentFilename?: string;
  /** Chained shot: the render with its overlap still at the head, and how long it is. */
  untrimmedUrl?: string;
  contextFrames?: number;
  /** ComfyUI input filenames of the shot's reference images. The latent refiner
   *  re-encodes its conditioning at the upscaled size and reads these for texture. */
  referenceImages?: string[];
  /**
   * The frames the shot was generated from, as ComfyUI input filenames. An I2V
   * shot carries no reference images at all, so these are the only image
   * anchoring its refine pass can be given.
   */
  firstFrame?: string;
  lastFrame?: string;
  plyUrl?: string | null;
  plyOriginalName?: string | null;
}

/**
 * The fields a downstream node is allowed to see of an upstream one.
 *
 * Pulled out of the hook so it can be tested directly, because one thing it has
 * to guarantee is not visible from inside a component: a shot re-placed from the
 * asset library must project to EXACTLY what the node that generated it
 * projected. Anything this reads and that library path does not restore is a
 * silent difference in the next upscale — same shot, different micro-detail.
 */
export function projectConnectedNode(
  node: { id: string; type?: string; data?: Record<string, any> },
  targetHandle?: string | null
): ConnectedInput {
  const d = (node.data ?? {}) as any;
  return {
    id: node.id,
    type: node.type,
    targetHandle,
    text: d?.text,
    url: d?.url,
    generatedUrl: d?.generatedUrl,
    comfyFilename: d?.comfyFilename,
    poseImageUrl: d?.poseImageUrl,
    depthImageUrl: d?.depthImageUrl,
    width: d?.width,
    height: d?.height,
    mediaType: d?.mediaType,
    fps: d?.fps,
    duration: d?.duration,
    label: d?.label,
    steps: d?.steps,
    length: d?.length,
    alias: d?.alias,
    latentFilename: d?.latentFilename,
    untrimmedUrl: typeof d?.untrimmedUrl === 'string' ? d.untrimmedUrl : undefined,
    contextFrames: Number(d?.contextFrames) || undefined,
    plyUrl: d?.plyUrl,
    plyOriginalName: d?.plyOriginalName,
    referenceImages: (d?.submittedResources?.reference_images || [])
      .map((r: any) => r?.comfy_filename)
      .filter(Boolean),
    firstFrame: d?.submittedResources?.first_frame?.comfy_filename,
    lastFrame: d?.submittedResources?.last_frame?.comfy_filename,
  };
}

