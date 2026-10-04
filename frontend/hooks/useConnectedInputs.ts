import { useMemo } from 'react';
import { useStore } from '@/lib/store';
import { type ConnectedInput, projectConnectedNode } from '@/lib/connectedInput';

export { projectConnectedNode };
export type { ConnectedInput };

export function useConnectedInputs(nodeId: string): ConnectedInput[] {
  // The selector computes a stable JSON string from edges + node data only.
  // Node *position* changes are excluded so dragging nodes does NOT trigger
  // per-frame re-computation here.
  const inputsStr = useStore((state) => {
    const connectedEdges = state.edges.filter((e) => e.target === nodeId);
    const inputs = connectedEdges
      .map((edge) => {
        const sourceNode = state.nodes.find((n) => n.id === edge.source);
        if (!sourceNode) return null;
        return projectConnectedNode(sourceNode, edge.targetHandle);
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);
    return JSON.stringify(inputs);
  });

  return useMemo(() => JSON.parse(inputsStr), [inputsStr]);
}
