'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReactFlow, useStore as useFlowStore, type OnResizeEnd } from '@xyflow/react';
import { resolveMediaRatio, type NodeSizeSpec } from '@/lib/nodeSizing';

/**
 * A node whose height is never stored.
 *
 * The node's width is the only size it keeps (`data.userWidth`). The height is whatever the card's own layout makes of it:
 * the chrome rows flow at their natural height and the picture sits in a box whose CSS `aspect-ratio` is the picture's
 * own, so the card cannot end up taller or shorter than its media, and nothing has to be measured or solved for.
 *
 * Because a size written from outside (a tidy, an MCP edit, a canvas saved by an older build) used to stay on the node
 * until something re-ran the fit, this hook also takes the stored height off the node whenever one shows up: React Flow
 * then measures the card.
 */
export interface UseAutoHeightNodeOptions {
  id: string;
  /** Where the picture's ratio comes from while no media has loaded yet, best first (usually the node's data width/height). */
  ratioSources?: Array<{ width?: number | null; height?: number | null } | null | undefined>;
  /** The width the user dragged the node to (data.userWidth). */
  userWidth?: number | null;
  defaultW?: number;
  minW?: number;
  maxW?: number;
  hasMedia?: boolean;
  /** The settings drawer is open over a node that has media: the picture is hidden (NodeShell does it from the spec). */
  mediaHidden?: boolean;
}

export interface UseAutoHeightNodeResult {
  /** Picture width / height: the loaded media's own, else the first usable source, else 16:9. */
  ratio: number;
  /** For NodeShell: the width limits the resize handles keep to. No height is involved. */
  spec: NodeSizeSpec;
  /** Call with the media's natural size once it is known (<video> onLoadedMetadata, poster <img> onLoad). */
  onMediaSize: (width: number, height: number) => void;
  /** Hand to NodeShell. Stores the dragged width. */
  onResizeEnd: OnResizeEnd;
}

export function useAutoHeightNode({
  id,
  ratioSources = [],
  userWidth,
  defaultW = 420,
  minW = 220,
  maxW = 1400,
  hasMedia = true,
  mediaHidden = false,
}: UseAutoHeightNodeOptions): UseAutoHeightNodeResult {
  const { setNodes, updateNodeData } = useReactFlow();
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const ratio = resolveMediaRatio(natural, ...ratioSources);

  // What the node carries right now. Watching it re-runs the effect when a height (or a different width) is written.
  const stored = useFlowStore((s) => {
    const n = s.nodeLookup.get(id)?.internals.userNode;
    return n ? `${n.width ?? ''}x${n.height ?? ''}` : '';
  });

  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== id || n.resizing) return n;
        const width = Math.round(Math.min(maxW, Math.max(minW, userWidth ?? n.width ?? defaultW)));
        if (n.height === undefined && n.width === width) return n;
        return { ...n, width, height: undefined };
      }),
    );
  }, [id, setNodes, userWidth, defaultW, minW, maxW, stored]);

  const onMediaSize = useCallback((width: number, height: number) => {
    if (!width || !height) return;
    setNatural((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);

  const onResizeEnd = useCallback<OnResizeEnd>(
    (_, params) => {
      updateNodeData(id, { userWidth: Math.round(params.width) });
    },
    [id, updateNodeData],
  );

  const spec = useMemo<NodeSizeSpec>(
    () => ({ minW, minH: 0, chromeH: 0, ratio, hasMedia, mediaHidden: hasMedia && mediaHidden, defaultW, maxW }),
    [minW, ratio, hasMedia, mediaHidden, defaultW, maxW],
  );

  return { ratio, spec, onMediaSize, onResizeEnd };
}
