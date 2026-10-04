/**
 * data.audioLocks -> the backend's audio_locks. Mirrors _audio_lock_entries in
 * backend/canvas_mcp_server.py so the studio's run button submits what the MCP run
 * would: a recording (a canvas audio/video node, or a url) put on a second of the
 * DELIVERED clip and kept as recorded while the rest of the sound is generated.
 * Leaving the field out of the request would silently render the clip without it.
 */
export type AudioLockRequest = {
  url: string;
  at: number;
  strength: number;
  text: string;
  from?: number;
  to?: number;
};

type NodeLike = { id: string; data?: Record<string, unknown> };

export function resolveAudioLocks(entries: unknown, nodes: NodeLike[]): AudioLockRequest[] {
  if (!Array.isArray(entries)) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return entries.map((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`audioLocks[${i}] must be an object like {"node": "va-...", "at": 5, "strength": 1, "text": "..."}`);
    }
    const e = raw as Record<string, unknown>;
    let url = typeof e.url === 'string' && e.url ? e.url : '';
    if (!url && typeof e.node === 'string' && e.node) {
      const src = byId.get(e.node);
      if (!src) throw new Error(`audioLocks[${i}] names node ${e.node}, which is not on the canvas`);
      const d = src.data ?? {};
      url = (typeof d.url === 'string' && d.url) || (typeof d.generatedUrl === 'string' && d.generatedUrl) || '';
      if (!url) throw new Error(`audioLocks[${i}]: node ${e.node} has no audio yet`);
    }
    if (!url) throw new Error(`audioLocks[${i}] needs a "node" (canvas audio node id) or a "url"`);
    if (e.at === undefined || e.at === null) {
      throw new Error(`audioLocks[${i}] needs "at": the second of the delivered clip it starts on`);
    }
    const out: AudioLockRequest = {
      url,
      at: Number(e.at),
      strength: e.strength === undefined || e.strength === null ? 1 : Number(e.strength),
      text: typeof e.text === 'string' ? e.text : '',
    };
    if (e.from !== undefined && e.from !== null) out.from = Number(e.from);
    if (e.to !== undefined && e.to !== null) out.to = Number(e.to);
    return out;
  });
}
