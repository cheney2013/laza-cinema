/**
 * The motion-context chains on one canvas, head first.
 *
 * A chain is generated shots (`video` nodes) each continuing the one wired
 * into its `in-motion-context`. On a real canvas the link is not always direct:
 *
 * - a trim or edit-window node sits between two shots (C10 is cut to 7.5 s and
 *   the cut feeds C11), so those nodes are passed through, not listed;
 * - the first link often comes from outside the scene: a 链头接点 (a video node
 *   with no inputs at all, carrying the previous scene's last clip) or an
 *   imported finished clip (a media node). That is where the chain comes FROM,
 *   not a shot of it, so it is reported as `from` and gets no HD count.
 *
 * HD is made in chain order (every upscale mounts the previous segment's HD over
 * its overlap), so each chain reports which shots already have a finished
 * upscale and the first one that does not.
 */

interface NodeLike {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
}

interface EdgeLike {
  source: string;
  target: string;
  targetHandle?: string | null;
}

export interface ChainSegment {
  id: string;
  label: string;
  hd: boolean;
}

export interface Chain {
  /** First generated shot: where HD for this chain starts. */
  head: ChainSegment;
  /** What the head continues, when that is not a shot of this scene. */
  from: { id: string; label: string } | null;
  /** Generated shots, head first, depth-first where one is continued twice. */
  segments: ChainSegment[];
  /** A shot continued by more than one node (alternative continuations). */
  branched: boolean;
  /** First shot without a finished HD, in chain order; null when all are done. */
  nextHd: ChainSegment | null;
}

const MOTION = 'in-motion-context';
const SHOT = 'video';
/** Nodes a chain runs through: they re-cut a shot, they do not generate one. */
const PASS_THROUGH = new Set(['videoTrim', 'videoEdit']);

const labelOf = (node: NodeLike | undefined, id: string) => {
  const label = node?.data?.label;
  return typeof label === 'string' && label.trim() ? label.trim() : id;
};

export function findChains(nodes: NodeLike[], edges: EdgeLike[]): Chain[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hasInput = new Set(edges.map((e) => e.target));
  const next = new Map<string, string[]>();
  const continued = new Set<string>();
  const link = (from: string, to: string) => {
    const list = next.get(from) ?? [];
    if (!list.includes(to)) next.set(from, [...list, to]);
    continued.add(to);
  };
  for (const e of edges) {
    const source = byId.get(e.source);
    const target = byId.get(e.target);
    if (!source || !target) continue;
    if (e.targetHandle === MOTION) link(e.source, e.target);
    else if (PASS_THROUGH.has(target.type ?? '') && (source.type === SHOT || PASS_THROUGH.has(source.type ?? ''))) {
      link(e.source, e.target);
    }
  }

  // An HD counts only when it was made from the take the shot shows now: a shot
  // re-rendered after its HD has an HD of an older take. (A shot with no clip to
  // read a take from cannot be judged, so a finished HD stands.)
  const takeTag = (url: unknown) => (typeof url === 'string' ? url.match(/H3_(?:Video|Chunk|Full|Latent)_([0-9a-f]{8})/)?.[1] ?? '' : '');
  const hdDone = new Set<string>();
  // Something carries on from this node: a shot takes it as its motion context, directly or through more cuts.
  const continues = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    return edges.some((e) => {
      if (e.source !== id || !byId.has(e.target)) return false;
      if (e.targetHandle === MOTION) return true;
      const target = byId.get(e.target);
      return PASS_THROUGH.has(target?.type ?? '') && (e.targetHandle === 'in-video' || e.targetHandle == null) && continues(e.target, seen);
    });
  };
  const cutIsUsed = (parent: string, cut: string) =>
    continues(cut) ||
    (byId.get(cut)?.type === 'videoTrim' && !edges.some((e) => e.source === parent && e.targetHandle === MOTION));
  // HD is often made of the cut clip (C10 -> trim -> HD), not of the shot itself: walk back
  // from the HD's source through the trims to the shot. Such an HD stands for the shot only
  // while the first cut was made from the take the shot shows and the HD is of the last cut.
  const parentOf = (id: string) =>
    edges.find((e) => e.target === id && (e.targetHandle === 'in-video' || e.targetHandle == null) && byId.has(e.source))?.source;
  for (const e of edges) {
    const up = byId.get(e.target);
    const d = up?.data ?? {};
    if (up?.type !== 'videoUpscale' || d.status !== 'done' || !d.generatedUrl) continue;
    let from = e.source;
    const cuts: string[] = [];
    while (PASS_THROUGH.has(byId.get(from)?.type ?? '')) {
      cuts.unshift(from);
      const parent = parentOf(from);
      if (!parent) break;
      from = parent;
    }
    const shown = takeTag(byId.get(from)?.data?.generatedUrl);
    if (cuts.length === 0) {
      if (!shown || takeTag(d.compareUrl) === shown) hdDone.add(from);
      continue;
    }
    // A cut only stands for the shot when the film really goes on from it (mirror of the server's
    // `_cut_is_used`): a side-street edit nothing continues from is a try, and its HD is not the shot's.
    if (!cutIsUsed(from, cuts[0])) continue;
    const firstCut = byId.get(cuts[0])?.data ?? {};
    const plan = (firstCut.trimPlan ?? {}) as Record<string, unknown>;
    const cutFrom = takeTag(firstCut.sourceUrl ?? plan.source_url);
    const lastFile = byId.get(cuts[cuts.length - 1])?.data?.generatedUrl;
    // An edit-window node records no source take (backend `_hd_made_from_shown`): judged by its file alone.
    const unrecordedEdit = byId.get(cuts[0])?.type === 'videoEdit' && !cutFrom;
    if (!shown || ((cutFrom === shown || unrecordedEdit) && Boolean(lastFile) && d.compareUrl === lastFile)) hdDone.add(from);
  }

  // A generated shot: a video node that was made from inputs. One with no
  // inputs at all only carries a clip in from elsewhere.
  const isShot = (id: string) => byId.get(id)?.type === SHOT && hasInput.has(id);
  const position = (id: string) => byId.get(id)?.position ?? { x: 0, y: 0 };
  const leftToRight = (a: string, b: string) => position(a).x - position(b).x || position(a).y - position(b).y;

  const chains: Chain[] = [];
  for (const origin of [...next.keys()].filter((id) => !continued.has(id)).sort(leftToRight)) {
    const segments: ChainSegment[] = [];
    const seen = new Set<string>();
    let branched = false;
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      if (isShot(id)) segments.push({ id, label: labelOf(byId.get(id), id), hd: hdDone.has(id) });
      const after = [...(next.get(id) ?? [])].sort(leftToRight);
      if (after.length > 1 && isShot(id)) branched = true;
      after.forEach(walk);
    };
    walk(origin);
    if (segments.length === 0) continue;
    chains.push({
      head: segments[0],
      from: isShot(origin) ? null : { id: origin, label: labelOf(byId.get(origin), origin) },
      segments,
      branched,
      nextHd: segments.find((s) => !s.hd) ?? null,
    });
  }
  // Natural order by head label, so 场3 C9 comes before 场3 C12.
  const collator = new Intl.Collator('zh', { numeric: true });
  return chains.sort((a, b) => collator.compare(a.head.label, b.head.label));
}
