'use client';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { provides } from '@/lib/nodeRegistry';
import { areNodePropsEqual, downloadFile } from '@/lib/utils';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import { VideoInterpolateNode as VideoInterpolateNodeType, VideoInterpolateNodeData } from '@/lib/types';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { cardBody, header, label, selectedShadow, defaultShadow } from './PromptNode';
import NodeShell from './NodeShell';
import { useAutoHeightNode } from '@/hooks/useAutoHeightNode';
import GeneratingLine from './GeneratingLine';
import VideoPreviewModal from './VideoPreviewModal';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult, useActiveBatchInfo } from '@/hooks/useJobPoller';

import { BACKEND_URL as API_BASE, posterUrl } from '@/lib/config';
import { showAlert } from '@/components/ui/Dialog';
import { NATIVE_VIDEO_CHROME_OFF } from './mediaChrome';
import NodeVideoPlayer from './NodeVideoPlayer';
import { NodeHeaderIconButton } from './nodeChrome';
import { GearIcon } from '@/components/ui/icons';
import { t } from '@/lib/i18n';

function VideoInterpolateNode({ id, data, selected }: NodeProps<VideoInterpolateNodeType>) {
  const { updateNodeData, addNodes, setNodes, getNodes } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const activeAudioNodeId = useStore((s) => s.activeAudioNodeId);
  const setActiveAudioNodeId = useStore((s) => s.setActiveAudioNodeId);
  const isAudioActive = activeAudioNodeId === id;
  const settings = useStore((s) => s.settings);

  const [showSettings, setShowSettings] = useState(false);
  const [showCompare, setShowCompare] = useState(false);

  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playToken, setPlayToken] = useState(0);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDur, setVideoDur] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const batchInfo = useActiveBatchInfo(data.jobId as string | undefined);
  const prevGeneratedUrlRef = useRef<string | null>(data.generatedUrl as string | null);
  const prevStatusRef = useRef<string>((data.status as string) || 'idle');
  const isInitialMountRef = useRef(true);

  const jobResult = useJobResult(data.jobId as string | undefined);
  useEffect(() => {
    if (!jobResult || cancelledRef.current) return;
    if (jobResult.status === 'done' && jobResult.url) {
      updateNodeData(id, { status: 'done', generatedUrl: jobResult.url as string, jobId: undefined });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || 'Interpolate failed', jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      // Cancelled elsewhere (another tab, the API, a script): stop waiting on it.
      updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
    }
  }, [jobResult]); // eslint-disable-line react-hooks/exhaustive-deps


  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      if (data.generatedUrl) {
        if (videoRef.current) {
          videoRef.current.pause();
          setIsPlaying(false);
        }
      }
      return;
    }

    const prevUrl = prevGeneratedUrlRef.current;
    const curUrl = data.generatedUrl as string | null;
    const prevStatus = prevStatusRef.current;
    const curStatus = (data.status as string) || 'idle';

    prevGeneratedUrlRef.current = curUrl;
    prevStatusRef.current = curStatus;

    const justFinished = (prevStatus === 'generating' && curStatus !== 'generating' && curUrl) || (curUrl && curUrl !== prevUrl);

    if (justFinished) {
      if (settings.autoplayOnComplete) {
        if (settings.unmuteOnComplete) setActiveAudioNodeId(id);
        // The <video> is usually not mounted yet (poster is up), so ask the player.
        setPlayToken((n) => n + 1);
      } else {
        videoRef.current?.pause();
        setIsPlaying(false);
      }
    }
  }, [data.generatedUrl, data.status, settings.autoplayOnComplete, settings.unmuteOnComplete, setActiveAudioNodeId, id]);

  useEffect(() => {
    if (data.status === 'generating') {
      if (videoRef.current) {
        videoRef.current.pause();
      }
      setIsPlaying(false);
    }
  }, [data.status]);

  // Sync DOM muted property with global audio exclusivity state
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = !isAudioActive;
    }
  }, [isAudioActive]);

  // Load output video as blob for CORS-safe playback
  useEffect(() => {
    if (!data.generatedUrl) { setVideoSrc(null); return; }
    const url = `${API_BASE}${data.generatedUrl}`;
    let blobUrl: string | null = null;
    fetch(url)
      .then((r) => r.blob())
      .then((blob) => { blobUrl = URL.createObjectURL(blob); setVideoSrc(blobUrl); })
      .catch(() => setVideoSrc(url));
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [data.generatedUrl]);

  useEffect(() => {
    if (showCompare && videoRef.current) {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  }, [showCompare]);

  // Any registered video producer, asset nodes holding a video included.
  const connectedVideo = connected.find((n) => provides(n, 'video'));
  const sourceVideoUrl = connectedVideo
    ? (connectedVideo.generatedUrl || connectedVideo.url) as string | null
    : null;

  const connectedVideoData = connectedVideo;

  const compareUrl = data.compareUrl || sourceVideoUrl;

  // Load source (input) video as blob for CORS-safe background preview
  useEffect(() => {
    if (!compareUrl) { setPreviewSrc(null); return; }
    if (compareUrl.startsWith('blob:')) { setPreviewSrc(compareUrl); return; }
    const url = compareUrl.startsWith('http') ? compareUrl : `${API_BASE}${compareUrl}`;
    let blobUrl: string | null = null;
    fetch(url)
      .then((r) => r.blob())
      .then((blob) => { blobUrl = URL.createObjectURL(blob); setPreviewSrc(blobUrl); })
      .catch(() => setPreviewSrc(url));
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [compareUrl]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (isPlaying) v.pause(); else v.play().catch(() => {});
  }, [isPlaying]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const canGenerate = comfyuiOnline && !!sourceVideoUrl;

  const isGenerating = data.status === 'generating';
  const currentShadow = selected ? selectedShadow : defaultShadow;
  const showOverlay = isHovered || showSettings || isFocused;

  const handleCancel = useCallback(async () => {
    cancelledRef.current = true;
    if (data.jobId) {
      try { await api.cancelJob(data.jobId as string); } catch {}
    }
    updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
  }, [id, updateNodeData, data.jobId]);

  const handleScreenshot = useCallback(async (videoEl?: HTMLVideoElement) => {
    const nodes = getNodes();
    const video = videoEl || videoRef.current;
    if (!video) {
      void showAlert('Video element not found');
      return;
    }

    if (video.videoWidth === 0 || video.videoHeight === 0 || video.readyState < 2) {
      void showAlert('Video is still loading or has no data. Please wait a moment.');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      void showAlert('Failed to get canvas context');
      return;
    }

    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch (e) {
      console.error('Failed to draw frame to canvas:', e);
      void showAlert('Failed to capture video frame. This is likely a CORS issue. Please check console.');
      return;
    }

    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) {
        void showAlert('Failed to create image blob');
        return;
      }
      const file = new File([blob], `shot-${Date.now()}.png`, { type: 'image/png' });

      const { url, comfy_filename } = await api.uploadStyleReference(file);

      const currentNode = nodes.find((n) => n.id === id);
      const selfX = currentNode?.position?.x ?? 0;
      const selfY = currentNode?.position?.y ?? 0;
      const selfWidth = currentNode?.measured?.width ?? currentNode?.width ?? 240;
      const selfHeight = currentNode?.measured?.height ?? currentNode?.height ?? 300;

      const newW = 240;
      const newH = 32 + Math.min(Math.round((240 * video.videoHeight) / video.videoWidth), 480);

      // Define candidate positions: Right, Bottom, Left, Top
      const dirs = [
        { x: selfX + selfWidth + 50, y: selfY }, // Right
        { x: selfX, y: selfY + selfHeight + 50 }, // Bottom
        { x: selfX - newW - 50, y: selfY }, // Left
        { x: selfX, y: selfY - newH - 50 } // Top
      ];

      let newX = selfX + selfWidth + 50;
      let newY = selfY;
      let foundFreeSpace = false;

      for (const dir of dirs) {
        let hasOverlap = false;
        for (const n of nodes) {
          if (n.id === id) continue;
          const nX = n.position?.x ?? 0;
          const nY = n.position?.y ?? 0;
          const nW = n.measured?.width ?? n.width ?? 280;
          const nH = n.measured?.height ?? n.height ?? 300;

          // Check overlap
          const xOverlap = !(dir.x + newW < nX || nX + nW < dir.x);
          const yOverlap = !(dir.y + newH < nY || nY + nH < dir.y);
          if (xOverlap && yOverlap) {
            hasOverlap = true;
            break;
          }
        }
        if (!hasOverlap) {
          newX = dir.x;
          newY = dir.y;
          foundFreeSpace = true;
          break;
        }
      }

      if (!foundFreeSpace) {
        // No free space in any direction. Place on the right, cascading with an offset (like Windows cascading windows)
        let cascadeCount = 0;
        for (const n of nodes) {
          if (n.id.startsWith('img-shot-') || n.id.startsWith('image-')) {
            const nX = n.position?.x ?? 0;
            if (nX >= selfX + selfWidth) {
              cascadeCount++;
            }
          }
        }
        const index = cascadeCount % 8;
        newX = selfX + selfWidth + 50 + index * 30;
        newY = selfY + index * 30;
      }

      const newNode = {
        id: `img-shot-${Date.now()}`,
        type: 'image',
        position: { x: newX, y: newY },
        data: { 
          url, 
          comfyFilename: comfy_filename,
          width: video.videoWidth,
          height: video.videoHeight
        },
        selected: false,
        zIndex: 1000,
        width: newW,
        height: newH,
      };

      console.log('Adding new node:', newNode);
      addNodes(newNode);

      window.dispatchEvent(new Event('takeSnapshot'));
    } catch (e: any) {
      console.error('Screenshot failed:', e);
      void showAlert(`Screenshot failed: ${e.message}`);
    }
  }, [id, videoRef, addNodes]);

  const handleGenerate = useCallback(async () => {
    if (!sourceVideoUrl) return;

    cancelledRef.current = false;
    if (videoRef.current) {
      videoRef.current.pause();
    }
    setIsPlaying(false);
    updateNodeData(id, { status: 'generating', jobId: undefined, error: undefined, compareUrl: sourceVideoUrl });
    try {
      const { job_id } = await api.interpolateVideo({
        video_url: sourceVideoUrl,
        target_fps: data.targetFps ?? 30,
      });
      if (cancelledRef.current) return;
      updateNodeData(id, { jobId: job_id });
    } catch (e: any) {
      if (!cancelledRef.current) updateNodeData(id, { status: 'error', error: e.message, jobId: undefined });
    }
  }, [sourceVideoUrl, data.targetFps, id, updateNodeData]);

  const iconBtn: React.CSSProperties = {
    background: 'none', border: 'none', padding: '6px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', color: 'rgba(255,255,255,0.6)',
    borderRadius: '6px', transition: 'background 0.2s, color 0.2s',
  };

  // Only the width is kept; the picture's box has the video's own ratio (hooks/useAutoHeightNode).
  const sizing = useAutoHeightNode({
    id,
    ratioSources: [{ width: connectedVideoData?.width, height: connectedVideoData?.height }],
    hasMedia: Boolean(data.generatedUrl || sourceVideoUrl),
    mediaHidden: showSettings,
    userWidth: data.userWidth as number | undefined,
    defaultW: 320,
  });

  return (
    <NodeShell
      nodeId={id}
      spec={sizing.spec}
      selected={selected}
      onResizeEnd={sizing.onResizeEnd}
      autoHeight
    >
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
          <InterpolateIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('视频插帧')}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-mono text-zinc-400 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">
            {connectedVideoData?.width && connectedVideoData?.height ? `${connectedVideoData.width}×${connectedVideoData.height} · ` : ''}
            {data.targetFps}fps
          </span>
          <NodeHeaderIconButton active={showSettings} onClick={() => setShowSettings((v) => !v)} title={t('设置')}>
            <GearIcon />
          </NodeHeaderIconButton>
        </div>
      </div>
      {showSettings && (
        <div data-chrome-row="settings" className="node-shell-drawer nodrag nowheel p-3 text-xs animate-in fade-in duration-150">
          <SettingsPanel data={data} id={id} updateNodeData={updateNodeData} inline />
        </div>
      )}

      {data.generatedUrl ? (
        // ── Result view ──────────────────────────────────────────────────────────
        <div data-node-media style={{ position: 'relative', flex: '0 0 auto', aspectRatio: String(sizing.ratio) }}>
          <div
            style={{ ...cardBody, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'transparent' }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            <div style={{ position: 'relative', flex: 1, borderRadius: 20, overflow: 'hidden', boxShadow: currentShadow, background: 'rgba(0,0,0,0.2)' }}>
              <NodeVideoPlayer
                nodeId={id}
                playToken={playToken}
                src={videoSrc}
                videoRef={videoRef}
                selected={selected}
                paused={showCompare || showSettings}
                onMediaSize={sizing.onMediaSize}
                onDuration={setVideoDur}
                actions={<><span /><div className="flex items-center gap-1">
                <button className="nodrag" onClick={() => void handleScreenshot()} title={t('抽取当前帧至画布')}
                  style={{ ...iconBtn, color: 'rgba(255,255,255,0.7)' }}>
                  <CameraIcon />
                </button>
                
                <button
                  className="nodrag"
                  onClick={() => {
                    if (videoRef.current) {
                      videoRef.current.pause();
                      setIsPlaying(false);
                    }
                    setShowCompare(true);
                  }}
                  title={t('放大查看')}
                  style={{ ...iconBtn, color: 'rgba(255,255,255,0.7)' }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                  </svg>
                </button>
                <button type="button" style={iconBtn} onClick={(e) => { e.stopPropagation(); void downloadFile(`${API_BASE}${data.generatedUrl}`, 'interpolated-video.mp4', (data as any).alias); }}>
                  <DownloadIcon />
                </button>
                <button className="nodrag"
                  onClick={handleGenerate}
                  disabled={isGenerating || !canGenerate}
                  style={{ ...iconBtn, color: 'rgba(255,255,255,0.7)', cursor: isGenerating || !canGenerate ? 'not-allowed' : 'pointer', opacity: !canGenerate && !isGenerating ? 0.3 : 1 }}>
                  <RegenIcon />
                </button>
                </div></>}
              >
              </NodeVideoPlayer>
              <GeneratingLine active={isGenerating} jobId={data.jobId as string | undefined} steps={1} statusText={batchInfo} onCancel={handleCancel} />
            </div>

            {data.status === 'error' && (
              <div style={{
                position: 'absolute', top: 12, left: 12, right: 12, zIndex: 40,
                padding: '6px 10px', fontSize: 11, textAlign: 'center', color: '#ff6b6b',
                background: 'rgba(40, 0, 0, 0.85)', backdropFilter: 'blur(10px)',
                borderRadius: 8, border: '1px solid rgba(255,107,107,0.25)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)', pointerEvents: 'none'
              }}>
                
                {t('处理失败')}
              </div>
            )}
          </div>

          {showCompare && (
            <VideoPreviewModal
              beforeUrl={previewSrc}
              afterUrl={videoSrc}
              onClose={() => setShowCompare(false)}
              onCaptureFrame={handleScreenshot}
              downloadName="interpolated-video.mp4"
              alias={(data as any).alias}
            />
          )}
        </div>
      ) : (
        // ── Idle / no result view ─────────────────────────────────────────────────
        <div data-node-media style={{ position: 'relative', flex: '0 0 auto', aspectRatio: String(sizing.ratio) }}>
          <div
            style={{ ...cardBody, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: sourceVideoUrl ? 'transparent' : cardBody.background }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            {previewSrc && (
              <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ borderRadius: 20, opacity: 0.45 }}>
                {/* A still backdrop, not a looping <video>: a background is not worth a download. */}
                {posterUrl(previewSrc) && (
                  <img src={posterUrl(previewSrc)!} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'brightness(0.9) saturate(1.1)', pointerEvents: 'none' }} />
                )}
              </div>
            )}
            <div className="relative z-10 w-full" style={{ flex: 1, padding: '14px 16px', display: 'flex', flexDirection: 'column', opacity: (sourceVideoUrl && !showOverlay) ? 0 : 1, transition: 'opacity 0.22s', pointerEvents: (sourceVideoUrl && !showOverlay) ? 'none' : 'auto' }}>
              {sourceVideoUrl ? (
                <div style={{ flex: 1 }} />
              ) : (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#555', textAlign: 'center', lineHeight: 1.5 }}>
                  
                  {t('连接视频生成或视频增强节点')}
                </div>
              )}

              {data.status === 'error' && (
                <div style={{
                  position: 'absolute', top: 12, left: 12, right: 12, zIndex: 40,
                  padding: '6px 10px', fontSize: 11, textAlign: 'center', color: '#f87171',
                  background: 'rgba(20, 10, 12, 0.92)', backdropFilter: 'blur(10px)',
                  borderRadius: 8, border: '1px solid rgba(248,113,113,0.3)',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)', pointerEvents: 'none'
                }}>
                  
                  {t('处理失败')}
                </div>
              )}

              <button
                onClick={handleGenerate}
                disabled={isGenerating || !canGenerate}
                style={{
                  marginTop: 10, width: '100%', padding: '8px 0', borderRadius: 10,
                  background: canGenerate ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)',
                  color: canGenerate ? '#fff' : '#666',
                  border: canGenerate ? '1px solid rgba(255,255,255,0.2)' : '1px solid transparent',
                  fontSize: 12, fontWeight: 500,
                  cursor: isGenerating || !canGenerate ? 'not-allowed' : 'pointer',
                  opacity: !canGenerate && !isGenerating ? 0.4 : 1,
                  fontFamily: 'inherit', transition: 'background 0.2s, color 0.2s, border-color 0.2s',
                }}
              >
                
                {t('开始插帧 (RIFE)')}
              </button>
            </div>
            <GeneratingLine active={isGenerating} jobId={data.jobId as string | undefined} steps={1} statusText={batchInfo} onCancel={handleCancel} />
          </div>
        </div>
      )}

      {/* Connection Handles (Permanently mounted to avoid unmount edge breaks) */}
      <IconHandle type="target" id="in-video" portType="video" nodeId={id} />
      <IconHandle type="source" id="out-video" portType="video" nodeId={id} />
    </NodeShell>
  );
}

export default memo(VideoInterpolateNode, areNodePropsEqual);

function SettingsPanel({ data, id, updateNodeData, inline }: {
  data: VideoInterpolateNodeData; id: string; updateNodeData: any; inline?: boolean;
}) {
  const rows = [
    {
      label: t('目标 FPS'),
      value: data.targetFps ?? 30,
      set: (v: number) => updateNodeData(id, { targetFps: v }),
      min: 16,
      max: 120,
      step: 1,
    },
  ];

  const inner = (
    <>
      {rows.map(({ label: lbl, value, set, min, max, step }) => (
        <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: '#bbb' }}>
          <span>{lbl}</span>
          <input type="number" className="nodrag"
            style={{
              width: 72,
              background: 'rgba(255,255,255,0.1)',
              border: 'none',
              borderRadius: 6,
              padding: '2px 8px',
              textAlign: 'right',
              color: '#fff',
              fontSize: 11,
              outline: 'none',
            }}
            value={value} min={min} max={max} step={step}
            onChange={(e) => set(+e.target.value)}
            onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
            onBlur={() => window.dispatchEvent(new Event('inputBlurred'))}
          />
        </div>
      ))}
    </>
  );

  if (inline) return <>{inner}</>;

  return (
    <div style={{ background: '#1c1c1c', borderRadius: '0 0 20px 20px', padding: '12px 14px 14px', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
      {inner}
    </div>
  );
}

function InterpolateIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


function PlayIcon() {
  return <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor"><path d="M2.5 1.5l7 4-7 4V1.5z" /></svg>;
}

function PauseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor">
      <rect x="2" y="1.5" width="2.8" height="8" rx="1" />
      <rect x="6.2" y="1.5" width="2.8" height="8" rx="1" />
    </svg>
  );
}

function RegenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M2.5 6.5A4 4 0 0 1 10.5 4M10.5 4V1.5M10.5 4H8" />
      <path d="M10.5 6.5A4 4 0 0 1 2.5 9M2.5 9v2.5M2.5 9H5" />
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


function CameraIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}
