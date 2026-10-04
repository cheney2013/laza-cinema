import { useMemo } from 'react';

import { useConnectedInputs, type ConnectedInput } from './useConnectedInputs';
import { emptyAssets, type H3Assets, type H3Mode } from '@/lib/h3/spec';

/**
 * Resolves what an H3 node has wired up, in the exact order the model will see it.
 *
 * This is the single authority for `<Picture N>` / `<Video N>` / `<Audio N>` numbering.
 * The order below mirrors `backend/workflow_builders.py` (`all_images`), where the
 * reference-image slots are filled `first_frame`, then `last_frame`, then the
 * remaining references. Computing it anywhere else is how the prompt and the
 * workflow end up disagreeing about which picture is `<Picture 1>` — a mismatch
 * that produces a plausible video of the wrong thing, with no error anywhere.
 */

const IMAGE_HANDLES = new Set(['in-image', 'in-ref-image', 'in-character', 'in-style']);
const IMAGE_TYPES = new Set(['image', 'gaussian', 'inpaint']);
const VIDEO_HANDLES = new Set(['in-ref-video', 'in-video']);
const AUDIO_HANDLES = new Set(['in-ref-audio', 'in-audio']);

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'];

/** The backend rejects image files in the video/audio slots; mirror that here. */
function isTimeBasedMedia(url: string | null | undefined): boolean {
  if (!url) return false;
  const clean = url.split('?')[0].toLowerCase();
  return !IMAGE_EXTS.some((ext) => clean.endsWith(ext));
}

export function assetUrl(n: ConnectedInput): string {
  return (n.generatedUrl || n.url || '') as string;
}

export interface H3AssetResolution {
  /** Reference images in `<Picture N>` order. */
  imageNodes: ConnectedInput[];
  videoNodes: ConnectedInput[];
  audioNodes: ConnectedInput[];
  /** Ready to hand to `compileDirectorSpec`. */
  assets: H3Assets;
  isFirstFrameActive: boolean;
  firstFrameNodeId: string | null;
  /** Prompt text coming in on the prompt port, if any. */
  connectedPromptText: string;
  /** The mode the current wiring implies. */
  suggestedMode: H3Mode;
}

export interface H3AssetInputs {
  refImageOrder?: string[];
  useFirstFrame?: boolean;
  firstFrameNodeId?: string | null;
  length?: number;
  fps?: number;
}

export function useH3Assets(nodeId: string, data: H3AssetInputs): H3AssetResolution {
  const connected = useConnectedInputs(nodeId);

  return useMemo(() => {
    const rawImages = connected.filter(
      (n) =>
        n.mediaType !== 'audio' &&
        n.mediaType !== 'video' &&
        (IMAGE_TYPES.has(n.type || '') || IMAGE_HANDLES.has(n.targetHandle || '')),
    );

    const order = data.refImageOrder || [];
    const wired = order.length
      ? [...rawImages].sort((a, b) => {
          const ia = order.indexOf(a.id);
          const ib = order.indexOf(b.id);
          if (ia === -1 && ib === -1) return 0;
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        })
      : rawImages;

    // A node with references arriving only on the reference ports is not starting
    // from a first frame unless the user said so.
    const refOnly =
      wired.length > 0 && wired.every((n) => n.targetHandle !== 'in-image');
    // Wiring alone decides (the first-frame toggles are gone; see VideoGenNode).
    const isFirstFrameActive = !refOnly && wired.length > 0;

    // The first-frame port wins over a stored id, which goes stale on a rewire
    // (see VideoGenNode's firstFrameNode).
    const firstFrameNode = isFirstFrameActive
      ? wired.find((n) => n.targetHandle === 'in-image')
        || wired.find((n) => n.id === data.firstFrameNodeId)
        || wired[0]
      : null;

    const imageNodes = firstFrameNode
      ? [firstFrameNode, ...wired.filter((n) => n.id !== firstFrameNode.id)]
      : wired;

    const videoNodes = connected.filter(
      (n) => VIDEO_HANDLES.has(n.targetHandle || '') && isTimeBasedMedia(assetUrl(n)),
    );
    const audioNodes = connected.filter(
      (n) =>
        (n.mediaType === 'audio' || AUDIO_HANDLES.has(n.targetHandle || '')) &&
        isTimeBasedMedia(assetUrl(n)),
    );

    const connectedPromptText = connected
      .filter((n) => n.type === 'prompt' || n.targetHandle === 'in-prompt')
      .map((n) => n.text)
      .filter(Boolean)
      .join(' ');

    const suggestedMode: H3Mode =
      videoNodes.length > 0 || audioNodes.length > 0
        ? 'ref2va'
        : isFirstFrameActive
          ? imageNodes.length > 1
            ? 'ref2va'
            : 'i2va'
          : imageNodes.length > 0
            ? 'ref2va'
            : 't2va';

    const toRef = (n: ConnectedInput) => ({ nodeId: n.id, alias: n.alias || n.label || '' });

    return {
      imageNodes,
      videoNodes,
      audioNodes,
      assets: emptyAssets({
        images: imageNodes.map(toRef),
        videos: videoNodes.map(toRef),
        audios: audioNodes.map(toRef),
        totalFrames: data.length || 124,
        fps: data.fps || 24,
      }),
      isFirstFrameActive,
      firstFrameNodeId: firstFrameNode?.id ?? null,
      connectedPromptText,
      suggestedMode,
    };
  }, [
    connected,
    data.refImageOrder,
    data.useFirstFrame,
    data.firstFrameNodeId,
    data.length,
    data.fps,
  ]);
}
