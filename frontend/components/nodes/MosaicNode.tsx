'use client';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { provides } from '@/lib/nodeRegistry';
import { areNodePropsEqual, downloadFile } from '@/lib/utils';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import { MosaicNode as MosaicNodeType } from '@/lib/types';
import { api } from '@/lib/api';
import { cardBody, header, label, selectedShadow, defaultShadow } from './PromptNode';
import NodeShell from './NodeShell';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import GeneratingLine from './GeneratingLine';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult, useActiveBatchInfo } from '@/hooks/useJobPoller';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import NodeVideoPlayer from './NodeVideoPlayer';
import { t } from '@/lib/i18n';
import Select from '@/components/ui/Select';

const FPS = 24;
/** Breasts are opt-in (backend/mosaic.py DEFAULT_CLASSES leaves them out): a clothed chest reads as one. */
const BREAST = 'FEMALE_BREAST_EXPOSED';

function MosaicNode({ id, data, selected }: NodeProps<MosaicNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const cancelledRef = useRef(false);
  const batchInfo = useActiveBatchInfo(data.jobId as string | undefined);

  const connectedVideo = connected.find((n) => provides(n, 'video'));
  const sourceVideoUrl = connectedVideo
    ? ((connectedVideo.generatedUrl || connectedVideo.url) as string | null)
    : null;

  const jobResult = useJobResult(data.jobId as string | undefined);
  useEffect(() => {
    if (!jobResult || cancelledRef.current) return;
    if (jobResult.status === 'done' && jobResult.url) {
      updateNodeData(id, {
        status: 'done', generatedUrl: jobResult.url as string, jobId: undefined,
        mosaicInfo: (jobResult as any).mosaic ?? undefined,
      });
      setShowSource(false);
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || 'Mosaic failed', jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
    }
  }, [jobResult]); // eslint-disable-line react-hooks/exhaustive-deps

  const shownUrl = (!showSource && data.generatedUrl) || sourceVideoUrl;
  useEffect(() => {
    if (!shownUrl) { setVideoSrc(null); return; }
    setVideoSrc(shownUrl.startsWith('http') || shownUrl.startsWith('blob:') ? shownUrl : `${API_BASE}${shownUrl}`);
  }, [shownUrl]);

  const seeds = (data.mosaicSeeds ?? []) as { frame: number; x: number; y: number }[];
  const [picking, setPicking] = useState(false);
  const [curFrame, setCurFrame] = useState(0);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const upd = () => setCurFrame(Math.round(v.currentTime * FPS));
    v.addEventListener('timeupdate', upd);
    v.addEventListener('seeked', upd);
    upd();
    return () => { v.removeEventListener('timeupdate', upd); v.removeEventListener('seeked', upd); };
  }, [videoSrc]);

  const [totalFrames, setTotalFrames] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const meta = () => setTotalFrames(Math.round((v.duration || 0) * FPS));
    const pl = () => setPlaying(true);
    const pa = () => setPlaying(false);
    v.addEventListener('loadedmetadata', meta);
    v.addEventListener('durationchange', meta);
    v.addEventListener('play', pl);
    v.addEventListener('pause', pa);
    meta();
    return () => {
      v.removeEventListener('loadedmetadata', meta); v.removeEventListener('durationchange', meta);
      v.removeEventListener('play', pl); v.removeEventListener('pause', pa);
    };
  }, [videoSrc, picking]);
  const stepFrames = (d: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = Math.min(Math.max(0, (Math.round(v.currentTime * FPS) + d) / FPS), v.duration || 0);
  };
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play(); else v.pause();
  };

  /** A click on the picture as {x, y} in 0..1 of the video itself (the player letterboxes it). */
  const pointOnVideo = (e: React.MouseEvent): { x: number; y: number } | null => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    const r = v.getBoundingClientRect();
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * scale, h = v.videoHeight * scale;
    const x = (e.clientX - r.left - (r.width - w) / 2) / w;
    const y = (e.clientY - r.top - (r.height - h) / 2) / h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
  };
  // What SAM takes a pointed-at part to be on that frame, drawn over the picture so a point that
  // landed on a finger or the face is seen at once. Keyed by frame + its points.
  type Preview = { key: string; frame: number; url?: string; area?: number; error?: string; busy?: boolean };
  const [previews, setPreviews] = useState<Preview[]>([]);
  const keyOf = (frame: number, pts: { x: number; y: number }[]) =>
    `${frame}|${pts.map((p) => `${p.x},${p.y}`).join(';')}`;
  const requestPreview = useCallback(async (frame: number, pts: { x: number; y: number }[]) => {
    if (!sourceVideoUrl || !pts.length) return;
    const key = keyOf(frame, pts);
    setPreviews((cur) => [...cur.filter((p) => p.frame !== frame), { key, frame, busy: true }]);
    try {
      const r = await api.mosaicPreview({ video_url: sourceVideoUrl, frame, points: pts });
      setPreviews((cur) => cur.map((p) => (p.key === key ? { key, frame, url: r.url, area: r.area } : p)));
    } catch (e: any) {
      setPreviews((cur) => cur.map((p) => (p.key === key ? { key, frame, error: e.message || 'preview failed' } : p)));
    }
  }, [sourceVideoUrl]);
  const addSeed = (e: React.MouseEvent) => {
    e.stopPropagation();
    const p = pointOnVideo(e);
    if (!p) return;
    const frame = Math.max(0, Math.round((videoRef.current?.currentTime ?? 0) * FPS));
    updateNodeData(id, { mosaicSeeds: [...seeds, { frame, ...p }] });
    void requestPreview(frame, [...seeds.filter((s) => s.frame === frame), p].map(({ x, y }) => ({ x, y })));
  };
  const removeSeed = (i: number) => {
    const gone = seeds[i];
    const rest = seeds.filter((_, k) => k !== i);
    updateNodeData(id, { mosaicSeeds: rest });
    const left = rest.filter((s) => s.frame === gone.frame).map(({ x, y }) => ({ x, y }));
    if (left.length) void requestPreview(gone.frame, left);
    else setPreviews((cur) => cur.filter((p) => p.frame !== gone.frame));
  };
  const shownPreview = previews.find((p) => p.frame === curFrame);

  const isGenerating = data.status === 'generating';
  const canRun = Boolean(sourceVideoUrl) && !isGenerating;
  const withBreast = (data.mosaicClasses ?? []).includes(BREAST);

  const handleCancel = useCallback(async () => {
    cancelledRef.current = true;
    if (data.jobId) {
      try { await api.cancelJob(data.jobId as string); } catch {}
    }
    updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
  }, [id, updateNodeData, data.jobId]);

  const handleRun = useCallback(async () => {
    if (!sourceVideoUrl) return;
    cancelledRef.current = false;
    videoRef.current?.pause();
    updateNodeData(id, {
      status: 'generating', jobId: undefined, error: undefined, sourceUrl: sourceVideoUrl,
      width: connectedVideo?.width, height: connectedVideo?.height,
    });
    try {
      const { job_id } = await api.mosaicVideo({
        video_url: sourceVideoUrl,
        expand: Number(data.mosaicExpand ?? 12),
        temporal: Number(data.mosaicTemporal ?? 2),
        style: (data.mosaicStyle as 'mosaic' | 'blur' | 'block') ?? 'mosaic',
        block: Number(data.mosaicBlock ?? 0),
        classes: data.mosaicClasses && data.mosaicClasses.length ? data.mosaicClasses : null,
        threshold: Number(data.mosaicThreshold ?? 0.25),
        step: Number(data.mosaicStep ?? 8),
        seeds: seeds.length ? seeds : null,
      });
      if (cancelledRef.current) return;
      updateNodeData(id, { jobId: job_id });
    } catch (e: any) {
      if (!cancelledRef.current) updateNodeData(id, { status: 'error', error: e.message, jobId: undefined });
    }
  }, [sourceVideoUrl, id, updateNodeData, data.mosaicExpand, data.mosaicTemporal, data.mosaicStyle,
      data.mosaicBlock, data.mosaicClasses, data.mosaicThreshold, data.mosaicStep, seeds,
      connectedVideo?.width, connectedVideo?.height]);

  const sizing = useNodeSizing({
    id,
    type: 'mosaic',
    rows: ['header', 'actions'],
    paddingX: 0,
    ratioSources: [{ width: connectedVideo?.width, height: connectedVideo?.height }],
    hasMedia: Boolean(data.generatedUrl || sourceVideoUrl),
    userWidth: data.userWidth as number | undefined,
  });

  const numInput: React.CSSProperties = {
    width: 58, background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 6,
    padding: '2px 6px', textAlign: 'right', color: '#fff', fontSize: 11, outline: 'none',
  };
  const smallBtn: React.CSSProperties = {
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6,
    padding: '2px 6px', color: '#ccc', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit',
  };
  const focus = {
    onFocus: () => window.dispatchEvent(new Event('inputFocused')),
    onBlur: () => window.dispatchEvent(new Event('inputBlurred')),
  };
  const info = data.mosaicInfo as
    { suspect_frames?: number[]; detected_frames?: number; keyframes?: number; no_detection?: boolean;
      mode?: string; tracked_frames?: number } | undefined;
  const suspects = info?.suspect_frames ?? [];
  const seekTo = (frame: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = frame / FPS;
  };
  const numRow = (field: 'mosaicExpand' | 'mosaicTemporal' | 'mosaicBlock' | 'mosaicStep' | 'mosaicThreshold',
                  lbl: string, tip: string, min: number, max: number, step = 1) => (
    <div key={field} style={{ display: 'flex', alignItems: 'center', gap: 6 }} title={tip}>
      <span style={{ flex: 1 }}>{lbl}</span>
      <input type="number" className="nodrag" style={numInput} min={min} max={max} step={step}
        value={data[field] as number}
        onChange={(e) => updateNodeData(id, { [field]: Math.min(max, Math.max(min, +e.target.value || 0)) })}
        {...focus} />
    </div>
  );

  return (
    <NodeShell nodeId={id} spec={sizing.spec} selected={selected} onResizeEnd={sizing.onResizeEnd} shellRef={sizing.shellRef}>
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
          <MosaicIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('平台打码')}</span>
        </div>
        {data.generatedUrl && sourceVideoUrl && (
          <button className="nodrag" style={smallBtn} onClick={() => setShowSource((v) => !v)}>
            {showSource ? t('看结果') : t('看原片')}
          </button>
        )}
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div style={{ ...cardBody, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: videoSrc ? 'transparent' : cardBody.background }}>
          {videoSrc ? (
            <div style={{ position: 'relative', flex: 1, borderRadius: 20, overflow: 'hidden', boxShadow: selected ? selectedShadow : defaultShadow, background: 'rgba(0,0,0,0.2)' }}>
              <NodeVideoPlayer
                nodeId={id}
                src={videoSrc}
                videoRef={videoRef}
                selected={selected}
                hideChrome={picking}
                onMediaSize={sizing.onMediaSize}
                actions={<><span />{data.generatedUrl && !showSource ? (
                  <button type="button" className="nodrag" style={{ ...smallBtn, background: 'none', border: 'none' }}
                    onClick={(e) => { e.stopPropagation(); void downloadFile(`${API_BASE}${data.generatedUrl}`, 'mosaic-video.mp4', (data as any).alias); }}>
                    <DownloadIcon />
                  </button>
                ) : <span />}</>}
              />
              <GeneratingLine active={isGenerating} jobId={data.jobId as string | undefined} steps={1} statusText={batchInfo} onCancel={handleCancel} />
              {picking && (!data.generatedUrl || showSource) && (
                <div className="nodrag" onClick={addSeed} onMouseDown={(e) => e.stopPropagation()}
                  style={{ position: 'absolute', inset: 0, cursor: 'crosshair', zIndex: 30 }} />
              )}
              {shownPreview?.url && (!data.generatedUrl || showSource) && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`${API_BASE}${shownPreview.url}`} alt="" draggable={false}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none', zIndex: 29 }} />
              )}
              {(!data.generatedUrl || showSource) && seeds.filter((s) => Math.abs(s.frame - curFrame) <= 1).map((s, i) => (
                <div key={`${s.frame}-${i}`} style={{
                  position: 'absolute', zIndex: 31, pointerEvents: 'none', width: 14, height: 14, borderRadius: 7,
                  border: '2px solid #22d3ee', background: 'rgba(34,211,238,0.25)',
                  left: `${s.x * 100}%`, top: `${s.y * 100}%`, transform: 'translate(-50%, -50%)',
                }} />
              ))}
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#555', textAlign: 'center', padding: 12 }}>
              {t('连接一个视频')}
            </div>
          )}
          {picking && videoSrc && (
            <div className="nodrag" onMouseDown={(e) => e.stopPropagation()}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', fontSize: 10, color: '#ccc' }}>
              <button className="nodrag" style={smallBtn} onClick={() => stepFrames(-1)}>‹</button>
              <button className="nodrag" style={smallBtn} onClick={togglePlay}>{playing ? '❚❚' : '▶'}</button>
              <button className="nodrag" style={smallBtn} onClick={() => stepFrames(1)}>›</button>
              <input type="range" className="nodrag" style={{ flex: 1 }} min={0} max={Math.max(1, totalFrames - 1)} step={1}
                value={Math.min(curFrame, Math.max(1, totalFrames - 1))}
                onChange={(e) => seekTo(+e.target.value)} />
              <span style={{ fontFamily: 'monospace' }}>{curFrame}/{Math.max(0, totalFrames - 1)}</span>
            </div>
          )}
          {data.status === 'error' && (
            <div style={{
              position: 'absolute', top: 12, left: 12, right: 12, zIndex: 40, padding: '6px 10px', fontSize: 11,
              textAlign: 'center', color: '#ff6b6b', background: 'rgba(40, 0, 0, 0.85)', borderRadius: 8,
              border: '1px solid rgba(255,107,107,0.25)', pointerEvents: 'none',
            }}>
              {t('处理失败')}{data.error ? `: ${data.error}` : ''}
            </div>
          )}
        </div>
      </div>

      <div data-chrome-row="actions" className="nodrag" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', fontSize: 11, color: '#bbb' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button className="nodrag" disabled={!sourceVideoUrl}
            style={{ ...smallBtn, background: picking ? 'rgba(34,211,238,0.25)' : smallBtn.background, color: picking ? '#a5f3fc' : '#ccc' }}
            onClick={() => { setPicking((v) => !v); if (data.generatedUrl) setShowSource(true); videoRef.current?.pause(); }}>
            {picking ? t('点击画面上的部位（再点一次结束）') : t('指定位置')}
          </button>
          {seeds.length > 0 && (
            <button className="nodrag" style={smallBtn} onClick={() => { updateNodeData(id, { mosaicSeeds: [] }); setPreviews([]); }}>{t('清空')}</button>
          )}
        </div>
        {shownPreview && (
          <div style={{ fontSize: 10, color: shownPreview.error ? '#f87171' : (shownPreview.area ?? 0) > 0.05 || shownPreview.area === 0 ? '#fbbf24' : '#a5f3fc' }}>
            {shownPreview.busy ? t('正在识别这一点…')
              : shownPreview.error ? `${t('识别失败')}: ${shownPreview.error}`
              : shownPreview.area === 0 ? t('这一点没有识别出任何东西，换个位置点')
              : (shownPreview.area ?? 0) > 0.05 ? `${t('识别范围偏大')} ${((shownPreview.area ?? 0) * 100).toFixed(1)}% ${t('，可能点到了身体或脸')}`
              : `${t('识别范围')} ${((shownPreview.area ?? 0) * 100).toFixed(2)}%`}
          </div>
        )}
        {seeds.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 10 }}>
            {seeds.map((s, i) => (
              <span key={`${s.frame}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 5px',
                borderRadius: 6, background: 'rgba(34,211,238,0.12)', color: '#a5f3fc' }}>
                <button className="nodrag" style={{ ...smallBtn, background: 'none', border: 'none', padding: 0, color: 'inherit' }}
                  onClick={() => { setShowSource(true); seekTo(s.frame); }}>{t('第')} {s.frame} {t('帧')}</button>
                <button className="nodrag" style={{ ...smallBtn, background: 'none', border: 'none', padding: 0, color: '#f87171' }}
                  onClick={() => removeSeed(i)}>×</button>
              </span>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 10, color: '#777' }}>
            {t('没有指定位置时按自动检测（只适合写实画面）；动漫或被遮挡的部位请在画面上点出来')}
          </div>
        )}
        {numRow('mosaicExpand', t('外扩（像素）'), t('遮罩向外扩的像素数，按 768 短边折算；漏打比多打严重，宁可大一点'), 0, 200)}
        {numRow('mosaicTemporal', t('前后帧并集'), t('每帧的遮罩取前后各几帧的并集，防止漏帧'), 0, 12)}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1 }}>{t('样式')}</span>
          <Select className="nodrag" value={data.mosaicStyle ?? 'mosaic'}
            style={{ ...numInput, width: 88, textAlign: 'left' }}
            onChange={(e) => updateNodeData(id, { mosaicStyle: e.target.value })}>
            <option value="mosaic">{t('马赛克')}</option>
            <option value="blur">{t('模糊')}</option>
            <option value="block">{t('色块')}</option>
          </Select>
        </div>
        {numRow('mosaicBlock', t('块大小（0=自动）'), t('马赛克块的像素大小，0 按画面大小自动取'), 0, 200)}
        {numRow('mosaicThreshold', t('检测灵敏度'), t('检测置信度阈值，越低越不容易漏，也越容易误检'), 0.05, 0.95, 0.05)}
        {numRow('mosaicStep', t('检测间隔（帧）'), t('每隔多少帧检测一次，其余帧由跟踪补上'), 1, 48)}
        <label className="nodrag" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
          title={t('穿着紧身衣物时检测器会把衣物轮廓当成裸露，默认不打；确认画面需要时再勾选')}>
          <input type="checkbox" className="nodrag" checked={withBreast}
            onChange={(e) => updateNodeData(id, { mosaicClasses: e.target.checked ? [BREAST] : [] })} />
          <span>{t('同时打胸部（易误检）')}</span>
        </label>
        {info?.no_detection && data.generatedUrl && (
          <div style={{ fontSize: 11, color: '#ff6b6b' }}>
            {t('没有检出任何要打码的部位，输出与原片相同。可调低灵敏度，或勾选胸部。')}
          </div>
        )}
        {info && data.generatedUrl && (
          <div style={{ fontSize: 10, color: suspects.length ? '#fbbf24' : '#777' }}>
            {info.mode === 'seeds'
              ? <>{t('已跟踪帧数')} {info.tracked_frames ?? 0}</>
              : <>{t('检出关键帧')} {info.detected_frames ?? 0}/{info.keyframes ?? 0}</>}
            {suspects.length > 0 && (
              <span> · {t('疑点帧')}：{suspects.slice(0, 12).map((f) => (
                <button key={f} className="nodrag" style={{ ...smallBtn, marginLeft: 3 }} onClick={() => seekTo(f)}>{f}</button>
              ))}</span>
            )}
          </div>
        )}
        <button className="nodrag" onClick={handleRun} disabled={!canRun}
          style={{
            width: '100%', padding: '6px 0', borderRadius: 8, fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
            background: canRun ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)',
            color: canRun ? '#fff' : '#666', border: '1px solid rgba(255,255,255,0.12)',
            cursor: canRun ? 'pointer' : 'not-allowed',
          }}>
          {t('打码')}
        </button>
      </div>

      <IconHandle type="target" id="in-video" portType="video" nodeId={id} />
      <IconHandle type="source" id="out-video" portType="video" nodeId={id} />
    </NodeShell>
  );
}

export default memo(MosaicNode, areNodePropsEqual);

function MosaicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <rect x="3" y="3" width="8" height="8" opacity="0.9" /><rect x="13" y="3" width="8" height="8" opacity="0.4" />
      <rect x="3" y="13" width="8" height="8" opacity="0.4" /><rect x="13" y="13" width="8" height="8" opacity="0.9" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}
