'use client';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { provides } from '@/lib/nodeRegistry';
import { areNodePropsEqual, downloadFile } from '@/lib/utils';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import { VideoTrimNode as VideoTrimNodeType } from '@/lib/types';
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
import { probeVideo } from '@/lib/videoProbe';
import TrimTimeline from './TrimTimeline';

/** H3 renders at 24 fps; the trim range is entered in frames of this rate. */
const FPS = 24;

function VideoTrimNode({ id, data, selected }: NodeProps<VideoTrimNodeType>) {
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
        trimPlan: (jobResult as any).trim ?? undefined,
        latentFilename: (jobResult as any).latent_filename ?? undefined,
      });
      setShowSource(false);
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || 'Trim failed', jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
    }
  }, [jobResult]); // eslint-disable-line react-hooks/exhaustive-deps

  const shownUrl = (!showSource && data.generatedUrl) || sourceVideoUrl;
  useEffect(() => {
    if (!shownUrl) { setVideoSrc(null); return; }
    setVideoSrc(shownUrl.startsWith('http') || shownUrl.startsWith('blob:') ? shownUrl : `${API_BASE}${shownUrl}`);
  }, [shownUrl]);

  const isGenerating = data.status === 'generating';
  const start = Number(data.trimStartSeconds ?? 0);
  const end = data.trimEndSeconds ?? null;

  // The timeline runs over the SOURCE clip: its length in frames, probed once.
  const [sourceFrames, setSourceFrames] = useState(0);
  useEffect(() => {
    if (!sourceVideoUrl) { setSourceFrames(0); return; }
    let live = true;
    const url = sourceVideoUrl.startsWith('http') || sourceVideoUrl.startsWith('blob:') ? sourceVideoUrl : `${API_BASE}${sourceVideoUrl}`;
    probeVideo(url).then((probe) => {
      if (live && Number.isFinite(probe.seconds) && probe.seconds > 0) setSourceFrames(Math.round(probe.seconds * FPS));
    }).catch(() => {});
    return () => { live = false; };
  }, [sourceVideoUrl]);
  const startFrame = Math.round(start * FPS);
  const endFrame = end === null || end === undefined ? sourceFrames : Math.min(sourceFrames || Infinity, Math.round(Number(end) * FPS));

  // Where the player is, as a frame of the source (the result starts at the cut's first frame).
  const [playFrame, setPlayFrame] = useState<number | null>(null);
  const showingSource = showSource || !data.generatedUrl;
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const update = () => setPlayFrame(Math.round(v.currentTime * FPS) + (showingSource ? 0 : startFrame));
    v.addEventListener('timeupdate', update);
    v.addEventListener('seeked', update);
    return () => { v.removeEventListener('timeupdate', update); v.removeEventListener('seeked', update); };
  }, [videoSrc, showingSource, startFrame]);

  // Dragging a handle scrubs the player to that frame (on the source, not the old result).
  const pendingSeek = useRef<number | null>(null);
  const scrubTo = (frame: number) => {
    pendingSeek.current = Math.max(0, frame) / FPS;
    if (data.generatedUrl && !showSource) setShowSource(true);
    applySeek();
  };
  const applySeek = () => {
    const v = videoRef.current;
    if (v && pendingSeek.current !== null && v.readyState >= 1 && (showSource || !data.generatedUrl)) {
      v.pause();
      v.currentTime = pendingSeek.current;
      pendingSeek.current = null;
    }
  };
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.addEventListener('loadedmetadata', applySeek);
    applySeek();
    return () => v.removeEventListener('loadedmetadata', applySeek);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const rangeValid = start >= 0 && (end === null || end > start);
  const canTrim = Boolean(sourceVideoUrl) && rangeValid && !isGenerating;

  const setFromPlayer = (field: 'trimStartSeconds' | 'trimEndSeconds') => {
    const v = videoRef.current;
    if (!v) return;
    updateNodeData(id, { [field]: Math.round(v.currentTime * FPS) / FPS });
  };
  // Entered and shown as frame numbers (the range is stored as seconds for the
  // backend, always a whole frame): start frame kept, end frame not kept.
  const toFrame = (sec: unknown) => (sec === null || sec === undefined || sec === '' ? '' : Math.round(Number(sec) * FPS));

  const handleCancel = useCallback(async () => {
    cancelledRef.current = true;
    if (data.jobId) {
      try { await api.cancelJob(data.jobId as string); } catch {}
    }
    updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
  }, [id, updateNodeData, data.jobId]);

  const handleTrim = useCallback(async () => {
    if (!sourceVideoUrl) return;
    cancelledRef.current = false;
    videoRef.current?.pause();
    updateNodeData(id, {
      status: 'generating', jobId: undefined, error: undefined, sourceUrl: sourceVideoUrl, latentFilename: undefined,
      width: connectedVideo?.width, height: connectedVideo?.height,
    });
    try {
      const { job_id } = await api.trimVideo({
        video_url: sourceVideoUrl,
        start_seconds: start,
        end_seconds: end,
        keep_audio: !data.trimMuteAudio,
        depth: !!data.trimDepth,
        latent_filename: connectedVideo?.latentFilename ?? null,
        context_frames: Number(connectedVideo?.contextFrames) || 0,
      });
      if (cancelledRef.current) return;
      updateNodeData(id, { jobId: job_id });
    } catch (e: any) {
      if (!cancelledRef.current) updateNodeData(id, { status: 'error', error: e.message, jobId: undefined });
    }
  }, [sourceVideoUrl, start, end, id, updateNodeData, connectedVideo?.width, connectedVideo?.height]);

  const sizing = useNodeSizing({
    id,
    type: 'videoTrim',
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
  const plan = data.trimPlan as { frames?: number; fps?: number } | undefined;

  return (
    <NodeShell nodeId={id} spec={sizing.spec} selected={selected} onResizeEnd={sizing.onResizeEnd} shellRef={sizing.shellRef}>
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
          <ScissorsIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('视频剪切')}</span>
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
                onMediaSize={sizing.onMediaSize}
                actions={<><span />{data.generatedUrl && !showSource ? (
                  <button type="button" className="nodrag" style={{ ...smallBtn, background: 'none', border: 'none' }}
                    onClick={(e) => { e.stopPropagation(); void downloadFile(`${API_BASE}${data.generatedUrl}`, 'trimmed-video.mp4', (data as any).alias); }}>
                    <DownloadIcon />
                  </button>
                ) : <span />}</>}
              />
              <GeneratingLine active={isGenerating} jobId={data.jobId as string | undefined} steps={1} statusText={batchInfo} onCancel={handleCancel} />
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#555', textAlign: 'center', padding: 12 }}>
              {t('连接一个视频')}
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
        {sourceFrames > 0 && (
          <TrimTimeline
            totalFrames={sourceFrames}
            start={Math.min(startFrame, Math.max(0, sourceFrames - 1))}
            end={Math.max(startFrame + 1, endFrame)}
            contextFrames={Number(connectedVideo?.contextFrames) || 0}
            hasLatent={Boolean(connectedVideo?.latentFilename)}
            playFrame={playFrame}
            onChange={(next) => {
              const patch: Record<string, unknown> = {};
              if (next.start !== undefined) { patch.trimStartSeconds = next.start / FPS; scrubTo(next.start); }
              if (next.end !== undefined) {
                patch.trimEndSeconds = next.end >= sourceFrames ? null : next.end / FPS;
                scrubTo(next.end - 1);
              }
              updateNodeData(id, patch);
            }}
            onSeek={(frame) => scrubTo(frame)}
          />
        )}
        {([['trimStartSeconds', t('起始帧'), t('设为起点')], ['trimEndSeconds', t('结束帧（不含）'), t('设为终点')]] as const).map(([field, lbl, btn]) => (
          <div key={field} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ flex: 1 }}>{lbl}</span>
            {data[field] !== null && data[field] !== undefined && (
              <span style={{ color: '#777', fontSize: 10 }}>{Number(data[field]).toFixed(3)}s</span>
            )}
            <input type="number" className="nodrag" style={numInput} min={0} step={1}
              value={toFrame(data[field])}
              placeholder={field === 'trimEndSeconds' ? t('到结尾') : '0'}
              onChange={(e) => updateNodeData(id, { [field]: e.target.value === '' ? (field === 'trimEndSeconds' ? null : 0) : Math.max(0, Math.round(+e.target.value)) / FPS })}
              onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
              onBlur={() => window.dispatchEvent(new Event('inputBlurred'))}
            />
            <button className="nodrag" style={smallBtn} disabled={!videoSrc} onClick={() => setFromPlayer(field)}>{btn}</button>
          </div>
        ))}
        <label className="nodrag" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
          title={t('剪出无声片段：作运镜参考挂到 H3 时不会多出一个 <Audio N>')}>
          <input type="checkbox" className="nodrag" checked={!!data.trimMuteAudio}
            onChange={(e) => updateNodeData(id, { trimMuteAudio: e.target.checked })} />
          <span>{t('去掉音轨')}</span>
        </label>
        <label className="nodrag" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
          title={t('输出逐帧深度图（无声）：作运镜参考时 H3 只能学到空间和机位运动，抄不到人脸、服装和画面质感')}>
          <input type="checkbox" className="nodrag" checked={!!data.trimDepth}
            onChange={(e) => updateNodeData(id, { trimDepth: e.target.checked })} />
          <span>{t('转深度图')}</span>
        </label>
        <button className="nodrag" onClick={handleTrim} disabled={!canTrim}
          style={{
            width: '100%', padding: '6px 0', borderRadius: 8, fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
            background: canTrim ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)',
            color: canTrim ? '#fff' : '#666', border: '1px solid rgba(255,255,255,0.12)',
            cursor: canTrim ? 'pointer' : 'not-allowed',
          }}>
          {t('剪切')}{plan?.frames ? ` · ${plan.frames}f` : ''}
        </button>
      </div>

      <IconHandle type="target" id="in-video" portType="video" nodeId={id} />
      <IconHandle type="source" id="out-video" portType="video" nodeId={id} />
    </NodeShell>
  );
}

export default memo(VideoTrimNode, areNodePropsEqual);

function ScissorsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
      <path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12" />
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
