'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';

import { api } from '@/lib/api';
import { SequenceTabs } from './SequenceTabs';
import { showAlert, showConfirm } from '@/components/ui/Dialog';
import { useStore } from '@/lib/store';
import { bumpAssetVersion } from '@/lib/assetVersions';
import { BACKEND_URL, resolveAssetUrl } from '@/lib/config';
import { nativeDownloadUrl } from '@/lib/download';
import { probeVideo, useVideoProbe } from '@/lib/videoProbe';
import { Compositor } from '@/lib/editor/compositor';
import { timelineToSrt } from '@/lib/editor/srt';
import { languageName, subtitleLangOf, subtitleLangsOf, switchSubtitleLang } from '@/lib/editor/subtitleLang';
import { namesLiveOnCanvases, ownedByProject, unusedLibraryItems } from '@/lib/editor/unusedAssets';
import { flatTimelineOf, useCutRoom } from '@/lib/editor/store';
import { adjacentRuns, clipEnd, clipLength, formatTimecode, isNeutral, mergeRuns, timelineDuration, type Timeline } from '@/lib/editor/types';
import { attachMseSequence, type MseClip } from '@/lib/mseSequence';
import FrameSizePicker from './FrameSizePicker';
import CoverPicker from './CoverPicker';
import SubtitleStylePicker from './SubtitleStylePicker';
import SubtitleLangPicker from './SubtitleLangPicker';
import MonitorOverlay from './MonitorOverlay';
import Inspector from './Inspector';
import TimelineView, { BIN_DRAG_TYPE } from './TimelineView';

import type { Node as FlowNode } from '@xyflow/react';
import { t } from '@/lib/i18n';
const EMPTY_EDGES: never[] = [];
const EMPTY_NODES: FlowNode[] = [];

/** One piece of generated media offered to the cut room. */
interface BinItem {
  /** The canvas node that made it, when there is one. Library assets from an
   *  earlier session, or from another project, have no node and carry ''. */
  nodeId: string;
  url: string;
  title: string;
  kind: 'video' | 'audio' | 'image';
  /** When the node was created, from its id. */
  createdAt: number;
  /** File name, shown as the second line. */
  name: string;
  /** Marked as the accepted take of its shot: sorted to the top, badged. */
  final: boolean;
  /** The canvas node's own label (“场3 C14a ✓ …”), the name the director knows the shot by. */
  label: string;
  /** An older take still listed in a node's version history (data.takes):
   *  which node, and which version (1 = oldest). Empty for everything else. */
  takeOf?: { nodeId: string; version: number; total: number };
}

type BinView = 'final' | 'canvas' | 'history' | 'all';

const NODE_TITLES: Record<string, string> = {
  video: '视频镜头',
  videoUpscale: '高清视频',
  videoCompare: '视频对比',
  videoEdit: '改原片 · 动作不变',
  videoReshot: '重拍一段 · 前后不动',
  videoBridge: '重做中间',
  videoContinue: '镜头续写',
  videoFrames: '首尾帧补中间',
  videoInterpolate: '补帧视频',
  videoTrim: '剪切视频',
  depthVideo: '深度视频',
  inpaint: '局部重绘',
};

function CutRoom({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  // Subscribe to the canvas only while the room is open; closed, every drag
  // frame would rebuild canvasTitles for nothing.
  const nodes = useStore((s) => (isOpen ? s.nodes : EMPTY_NODES));
  const canvasEdges = useStore((s) => (isOpen ? s.edges : EMPTY_EDGES));
  const projectId = useStore((s) => s.currentProjectId);
  const projectName = useStore((s) => s.currentProjectName);
  const { setCenter, getNode, screenToFlowPosition } = useReactFlow();

  const timeline = useCutRoom((s) => s.timeline);
  // What the monitor plays: references to other films expanded into their clips.
  const playedTimeline = useCutRoom(flatTimelineOf);
  const activeSeqName = useCutRoom((s) => s.sequences.find((q) => q.id === s.activeSeqId)?.name);
  const playhead = useCutRoom((s) => s.playhead);
  const playing = useCutRoom((s) => s.playing);
  const pxPerFrame = useCutRoom((s) => s.pxPerFrame);
  const selection = useCutRoom((s) => s.selection);
  // Only the count matters here, so pasting into another tab does not re-render
  // this toolbar on every field of the copied clips.
  const clipboardCount = useCutRoom((s) => s.clipboard?.clips.length ?? 0);
  // Whether the transport button offers to bypass or to restore.
  const bypassedSelection = useCutRoom(
    (s) =>
      s.selection.length > 0 &&
      s.timeline.clips.filter((c) => s.selection.includes(c.id)).every((c) => c.bypassed)
  );
  // Merging is only offered when the selection really is one split apart.
  const mergeable = useCutRoom((s) => mergeRuns(s.timeline, s.selection).length > 0);
  // Flattening asks less of the selection — only that the pieces touch — and
  // pays for it with a render, so it is offered for exactly one run at a time.
  const flattenable = useCutRoom((s) => adjacentRuns(s.timeline, s.selection).length === 1);
  // Two loose clips can become a group; anything already grouped can be broken up.
  const groupable = useCutRoom(
    (s) =>
      s.selection.length > 1 &&
      s.timeline.clips.filter((c) => s.selection.includes(c.id)).some((c) => !c.groupId)
  );
  const ungroupable = useCutRoom((s) =>
    s.timeline.clips.some((c) => s.selection.includes(c.id) && c.groupId)
  );
  const snapping = useCutRoom((s) => s.snapping);
  const saving = useCutRoom((s) => s.saving);
  const exportStatus = useCutRoom((s) => s.exportStatus);
  const exportProgress = useCutRoom((s) => s.exportProgress);
  const exportUrl = useCutRoom((s) => s.exportUrl);
  const exportError = useCutRoom((s) => s.exportError);
  const scratch = useCutRoom((s) => s.scratch);
  const openingScratch = useCutRoom((s) => s.openingScratch);
  const exportTarget = useCutRoom((s) => s.exportTarget);
  // The export effect is declared above jumpToNode; it reaches it through this.
  const jumpToNodeRef = useRef<(nodeId: string) => void>(() => {});
  /** What became of the last single-clip export, shown in the status strip. */
  // What the running single-asset render is for. A lone clip is not a film: the
  // only two things to do with it are put it back over the original, or keep it
  // alongside — so that choice is made before the render, not after it.
  const [intent, setIntent] = useState<'overwrite' | 'saveAs' | null>(null);
  const [scratchResult, setScratchResult] = useState<string | null>(null);
  const [mseFailed, setMseFailed] = useState(false);

  const [adding, setAdding] = useState<string | null>(null);
  /** The bin row last clicked, so a click has a visible answer. */
  const [picked, setPicked] = useState<string | null>(null);
  /** The bin row whose file is being deleted. */
  const [deleting, setDeleting] = useState<string | null>(null);
  // Slow playback, for hearing exactly where a line starts. Pitch is kept
  // (the browser's preservesPitch), so speech stays readable at ½× and ¼×.
  const [playRate, setPlayRate] = useState(1);
  const playRateRef = useRef(1);
  playRateRef.current = playRate;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mseVideoRef = useRef<HTMLVideoElement>(null);
  const compositorRef = useRef<Compositor | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  const duration = timelineDuration(timeline);

  // MSE is exact for a single uninterrupted lane of plain hard cuts. Anything
  // composited or transformed stays on the canvas path so preview remains an
  // honest representation of export.
  const msePlan = useMemo(() => {
    const videoTracks = playedTimeline.tracks.filter((track) => track.kind === 'video' && !track.muted && !track.bypassed);
    const audioClips = playedTimeline.clips.filter((clip) => {
      const track = playedTimeline.tracks.find((candidate) => candidate.id === clip.trackId);
      return !clip.bypassed && !track?.bypassed && track?.kind === 'audio';
    });
    if (videoTracks.length !== 1 || audioClips.length) return null;
    const track = videoTracks[0];
    const clips = playedTimeline.clips
      .filter((clip) => clip.trackId === track.id && !clip.bypassed)
      .sort((a, b) => a.start - b.start);
    if (!clips.length) return null;
    let cursor = 0;
    const sequence: MseClip[] = [];
    for (const clip of clips) {
      const asset = playedTimeline.assets[clip.assetId];
      const plain =
        !clip.text && asset?.kind === 'video' && !asset.offline && clip.start === cursor &&
        (clip.speed || 1) === 1 && !clip.transitionIn && !clip.crop && !(clip.rotate || 0) &&
        !clip.flipH && !clip.flipV && !(clip.zoom && Math.abs(clip.zoom - 1) > 0.001) &&
        !clip.offsetX && !clip.offsetY && (!clip.fit || clip.fit === 'contain') &&
        isNeutral(clip.filters) && !clip.muted && (clip.volume ?? 1) === 1 &&
        !clip.fadeIn && !clip.fadeOut;
      if (!plain) return null;
      const frames = clipLength(clip);
      sequence.push({
        url: asset.proxyUrl || asset.url,
        start: clip.inFrame / playedTimeline.fps,
        duration: frames / playedTimeline.fps,
      });
      cursor += frames;
    }
    return sequence;
  }, [playedTimeline]);
  const msePlanKey = msePlan?.map((clip) => `${clip.url}@${clip.start}:${clip.duration}`).join('|') ?? '';

  useEffect(() => {
    const video = mseVideoRef.current;
    if (!isOpen || !video || !msePlan) return;
    setMseFailed(false);
    return attachMseSequence(video, msePlan, {
      width: timeline.width,
      height: timeline.height,
      fps: timeline.fps,
      onError: () => setMseFailed(true),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, msePlanKey, timeline.width, timeline.height, timeline.fps]);

  useEffect(() => {
    const video = mseVideoRef.current;
    if (!video || !msePlan) return;
    video.loop = false;
    if (Math.abs(video.currentTime - playhead / timeline.fps) > 0.18) {
      video.currentTime = playhead / timeline.fps;
    }
    if (playing) void video.play().catch(() => {});
    else video.pause();
  }, [msePlanKey, playing, playhead, timeline.fps]);

  // How many clips each library asset already accounts for on the timeline —
  // the bin is a list you pull from repeatedly, and "did that click land?" is
  // the question it has to answer.
  const usedByUrl = useMemo(() => {
    const counts = new Map<string, number>();
    for (const clip of timeline.clips) {
      const url = timeline.assets[clip.assetId]?.url;
      if (url) counts.set(url, (counts.get(url) ?? 0) + 1);
    }
    return counts;
  }, [timeline.clips, timeline.assets]);

  // ── Media bin ───────────────────────────────────────────────────────────────
  // Everything in the library, not only what happens to be on the canvas right
  // now: a cut is assembled from takes, and takes outlive the nodes that made
  // them. The canvas is still consulted, but only to name a shot after the node
  // that produced it.
  const [libraryClips, setLibraryClips] = useState<
    Array<{ url: string; name: string; modified: number; kind: 'video' | 'audio' | 'image'; bytes: number; owned: boolean }>
  >([]);

  useEffect(() => {
    if (!isOpen || scratch) return;
    let live = true;
    void api
      .listAssets(projectId)
      .then((data) => {
        if (!live) return;
        // Sound belongs in the bin as much as picture does: music, ambience and
        // detached dialogue are cut on the A tracks, and a cut room that only
        // lists video has no way to bring them in at all. Stills come in too:
        // they sit on the timeline as held frames and take the same grade.
        setLibraryClips(
          data.assets
            .filter((a) => a.kind === 'video' || a.kind === 'audio' || a.kind === 'image')
            .map((a) => ({
              url: a.url,
              name: a.name,
              modified: a.modified,
              kind: a.kind as 'video' | 'audio' | 'image',
              bytes: a.size + a.companion_size,
              // Only this project's own files may be cleaned up from here.
              owned: projectId ? ownedByProject(a, projectId) : false,
            }))
        );
      })
      .catch(() => setLibraryClips([]));
    return () => {
      live = false;
    };
  }, [isOpen, scratch, projectId]);

  const canvasTitles = useMemo(() => {
    const byUrl = new Map<string, { nodeId: string; title: string; label: string; accepted: boolean }>();
    nodes.forEach((node) => {
      const data = node.data as Record<string, unknown> | undefined;
      if (!data) return;
      const url = (data.generatedUrl || data.url) as string | undefined;
      if (!url || typeof url !== 'string') return;
      const label = typeof data.label === 'string' ? data.label : '';
      byUrl.set(url, {
        nodeId: node.id,
        title: t(NODE_TITLES[node.type ?? ''] ?? '素材片段'),
        label,
        // A label that says the take was accepted counts as the 成片 mark too:
        // that is how the canvas records a director's sign-off today.
        accepted: /✓|定版/.test(label),
      });
    });
    return byUrl;
  }, [nodes]);

  // Older takes each node still keeps in its version list, by url. The canvas
  // only points at the current one, so without this an old take is an orphan
  // file in 全部文件 with nothing saying which shot it was.
  const takeOwners = useMemo(() => {
    const byUrl = new Map<string, { nodeId: string; label: string; version: number; total: number }>();
    nodes.forEach((node) => {
      const data = node.data as Record<string, unknown> | undefined;
      const takes = (data?.takes as { url?: string | null; createdAt?: number }[] | undefined) || [];
      const done = takes.filter((tk) => typeof tk.url === 'string' && tk.url);
      if (done.length === 0) return;
      const label = typeof data?.label === 'string' ? data.label : node.id;
      // takes are newest first; number them oldest = 1.
      done.forEach((tk, i) =>
        byUrl.set(tk.url as string, { nodeId: node.id, label, version: done.length - i, total: done.length })
      );
    });
    return byUrl;
  }, [nodes]);

  // Which library files are the accepted takes. The flag lives on the canvas
  // node (data.final) because that is what the studio and the MCP both write;
  // the bin resolves it by url, so a take keeps its mark even after the node
  // has moved on to a newer render.
  const finalUrls = useMemo(() => {
    const urls = new Set<string>();
    nodes.forEach((node) => {
      const data = node.data as Record<string, unknown> | undefined;
      if (!data || data.final !== true) return;
      const url = (data.generatedUrl || data.url) as string | undefined;
      if (typeof url === 'string' && url) urls.add(url);
    });
    return urls;
  }, [nodes]);

  // Marking is done from the bin because that is where takes are compared.
  // Only a clip a live node still points at can be marked: the flag has to live
  // somewhere the canvas saves.
  const toggleFinal = useCallback((item: BinItem) => {
    if (!item.nodeId) return;
    const { nodes: current, setNodes } = useStore.getState();
    setNodes(
      current.map((node) =>
        node.id === item.nodeId
          ? { ...node, data: { ...(node.data as object), final: !item.final } }
          : node
      )
    );
  }, []);

  const bin = useMemo<BinItem[]>(() => {
    const items: BinItem[] = libraryClips.map((clip) => {
      const source = canvasTitles.get(clip.url);
      const take = takeOwners.get(clip.url);
      return {
        nodeId: source?.nodeId ?? '',
        url: clip.url,
        title: source?.title ?? (clip.kind === 'audio' ? t('音频素材') : clip.kind === 'image' ? t('图片素材') : t('素材片段')),
        kind: clip.kind,
        // The file's own timestamp: a library asset has no node id to read a
        // creation time out of.
        createdAt: clip.modified * 1000,
        name: clip.name,
        final: finalUrls.has(clip.url) || !!source?.accepted,
        label: source?.label ?? take?.label ?? '',
        takeOf: take ? { nodeId: take.nodeId, version: take.version, total: take.total } : undefined,
      };
    });
    // Accepted takes first, then the version each canvas node currently shows,
    // then everything else (older takes, orphans), newest first within each:
    // a bin holding every take of every shot is otherwise no help in telling the
    // one on the canvas from the six that were replaced.
    const rank = (i: BinItem) => (i.final ? 0 : i.nodeId ? 1 : 2);
    return items.sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
  }, [libraryClips, canvasTitles, finalUrls, takeOwners]);

  // What a clip on the timeline is called: the shot's label, with the version
  // in front when the shot has more than one ("第3版 场4 C27 …"). The node type
  // (视频镜头) says nothing about which shot it is.
  const assetTitles = useMemo(() => {
    const titles: Record<string, string> = {};
    for (const item of bin) {
      if (!item.label) continue;
      titles[item.url] =
        item.takeOf && item.takeOf.total > 1
          ? `${t('第{v1}版', { v1: item.takeOf.version })} ${item.label}`
          : item.label;
    }
    return titles;
  }, [bin]);
  useEffect(() => {
    if (isOpen && Object.keys(assetTitles).length) useCutRoom.getState().retitleAssets(assetTitles);
  }, [isOpen, assetTitles]);

  // 换成高清版: every 高清视频 node that has finished, keyed by the file it was
  // made from (the node wired into it). A rough-cut clip whose file is such a
  // source can be relinked to the upscale with its cut untouched. A cut spans
  // scenes, so the other scenes' upscales come from the backend; the open
  // canvas is layered on top, being the freshest (a job that just finished may
  // not be saved yet).
  const [projectHd, setProjectHd] = useState<Record<string, { url: string; headFrames: number }>>({});
  useEffect(() => {
    if (!isOpen || !projectId) return;
    let cancelled = false;
    api.projectHdMap(projectId)
      .then((res) => { if (!cancelled) setProjectHd(res.map || {}); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen, projectId, nodes]);
  const hdMap = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const map: Record<string, { url: string; headFrames: number }> = { ...projectHd };
    for (const node of nodes) {
      if (node.type !== 'videoUpscale') continue;
      const nd = node.data as Record<string, unknown>;
      // The full file when the result was served cut; headFrames lead it.
      const hd = nd?.untrimmedUrl || nd?.generatedUrl;
      if (typeof hd !== 'string' || !hd) continue;
      // An upscale made from the untrimmed render carries the overlap too.
      const headFrames = Number(nd?.overlapFrames) || 0;
      for (const edge of canvasEdges as { source: string; target: string; targetHandle?: string | null }[]) {
        // in-video only: boards wired to in-ref-image are not its source
        if (edge.target !== node.id || (edge.targetHandle && edge.targetHandle !== 'in-video')) continue;
        const data = byId.get(edge.source)?.data as Record<string, unknown> | undefined;
        const src = (data?.generatedUrl || data?.url) as string | undefined;
        if (typeof src === 'string' && src) map[src] = { url: hd, headFrames };
      }
    }
    return map;
  }, [nodes, canvasEdges, projectHd]);
  // Chained shots: the node's clip has its head overlap cut off; the untrimmed
  // render (data.untrimmedUrl) still has it, contextFrames long.
  const chainMap = useMemo(() => {
    const map: Record<string, { url: string; frames: number }> = {};
    for (const node of nodes) {
      const data = node.data as Record<string, unknown> | undefined;
      const url = data?.generatedUrl;
      const full = data?.untrimmedUrl;
      const frames = Number(data?.contextFrames) || 0;
      if (typeof url === 'string' && url && typeof full === 'string' && full && frames > 0) {
        map[url] = { url: full, frames };
      }
    }
    return map;
  }, [nodes]);
  const chainPending = Object.values(timeline.assets).filter((a) => !a.chainHead && chainMap[a.url]).length;
  const hdPending = Object.values(timeline.assets).filter(
    (a) => !a.roughUrl && (hdMap[a.url] || (a.chainHead && hdMap[a.chainHead.trimmedUrl]))
  ).length;
  const hdDone = Object.values(timeline.assets).filter((a) => a.roughUrl).length;
  const [relinking, setRelinking] = useState(false);
  const relink = useCallback(async (map: Record<string, { url: string; headFrames: number }>, direction: 'hd' | 'rough') => {
    setRelinking(true);
    try {
      await useCutRoom.getState().relinkAssets(map, direction);
    } finally {
      setRelinking(false);
    }
  }, []);

  // Fuzzy find over file name, node id and title. Every space-separated word
  // must hit, either as a plain substring or as its letters in order ("h3v1a"
  // finds H3_Video_1a…); substring hits rank above scattered ones.
  const [query, setQuery] = useState('');
  // What the bin lists. 成片: the accepted take of each shot, in shot order --
  // what a cut is assembled from. 画布当前: the version every canvas node shows
  // now, accepted or not. 全部文件: the whole library, old takes included.
  const [view, setView] = useState<BinView>('final');
  const viewItems = useMemo(() => {
    if (view === 'all') return bin;
    if (view === 'history') {
      // Every version of every node that has more than one, grouped by shot,
      // newest version first within a shot.
      const collator = new Intl.Collator('zh', { numeric: true });
      const keep = bin.filter((i) => i.takeOf && i.takeOf.total > 1);
      const shot = (i: BinItem) => takeOwners.get(i.url)?.label ?? '';
      return [...keep]
        .sort((a, b) => collator.compare(shot(a), shot(b)) || b.takeOf!.version - a.takeOf!.version)
        .map((i) => ({ ...i, label: shot(i) }));
    }
    const keep = bin.filter((i) => i.nodeId && (view === 'canvas' || i.final));
    // Shot order: the label ("场3 C12b …") sorts naturally, so C9 < C10 < C12a < C12b.
    const collator = new Intl.Collator('zh', { numeric: true });
    return [...keep].sort((a, b) => collator.compare(a.label || a.name, b.label || b.name));
  }, [bin, view, takeOwners]);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return viewItems;
    const scored: { item: BinItem; score: number }[] = [];
    for (const item of viewItems) {
      const hay = `${item.label} ${item.name} ${item.nodeId} ${item.title} ${item.url}`.toLowerCase();
      let score = 0;
      let ok = true;
      for (const word of words) {
        if (hay.includes(word)) {
          score += 2;
          continue;
        }
        let at = 0;
        for (const ch of word) {
          at = hay.indexOf(ch, at);
          if (at < 0) break;
          at += 1;
        }
        if (at < 0) {
          ok = false;
          break;
        }
        score += 1;
      }
      if (ok) scored.push({ item, score });
    }
    // Stable sort keeps the accepted-first, newest-first order within a score.
    return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
  }, [viewItems, query]);

  useEffect(() => {
    useCutRoom.getState().setOpen(isOpen);
    return () => useCutRoom.getState().setOpen(false);
  }, [isOpen]);

  // ── Load the project's timeline when the cut room opens ─────────────────────
  useEffect(() => {
    if (!isOpen || !projectId) return;
    // A lone clip is not the project's cut. `openingScratch` counts as well:
    // opening one is asynchronous and the room is told to open in the same
    // breath, so on a big file (its probe builds a proxy) `scratch` is not set
    // yet and the load would land on top of the tab being built.
    const cut = useCutRoom.getState();
    if (cut.scratch || cut.openingScratch) return;
    if (cut.projectId !== projectId) {
      void useCutRoom.getState().load(projectId);
    }
    // Both scratch flags are in the deps: leaving a lone-clip tab is the moment
    // the project's own films are wanted, and the room is not reopened in
    // between to re-run this.
  }, [isOpen, projectId, openingScratch, scratch]);

  // ── Land on the clip the asset library asked for ────────────────────────────
  // Only once the load has settled: opening the cut room for a project it does
  // not already hold triggers a load, and a load clears the selection.
  const loadingTimeline = useCutRoom((s) => s.loading);
  const focusClipId = useCutRoom((s) => s.focusClipId);
  useEffect(() => {
    if (!isOpen || loadingTimeline || !focusClipId) return;
    useCutRoom.getState().consumeFocusClip();
  }, [isOpen, loadingTimeline, focusClipId, timeline]);

  // ── Master clock and compositor ─────────────────────────────────────────────
  // One loop drives everything while the cut room is open: it advances the
  // playhead from wall time when playing, and repaints the monitor either way,
  // so a scrub, a trim and a colour change all show up immediately.
  useEffect(() => {
    if (!isOpen) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const compositor = new Compositor(canvas);
    compositorRef.current = compositor;
    lastTickRef.current = performance.now();

    const tick = (now: number) => {
      const store = useCutRoom.getState();
      const elapsed = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;

      const mseVideo = mseVideoRef.current;
      const mseActive = Boolean(msePlan && !mseFailed && mseVideo && playRateRef.current === 1);
      if (store.playing && mseActive && mseVideo) {
        store.setPlayhead(Math.min(timelineDuration(store.timeline), mseVideo.currentTime * store.timeline.fps));
      } else if (store.playing) {
        const total = timelineDuration(store.timeline);
        const next = store.playhead + elapsed * store.timeline.fps * playRateRef.current;
        if (next >= total) {
          store.setPlayhead(total);
          store.setPlaying(false);
        } else {
          store.setPlayhead(next);
        }
      }
      compositor.setRate(playRateRef.current);
      compositor.setPlaying(mseActive ? false : useCutRoom.getState().playing);
      // A crop is chosen against the WHOLE picture: the part being cut away has
      // to stay on screen to be dragged back in. The clip is drawn uncropped and
      // fitted whole for as long as the handles are up; the overlay places them
      // against exactly this substitution.
      const draft = store.cropDraft;
      const played = flatTimelineOf(store);
      const shown = draft
        ? {
            ...played,
            clips: played.clips.map((c) =>
              c.id === draft.clipId ? { ...c, crop: undefined, fit: 'contain' as const } : c
            ),
          }
        : played;
      if (!mseActive) compositor.render(shown, useCutRoom.getState().playhead);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      compositor.dispose();
      compositorRef.current = null;
    };
  }, [isOpen, msePlanKey, mseFailed]);

  useEffect(() => {
    if (!scratch || !intent || exportStatus !== 'completed' || !exportUrl) return;
    const chosen = intent;
    setIntent(null);
    if (chosen === 'saveAs') {
      setScratchResult(t('已另存为新素材：{v1}', { v1: exportUrl.split('/').pop() ?? '' }));
      return;
    }
    setScratchResult(t('正在覆盖原素材…'));
    api
      .replaceAsset(scratch.name, exportUrl)
      .then((result) => {
        // The url did not change, so nothing showing this file would ever ask
        // for it again: the version makes it a new address to the browser, and
        // the re-probe replaces the proxy, thumbnails, peaks and length that
        // still describe the file as it was before it was overwritten.
        bumpAssetVersion(result.url);
        void useCutRoom.getState().refreshAssetByUrl(result.url);
        setScratchResult(
          t('已覆盖 {v1}{v2}', {
            v1: scratch.name,
            v2: result.dropped_latents.length ? t('，并清理了它的潜空间文件') : '',
          })
        );
      })
      .catch((e: Error) => setScratchResult(t('覆盖失败：{v1}', { v1: e.message })));
  }, [scratch, intent, exportStatus, exportUrl]);

  // A finished film goes straight to the browser's downloads; the link in the outcome bar repeats it.
  // Only a film exported for download lives under uploads/exports/.
  const downloadHref =
    !scratch && exportUrl?.startsWith('/uploads/exports/')
      ? nativeDownloadUrl(exportUrl, `${[projectName || 'cut', activeSeqName].filter(Boolean).join('_')}.mp4`, BACKEND_URL)
      : null;
  const downloadedUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!downloadHref || exportStatus !== 'completed' || downloadedUrl.current === downloadHref) return;
    downloadedUrl.current = downloadHref;
    const link = document.createElement('a');
    link.href = downloadHref;
    link.download = '';
    link.click();
  }, [downloadHref, exportStatus]);

  // A single clip's render goes back to the canvas as an upload node, the same
  // shape 素材库's 放到画布 makes — the canvas is the record, so a shot that came
  // out of the cut room has to arrive there as a node, not as a loose file.
  useEffect(() => {
    if (exportTarget !== 'canvas') return;
    if (exportStatus !== 'completed' || !exportUrl) return;
    const url = exportUrl;
    // Read once and clear immediately: the effect re-runs on any store change,
    // and the node must be dropped exactly once.
    useCutRoom.getState().dismissExport();

    const audio = /\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(url);
    // No cancel-on-cleanup here: dismissExport() above changes exportTarget, so
    // this effect's cleanup runs before the probe resolves. A `live` flag set
    // false there dropped every clip before it reached the canvas.
    void probeVideo(resolveAssetUrl(url), audio ? 'audio' : 'video')
      .then((probe) => {
        const centre = screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        });
        const boxWidth = 240;
        // Sound has no picture to size the box from; the upload node draws a
        // fixed player strip for it.
        const boxHeight = audio
          ? 120
          : probe.w && probe.h
            ? 32 + Math.min(Math.round((boxWidth * probe.h) / probe.w), 480)
            : undefined;
        // Nearest free spot to the view centre: rings of grid cells outward, first
        // cell whose box (plus a margin) touches no existing node wins.
        const existing = useStore.getState().nodes;
        const w = boxWidth;
        const h = boxHeight ?? 200;
        const gap = 40;
        const hits = (x: number, y: number) => existing.some((n) => {
          const nw = n.measured?.width ?? n.width ?? 300;
          const nh = n.measured?.height ?? n.height ?? 300;
          return x < n.position.x + nw + gap && x + w + gap > n.position.x
            && y < n.position.y + nh + gap && y + h + gap > n.position.y;
        });
        let position = { x: centre.x - w / 2, y: centre.y - h / 2 };
        search: for (let r = 0; r <= 40; r++) {
          for (let i = -r; i <= r; i++) {
            for (let j = -r; j <= r; j++) {
              if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
              const x = centre.x - w / 2 + i * (w + gap);
              const y = centre.y - h / 2 + j * (h + gap);
              if (!hits(x, y)) { position = { x, y }; break search; }
            }
          }
        }
        window.dispatchEvent(new Event('takeSnapshot'));
        const nodeId = `image-${Date.now()}`;
        useStore.getState().setNodes([
          ...existing,
          {
            id: nodeId,
            type: 'image',
            position,
            // Backend-relative path: resolveAssetUrl adds the host on read.
            data: { url, mediaType: audio ? 'audio' : 'video' },
            ...(boxHeight ? { width: boxWidth, height: boxHeight } : {}),
          },
        ]);
        // The dialog outlives this effect's cleanup on purpose: the node is
        // already on the canvas, so the receipt stands even if the store moves on.
        void showConfirm(t('已放到画布：{v1}', { v1: url.split('/').pop() ?? '' }), {
          title: t('片段已导出'),
          confirmText: t('在画布中定位'),
          cancelText: t('好的'),
        }).then((locate) => {
          if (locate) jumpToNodeRef.current(nodeId);
        });
      })
      .catch((e: Error) => {
        void showAlert(t('放到画布失败：{v1}', { v1: e.message }), { title: t('片段导出失败'), confirmText: t('好的') });
      });
  }, [exportTarget, exportStatus, exportUrl, screenToFlowPosition]);

  const togglePlay = useCallback(() => {
    // An AudioContext may only be created from a gesture, so it is built here
    // rather than when the compositor is constructed.
    compositorRef.current?.ensureAudio();
    const store = useCutRoom.getState();
    if (!store.playing && store.playhead >= timelineDuration(store.timeline)) store.setPlayhead(0);
    store.setPlaying(!store.playing);
  }, []);

  // ── Keyboard ────────────────────────────────────────────────────────────────
  // The cut room owns the keyboard while it is open. Its handler runs in the
  // capture phase on `window` — ahead of every other listener in the app — and
  // stops the event dead afterwards, so a key pressed here never also reaches
  // the canvas, a node, or the assistant behind it. Typing is unaffected:
  // propagation is stopped, the default action is not.
  useEffect(() => {
    if (!isOpen) return;

    // A global <DialogHost> dialog sits above everything, this mode included, and
    // runs its own capture-phase handler. While one is open it owns the keyboard:
    // we neither act on keys nor swallow them.
    const dialogOpen = () => Boolean(document.querySelector('[data-app-dialog]'));

    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen()) return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      );
      // The one field that handles its own keys: the timeline's rename box needs
      // Enter and Escape. This listener runs at window capture, ahead of React's
      // own root listener, so swallowing here would kill that box's handler
      // before it ever fires. It stops propagation itself instead.
      if (typing && target?.dataset.clipRename !== undefined) return;
      // Stop first: even a key this component ignores must not fall through to
      // the canvas, and a key typed into a field here is nobody else's business.
      event.stopImmediatePropagation();
      if (typing) return;

      const store = useCutRoom.getState();
      const meta = event.ctrlKey || event.metaKey;

      // Ctrl+G / Ctrl+Shift+G, the binding every NLE uses. Checked before the
      // plain-key switch so a bare G stays free.
      if (meta && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        if (event.shiftKey) store.ungroupSelection();
        else store.groupSelection();
        return;
      }
      if (meta && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        // 锁轨上的片段选中了也不能动，选进来只会让删除/移动看起来漏做了。
        const locked = new Set(store.timeline.tracks.filter((t) => t.locked).map((t) => t.id));
        store.setSelection(
          store.timeline.clips.filter((c) => !locked.has(c.trackId)).map((c) => c.id)
        );
        return;
      }
      // Ctrl+C / Ctrl+V. The clipboard lives on the store rather than in the
      // session, so what is copied in one film pastes into another tab.
      // Typing was already handled above: in a text field these never get here
      // and the browser's own copy/paste runs.
      if (meta && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        store.copySelection();
        return;
      }
      if (meta && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        store.pasteClipboard();
        return;
      }
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      switch (event.key) {
        case ' ':
          event.preventDefault();
          // Play/pause fires on keyup, not here: while space is down the
          // timeline pans under a left-drag, and a press that panned must not
          // also start playback. Holding the key therefore does nothing but arm
          // the pan — no auto-repeat to guard against either.
          if (!event.repeat) store.setSpaceHeld(true);
          break;
        case 's':
        case 'S':
          event.preventDefault();
          if (!event.repeat) store.splitAtPlayhead();
          break;
        case 'm':
        case 'M':
          event.preventDefault();
          if (!event.repeat) store.mergeSelection();
          break;
        // J slower, L back to normal: ½× and ¼× for placing an audio cut.
        case 'j':
        case 'J':
          event.preventDefault();
          setPlayRate((r) => (r > 0.5 ? 0.5 : 0.25));
          break;
        case 'l':
        case 'L':
          event.preventDefault();
          setPlayRate(1);
          break;
        case 'b':
        case 'B':
          event.preventDefault();
          if (!event.repeat) store.toggleBypass();
          break;
        case 't':
        case 'T':
          event.preventDefault();
          store.addTextClip();
          break;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          store.deleteSelection();
          break;
        // D / F sit under the left hand while the right one stays on the mouse,
        // which is how frame-by-frame checking actually gets done. The arrows do
        // the same thing for anyone reaching for them.
        case 'ArrowLeft':
        case 'd':
        case 'D':
          event.preventDefault();
          // Stepping means looking at one frame: stop playback first.
          if (store.playing) store.setPlaying(false);
          store.setPlayhead(Math.round(store.playhead) - (event.shiftKey ? store.timeline.fps : 1));
          break;
        case 'ArrowRight':
        case 'f':
        case 'F':
          event.preventDefault();
          // Stepping means looking at one frame: stop playback first.
          if (store.playing) store.setPlaying(false);
          store.setPlayhead(Math.round(store.playhead) + (event.shiftKey ? store.timeline.fps : 1));
          break;
        case 'ArrowUp':
        case 'ArrowDown': {
          event.preventDefault();
          // Jump between cut points — the edges you actually want to land on.
          const edges = [0, ...store.timeline.clips.flatMap((c) => [c.start, clipEnd(c)])]
            .sort((a, b) => a - b);
          const next =
            event.key === 'ArrowDown'
              ? edges.find((e) => e > store.playhead)
              : [...edges].reverse().find((e) => e < store.playhead);
          if (next !== undefined) store.setPlayhead(next);
          break;
        }
        case '=':
        case '+':
          store.setPxPerFrame(store.pxPerFrame * 1.4);
          break;
        case '-':
          store.setPxPerFrame(store.pxPerFrame / 1.4);
          break;
        case 'Escape':
          onClose();
          break;
        default:
          break;
      }
    };
    // keyup and keypress carry no cut-room bindings, but plenty of components
    // listen for them; they get swallowed too so nothing acts on half a press.
    const swallow = (event: KeyboardEvent) => {
      if (dialogOpen()) return;
      event.stopImmediatePropagation();
      if (event.type === 'keyup' && event.key === ' ') {
        const store = useCutRoom.getState();
        // Only a press this handler armed counts: a space typed into a field
        // returns before the keydown branch, and its keyup must not play.
        if (store.spaceHeld && !store.spacePanned) togglePlay();
        store.setSpaceHeld(false);
      }
    };

    // Alt-tabbing away while space is down never delivers the keyup, and the
    // timeline would stay in pan mode until the next press.
    const onBlur = () => useCutRoom.getState().setSpaceHeld(false);

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', swallow, true);
    window.addEventListener('keypress', swallow, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', swallow, true);
      window.removeEventListener('keypress', swallow, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [isOpen, onClose, togglePlay]);

  // Double-click / Enter: insert at the playhead (not the end of the film).
  // A drop on the timeline passes its own track and frame.
  const addToTimeline = useCallback(async (item: BinItem, place?: { trackId?: string; at: number }) => {
    setPicked(item.url);
    setAdding(item.url);
    try {
      const assetId = await useCutRoom.getState().addAsset({ ...item, title: assetTitles[item.url] || item.title });
      if (chainMap[item.url]) await useCutRoom.getState().openChainHeads({ [item.url]: chainMap[item.url] });
      const at = place ? place.at : useCutRoom.getState().playhead;
      if (assetId) useCutRoom.getState().appendClip(assetId, place?.trackId, at, Boolean(place));
    } finally {
      setAdding(null);
    }
  }, [assetTitles, chainMap]);

  /**
   * Throw a take away from the room where you can see it is a bad take.
   *
   * The bin is where rejects become obvious, so culling belongs here — but this
   * deletes the file, not a row in a list. Everything that will notice is named
   * before the fact: the clips already cut from it, the canvas node that made
   * it, and the latent that goes with it (which is where the disk space is).
   */
  const deleteAsset = useCallback(
    async (item: BinItem, usedClips: number) => {
      const warnings = [
        usedClips > 0
          ? t('时间线上有 {n} 段用着它，删除后这些片段会变成缺失素材（位置和时长保留）。', { n: usedClips })
          : '',
        item.nodeId ? t('画布上生成它的节点也会变成缺失素材。') : '',
      ].filter(Boolean);
      const confirmed = await showConfirm(
        [t('删除素材 {v1}？', { v1: item.name }), t('文件会从磁盘删除，配套的潜空间文件一并清理。'), ...warnings].join('\n'),
        { title: t('删除素材'), confirmText: t('删除'), danger: true }
      );
      if (!confirmed) return;

      setDeleting(item.url);
      try {
        const result = await api.deleteAssets({ names: [item.name] });
        if (result.deleted.length === 0) {
          // Usually the file is open somewhere: say so instead of quietly
          // dropping the row for a file that is still on disk.
          await showConfirm(t('{v1} 未能删除，可能正被占用。', { v1: item.name }), {
            title: t('删除失败'),
            confirmText: '知道了',
          });
          return;
        }
        setLibraryClips((clips) => clips.filter((c) => c.url !== item.url));
        setPicked((current) => (current === item.url ? null : current));
        // The cut keeps its shape; the clips that pointed at this file now say
        // so rather than playing black.
        useCutRoom.getState().markAssetsOffline(item.url);
      } finally {
        setDeleting(null);
      }
    },
    []
  );

  /**
   * 清理未使用: delete every library file that no film uses.
   *
   * "Film" is every sequence of the project, read the way the asset library reads them: the cut room's
   * in-memory copy where it holds one (it has edits autosave has not written yet), the saved timeline
   * otherwise. If any sequence cannot be read the usage is unknown, so nothing is deleted. The files go
   * from the disk with their latents, and the canvas nodes that still show them become missing assets.
   */
  const [cleaning, setCleaning] = useState(false);
  const cleanUnused = useCallback(async () => {
    if (!projectId || cleaning) return;
    setCleaning(true);
    try {
      let timelines: Timeline[];
      try {
        const { sequences } = await api.listSequences(projectId, true);
        const cut = useCutRoom.getState();
        const held = cut.projectId === projectId;
        timelines = sequences.map((q) => {
          const live = !held ? null : q.id === cut.activeSeqId ? cut.timeline : cut.sessions[q.id]?.timeline ?? null;
          const timeline = live ?? (q.timeline as Timeline | null);
          if (!timeline) throw new Error(q.name);
          return timeline;
        });
        if (timelines.length === 0) throw new Error('no sequences');
      } catch (e) {
        await showAlert(t('读不到所有剪辑台的时间线（{v1}），不知道哪些素材在用，没有删除任何文件。', { v1: (e as Error).message }));
        return;
      }
      // What canvas nodes point at now stays, in every scene: this scene's nodes as they are in memory,
      // the others as saved. A scene that cannot be read stops the cleanup, as an unreadable film does.
      let keep: Set<string>;
      try {
        const { scenes } = await api.listScenes(projectId);
        const current = useStore.getState();
        const canvases = await Promise.all(
          scenes.map((scene) =>
            scene.id === current.currentSceneId
              ? Promise.resolve({ nodes: current.nodes as unknown[] })
              : api.loadCanvas(projectId, 'default', scene.id)
          )
        );
        keep = namesLiveOnCanvases(canvases.flatMap((c) => c.nodes as Array<{ data?: unknown }>));
      } catch (e) {
        await showAlert(t('读不到所有场景的画布（{v1}），不知道哪些素材被节点引用，没有删除任何文件。', { v1: (e as Error).message }));
        return;
      }
      const stale = unusedLibraryItems(libraryClips.filter((item) => item.owned && item.kind !== 'image'), timelines, keep);
      if (stale.length === 0) {
        await showAlert(t('素材库里的视频和音频都在某个剪辑台的时间线上用着，或是画布节点当前引用的，没有可清理的。'));
        return;
      }
      const bytes = stale.reduce((sum, item) => sum + item.bytes, 0);
      const size = bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(2)} GB` : `${Math.max(1, Math.round(bytes / 2 ** 20))} MB`;
      const confirmed = await showConfirm(
        [
          t('清理 {n} 个没有被任何剪辑台时间线使用、也不是画布节点当前引用的素材（约 {size}）？', { n: stale.length, size }),
          t('只清理本项目自己的素材：别的项目做的、别的项目也在用的、来源不明的都不会动。'),
          t('文件会从磁盘删除，配套的潜空间文件一并清理，不能恢复。'),
          t('画布节点历史版本里记着的旧片子也会被删，那些版本之后打不开。'),
        ].join('\n'),
        { title: t('清理未使用素材'), confirmText: t('删除'), danger: true }
      );
      if (!confirmed) return;
      const result = await api.deleteAssets({ names: stale.map((item) => item.name), project: projectId });
      const gone = new Set(result.deleted);
      setLibraryClips((clips) => clips.filter((c) => !gone.has(c.name)));
      setPicked(null);
      await showAlert(
        t('已删除 {n} 个文件，释放 {size}', { n: result.deleted.length, size: `${(result.freed_bytes / 2 ** 20).toFixed(0)} MB` }) +
          (result.skipped.length ? t(' · {n} 个未能删除（可能正被占用）', { n: result.skipped.length }) : '')
      );
    } catch (e) {
      await showAlert(t('清理失败：{error}', { error: (e as Error).message }));
    } finally {
      setCleaning(false);
    }
  }, [projectId, cleaning, libraryClips]);

  // 全部加入 lays down what the bin shows (view + search), and can be stopped:
  // each clip waits on addAsset, so a long list takes a while.
  const [filling, setFilling] = useState(false);
  const fillStop = useRef(false);
  const fillTimeline = useCallback(async () => {
    if (filling) {
      fillStop.current = true;
      return;
    }
    // 成片 / 画布当前 are already in shot order. 全部文件 reads newest first,
    // but a first cut has to run in the order the shots were made.
    // Picture only: a first cut is a run of shots. Music is placed against that
    // run, not laid end to end with it, so it is added a track at a time by hand.
    const ordered = view === 'all' && !query.trim() ? [...shown].reverse() : shown;
    fillStop.current = false;
    setFilling(true);
    try {
      for (const item of ordered.filter((i) => i.kind === 'video')) {
        if (fillStop.current) break;
        const assetId = await useCutRoom.getState().addAsset({ ...item, title: assetTitles[item.url] || item.title });
        if (chainMap[item.url]) await useCutRoom.getState().openChainHeads({ [item.url]: chainMap[item.url] });
        if (fillStop.current) break;
        if (assetId) useCutRoom.getState().appendClip(assetId);
      }
    } finally {
      setFilling(false);
    }
  }, [filling, shown, view, query, assetTitles, chainMap]);

  const jumpToNode = useCallback(
    (nodeId: string) => {
      const node = getNode(nodeId);
      if (!node) return;
      useStore.getState().setNodes(
        useStore.getState().nodes.map((n) => ((n.id === nodeId) === Boolean(n.selected) ? n : { ...n, selected: n.id === nodeId })),
      );
      const width = node.measured?.width ?? 300;
      const height = node.measured?.height ?? 300;
      setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: 1.1, duration: 400 });
      onClose();
    },
    [getNode, setCenter, onClose]
  );
  jumpToNodeRef.current = jumpToNode;

  if (!isOpen) return null;

  const exporting = exportStatus === 'queued' || exportStatus === 'running';

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0b0b0f] text-zinc-200">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-none items-center justify-between border-b border-white/10 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold tracking-wide">{t('✂️ 剪辑台')}</span>
          {scratch ? (
            <span className="flex items-center gap-2">
              <span className="rounded bg-sky-500/20 px-2 py-0.5 text-[11px] text-sky-200">{t('单素材剪辑')}</span>
              <span className="max-w-[280px] truncate font-mono text-[11px] text-zinc-400" title={scratch.name}>
                {scratch.name}
              </span>
            </span>
          ) : (
            <span className="text-xs text-zinc-500">{projectName}</span>
          )}
          <span className="font-mono text-[11px] text-zinc-600 tabular-nums">
            {timeline.clips.length}  {t('片段 ·')} {formatTimecode(duration, timeline.fps)} · {timeline.fps}fps
          </span>
          <FrameSizePicker />
          {!scratch && <SubtitleStylePicker />}
          {!scratch && <SubtitleLangPicker />}
          {!scratch && <CoverPicker />}
          {!scratch && (
            <button
              onClick={() => {
                const result = useCutRoom.getState().seamDissolveAll();
                const lines: string[] = [];
                if (result.applied > 0) lines.push(t('已处理 {v1} 个接缝，可以撤销（Ctrl+Z 一次全部退回）。', { v1: result.applied }));
                if (result.already > 0) lines.push(t('已经是溶解的接缝 {v1} 个，没有改动。', { v1: result.already }));
                if (result.blocked.length > 0) {
                  lines.push(t('没能处理 {v1} 个：', { v1: result.blocked.length }));
                  result.blocked.slice(0, 8).forEach((b) => lines.push(`· ${b.label}：${t(b.reason)}`));
                  if (result.blocked.length > 8) lines.push(t('…还有 {v1} 个', { v1: result.blocked.length - 8 }));
                }
                if (lines.length === 0) lines.push(t('没有找到可以做接缝溶解的片段（需要保留了重叠帧的接续生成片段）。'));
                lines.push(t('自动接缝：重叠段只播上一段的声音（新片段开头重叠部分的声音不用）。你手动处理的帧不动，自动只接管剩下的帧。'));
                void showAlert(lines.join('\n'), { title: t('全部接缝溶解'), confirmText: t('好的') });
              }}
              disabled={timeline.clips.length === 0}
              className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-zinc-200 disabled:opacity-40"
              title={t('给整条时间线上所有接续生成的片段做自动接缝溶解：露出重叠帧、对齐上一段末尾、溶解；重叠段只播上一段的声音。你手动设过溶解的片段，那几帧不动，只处理剩下的帧。')}
            >
              {t('全部接缝溶解')}
            </button>
          )}
          {saving && <span className="text-[11px] text-zinc-600">{t('保存中…')}</span>}
        </div>
        <div className="flex items-center gap-2">
          {scratch ? (
            <>
              <button
                onClick={() => {
                  setScratchResult(null);
                  setIntent('overwrite');
                  void useCutRoom.getState().startExport(scratch.name);
                }}
                disabled={exporting || timeline.clips.length === 0}
                className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-400/20 disabled:opacity-40"
                title={t('用剪好的版本替换原文件，画布和时间线上的引用不用改；原素材的潜空间会被清理')}
              >
                {exporting && intent === 'overwrite'
                  ? t('覆盖中 {v1}%', { v1: Math.round(exportProgress * 100) })
                  : t('覆盖原素材')}
              </button>
              <button
                onClick={() => {
                  setScratchResult(null);
                  setIntent('saveAs');
                  void useCutRoom.getState().startExport(scratch.name);
                }}
                disabled={exporting || timeline.clips.length === 0}
                className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-400/20 disabled:opacity-40"
                title={t('剪好的版本存成素材库里的新文件，原素材保持不变')}
              >
                {exporting && intent === 'saveAs'
                  ? t('另存中 {v1}%', { v1: Math.round(exportProgress * 100) })
                  : t('另存为新素材')}
              </button>
            </>
          ) : (
            <ExportFilmButton
              baseName={[projectName || 'cut', activeSeqName].filter(Boolean).join('_')}
              disabled={exporting || timeline.clips.length === 0}
              exporting={exporting}
              progress={exportProgress}
            />
          )}
          {!scratch && chainPending > 0 && (
            <button
              onClick={() => void useCutRoom.getState().openChainHeads(chainMap)}
              className="rounded-lg border border-violet-400/40 bg-violet-400/10 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-400/20"
              title={t('时间线上的链式镜头改用含重叠帧的完整文件：画面不变，拖片段头部即可往前拉出重叠帧（可撤销）')}
            >
              {t('展开重叠帧（{n}）', { n: chainPending })}
            </button>
          )}
          {!scratch && (hdPending > 0 || hdDone > 0) && (
            <button
              onClick={() => void (hdPending > 0 ? relink(hdMap, 'hd') : relink({}, 'rough'))}
              disabled={relinking}
              className="rounded-lg border border-sky-400/40 bg-sky-400/10 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-400/20 disabled:opacity-40"
              title={
                hdPending > 0
                  ? t('把时间线上有高清视频节点的片段换成高清文件，位置和剪辑点不变（可撤销）')
                  : t('换回粗版文件（可撤销）')
              }
            >
              {relinking
                ? t('替换中…')
                : hdPending > 0
                ? t('换成高清版（{n}）', { n: hdPending })
                : t('换回粗版（{n}）', { n: hdDone })}
            </button>
          )}
          <button
            onClick={() => {
              if (scratch) useCutRoom.getState().exitScratch();
              onClose();
            }}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.08]"
          >
            {scratch ? t('退出单素材剪辑 (Esc)') : t('返回画布 (Esc)')}
          </button>
        </div>
      </div>

      <SequenceTabs />

      <div className="flex min-h-0 flex-1">
        {/* ── Media bin: every clip in the library. A single-asset session has
            no business offering them — there is one clip and it is already
            here. */}
        {!scratch && (
          <div className="flex w-[236px] flex-none flex-col border-r border-white/10">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              
              {t('素材')}{' '}
              {viewItems.length > 0 && (
                <span className="text-zinc-600">
                  ({query.trim() ? `${shown.length}/${viewItems.length}` : viewItems.length})
                </span>
              )}
            </span>
            <span className="flex items-center gap-2">
              <button
                onClick={() => void cleanUnused()}
                disabled={cleaning}
                className="text-[11px] text-zinc-500 hover:text-red-300 disabled:opacity-50"
                title={t('删除所有剪辑台的时间线都没用到、画布节点当前也没引用的素材文件（删之前会列出数量并确认）')}
              >
                {cleaning ? t('清理中…') : t('清理未使用')}
              </button>
              <button
                onClick={() => void fillTimeline()}
                className="text-[11px] text-emerald-300 hover:text-emerald-200"
                title={filling ? t('停止加入') : t('把列表里显示的素材按顺序铺到时间线')}
              >
                {filling ? t('停止') : t('全部加入')}
              </button>
            </span>
          </div>
          <div className="flex gap-1 border-b border-white/10 px-2 py-1.5">
            {([['final', '成片'], ['canvas', '画布当前'], ['history', '历史版本'], ['all', '全部文件']] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`flex-1 rounded px-1 py-0.5 text-[11px] ${
                  view === v ? 'bg-white/15 text-zinc-100' : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
                }`}
              >
                {t(label)}
              </button>
            ))}
          </div>
          <div className="relative border-b border-white/10 px-2 py-1.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
              }}
              placeholder={t('按镜头名、文件名或节点 ID 搜索')}
              className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 pr-6 text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-emerald-400/40"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[12px] text-zinc-500 hover:text-zinc-200"
                title={t('清空搜索')}
              >
                ×
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {view === 'final' && viewItems.length === 0 && bin.length > 0 && !query && (
              <p className="px-1 py-4 text-[11px] leading-relaxed text-zinc-600">
                {t('还没有定版的镜头。画布节点标签里带 ✓ 或在这里点「成片」就会出现在这一栏。')}
              </p>
            )}
            {viewItems.length > 0 && shown.length === 0 && (
              <p className="px-1 py-4 text-[11px] leading-relaxed text-zinc-600">
                {t('没有匹配「{v1}」的素材', { v1: query.trim() })}
              </p>
            )}
            {bin.length === 0 && (
              <p className="px-1 py-4 text-[11px] leading-relaxed text-zinc-600">

{t('素材库里还没有素材。视频和音频生成完成后会出现在这里。')}
              </p>
            )}
            {shown.map((item) => (
              <BinRow
                key={`${item.nodeId}-${item.url}`}
                item={item}
                adding={adding === item.url}
                picked={picked === item.url}
                used={usedByUrl.get(item.url) ?? 0}
                deleting={deleting === item.url}
                onAdd={() => void addToTimeline(item)}
                onPick={() => setPicked(item.url)}
                onDelete={() => void deleteAsset(item, usedByUrl.get(item.url) ?? 0)}
                onJump={item.nodeId || item.takeOf ? () => jumpToNode(item.nodeId || item.takeOf!.nodeId) : undefined}
                onToggleFinal={item.nodeId ? () => toggleFinal(item) : undefined}
              />
            ))}
          </div>
        </div>
        )}

        {/* ── Monitor + timeline ────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The surround is deliberately NOT black. The composited frame fills
              itself with black wherever nothing is playing — letterbox bars, a
              gap between shots, the head of the timeline — so a black surround
              makes the frame's own edge invisible, and there is no telling what
              is picture and what is room. A lighter ground plus a hairline and a
              drop shadow puts the frame plainly on top of it. */}
          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-[#17171d] p-6">
            {/* Every track is composited into this one canvas — what it shows is
                what the export renders. */}
            <canvas
              ref={canvasRef}
              className={`max-h-full max-w-full object-contain shadow-[0_0_0_1px_rgba(255,255,255,0.16),0_18px_44px_rgba(0,0,0,0.65)] ${msePlan && !mseFailed ? 'invisible' : ''}`}
            />
            {msePlan && !mseFailed && (
              <video
                ref={mseVideoRef}
                playsInline
                className="absolute object-contain shadow-[0_0_0_1px_rgba(255,255,255,0.16),0_18px_44px_rgba(0,0,0,0.65)]"
                style={{ maxHeight: 'calc(100% - 3rem)', maxWidth: 'calc(100% - 3rem)' }}
                onError={() => setMseFailed(true)}
              />
            )}
            {/* Crop / fit / rotate / flip, drawn on the picture they act on. */}
            <MonitorOverlay canvasRef={canvasRef} />
          </div>

          {/* Transport */}
          <div className="flex flex-none flex-wrap items-center gap-3 border-y border-white/10 px-3 py-1.5">
            <button
              onClick={togglePlay}
              className="w-16 rounded border border-white/10 bg-white/[0.05] px-2 py-1 text-xs hover:bg-white/[0.1]"
            >
              {playing ? t('⏸ 暂停') : t('▶ 播放')}
            </button>
            <div className="flex overflow-hidden rounded border border-white/10" title={t('慢放听清对白起点 · J 放慢 · L 恢复')}>
              {[1, 0.5, 0.25].map((r) => (
                <button
                  key={r}
                  onClick={() => setPlayRate(r)}
                  className={`px-1.5 py-1 font-mono text-[11px] ${
                    playRate === r ? 'bg-sky-400/20 text-sky-200' : 'bg-white/[0.05] text-zinc-400 hover:bg-white/[0.1]'
                  }`}
                >
                  {r === 1 ? '1×' : r === 0.5 ? '½×' : '¼×'}
                </button>
              ))}
            </div>
            <span className="font-mono text-xs text-emerald-300 tabular-nums">
              {formatTimecode(playhead, timeline.fps)}
            </span>
            <span className="font-mono text-[11px] text-zinc-600 tabular-nums">
              / {formatTimecode(duration, timeline.fps)}
            </span>
            <span className="font-mono text-[10px] text-zinc-600" title={t('按住 Shift 一次跳一秒')}>
              
              {t('D/F 逐帧')}
            </span>

            <div className="mx-1 h-4 w-px bg-white/10" />

            <button onClick={() => useCutRoom.getState().splitAtPlayhead()} className="text-xs text-zinc-400 hover:text-white">
              
              {t('分割 (S)')}
            </button>
            <button
              onClick={() => useCutRoom.getState().mergeSelection()}
              disabled={!mergeable}
              className="text-xs text-zinc-400 hover:text-white disabled:opacity-40"
              title={t('把选中的相邻片段接回一条。要求同一轨道、首尾相接、同一素材同倍速，且分割后没有再修剪过')}
            >
              
              {t('合并 (M)')}
            </button>
            <button
              onClick={() => void useCutRoom.getState().startMergeRender(`${projectName || 'cut'}-合并`)}
              disabled={!flattenable || exporting}
              className="text-xs text-zinc-400 hover:text-white disabled:opacity-40"
              title={t('把选中的相邻片段渲染成一个新素材，替换成一个片段。跨素材、变速、调色、裁切和它们之间的转场都会烘焙进去，合并后不能再逐段调整')}
            >
              {exporting && exportTarget === 'merge'
                ? t('合并中 {v1}%', { v1: Math.round(exportProgress * 100) })
                : t('合并为一段')}
            </button>
            <button
              onClick={() => useCutRoom.getState().copySelection()}
              disabled={selection.length === 0}
              className="text-xs text-zinc-400 hover:text-white disabled:opacity-40"
              title={t('复制选中的片段，可以粘贴到别的片单页签里 (Ctrl+C)')}
            >
              {t('复制 (Ctrl+C)')}
            </button>
            <button
              onClick={() => useCutRoom.getState().pasteClipboard()}
              disabled={clipboardCount === 0}
              className="text-xs text-zinc-400 hover:text-white disabled:opacity-40"
              title={t('把复制的片段粘贴到播放头处，保持它们之间的间距和轨道 (Ctrl+V)')}
            >
              {clipboardCount > 0 ? t('粘贴 {v1} 段 (Ctrl+V)', { v1: clipboardCount }) : t('粘贴 (Ctrl+V)')}
            </button>
            <button
              onClick={() => useCutRoom.getState().groupSelection()}
              disabled={!groupable}
              className="text-xs text-zinc-400 hover:text-white disabled:opacity-40"
              title={t('把选中的片段锁成一组：点中任意一段即选中整组，移动、删除、旁通都一起 (Ctrl+G)')}
            >
              
              {t('合组 (Ctrl+G)')}
            </button>
            <button
              onClick={() => useCutRoom.getState().ungroupSelection()}
              disabled={!ungroupable}
              className="text-xs text-zinc-400 hover:text-white disabled:opacity-40"
              title={t('解开选中片段所在的组，恢复各自独立 (Ctrl+Shift+G)')}
            >
              
              {t('解组')}
            </button>
            <button
              onClick={() => {
                const why = useCutRoom.getState().detachAudio();
                if (why) void showAlert(why);
              }}
              disabled={selection.length === 0}
              className="text-xs text-zinc-400 hover:text-white disabled:opacity-40"
              title={t('把选中镜头的声音拆到独立音频轨，画面转为静音')}
            >
              
              {t('分离音频')}
            </button>
            <button
              onClick={() => useCutRoom.getState().toggleBypass()}
              disabled={selection.length === 0}
              className={`text-xs disabled:opacity-40 ${
                bypassedSelection ? 'text-amber-300 hover:text-amber-200' : 'text-zinc-400 hover:text-white'
              }`}
              title={t('选中的片段留在原位，但不参与预览和导出')}
            >
              {bypassedSelection ? t('取消旁通 (B)') : t('旁通 (B)')}
            </button>
            <button
              onClick={() => useCutRoom.getState().deleteSelection()}
              disabled={selection.length === 0}
              className="text-xs text-zinc-400 hover:text-white disabled:opacity-40"
            >
              
              {t('删除 (Del)')}
            </button>
            <button onClick={() => useCutRoom.getState().addTextClip()} className="text-xs text-zinc-400 hover:text-white">
              
              {t('加字幕 (T)')}
            </button>
            <AutoSubtitlesButton />
            <button onClick={() => useCutRoom.getState().addTrack('video')} className="text-xs text-zinc-400 hover:text-white">
              
              {t('+视频轨')}
            </button>
            <button onClick={() => useCutRoom.getState().addTrack('audio')} className="text-xs text-zinc-400 hover:text-white">
              
              {t('+音频轨')}
            </button>
            <button
              onClick={() => useCutRoom.getState().toggleSnapping()}
              className={`rounded px-2 py-0.5 text-xs ${snapping ? 'bg-emerald-400/20 text-emerald-200' : 'text-zinc-500 hover:text-zinc-300'}`}
              title={t('拖动时吸附到播放头与相邻片段边缘 (按住 Alt 临时关闭)')}
            >
              
              {t('吸附')}
            </button>

            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => useCutRoom.getState().undo()} className="text-xs text-zinc-400 hover:text-white">
                
                {t('撤销')}
              </button>
              <button onClick={() => useCutRoom.getState().redo()} className="text-xs text-zinc-400 hover:text-white">
                
                {t('重做')}
              </button>
              <div className="h-4 w-px bg-white/10" />
              <button
                onClick={() => useCutRoom.getState().setPxPerFrame(pxPerFrame / 1.4)}
                className="px-1 text-xs text-zinc-400 hover:text-white"
              >
                −
              </button>
              <span className="font-mono text-[10px] text-zinc-600" title={t('时间线上 Ctrl+滚轮缩放，滚轮上下滚动轨道，Shift+滚轮横向滚动')}>{t('缩放')}</span>
              <button
                onClick={() => useCutRoom.getState().setPxPerFrame(pxPerFrame * 1.4)}
                className="px-1 text-xs text-zinc-400 hover:text-white"
              >
                +
              </button>
            </div>
          </div>

          <div className="flex h-[230px] flex-none">
            <TimelineView
              onDropAsset={(url, trackId, at) => {
                const item = bin.find((i) => i.url === url);
                if (item) void addToTimeline(item, { trackId, at });
              }}
            />
          </div>
        </div>

        <Inspector onLocate={jumpToNode} />
      </div>

      {/* ── Outcome ─────────────────────────────────────────────────────
          A project export hands back a film to open; a single-asset session has
          already put the result where it belongs. */}

      {exportStatus && !exporting && (
        <div className="flex flex-none items-center gap-3 border-t border-white/10 px-4 py-2 text-xs">
          {!exportUrl && <span className="text-red-300">{t('导出失败：')}{exportError}</span>}
          {exportUrl && scratch && (
            <span className={scratchResult?.startsWith(t('覆盖失败')) ? 'text-red-300' : 'text-emerald-300'}>
              {scratchResult ?? t('处理中…')}
            </span>
          )}
          {exportUrl && !scratch && (
            <>
              <span className="text-emerald-300">{t('导出完成')}</span>
              {downloadHref ? (
                <a href={downloadHref} download className="text-emerald-200 underline">
                  {t('下载成片')}
                </a>
              ) : (
                <a href={resolveAssetUrl(exportUrl)} target="_blank" rel="noreferrer" className="text-emerald-200 underline">
                  {exportUrl.endsWith('.wav') ? t('打开音频') : t('打开成片')}
                </a>
              )}
            </>
          )}
          <button
            onClick={() => {
              useCutRoom.getState().dismissExport();
              setScratchResult(null);
            }}
            className="ml-auto text-zinc-500 hover:text-zinc-300"
          >
            
            {t('关闭')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * One clip in the bin.
 *
 * The first line is what tells shots apart at a glance, and a node-type label
 * ("素材片段") does not: every row said the same thing. Resolution and length do,
 * and both are read off the thumbnail element that is loading anyway — nothing
 * records them server side.
 */
function BinRow({
  item,
  adding,
  picked,
  used,
  deleting,
  onAdd,
  onPick,
  onDelete,
  onJump,
  onToggleFinal,
}: {
  item: BinItem;
  adding: boolean;
  /** Last row clicked. */
  picked: boolean;
  /** Clips on the timeline that came from this asset. */
  used: number;
  /** Its file is being deleted right now. */
  deleting: boolean;
  onAdd: () => void;
  onPick: () => void;
  onDelete: () => void;
  /** Set only for an asset a live canvas node still points at; jumps to it. */
  onJump?: () => void;
  /** Set only for an asset a live canvas node still points at; marks it 成片. */
  onToggleFinal?: () => void;
}) {
  // Read once through the shared probe, not off a <video> that lives as long as
  // the row: Chrome caps media players per page, and a bin of clips used them up
  // before the exported film's player could be created (2026-09-06).
  const isImage = item.kind === 'image';
  const videoMeta = useVideoProbe(isImage ? null : resolveAssetUrl(item.url), item.kind === 'audio' ? 'audio' : 'video');
  // A still has no player to probe; its size comes off the thumbnail once loaded.
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);
  const meta = videoMeta;
  const [hovered, setHovered] = useState(false);

  return (
    // A div, not a button: the row carries its own delete action, and a button
    // inside a button is invalid markup that browsers resolve by dropping one.
    <div
      role="button"
      tabIndex={0}
      onClick={() => !adding && !deleting && onPick()}
      onDoubleClick={() => !adding && !deleting && onAdd()}
      draggable={!adding && !deleting}
      onDragStart={(e) => {
        e.dataTransfer.setData(BIN_DRAG_TYPE, item.url);
        e.dataTransfer.effectAllowed = 'copy';
        // Hold the row by its left edge: the drop frame is the clip's head, so
        // the cursor should sit where the head will land.
        const rect = e.currentTarget.getBoundingClientRect();
        e.dataTransfer.setDragImage(e.currentTarget, 0, e.clientY - rect.top);
      }}

      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          // Space is also the transport's play/pause, bound on window. Adding a
          // clip and starting playback off one keypress is not what was asked.
          e.stopPropagation();
          if (!adding && !deleting) onAdd();
        }
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className={`group relative mb-1.5 flex w-full cursor-pointer items-center gap-2 rounded-lg border p-1.5 text-left transition-colors ${
        adding || deleting ? 'pointer-events-none opacity-50' : ''
      } ${
        picked
          ? 'border-emerald-400/70 bg-emerald-400/10'
          : item.final
          ? 'border-amber-300/60 bg-amber-300/[0.07] hover:border-amber-300/80 hover:bg-amber-300/[0.12]'
          : used > 0
          ? 'border-emerald-400/20 bg-white/[0.03] hover:border-emerald-400/40 hover:bg-white/[0.07]'
          : 'border-white/[0.08] bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.07]'
      }`}
      title={`${item.title}\n${t('单击选中 · 双击插入到播放头 · 拖到时间线上放到指定位置')}`}
    >
      <span className="relative flex-none">
        {item.kind === 'audio' ? (
          // Nothing to look at, so the tile says what it is; the length still
          // comes off the element's own metadata.
          <span className="flex h-9 w-16 flex-none items-center justify-center rounded bg-sky-400/10 text-sky-300">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </span>
        ) : isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resolveAssetUrl(item.url)}
            alt=""
            loading="lazy"
            onLoad={(e) => setImageSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            className="h-9 w-16 flex-none rounded object-cover"
          />
        ) : meta?.poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={meta.poster} alt="" className="h-9 w-16 flex-none rounded object-cover" />
        ) : (
          <span className="block h-9 w-16 flex-none rounded bg-black/40" />
        )}
        {used > 0 && (
          <span
            className="absolute -right-1 -top-1 rounded-full bg-emerald-400 px-1 text-[9px] font-bold leading-4 text-emerald-950"
            title={t('时间线上已有 {v1} 段来自这个素材', { v1: used })}
          >
            {used}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        {(item.label || item.takeOf) && (
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-zinc-100" title={item.label}>
            {item.takeOf && (
              <span
                className={`flex-none rounded px-1 font-mono tabular-nums ${
                  item.nodeId ? 'bg-emerald-400/20 text-emerald-200' : 'bg-white/10 text-zinc-300'
                }`}
                title={item.nodeId ? t('画布当前显示的版本') : undefined}
              >
                {t('第{v1}版', { v1: item.takeOf.version })}
              </span>
            )}
            <span className="truncate">{item.label}</span>
          </span>
        )}
        <span
          className={`block truncate font-mono text-[11px] tabular-nums ${
            picked ? 'text-emerald-200' : 'text-zinc-300'
          }`}
        >
          {isImage
            ? imageSize ? t('图片 · {v1}×{v2}', { v1: imageSize.w, v2: imageSize.h }) : t('读取中…')
            : meta
            ? item.kind === 'audio'
              ? t('音频 · {v1}s', { v1: meta.seconds.toFixed(1) })
              : `${meta.w}×${meta.h} · ${meta.seconds.toFixed(1)}s`
            : t('读取中…')}
        </span>
        <span className="flex items-center gap-1">
          {/* The bin lists the whole library, so a file left over from an older
              cut looks exactly like the shot a node just rendered. This badge is
              the difference: a canvas node still points at this file, and
              clicking it goes there. */}
          {onToggleFinal && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleFinal();
              }}
              className={`flex-none rounded px-1 text-[9px] leading-4 ${
                item.final
                  ? 'bg-amber-300/25 text-amber-200 hover:bg-amber-300/40'
                  : 'bg-white/5 text-zinc-600 opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-zinc-300'
              }`}
              title={item.final ? t('取消成片标记') : t('标为成片（排在素材栏最前）')}
            >
              
              {t('成片')}
            </button>
          )}
          {onJump && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onJump();
              }}
              className="flex-none rounded bg-sky-400/15 px-1 text-[9px] leading-4 text-sky-300 hover:bg-sky-400/30 hover:text-sky-200"
              title={t('画布上有节点在用这个素材（{v1}）— 点击跳到该节点', { v1: item.title })}
            >
              
              {t('画布')}
            </button>
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-600" title={item.name}>
            {deleting ? t('正在删除…') : adding ? t('生成代理中…') : item.name}
          </span>
        </span>
      </span>

      {/* Culling is the other half of reviewing takes, so the bin offers it —
          but only on the row under the pointer, and never in a position a
          click meant for "add to timeline" could land on. */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className={`absolute right-1 top-1 rounded bg-zinc-900/80 p-0.5 text-zinc-500 transition-opacity hover:bg-rose-500/25 hover:text-rose-300 ${
          hovered ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        title={
          used > 0
            ? t('删除这个素材文件（时间线上有 {v1} 段在用它）', { v1: used })
            : t('删除这个素材文件')
        }
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </svg>
  );
}

// Re-rendered on every canvas change before 2026-09-05; props are stable now.
export default React.memo(CutRoom);

/**
 * Hands the film's subtitles to the browser as .srt files (UTF-8, which Bilibili takes as it is): one per
 * language when the film has several, named `<name>.<code>.srt`. False when there are none.
 */
function saveSrt(baseName: string): boolean {
  const flat = flatTimelineOf(useCutRoom.getState());
  const langs = subtitleLangsOf(flat);
  const safe = (baseName || 'subtitles').replace(/[\\/:*?"<>|]/g, '_');
  let saved = false;
  for (const lang of langs) {
    const srt = timelineToSrt(switchSubtitleLang(flat, lang));
    if (!srt) continue;
    const url = URL.createObjectURL(new Blob([srt], { type: 'application/x-subrip;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = langs.length > 1 ? `${safe}.${lang}.srt` : `${safe}.srt`;
    link.click();
    URL.revokeObjectURL(url);
    saved = true;
  }
  return saved;
}

const hasSubtitles = (timeline: Timeline) => timeline.clips.some((c) => c.text && !c.bypassed && c.text.content.trim());

type ExportWay = 'burn' | 'soft' | 'both' | 'srt';

/**
 * 导出成片: with subtitles on the timeline it first asks how they leave -- burned into the picture,
 * as a separate .srt beside a clean film, both, or the .srt alone. Without subtitles it just exports.
 */
function ExportFilmButton({ baseName, disabled, exporting, progress }: {
  baseName: string; disabled: boolean; exporting: boolean; progress: number;
}) {
  const [open, setOpen] = React.useState(false);
  const [way, setWay] = React.useState<ExportWay>('soft');
  const subtitled = useCutRoom((st) => hasSubtitles(flatTimelineOf(st)));
  const multiLang = useCutRoom((st) => subtitleLangsOf(st.timeline).length > 1);
  const ways: { id: ExportWay; title: string; hint: string }[] = [
    { id: 'soft', title: t('成片不带字幕 + 单独的 SRT 文件'), hint: t('推荐传 B 站：观众可以开关字幕，改字不用重新导出') },
    { id: 'burn', title: t('字幕烧录进画面'), hint: t('任何播放器看到的都一样，但关不掉、改字要重新导出；适合短视频平台') },
    { id: 'both', title: t('烧录版成片 + 单独的 SRT 文件'), hint: t('一次拿到两种') },
    { id: 'srt', title: t('只导出 SRT 文件'), hint: t('不渲染视频，立即得到字幕文件') },
  ];
  const go = () => {
    setOpen(false);
    if (way === 'srt') { saveSrt(baseName); return; }
    void useCutRoom.getState().startExport(baseName, { burnSubtitles: way !== 'soft', download: true });
    if (way !== 'burn') saveSrt(baseName);
  };
  return (
    <>
      <button
        onClick={() => (subtitled ? setOpen(true) : void useCutRoom.getState().startExport(baseName, { download: true }))}
        disabled={disabled}
        className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-400/20 disabled:opacity-40"
      >
        {exporting ? t('导出中 {v1}%', { v1: Math.round(progress * 100) }) : t('导出成片')}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="w-[420px] rounded-lg border border-white/10 bg-[#15151c] p-4 shadow-2xl">
            <p className="text-sm font-semibold text-zinc-100">{t('字幕怎么导出')}</p>
            <p className="mt-1 text-[11px] text-zinc-500">
              {multiLang
                ? t('烧录的是当前语言「{v1}」；SRT 每种语言导出一个文件。', { v1: languageName(subtitleLangOf(flatTimelineOf(useCutRoom.getState()))) })
                : t('烧录的字幕语言：{v1}', { v1: languageName(subtitleLangOf(flatTimelineOf(useCutRoom.getState()))) })}
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {ways.map((w) => (
                <label
                  key={w.id}
                  className={`flex cursor-pointer gap-2 rounded border px-3 py-2 ${way === w.id ? 'border-emerald-400/50 bg-emerald-400/10' : 'border-white/10 hover:bg-white/[0.04]'}`}
                >
                  <input type="radio" name="export-way" checked={way === w.id} onChange={() => setWay(w.id)} className="mt-0.5" />
                  <span>
                    <span className="block text-xs text-zinc-100">{w.title}</span>
                    <span className="block text-[11px] text-zinc-500">{w.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setOpen(false)} className="rounded px-3 py-1 text-xs text-zinc-400 hover:text-white">
                {t('取消')}
              </button>
              <button onClick={go} className="rounded border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-400/20">
                {t('导出')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Transcribes the film's sound into titles. The wait runs to minutes on the CPU,
 * so it is a modal with a real progress bar and a way out.
 */
function AutoSubtitlesButton() {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [stage, setStage] = React.useState<'mixing' | 'transcribing'>('mixing');
  const [note, setNote] = React.useState<string | null>(null);
  const controller = React.useRef<AbortController | null>(null);

  const run = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setOpen(true);
    setBusy(true);
    setProgress(0);
    setStage('mixing');
    setNote(null);
    try {
      const count = await useCutRoom.getState().autoSubtitles({
        signal: abort.signal,
        onProgress: (value, current) => {
          setProgress(value);
          setStage(current);
        },
      });
      if (count === null) {
        setOpen(false);
        return;
      }
      if (count > 0) {
        // The subtitles on the timeline are the answer; nothing left to read here.
        setOpen(false);
        return;
      }
      setProgress(1);
      setNote(t('没有识别出台词'));
    } catch (error) {
      setNote((error as Error).message);
    } finally {
      setBusy(false);
      controller.current = null;
    }
  };

  const cancel = () => {
    controller.current?.abort();
    setOpen(false);
  };

  return (
    <>
      <button
        onClick={() => void run()}
        disabled={busy}
        className="text-xs text-zinc-400 hover:text-white disabled:opacity-60"
        title={t('识别整条时间线的声音，每句台词生成一条字幕，放在「字幕」轨上；再次运行会替换这条轨')}
      >
        {t('自动字幕')}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="w-[360px] rounded-lg border border-white/10 bg-[#15151c] p-4 shadow-2xl">
            <p className="text-sm font-semibold text-zinc-100">{t('自动字幕')}</p>
            <p className="mt-2 text-xs text-zinc-400">
              {busy
                ? stage === 'mixing'
                  ? t('正在混合时间线的声音…')
                  : t('正在识别台词…')
                : note}
            </p>
            <div className="mt-3 h-1.5 overflow-hidden rounded bg-white/10">
              <div
                className="h-full bg-emerald-400 transition-[width] duration-500"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-right font-mono text-[11px] tabular-nums text-zinc-500">
              {Math.round(progress * 100)}%
            </p>
            <div className="mt-3 flex justify-end">
              {busy ? (
                <button
                  onClick={cancel}
                  className="rounded border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:bg-white/[0.08]"
                >
                  {t('取消')}
                </button>
              ) : (
                <button
                  onClick={() => setOpen(false)}
                  className="rounded border border-emerald-400/50 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-400/20"
                >
                  {t('关闭')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
