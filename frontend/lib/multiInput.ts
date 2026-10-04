/**
 * Input ports that take several wires, for node types the store's connect rules have no branch of
 * their own for. The wire order is the numbering the prompt refers to (<image N>, <Picture N>), so
 * a second wire is added after the first rather than replacing it.
 *
 * 生成图片 (qwenImage) read "可多个" on its port but replaced the old wire on every new connection, so
 * only one reference could ever be connected (2026-10-03).
 */
const MULTI_INPUT: Record<string, readonly string[]> = {
  qwenImage: ['in-ref'],
  characterSheet: ['in-prop'],
  audioRefine: ['in-ref-image', 'in-ref-audio'],
  videoUpscale: ['in-ref-image'],
};

export function isMultiInputHandle(nodeType: string | undefined, handle: string | null | undefined): boolean {
  if (handle === 'in-style' || handle === 'in-prompt') return true;
  return Boolean(nodeType && handle && MULTI_INPUT[nodeType]?.includes(handle));
}
