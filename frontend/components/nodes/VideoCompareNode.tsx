'use client';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { NodeProps, useReactFlow } from '@xyflow/react';
import { areNodePropsEqual } from '@/lib/utils';
import IconHandle from './IconHandle';
import NodeShell from './NodeShell';
import { NodeHeaderButton } from './nodeChrome';
import VideoPreviewModal from './VideoPreviewModal';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { cardBody, header, label } from './PromptNode';
import { VideoCompareNode as VideoCompareNodeType, VideoCompareNodeData } from '@/lib/types';
import { BACKEND_URL as API_BASE, posterUrl } from '@/lib/config';
import { MediaCameraIcon, MediaMaximizeIcon, NATIVE_VIDEO_CHROME_OFF } from './mediaChrome';
import { useFrameGrab } from '@/lib/frameGrab';
import { t } from '@/lib/i18n';

type CompareMode = 'wipe' | 'sideBySide' | 'flip';

const MODES: { id: CompareMode; label: string; title: string }[] = [
  { id: 'wipe', label: '滑动', title: '一条分割线，左右各一版 —— 看同一处细节的差别' },
  { id: 'sideBySide', label: '并排', title: '两版各占一半 —— 看整体构图差别' },
  { id: 'flip', label: '闪切', title: '原地切换 A/B —— 眼睛对位置变化最敏感，微小差别靠这个看' },
];

function srcOf(u?: string | null): string | null {
  if (!u) return null;
  return u.startsWith('http') || u.startsWith('blob:') ? u : `${API_BASE}${u}`;
}

function VideoCompareNode({ id, data, selected }: NodeProps<VideoCompareNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  const grabFrame = useFrameGrab();

  const inA = connected.find((n) => n.targetHandle === 'in-video-a');
  const inB = connected.find((n) => n.targetHandle === 'in-video-b');
  const urlA = srcOf(inA?.generatedUrl || inA?.url);
  const urlB = srcOf(inB?.generatedUrl || inB?.url);
  const both = Boolean(urlA && urlB);

  const mode = (data.mode as CompareMode) || 'wipe';
  const [split, setSplit] = useState(50);
  const [showB, setShowB] = useState(false);      // flip mode: which side is up
  const [isPlaying, setIsPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [sizeA, setSizeA] = useState<{ w: number; h: number } | null>(null);
  const [sizeB, setSizeB] = useState<{ w: number; h: number } | null>(null);

  const aRef = useRef<HTMLVideoElement>(null);
  const bRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  // Guards the two-way seek sync: writing currentTime on one element fires its own
  // timeupdate, which would write back to the other and fight the user's drag.
  const syncingRef = useRef(false);

  const sizing = useNodeSizing({
    id,
    type: 'videoCompare',
    rows: ['header'],
    hasMedia: both,
    userWidth: data.userWidth as number | undefined,
    deps: [urlA, urlB, mode],
  });

  // ── Playback, driven off A and mirrored onto B ──────────────────────────────
  const togglePlay = useCallback(() => {
    const a = aRef.current;
    const b = bRef.current;
    if (!a) return;
    if (a.paused) {
      a.play().catch(() => {});
      b?.play().catch(() => {});
    } else {
      a.pause();
      b?.pause();
    }
  }, []);

  const seekTo = useCallback((t: number) => {
    syncingRef.current = true;
    if (aRef.current) aRef.current.currentTime = t;
    if (bRef.current) bRef.current.currentTime = t;
    setTime(t);
    // Release on the next frame: the elements emit their seek events first.
    requestAnimationFrame(() => { syncingRef.current = false; });
  }, []);

  const step = useCallback((frames: number) => {
    const fps = (inA?.fps as number | undefined) || 24;
    const a = aRef.current;
    if (!a) return;
    a.pause(); bRef.current?.pause();
    seekTo(Math.max(0, Math.min(dur || a.duration || 0, a.currentTime + frames / fps)));
  }, [dur, inA?.fps, seekTo]);

  // B follows A. Without this the two drift apart within seconds: browsers decode
  // independently and never resync two elements on their own.
  useEffect(() => {
    const a = aRef.current;
    const b = bRef.current;
    if (!a || !b) return;
    const onTime = () => {
      if (syncingRef.current) return;
      setTime(a.currentTime);
      if (Math.abs(b.currentTime - a.currentTime) > 0.05) b.currentTime = a.currentTime;
    };
    a.addEventListener('timeupdate', onTime);
    return () => a.removeEventListener('timeupdate', onTime);
  }, [urlA, urlB]);

  // Keyboard: space toggles, arrows step a frame. Only while this node is hovered,
  // so it cannot steal the canvas's own shortcuts.
  useEffect(() => {
    if (!isHovered || !both || showModal) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key.toLowerCase() === 'b') { e.preventDefault(); setShowB((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isHovered, both, showModal, togglePlay, step]);

  const onDividerMove = useCallback((clientX: number) => {
    const box = boxRef.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    setSplit(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => { if (draggingRef.current) onDividerMove(e.clientX); };
    const up = () => { draggingRef.current = false; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [onDividerMove]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const dims = (s: { w: number; h: number } | null) => (s ? `${s.w}×${s.h}` : '—');
  // Same shot at two sizes is the common case here, so the ratio is worth stating
  // outright rather than leaving it to be worked out from two resolutions.
  const scaleNote = sizeA && sizeB && sizeA.w !== sizeB.w
    ? `B/A ${(sizeB.w / sizeA.w).toFixed(2)}×`
    : null;

  const videoStyle: React.CSSProperties = {
    position: 'absolute', inset: 0, width: '100%', height: '100%',
    objectFit: 'contain', background: '#000',
  };

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
          <span className="text-[11px]">⇄</span>
          <span style={label} className="text-zinc-200" data-chrome="label">{t('视频对比')}</span>
        </div>
        <div className="flex items-center gap-1">
          {MODES.map((m) => (
            <NodeHeaderButton
              key={m.id}
              active={mode === m.id}
              title={t(m.title)}
              onClick={() => updateNodeData(id, { mode: m.id })}
            >
              {t(m.label)}
            </NodeHeaderButton>
          ))}
        </div>
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          style={{ ...cardBody, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {!both ? (
            <div style={{
              flex: 1, borderRadius: 20, background: '#18181b',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, color: '#555', textAlign: 'center', lineHeight: 1.6, padding: 14,
            }}>
              {urlA || urlB ? t('再接入一个视频即可对比') : t('接入两个视频（A 基准 / B 对比）')}
            </div>
          ) : (
            <div ref={boxRef} style={{ position: 'relative', flex: 1, borderRadius: 20, overflow: 'hidden', background: '#000' }}>
              {/* A is the base layer; B is clipped on top so both stay pixel-aligned.
                  Side-by-side squeezes each into its own half instead. */}
              <video
                ref={aRef}
                src={urlA!}
                preload="metadata"
                poster={posterUrl(urlA) ?? undefined}
                {...NATIVE_VIDEO_CHROME_OFF}
                loop playsInline crossOrigin="anonymous"
                style={{
                  ...videoStyle,
                  clipPath: mode === 'sideBySide' ? 'inset(0 50% 0 0)' : undefined,
                  opacity: mode === 'flip' && showB ? 0 : 1,
                }}
                onLoadedMetadata={() => {
                  const v = aRef.current;
                  if (!v) return;
                  setDur(v.duration || 0);
                  if (v.videoWidth) {
                    setSizeA({ w: v.videoWidth, h: v.videoHeight });
                    // A decides the node's aspect ratio; B is drawn into the same box.
                    sizing.onMediaSize(v.videoWidth, v.videoHeight);
                  }
                }}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              />
              <video
                ref={bRef}
                src={urlB!}
                preload="metadata"
                poster={posterUrl(urlB) ?? undefined}
                {...NATIVE_VIDEO_CHROME_OFF}
                loop playsInline muted crossOrigin="anonymous"
                style={{
                  ...videoStyle,
                  clipPath:
                    mode === 'wipe' ? `inset(0 0 0 ${split}%)`
                      : mode === 'sideBySide' ? 'inset(0 0 0 50%)'
                        : undefined,
                  opacity: mode === 'flip' && !showB ? 0 : 1,
                }}
                onLoadedMetadata={() => {
                  const v = bRef.current;
                  if (v?.videoWidth) setSizeB({ w: v.videoWidth, h: v.videoHeight });
                }}
              />

              {mode === 'wipe' && (
                <div
                  className="nodrag"
                  onMouseDown={(e) => { e.stopPropagation(); draggingRef.current = true; }}
                  style={{
                    position: 'absolute', top: 0, bottom: 0, left: `${split}%`,
                    width: 14, marginLeft: -7, cursor: 'ew-resize', zIndex: 15,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <div style={{ width: 2, height: '100%', background: 'rgba(255,255,255,0.85)' }} />
                  <div style={{
                    position: 'absolute', width: 22, height: 22, borderRadius: 11,
                    background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.85)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 9, color: '#fff',
                  }}>⇄</div>
                </div>
              )}

              {/* Which side am I looking at — without it a wipe is unreadable the
                  moment the two versions look similar, which is exactly when it matters. */}
              <div style={{
                position: 'absolute', top: 6, left: 8, zIndex: 12,
                fontSize: 9, fontFamily: 'monospace', color: 'rgba(255,255,255,0.9)',
                background: 'rgba(0,0,0,0.5)', padding: '2px 5px', borderRadius: 4,
                opacity: mode === 'flip' && showB ? 0.25 : 1,
              }}>A {dims(sizeA)}</div>
              <div style={{
                position: 'absolute', top: 6, right: 8, zIndex: 12,
                fontSize: 9, fontFamily: 'monospace', color: 'rgba(255,255,255,0.9)',
                background: 'rgba(0,0,0,0.5)', padding: '2px 5px', borderRadius: 4,
                opacity: mode === 'flip' && !showB ? 0.25 : 1,
              }}>B {dims(sizeB)}{scaleNote ? ` · ${scaleNote}` : ''}</div>

              {/* Transport */}
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 20,
                padding: '20px 10px 8px',
                background: 'linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 100%)',
                display: 'flex', alignItems: 'center', gap: 6,
                opacity: isHovered ? 1 : 0, transition: 'opacity 0.2s',
                pointerEvents: isHovered ? 'auto' : 'none',
              }}>
                <button className="nodrag" onClick={togglePlay} title={t('播放/暂停 (空格)')}
                  style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 12, padding: '2px 4px' }}>
                  {isPlaying ? '❚❚' : '▶'}
                </button>
                <button className="nodrag" onClick={() => step(-1)} title={t('上一帧 (←)')}
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.75)', cursor: 'pointer', fontSize: 11 }}>◀|</button>
                <button className="nodrag" onClick={() => step(1)} title={t('下一帧 (→)')}
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.75)', cursor: 'pointer', fontSize: 11 }}>|▶</button>
                <div className="nodrag"
                  style={{ flex: 1, height: 20, display: 'flex', alignItems: 'center', cursor: 'pointer' }}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    seekTo(((e.clientX - r.left) / r.width) * (dur || 0));
                  }}
                >
                  <div style={{ width: '100%', height: 3, background: 'rgba(255,255,255,0.2)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${(time / (dur || 1)) * 100}%`, height: '100%', background: 'rgba(255,255,255,0.9)' }} />
                  </div>
                </div>
                <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'rgba(255,255,255,0.7)' }}>
                  {fmt(time)}/{fmt(dur)}
                </span>
                {mode === 'flip' && (
                  <button className="nodrag" onClick={() => setShowB((v) => !v)} title={t('切换 A/B (B 键)')}
                    style={{
                      background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.25)',
                      color: '#fff', cursor: 'pointer', fontSize: 9, borderRadius: 4, padding: '2px 6px',
                    }}>{showB ? 'B' : 'A'}</button>
                )}
                {/* 抽帧：对比节点上两版各抽各的，抽的是播放头当前那一帧 */}
                <button className="nodrag" onClick={() => void grabFrame(aRef.current, id)} title={t('抽取 A 的当前帧至画布')}
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.75)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2, fontSize: 9, padding: 0 }}>
                  <MediaCameraIcon size={11} />A
                </button>
                <button className="nodrag" onClick={() => void grabFrame(bRef.current, id)} title={t('抽取 B 的当前帧至画布')}
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.75)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2, fontSize: 9, padding: 0 }}>
                  <MediaCameraIcon size={11} />B
                </button>
                <button className="nodrag" onClick={() => { aRef.current?.pause(); bRef.current?.pause(); setShowModal(true); }}
                  title={t('放大查看')}
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.75)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}><MediaMaximizeIcon size={11} /></button>
              </div>
            </div>
          )}
        </div>

        {showModal && (
          <VideoPreviewModal
            beforeUrl={urlA}
            afterUrl={urlB}
            fps={(inA?.fps as number | undefined) || undefined}
            onClose={() => setShowModal(false)}
            onCaptureFrame={(v) => void grabFrame(v, id)}
          />
        )}
      </div>

      <IconHandle type="target" id="in-video-a" portType="video" nodeId={id} style={{ top: '35%' }} title={t('A —— 基准（分割线左侧）')} />
      <IconHandle type="target" id="in-video-b" portType="video" nodeId={id} style={{ top: '65%' }} title={t('B —— 对比（分割线右侧）')} />
    </NodeShell>
  );
}

export default memo(VideoCompareNode, areNodePropsEqual);
