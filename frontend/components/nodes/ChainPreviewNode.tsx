'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, type NodeProps } from '@xyflow/react';
import IconHandle from './IconHandle';
import NodeShell from './NodeShell';
import { cardBody, defaultShadow, header, label, selectedShadow } from './PromptNode';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { useStore } from '@/lib/store';
import { t } from '@/lib/i18n';
import { attachMseSequence } from '@/lib/mseSequence';
import { probeVideo } from '@/lib/videoProbe';

interface ChainClip {
  /** Unique within the playlist: the same node can be reached through two sources. */
  id: string;
  url: string;
  width?: number;
  height?: number;
}

/** One wired input: a plain video, or the tail of a motion-context chain expanded to its clips. */
interface PreviewSource {
  edgeId: string;
  nodeId: string;
  name: string;
  clips: ChainClip[];
}

function mediaUrl(url: string): string {
  return url.startsWith('blob:') || url.startsWith('http') ? url : `${API_BASE}${url}`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function ChainPreviewNode({ id, data, selected }: NodeProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const continuePlayback = useRef(false);
  const pendingSeek = useRef<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [localTime, setLocalTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  // sound follows the canvas-wide rule: one node audible, the next one playing
  // inherits the last mute state (useSingleAudioCoordinator)
  const muted = useStore((state) => state.activeAudioNodeId !== id);
  const setActiveAudioNodeId = useStore((state) => state.setActiveAudioNodeId);
  const [mseError, setMseError] = useState<string | null>(null);
  const resumeRef = useRef<{ time: number; playing: boolean } | null>(null);

  const { updateNodeData } = useReactFlow();
  // Every in-video edge is one source. A source whose node continues another
  // (in-motion-context) is a chain tail and plays the whole chain from its head;
  // anything else plays as the single clip it is.
  const sourcesJson = useStore((state) => {
    const inputs = state.edges.filter((edge) => edge.target === id && edge.targetHandle === 'in-video');
    if (!inputs.length) return '[]';
    const byId = new Map(state.nodes.map((node) => [node.id, node]));
    const sources: PreviewSource[] = inputs.map((input) => {
      const clips: ChainClip[] = [];
      const seen = new Set<string>();
      let currentId: string | undefined = input.source;
      while (currentId && !seen.has(currentId)) {
        seen.add(currentId);
        const node = byId.get(currentId);
        if (!node) break;
        const nodeData = node.data as Record<string, unknown>;
        const url = (nodeData.generatedUrl || nodeData.url) as string | undefined;
        if (url) {
          clips.push({
            id: `${input.id}:${currentId}`,
            url,
            width: nodeData.width as number | undefined,
            height: nodeData.height as number | undefined,
          });
        }
        const parent = state.edges.find((edge) =>
          edge.target === currentId && edge.targetHandle === 'in-motion-context');
        currentId = parent?.source;
      }
      clips.reverse();
      const tail = byId.get(input.source)?.data as Record<string, unknown> | undefined;
      const name = String(tail?.alias || tail?.label || input.source);
      return { edgeId: input.id, nodeId: input.source, name, clips };
    });
    return JSON.stringify(sources);
  });

  // Play order: data.sourceOrder (edge ids) as the user arranged it; sources not
  // in it yet (just wired) follow in wiring order.
  const sourceOrder = (data.sourceOrder as string[] | undefined) ?? [];
  const sources = useMemo<PreviewSource[]>(() => {
    const all: PreviewSource[] = JSON.parse(sourcesJson);
    const rank = (s: PreviewSource) => {
      const i = sourceOrder.indexOf(s.edgeId);
      return i < 0 ? sourceOrder.length + all.indexOf(s) : i;
    };
    return [...all].sort((a, b) => rank(a) - rank(b));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesJson, sourceOrder.join('|')]);
  const clips = useMemo<ChainClip[]>(() => sources.flatMap((source) => source.clips), [sources]);
  const chainJson = useMemo(() => JSON.stringify(clips), [clips]);

  const moveSource = (edgeId: string, step: -1 | 1) => {
    const order = sources.map((source) => source.edgeId);
    const from = order.indexOf(edgeId);
    const to = from + step;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    videoRef.current?.pause();
    continuePlayback.current = false;
    setActiveIndex(0);
    setLocalTime(0);
    updateNodeData(id, { sourceOrder: order });
  };
  const active = clips[Math.min(activeIndex, Math.max(0, clips.length - 1))];
  // Per-clip durations, read through the shared probe (one throwaway player at a
  // time) instead of a hidden <video> per clip that stayed mounted: a 14-segment
  // chain held 14 media players open on the canvas (2026-09-23).
  const clipUrlKey = JSON.stringify([...new Set(clips.map((clip) => clip.url))]);
  useEffect(() => {
    let live = true;
    for (const url of JSON.parse(clipUrlKey) as string[]) {
      probeVideo(mediaUrl(url)).then((probe) => {
        if (!live || !Number.isFinite(probe.seconds) || probe.seconds <= 0) return;
        setDurations((old) => old[url] === probe.seconds ? old : { ...old, [url]: probe.seconds });
      }).catch(() => {});
    }
    return () => { live = false; };
  }, [clipUrlKey]);
  const clipDurations = clips.map((clip) => durations[clip.url] || 0);
  const elapsedBefore = clipDurations.slice(0, activeIndex).reduce((sum, value) => sum + value, 0);
  const totalDuration = clipDurations.reduce((sum, value) => sum + value, 0);
  const globalTime = Math.min(totalDuration, elapsedBefore + localTime);
  const totalFrames = totalDuration > 0 ? Math.max(1, Math.ceil(totalDuration * 24)) : 0;
  const currentFrame = totalFrames > 0
    ? Math.min(totalFrames - 1, Math.max(0, Math.floor(globalTime * 24 + 1e-3)))
    : 0;

  const durationKey = clips.map((clip) => `${clip.id}:${durations[clip.url] || 0}`).join('|');

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !clips.length || mseError) return;
    if (clips.some((clip) => !Number.isFinite(durations[clip.url]) || !(durations[clip.url] > 0))) return;
    // A render finishing anywhere in the chain changes a url or a duration and
    // rebuilds the stream. Rebuilding used to drop the playhead to 0 and leave
    // the player paused mid-watch; carry the position and play state across.
    const resume = resumeRef.current;
    resumeRef.current = null;
    const detach = attachMseSequence(
      video,
      clips.map((clip) => ({ url: clip.url, duration: durations[clip.url] })),
      {
        width: active?.width || 1376,
        height: active?.height || 768,
        fps: 24,
        startTime: resume?.time,
        autoplay: resume?.playing,
        onError: (error) => setMseError(error.message),
      }
    );
    return () => {
      resumeRef.current = { time: video.currentTime || 0, playing: !video.paused && !video.ended };
      detach();
    };
  // `durationKey` is the stable primitive representation of the probe results.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainJson, durationKey, mseError]);

  useEffect(() => {
    if (activeIndex < clips.length) return;
    setActiveIndex(Math.max(0, clips.length - 1));
  }, [activeIndex, clips.length]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !continuePlayback.current) return;
    void video.play().catch(() => { continuePlayback.current = false; setIsPlaying(false); });
  }, [active?.url]);

  const seekGlobal = (time: number) => {
    if (!clips.length || totalDuration <= 0) return;
    const target = Math.max(0, Math.min(time, totalDuration));
    const video = videoRef.current;
    if (!mseError && video?.src.startsWith('blob:')) {
      video.currentTime = target;
      return;
    }
    let cursor = 0;
    let index = clips.length - 1;
    for (let i = 0; i < clips.length; i += 1) {
      const end = cursor + clipDurations[i];
      if (target < end || i === clips.length - 1) { index = i; break; }
      cursor = end;
    }
    const within = Math.min(clipDurations[index] || 0, Math.max(0, target - cursor));
    pendingSeek.current = within;
    setLocalTime(within);
    if (index === activeIndex && videoRef.current) {
      videoRef.current.currentTime = within;
      pendingSeek.current = null;
    } else {
      continuePlayback.current = isPlaying;
      setActiveIndex(index);
    }
  };

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (activeIndex === clips.length - 1 && video.ended) seekGlobal(0);
      continuePlayback.current = true;
      void video.play();
    } else {
      continuePlayback.current = false;
      video.pause();
    }
  };

  // The chain plays as one MSE stream, which the preview modal cannot take, so
  // its fullscreen view gets the modal's keys instead: D/F step one frame,
  // space plays and pauses (2026-09-15: every enlarged view steps frames).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const player = playerRef.current;
      const video = videoRef.current;
      if (!player || !video || document.fullscreenElement !== player) return;
      const key = e.key.toLowerCase();
      if (key === 'd' || key === 'f') {
        e.preventDefault();
        video.pause();
        continuePlayback.current = false;
        const step = (key === 'd' ? -1 : 1) / 24;
        video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + step));
      } else if (key === ' ') {
        e.preventDefault();
        togglePlayback();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const sizing = useNodeSizing({
    id,
    type: 'chainPreview',
    rows: ['header', 'sources'],
    activeRows: sources.length > 1 ? ['header', 'sources'] : ['header'],
    paddingX: 0,
    ratioSources: [{ width: active?.width, height: active?.height }],
    userWidth: data.userWidth as number | undefined,
  });

  return (
    <NodeShell
      nodeId={id}
      spec={sizing.spec}
      selected={selected}
      onResizeEnd={sizing.onResizeEnd}
      shellRef={sizing.shellRef}
    >
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
          <PlayIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('智能视频预览')}</span>
        </div>
        {clips.length > 0 && (
          <span className="ml-auto pr-2 text-[11px] tabular-nums text-zinc-500">
            {formatTime(totalDuration)}
          </span>
        )}
      </div>

      {sources.length > 1 && (
        <div data-chrome-row="sources" className="nodrag flex flex-wrap gap-1 px-2 pb-1.5">
          {sources.map((source, index) => {
            const seconds = source.clips.reduce((sum, clip) => sum + (durations[clip.url] || 0), 0);
            const playing = active && source.clips.some((clip) => clip.id === active.id);
            return (
              <div
                key={source.edgeId}
                className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${playing ? 'border-violet-400/50 bg-violet-500/10 text-zinc-100' : 'border-white/10 bg-white/[0.04] text-zinc-400'}`}
                title={source.nodeId}
              >
                <button type="button" disabled={index === 0} onClick={() => moveSource(source.edgeId, -1)}
                  className="cursor-pointer text-zinc-500 hover:text-white disabled:cursor-default disabled:opacity-25" title={t('前移')}>‹</button>
                <span className="tabular-nums text-zinc-500">{index + 1}</span>
                <span className="max-w-[140px] truncate">{source.name}</span>
                {source.clips.length > 1 && (
                  <span className="text-zinc-500">{t('链 {n} 段', { n: source.clips.length })}</span>
                )}
                <span className="tabular-nums text-zinc-500">{formatTime(seconds)}</span>
                <button type="button" disabled={index === sources.length - 1} onClick={() => moveSource(source.edgeId, 1)}
                  className="cursor-pointer text-zinc-500 hover:text-white disabled:cursor-default disabled:opacity-25" title={t('后移')}>›</button>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div style={{ ...cardBody, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'transparent' }}>
          <div ref={playerRef} className="node-shell-media group" style={{ position: 'relative', borderRadius: 20, overflow: 'hidden', boxShadow: selected ? selectedShadow : defaultShadow, background: 'rgba(0,0,0,0.35)' }}>
            {active ? (
              <>
                <video
                  ref={videoRef}
                  src={mseError ? mediaUrl(active.url) : undefined}
                  playsInline
                  preload="auto"
                  muted={muted}
                  onClick={togglePlayback}
                  onLoadedMetadata={(event) => {
                    // React clears currentTarget after the handler returns. Capture
                    // primitive metadata before passing it into a state updater,
                    // which may run later during concurrent rendering.
                    const video = event.currentTarget;
                    const duration = video.duration;
                    sizing.onMediaSize(video.videoWidth, video.videoHeight);
                    // Under MSE this element plays the whole joined chain, so its
                    // duration is the sum, not the active clip's. Writing it back as
                    // the clip's duration grew the total, which re-attached a longer
                    // sequence, which fired this again: the length grew without end.
                    // Per-clip durations come from the probe <video>s below.
                    if (!mseError) return;
                    if (!Number.isFinite(duration) || duration <= 0) return;
                    setDurations((old) => old[active.url] === duration
                      ? old
                      : { ...old, [active.url]: duration });
                    if (pendingSeek.current !== null) {
                      video.currentTime = pendingSeek.current;
                      pendingSeek.current = null;
                    }
                  }}
                  onTimeUpdate={(event) => {
                    const time = event.currentTarget.currentTime;
                    if (mseError) {
                      setLocalTime(time);
                      return;
                    }
                    let cursor = 0;
                    let index = clips.length - 1;
                    for (let i = 0; i < clipDurations.length; i += 1) {
                      if (time < cursor + clipDurations[i]) { index = i; break; }
                      cursor += clipDurations[i];
                    }
                    setActiveIndex(index);
                    setLocalTime(Math.max(0, time - cursor));
                  }}
                  onPlay={() => { continuePlayback.current = true; setIsPlaying(true); }}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => {
                    if (!mseError) {
                      continuePlayback.current = false;
                      setIsPlaying(false);
                      return;
                    }
                    if (activeIndex + 1 < clips.length) {
                      pendingSeek.current = 0;
                      continuePlayback.current = true;
                      setLocalTime(0);
                      setActiveIndex((index) => index + 1);
                    } else {
                      continuePlayback.current = false;
                      setIsPlaying(false);
                    }
                  }}
                  style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', cursor: 'pointer' }}
                />
                <div className="nodrag nowheel absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-3 pb-2 pt-8 opacity-100 transition-opacity group-hover:opacity-100">
                  <button type="button" onClick={togglePlayback} className="text-white/90 hover:text-white" title={isPlaying ? t('暂停') : t('播放')}>
                    {isPlaying ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(totalDuration, 0.01)}
                    step={0.01}
                    value={globalTime}
                    onChange={(event) => seekGlobal(Number(event.target.value))}
                    className="h-1 min-w-0 flex-1 cursor-pointer accent-violet-400"
                    aria-label={t('视频进度')}
                  />
                  <span className="min-w-fit text-[10px] tabular-nums text-white/75">
                    {formatTime(globalTime)} / {formatTime(totalDuration)}
                  </span>
                  <span className="min-w-fit text-[10px] font-mono tabular-nums text-white/80">
                    F {currentFrame} / {totalFrames - 1}
                  </span>
                  <button type="button" onClick={() => setActiveAudioNodeId(muted ? id : null)} className="text-[11px] text-white/80 hover:text-white" title={muted ? t('取消静音') : t('静音')}>
                    {muted ? '🔇' : '🔊'}
                  </button>
                  <button type="button" onClick={() => void playerRef.current?.requestFullscreen()} className="text-white/80 hover:text-white" title={t('全屏')}>
                    <FullscreenIcon />
                  </button>
                </div>
              </>
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[13px] text-zinc-500">
                {t('接入视频即可连续播放（可接多个普通视频或链尾）')}
              </div>
            )}
            {mseError && (
              <div className="pointer-events-none absolute right-2 top-2 rounded bg-amber-950/80 px-2 py-1 text-[9px] text-amber-200" title={mseError}>
                MSE fallback
              </div>
            )}
          </div>
        </div>
        <IconHandle type="target" id="in-video" portType="video" nodeId={id} style={{ top: '50%' }} title={t('接入视频（可多接，普通视频或链尾）')} />
      </div>
    </NodeShell>
  );
}

function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m8 5 11 7-11 7z" />
    </svg>
  );
}

function PauseIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3v14H7zm7 0h3v14h-3z" /></svg>;
}

function FullscreenIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></svg>;
}

export default memo(ChainPreviewNode);
