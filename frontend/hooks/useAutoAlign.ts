import { useCallback } from 'react';
import { create } from 'zustand';
import { type Node, type NodeChange } from '@xyflow/react';

export type HelperLines = {
  horizontal?: number;
  vertical?: number;
};

/**
 * The lines live outside InfiniteCanvas on purpose (2026-09-05): as React state
 * there, every snap flip during a drag re-rendered the whole canvas component.
 * Only <HelperLines/> reads this store.
 */
export const useHelperLinesStore = create<{ lines: HelperLines; set: (l: HelperLines) => void }>((set) => ({
  lines: {},
  set: (lines) => set((st) => {
    if (st.lines.horizontal === lines.horizontal && st.lines.vertical === lines.vertical) return st;
    return { lines };
  }),
}));

export const useAutoAlign = (threshold = 8) => {
  const setHelperLines = (update: HelperLines | ((prev: HelperLines) => HelperLines)) => {
    const prev = useHelperLinesStore.getState().lines;
    const next = typeof update === 'function' ? update(prev) : update;
    if (next !== prev) useHelperLinesStore.getState().set(next);
  };

  const alignNodes = useCallback(
    (changes: NodeChange[], allNodes: Node[], zoom: number): NodeChange[] => {
      // Find the "primary" node being dragged or just dropped (usually the first one in changes)
      const positionChange = changes.find(
        (c): c is any => c.type === 'position' && c.dragging !== undefined && !!c.position
      );

      if (!positionChange) {
        setHelperLines((prev) => {
          if (prev.horizontal === undefined && prev.vertical === undefined) return prev;
          return {};
        });
        return changes;
      }

      // Convert threshold from screen pixels to flow units
      const flowThreshold = threshold / zoom;

      const draggedNode = allNodes.find((n) => n.id === positionChange.id);
      if (!draggedNode) return changes;

      const draggedNodeWidth = draggedNode.measured?.width ?? 0;
      const draggedNodeHeight = draggedNode.measured?.height ?? 0;

      const { x, y } = positionChange.position;
      let snappedX = x;
      let snappedY = y;
      let horizontalLine: number | undefined;
      let verticalLine: number | undefined;

      // Identify which nodes are currently being dragged or just dropped to avoid snapping to them
      const draggingNodeIds = new Set(
        changes
          .filter((c): c is any => c.type === 'position' && c.dragging !== undefined)
          .map((c) => c.id)
      );

      const nodesToCompare = allNodes.filter((n) => !draggingNodeIds.has(n.id));

      for (const node of nodesToCompare) {
        const nodeWidth = node.measured?.width ?? 0;
        const nodeHeight = node.measured?.height ?? 0;
        const nodeX = node.position.x;
        const nodeY = node.position.y;

        // Vertical Snap (Alignment on X axis)
        const xTargets = [
          { val: nodeX, line: nodeX }, // Left
          { val: nodeX + nodeWidth / 2, line: nodeX + nodeWidth / 2 }, // Center
          { val: nodeX + nodeWidth, line: nodeX + nodeWidth }, // Right
        ];

        const draggedXPoints = [
          { val: x, offset: 0 }, // Left
          { val: x + draggedNodeWidth / 2, offset: draggedNodeWidth / 2 }, // Center
          { val: x + draggedNodeWidth, offset: draggedNodeWidth }, // Right
        ];

        for (const target of xTargets) {
          for (const dragged of draggedXPoints) {
            if (Math.abs(target.val - dragged.val) < flowThreshold) {
              snappedX = target.val - dragged.offset;
              verticalLine = target.line;
            }
          }
        }

        // Horizontal Snap (Alignment on Y axis)
        const yTargets = [
          { val: nodeY, line: nodeY }, // Top
          { val: nodeY + nodeHeight / 2, line: nodeY + nodeHeight / 2 }, // Center
          { val: nodeY + nodeHeight, line: nodeY + nodeHeight }, // Bottom
        ];

        const draggedYPoints = [
          { val: y, offset: 0 }, // Top
          { val: y + draggedNodeHeight / 2, offset: draggedNodeHeight / 2 }, // Center
          { val: y + draggedNodeHeight, offset: draggedNodeHeight }, // Bottom
        ];

        for (const target of yTargets) {
          for (const dragged of draggedYPoints) {
            if (Math.abs(target.val - dragged.val) < flowThreshold) {
              snappedY = target.val - dragged.offset;
              horizontalLine = target.line;
            }
          }
        }
      }

      // Only show helper lines while actively dragging
      if (positionChange.dragging) {
        setHelperLines((prev) => {
          if (prev.horizontal === horizontalLine && prev.vertical === verticalLine) return prev;
          return { horizontal: horizontalLine, vertical: verticalLine };
        });
      } else {
        setHelperLines((prev) => {
          if (prev.horizontal === undefined && prev.vertical === undefined) return prev;
          return {};
        });
      }

      // Calculate the delta shift if any snapping occurred
      const shiftX = snappedX - x;
      const shiftY = snappedY - y;

      if (shiftX !== 0 || shiftY !== 0) {
        return changes.map((c) => {
          if (c.type === 'position' && c.dragging !== undefined && c.position) {
            return {
              ...c,
              position: {
                x: c.position.x + shiftX,
                y: c.position.y + shiftY,
              },
            };
          }
          return c;
        });
      }

      return changes;
    },
    [threshold]
  );

  return { alignNodes };
};
