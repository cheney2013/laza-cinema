import { useStore } from '@/lib/store';

/**
 * The prompt node wired into a node's `in-prompt`, and whether the two own each
 * other: exactly one prompt node comes in, and that prompt node feeds nothing
 * else. Only then can the receiving node edit the text in place and write it
 * back, because no other node reads it and no second prompt competes with it.
 *
 * Returns primitives so a node re-renders only when the binding itself changes.
 */
export function usePromptBinding(nodeId: string): { promptNodeId: string | null; exclusive: boolean } {
  const key = useStore((s) => {
    const incoming = s.edges.filter((e) => e.target === nodeId && e.targetHandle === 'in-prompt');
    const sources = incoming
      .map((e) => s.nodes.find((n) => n.id === e.source))
      .filter((n) => n?.type === 'prompt');
    if (sources.length === 0) return '';
    const only = sources.length === 1 ? sources[0]!.id : '';
    const exclusive = Boolean(only) && s.edges.filter((e) => e.source === only).length === 1;
    return `${sources[0]!.id}|${exclusive ? 1 : 0}`;
  });
  if (!key) return { promptNodeId: null, exclusive: false };
  const [promptNodeId, flag] = key.split('|');
  return { promptNodeId, exclusive: flag === '1' };
}
