'use client';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { provides } from '@/lib/nodeRegistry';
import { areNodePropsEqual } from '@/lib/utils';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import { VideoUpscaleNode as VideoUpscaleNodeType, VideoUpscaleNodeData } from '@/lib/types';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { cardBody, header, label, selectedShadow, defaultShadow } from './PromptNode';
import NodeShell from './NodeShell';
import { NodeHeaderIconButton } from './nodeChrome';
import { BoltIcon, GearIcon, SparkIcon } from '@/components/ui/icons';
import { useAutoHeightNode } from '@/hooks/useAutoHeightNode';
import GeneratingLine from './GeneratingLine';
import VideoPreviewModal from './VideoPreviewModal';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult, useActiveBatchInfo } from '@/hooks/useJobPoller';

import { BACKEND_URL as API_BASE, posterUrl } from '@/lib/config';
import AlertModal from './AlertModal';
import NodeErrorBanner from './NodeErrorBanner';
import { SeedControl, resolveSeedForGeneration } from './SeedControl';
import { showAlert as showDialogAlert } from '@/components/ui/Dialog';
import { MediaMaximizeIcon, NATIVE_VIDEO_CHROME_OFF } from './mediaChrome';
import NodeVideoPlayer from './NodeVideoPlayer';
import { t } from '@/lib/i18n';
import { useLatentUpscaleDisabled } from '@/lib/useDisabledNodeTypes';

const MAX_LONG_SIDE = 3968;
const MAX_SHORT_SIDE = 2176;


/**
 * The scale the H3 latent path is actually vouched for at: the default scale_by
 * in build_h3_latent_upscale_workflow, and the factor the 3D latent upscaler
 * was measured at. The other presets run; nothing here backs them.
 */
const H3_LATENT_RECOMMENDED_SCALE = 2.0;

// The 8-hex tag a take's clip, untrimmed file and latent share.
const takeTag = (url: unknown) => (String(url || '').match(/H3_(?:Video|Chunk|Full|Latent)_([0-9a-f]{8})/) || [])[1] || '';

function VideoUpscaleNode({ id, data, selected }: NodeProps<VideoUpscaleNodeType>) {
  // 16 GB machines cannot load the latent refine's 21 GB base: ESRGAN is the only picture method there.
  const latentDisabled = useLatentUpscaleDisabled();
  const { updateNodeData, addNodes, setNodes, getNodes } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const activeAudioNodeId = useStore((s) => s.activeAudioNodeId);
  const setActiveAudioNodeId = useStore((s) => s.setActiveAudioNodeId);
  const isAudioActive = activeAudioNodeId === id;
  const settings = useStore((s) => s.settings);
  const [showSettings, setShowSettings] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [showAlert, setShowAlert] = useState(false);

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
      updateNodeData(id, {
        status: 'done',
        generatedUrl: jobResult.url as string,
        jobId: undefined,
        // How many overlap frames lead the full file. generatedUrl is the shot
        // alone; the full file (untrimmedUrl) is for the cut room only.
        overlapFrames: data.pendingOverlapFrames ?? 0,
        untrimmedUrl: ((jobResult as any).untrimmed_url as string | undefined) ?? undefined,
        contextFrames: ((jobResult as any).context_frames as number | undefined) ?? undefined,
      });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || 'Upscale failed', jobId: undefined });
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
  // A chained shot's full render, overlap with the previous shot included.
  const untrimmedUrl =
    typeof connectedVideo?.untrimmedUrl === 'string' && connectedVideo.untrimmedUrl
      ? (connectedVideo.untrimmedUrl as string)
      : null;
  // A chained shot is enhanced with its overlap unless switched off: the cut room
  // needs those frames at HD to move the seam, and nobody should have to remember
  // to tick a box per shot. Same rule as the MCP's _run_upscale_locked.
  // Always on: a chained shot is enhanced with its overlap, not a user choice
  // (2026-09-29: show it, do not let it be changed).
  const overlapOn = true;
  // Which references a latent refine sees -- the MCP's rule: an explicit
  // upscaleRefs wins; otherwise images wired to in-ref-image, else the source
  // clip's references as it is wired now (falling back to what it was
  // submitted with only when nothing is wired to it). Joined into a string so
  // the selector stays stable while the canvas is dragged.
  const sourceWired = useStore((s) => {
    const srcId = connected.find((n) => n.targetHandle === 'in-video')?.id;
    if (!srcId) return '';
    return s.edges
      .filter((e) => e.target === srcId && e.targetHandle === 'in-ref-image')
      .map((e) => {
        const d = s.nodes.find((n) => n.id === e.source)?.data as any;
        return String(d?.generatedUrl || d?.url || '').split('/').pop() || '';
      })
      .filter(Boolean)
      .join('|');
  });
  const wiredRefs = connected
    .filter((n) => n.targetHandle === 'in-ref-image')
    .map((n) => String(n.generatedUrl || n.url || '').split('/').pop() || '')
    .filter(Boolean);
  const refsMode = String(data.upscaleRefs || (wiredRefs.length ? 'wired' : 'inherit')).toLowerCase();
  const inheritedRefs = sourceWired ? sourceWired.split('|') : (connectedVideo?.referenceImages ?? []);
  const refineRefs = refsMode === 'none' ? [] : refsMode === 'wired' ? wiredRefs : inheritedRefs;
  // Canvases written through the MCP store sizes as strings ("1376"). Compared as
  // strings, "1376" > "768" is false, so a landscape clip took the portrait branch
  // and every 2x target was clamped to 2176x1216 (2026-09-16).
  const connectedVideoWidth = Number(connectedVideo?.width) || undefined;
  const connectedVideoHeight = Number(connectedVideo?.height) || undefined;

  const [latentInfo, setLatentInfo] = useState<{ exists: boolean; latent_filename: string | null; context_frames?: number } | null>(null);
  const knownLatent = typeof connectedVideo?.latentFilename === 'string' ? connectedVideo.latentFilename : '';

  useEffect(() => {
    if (!sourceVideoUrl) {
      setLatentInfo(null);
      return;
    }
    let cancelled = false;
    const latentParam = knownLatent ? `&latent_filename=${encodeURIComponent(knownLatent)}` : '';
    fetch(`${API_BASE}/check-latent?video_url=${encodeURIComponent(sourceVideoUrl)}${latentParam}`)
      .then((r) => r.json())
      .then((res) => {
        if (!cancelled && res) {
          setLatentInfo(res);
        }
      })
      .catch(() => {
        if (!cancelled) setLatentInfo({ exists: false, latent_filename: null });
      });
    return () => {
      cancelled = true;
    };
  }, [sourceVideoUrl, knownLatent]);

  const hasLatent = Boolean(latentInfo?.exists || connectedVideo?.latentFilename);
  // The overlap a chained clip carries: recorded on the node since the untrimmed
  // H3_Full_ file exists; for older chained clips the latent still holds it, and
  // the backend counts it (latent frames minus clip frames).
  const contextFrames = Number(connectedVideo?.contextFrames) || Number(latentInfo?.context_frames) || 0;
  // The untrimmed file serves every method; without it only the latent refine
  // can keep the overlap (keep_context re-decodes it from the latent).
  const overlapAvailable = contextFrames > 0 && (Boolean(untrimmedUrl) || hasLatent);
  const withOverlap = Boolean(overlapOn && overlapAvailable);
  // The previous chain's finished HD: its last contextFrames frames are this
  // latent's context window at HD, mounted over it so the two HD shots agree
  // across the seam (same rule as the MCP's _run_upscale_locked). Returned as a
  // string so the selector stays stable while the canvas is dragged.
  const prevHd = useStore((s) => {
    const srcId = connectedVideo?.id;
    if (!srcId) return '';
    const mc = s.edges.find((e) => e.target === srcId && e.targetHandle === 'in-motion-context');
    if (!mc) return '';
    const ups = s.edges
      .filter((e) => e.source === mc.source)
      .map((e) => s.nodes.find((n) => n.id === e.target))
      .filter((n) => n?.type === 'videoUpscale');
    const done = ups.filter((n) => (n?.data as any)?.status === 'done' && (n?.data as any)?.generatedUrl);
    if (!done.length) return `missing|${mc.source}`;
    // Only an HD of the very take this shot was chained from: its tail is this
    // shot's overlap. (C17b was chained from C17a 3412ff67; C17a's HD was of a
    // later take.) No recorded take: anchor without the check, as the MCP does.
    const srcData = s.nodes.find((n) => n.id === srcId)?.data as any;
    const shown = (srcData?.takes || []).find((tk: any) => tk?.url === srcData?.generatedUrl);
    const mcInput = (shown?.inputs || []).find((i: any) => i?.targetHandle === 'in-motion-context');
    const chained = takeTag(mcInput?.url);
    const match = done.filter((n) => !chained || takeTag((n?.data as any)?.compareUrl) === chained);
    const pick = match[match.length - 1];
    // A shot that carries on from frame N of the previous clip: its overlap is frames
    // N-overlap..N-1, so the anchor is cut there; an HD made with the overlap leads
    // with its own overlap frames, which shifts frame N that far into the file.
    if (pick) {
      const at = Number(srcData?.motionContextAtFrame) || 0;
      const lead = Number((pick.data as any).overlapFrames) || 0;
      return `${pick.id}|${(pick.data as any).generatedUrl}|${at ? at + lead : 0}`;
    }
    return `mismatch|${takeTag((done[done.length - 1]?.data as any)?.compareUrl)}>${chained}`;
  });
  const [prevHdNodeId, prevHdUrl, prevHdEndFrame] = prevHd.split('|');
  const prevHdReady = Boolean(prevHd) && prevHdNodeId !== 'missing' && prevHdNodeId !== 'mismatch';
  const prevChainId = prevHdNodeId === 'missing' ? prevHdUrl : '';
  const prevMismatch = prevHdNodeId === 'mismatch' ? prevHdUrl : '';
  const isOneXMode = Math.abs((data.scaleBy ?? 2.0) - 1.0) < 0.01;

  // Automatically adapt algorithm based on whether latent space is available
  useEffect(() => {
    if (!sourceVideoUrl) return;
    const isOneX = Math.abs((data.scaleBy ?? 2.0) - 1.0) < 0.01;
    // A clip without a saved latent is refined too: the backend encodes the
    // clip itself (2026-09-29).
    const targetMethod = isOneX ? 'lms' : data.upscaleMethod === 'esrgan' || latentDisabled ? 'esrgan' : 'h3_latent';
    if (data.method !== targetMethod) {
      updateNodeData(id, {
        method: targetMethod,
        repair: false,
        steps: isOneX ? 8 : ((data.steps !== undefined && data.steps <= 20) ? data.steps : 4),
        denoiseStrength: data.denoiseStrength !== undefined ? data.denoiseStrength : (hasLatent ? 0.38 : 0.25),
        scaleBy: data.scaleBy ?? 2.0,
      });
    }
  }, [hasLatent, sourceVideoUrl, id, data.method, data.scaleBy, data.upscaleMethod, latentDisabled, updateNodeData]);

  const compareUrl = data.compareUrl || sourceVideoUrl;

  // Load source (input) video as blob for CORS-safe background preview
  useEffect(() => {
    if (!compareUrl) { setPreviewSrc(null); return; }
    // Already a blob URL — use directly
    if (compareUrl.startsWith('blob:')) { setPreviewSrc(compareUrl); return; }
    const url = compareUrl.startsWith('http') ? compareUrl : `${API_BASE}${compareUrl}`;
    let blobUrl: string | null = null;
    fetch(url)
      .then((r) => r.blob())
      .then((blob) => { blobUrl = URL.createObjectURL(blob); setPreviewSrc(blobUrl); })
      .catch(() => setPreviewSrc(url));
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [compareUrl]);


  useEffect(() => {
    if (connectedVideoWidth && connectedVideoHeight && !data.generatedUrl) {
      const originalRatio = connectedVideoWidth / connectedVideoHeight;

      const factor = data.scaleBy ?? 2.0;
      // LMS is strictly same-size. Other methods keep their historical
      // 64-pixel alignment and output-size safeguards.
      let targetW = Math.abs(factor - 1.0) < 0.01
        ? connectedVideoWidth
        : Math.ceil((connectedVideoWidth * factor) / 64) * 64;
      let targetH = Math.abs(factor - 1.0) < 0.01
        ? connectedVideoHeight
        : Math.ceil((connectedVideoHeight * factor) / 64) * 64;

      if (Math.abs(factor - 1.0) < 0.01) {
        if (data.width !== targetW || data.height !== targetH) {
          updateNodeData(id, { width: targetW, height: targetH });
        }
        return;
      }

      // 2. Apply constraints based on orientation to preserve aspect ratio
      const isLandscape = connectedVideoWidth > connectedVideoHeight;
      const isPortrait = connectedVideoWidth < connectedVideoHeight;
      const isSquare = connectedVideoWidth === connectedVideoHeight;

      if (isSquare) {
        // Clamp square to MAX_SHORT_SIDE on both sides to keep 1:1 ratio
        const maxVal = Math.min(targetW, MAX_SHORT_SIDE);
        targetW = maxVal;
        targetH = maxVal;
      } else if (isLandscape) {
        // Clamp height to MAX_SHORT_SIDE, adjust width proportionally
        if (targetH > MAX_SHORT_SIDE) {
          targetH = MAX_SHORT_SIDE;
          targetW = Math.round(targetH * originalRatio / 64) * 64;
        }
        if (targetW > MAX_LONG_SIDE) {
          targetW = MAX_LONG_SIDE;
          targetH = Math.round(targetW / originalRatio / 64) * 64;
        }
      } else {
        // Clamp width to MAX_SHORT_SIDE, adjust height proportionally
        if (targetW > MAX_SHORT_SIDE) {
          targetW = MAX_SHORT_SIDE;
          targetH = Math.round(targetW / originalRatio / 64) * 64;
        }
        if (targetH > MAX_LONG_SIDE) {
          targetH = MAX_LONG_SIDE;
          targetW = Math.round(targetH * originalRatio / 64) * 64;
        }
      }

      if (data.width !== targetW || data.height !== targetH) {
        updateNodeData(id, { width: targetW, height: targetH });
      }
    }
  }, [connectedVideoWidth, connectedVideoHeight, data.generatedUrl, data.scaleBy, data.width, data.height, id, updateNodeData]);

  const isGenerating = data.status === 'generating';
  const currentShadow = selected ? selectedShadow : defaultShadow;
  const showOverlay = isHovered || isFocused;

  // Only the width is kept; the result sits in a box with its own ratio, the idle view is as tall as its content
  // (hooks/useAutoHeightNode).
  const sizing = useAutoHeightNode({
    id,
    ratioSources: [
      { width: data.width as number | undefined, height: data.height as number | undefined },
      { width: connectedVideoWidth, height: connectedVideoHeight },
    ],
    hasMedia: Boolean(data.generatedUrl),
    mediaHidden: showSettings,
    userWidth: data.userWidth as number | undefined,
    defaultW: 320,
  });

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
      void showDialogAlert('Video element not found');
      return;
    }

    if (video.videoWidth === 0 || video.videoHeight === 0 || video.readyState < 2) {
      void showDialogAlert('Video is still loading or has no data. Please wait a moment.');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      void showDialogAlert('Failed to get canvas context');
      return;
    }

    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch (e) {
      console.error('Failed to draw frame to canvas:', e);
      void showDialogAlert('Failed to capture video frame. This is likely a CORS issue. Please check console.');
      return;
    }

    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) {
        void showDialogAlert('Failed to create image blob');
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
      void showDialogAlert(`Screenshot failed: ${e.message}`);
    }
  }, [id, videoRef, addNodes]);

  const handleGenerate = useCallback(async () => {
    if (!sourceVideoUrl) return;

    // Check if current video is already at or above max resolution based on orientation
    const cWidth = connectedVideoWidth ?? 0;
    const cHeight = connectedVideoHeight ?? 0;
    const isLandscape = cWidth >= cHeight;
    const maxWidth = isLandscape ? MAX_LONG_SIDE : MAX_SHORT_SIDE;
    const maxHeight = isLandscape ? MAX_SHORT_SIDE : MAX_LONG_SIDE;

    const isOneX = Math.abs((data.scaleBy ?? 2.0) - 1.0) < 0.01;
    if (!isOneX && (cWidth >= maxWidth || cHeight >= maxHeight)) {
      setShowAlert(true);
      return;
    }

    cancelledRef.current = false;
    if (videoRef.current) {
      videoRef.current.pause();
    }
    // ESRGAN is chosen by hand, for a shot the latent enlargement spoils (a near-black one grows pink blotches).
    const effectiveMethod = isOneX ? 'lms' : data.upscaleMethod === 'esrgan' || latentDisabled ? 'esrgan' : 'h3_latent';
    // A saved latent: only then does the chain's previous-HD anchor apply.
    const isH3Latent = effectiveMethod === 'h3_latent' && Boolean(hasLatent);

    let scaleBy = data.scaleBy;
    if (!scaleBy && connectedVideoWidth && data.width) {
      scaleBy = Math.round((data.width / connectedVideoWidth) * 10) / 10;
    }
    if (!scaleBy || scaleBy < 1.0) scaleBy = 2.0;

    const resolvedLatent =
      connectedVideo?.latentFilename ||
      latentInfo?.latent_filename ||
      (connectedVideo?.generatedUrl
        ? `${connectedVideo.generatedUrl.split('/').pop()?.replace(/\.[^/.]+$/, '')}.safetensors`
        : null);

    updateNodeData(id, {
      status: 'generating',
      jobId: undefined,
      error: undefined,
      compareUrl: withOverlap && untrimmedUrl ? untrimmedUrl : sourceVideoUrl,
      pendingOverlapFrames: withOverlap ? contextFrames : 0,
      anchorFrom: isH3Latent && prevHdReady && contextFrames > 0 ? prevHdNodeId : null,
      anchorNote: isH3Latent && prevChainId ? `previous chain ${prevChainId} has no finished 视频增强 yet`
        : isH3Latent && prevMismatch ? `previous HD is of take ${prevMismatch.split('>')[0]}, this shot was chained from ${prevMismatch.split('>')[1]}` : null,
    });
    try {
      const { effectiveSeed, nextSeedToStore } = resolveSeedForGeneration(
        data.seed as number | undefined,
        data.seedMode as any,
        81000
      );

      if (data.seedMode === 'random') {
        updateNodeData(id, { seed: nextSeedToStore });
      }

      const { job_id } = await api.upscaleVideo({
        video_url: (withOverlap && untrimmedUrl ? untrimmedUrl : sourceVideoUrl) as string,
        keep_context: withOverlap,
        overlap_frames: withOverlap ? contextFrames : 0,
        width: data.width,
        height: data.height,
        steps: effectiveMethod === 'lms' ? 8 : (data.steps ?? 4),
        denoise_strength: data.denoiseStrength ?? (isH3Latent ? 0.38 : 0.25),
        seed: effectiveSeed,
        target_fps: data.targetFps ?? 0,
        repair: false,
        length: data.length ?? 0,
        method: effectiveMethod,
        latent_filename: effectiveMethod === 'h3_latent' ? resolvedLatent : null,
        scale_by: scaleBy,
        // Deliberately NOT the source shot's prompt. A refine pass is told how to
        // render, not what to render: measured, the scene prompt was worth 0.13 dB
        // over the generic one, and describing a scene to a pass that is only
        // sharpening invites it to paint that scene back in. Empty falls through to
        // the backend's fixed quality text.
        prompt: data.prompt || '',
        reference_images: effectiveMethod === 'h3_latent' && refineRefs.length ? refineRefs : undefined,
        // The frames the shot was generated from. A guide is not a reference: it
        // is re-injected at its frame index every step, so it pins composition
        // where a reference only offers texture — and for an I2V shot, which has
        // no references at all, it is the only anchoring the refine pass gets.
        first_frame: effectiveMethod === 'h3_latent' ? connectedVideoData?.firstFrame : undefined,
        last_frame: effectiveMethod === 'h3_latent' ? connectedVideoData?.lastFrame : undefined,
        prev_hd_url: effectiveMethod === 'h3_latent' && prevHdReady && contextFrames > 0 ? prevHdUrl : undefined,
        anchor_frames: effectiveMethod === 'h3_latent' && prevHdReady && contextFrames > 0 ? contextFrames : undefined,
        anchor_end_frame: effectiveMethod === 'h3_latent' && prevHdReady && contextFrames > 0 && Number(prevHdEndFrame) > 0 ? Number(prevHdEndFrame) : undefined,
        manual_sigmas: effectiveMethod === 'h3_latent' && typeof data.manualSigmas === 'string' && data.manualSigmas.trim() ? data.manualSigmas.trim() : undefined,
      });
      if (cancelledRef.current) return;
      updateNodeData(id, { jobId: job_id });
    } catch (e: any) {
      if (!cancelledRef.current) updateNodeData(id, { status: 'error', error: e.message, jobId: undefined });
    }
  }, [sourceVideoUrl, data, id, updateNodeData, connectedVideoWidth, connectedVideoHeight, hasLatent, connectedVideo?.latentFilename, setShowAlert, withOverlap, untrimmedUrl, contextFrames, refineRefs.join('|'), prevHd]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (isPlaying) v.pause(); else v.play().catch(() => {});
  }, [isPlaying]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const canGenerate = comfyuiOnline && !!sourceVideoUrl;

  const iconBtn: React.CSSProperties = {
    background: 'none', border: 'none', padding: '6px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', color: 'rgba(255,255,255,0.6)',
    borderRadius: '6px', transition: 'background 0.2s, color 0.2s',
  };

  return (
    <NodeShell
      nodeId={id}
      spec={sizing.spec}
      selected={selected}
      onResizeEnd={sizing.onResizeEnd}
      autoHeight
    >
      {/* 功能区与设置抽屉。抽屉是流内一行：打开撑高节点，关上还原 */}
      <div className="node-shell-headwrap" style={{ position: 'relative', flex: '0 0 auto' }}>
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
          <UpscaleIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('视频增强')}</span>
        </div>
        <div className="flex items-center gap-1">
          {isOneXMode ? (
            <span className="text-[8px] font-mono text-cyan-300 bg-cyan-500/15 border border-cyan-500/30 px-1.5 py-0.5 rounded-full flex items-center gap-0.5" title={t('1× 使用 LMS guide-latent 锐化，保持原尺寸并沿用源音轨')}>
              <SparkIcon />
              <span>LMS 1×</span>
            </span>
          ) : data.upscaleMethod === 'esrgan' ? (
            <span className="text-[8px] font-mono text-amber-300 bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 rounded-full flex items-center gap-0.5" title={t('ESRGAN 放大：不经 H3 潜空间，确定性，不添加细节')}>
              <SparkIcon />
              <span>ESRGAN</span>
            </span>
          ) : hasLatent ? (
            <span className="text-[8px] font-mono text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 rounded-full flex items-center gap-0.5" title={t('检测到原始未解码 H3 Latent 潜张量，已自动匹配无损潜空间二阶段精炼')}>
              <BoltIcon />
              <span>H3 Latent</span>
            </span>
          ) : (
            <span className="text-[8px] font-mono text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 rounded-full flex items-center gap-0.5" title={t('没有保存的潜变量：先把视频本身用 H3 VAE 编码，再做潜空间精炼（补帧到 H3 帧数档位，完成后裁回原长、接回原音轨）')}>
              <BoltIcon />
              <span>H3 Latent · {t('视频编码')}</span>
            </span>
          )}
          <span className="text-[10px] font-mono text-zinc-400 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">
            {data.width}×{data.height}{connectedVideoData?.fps ? ` · ${connectedVideoData.fps}fps` : ''}
          </span>
          <NodeHeaderIconButton
            active={showSettings}
            onClick={() => setShowSettings(!showSettings)}
            title={t('增强参数')}
          >
            <GearIcon />
          </NodeHeaderIconButton>
        </div>
      </div>

        {showSettings && (
          <div data-chrome-row="settings" className="node-shell-drawer nodrag nowheel p-3 text-xs animate-in fade-in duration-150">
            <SettingsPanel
              data={data}
              id={id}
              updateNodeData={updateNodeData}
              hasLatent={hasLatent}
              connectedVideoWidth={connectedVideoWidth}
              connectedVideoHeight={connectedVideoHeight}
              untrimmedUrl={untrimmedUrl}
              overlapAvailable={overlapAvailable}
              anchorState={hasLatent && contextFrames > 0 ? (prevHdReady ? 'ready' : prevMismatch ? 'mismatch' : prevChainId ? 'missing' : 'none') : 'none'}
              anchorDetail={prevMismatch}
              contextFrames={contextFrames}
              wiredRefCount={wiredRefs.length}
              inline
            />
          </div>
        )}
      </div>

      {data.generatedUrl ? (
        // ── Result view ──────────────────────────────────────────────────────────
        <div data-node-media style={{ position: 'relative', flex: '0 0 auto', aspectRatio: String(sizing.ratio) }}>
          <div
            style={{ ...cardBody, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', borderRadius: 20 }}>
              <NodeVideoPlayer
                nodeId={id}
                playToken={playToken}
                src={videoSrc || `${API_BASE}${data.generatedUrl}`}
                videoRef={videoRef}
                selected={selected}
                paused={showCompare || showSettings}
                // The file keeps a chained shot's overlap for the cut room; the node
                // shows only the shot.
                // Older results served the full file as generatedUrl; skip its head.
                headSeconds={data.untrimmedUrl ? 0 : (Number(data.overlapFrames) || 0) / 24}
                onMediaSize={sizing.onMediaSize}
                actions={<><span /><div className="flex items-center gap-1">
                <button className="nodrag" onClick={() => handleScreenshot()} style={iconBtn} title={t('截图')}>
                  <ScreenshotIcon />
                </button>
                <button
                  className="nodrag"
                  onClick={handleGenerate}
                  disabled={isGenerating || !canGenerate}
                  style={{ ...iconBtn, opacity: isGenerating || !canGenerate ? 0.35 : 1,
                           cursor: isGenerating || !canGenerate ? 'not-allowed' : 'pointer' }}
                  title={hasLatent ? t('用当前设置重新做一次潜空间精炼') : t('用当前设置重新增强一次')}
                >
                  <RegenIcon />
                </button>
                {(
                  <button
                    className="nodrag"
                    onClick={() => {
                      if (videoRef.current) {
                        videoRef.current.pause();
                        setIsPlaying(false);
                      }
                      setShowCompare(true);
                    }}
                    style={iconBtn}
                    title={compareUrl ? t('放大查看（可对比原视频）') : t('放大查看')}
                  >
                    <MediaMaximizeIcon size={13} />
                  </button>
                )}
                </div></>}
              />
            </div>
            <GeneratingLine active={isGenerating} jobId={data.jobId as string | undefined} steps={data.steps} statusText={batchInfo} onCancel={handleCancel} />
          </div>

          {showCompare && (
            <VideoPreviewModal
              fps={connectedVideoData?.fps as number | undefined}
              beforeUrl={previewSrc}
              afterUrl={videoSrc || `${API_BASE}${data.generatedUrl}`}
              onClose={() => setShowCompare(false)}
              onCaptureFrame={handleScreenshot}
              downloadName="upscaled-video.mp4"
              alias={(data as any).alias}
              headSeconds={data.untrimmedUrl ? 0 : (Number(data.overlapFrames) || 0) / 24}
            />
          )}
        </div>
      ) : (
        // ── Empty / Idle / Generating view ───────────────────────────────────────
        <div style={{ position: 'relative', flex: '0 0 auto', minHeight: 220 }}>
          <div data-shell-content style={{ ...cardBody, width: '100%', height: 'auto', minHeight: 220, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{
              position: 'relative', flex: 1, borderRadius: 20,
              background: '#18181b', padding: '14px',
              display: 'flex', flexDirection: 'column',
              boxShadow: currentShadow,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div className="flex items-center gap-1.5">
                  <span style={{ fontSize: 12, fontWeight: 500, color: '#e4e4e7' }}>{t('增强设置')}</span>
                  {hasLatent && (
                    <span className="text-[9px] font-mono text-zinc-200 bg-white/10 border border-white/20 px-1.5 py-0.2 rounded-full flex items-center gap-0.5">
                      ✦ Latent Refiner
                    </span>
                  )}
                </div>
              </div>

              {sourceVideoUrl ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8, padding: '4px 0' }}>
                  {hasLatent ? (
                    <div className="p-2.5 rounded-xl bg-white/[0.04] border border-white/10 text-zinc-300 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-[11px] font-medium text-white">
                          <span>⚡</span>
                          <span>{t('H3 潜空间无损精炼')}</span>
                        </div>
                        <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-white/10 text-zinc-200 border border-white/15">
                          
                          {t('原生 DiT 采样')}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-zinc-400">
                        <span>{t('放大倍率:')}</span>
                        <div className="flex items-center gap-1">
                          {[1.0, 2.0, 3.0, 4.0].map((s) => {
                            const currentScale = data.scaleBy ?? 2.0;
                            const isSelected = Math.abs(currentScale - s) < 0.05;
                            return (
                              <button
                                key={s}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const cW = connectedVideoWidth || 1376;
                                  const cH = connectedVideoHeight || 768;
                                  const targetW = Math.round((cW * s) / 64) * 64;
                                  const targetH = Math.round((cH * s) / 64) * 64;
                                  updateNodeData(id, { scaleBy: s, width: targetW, height: targetH });
                                }}
                                className={`nodrag px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer transition-colors border select-none ${
                                  isSelected
                                    ? 'bg-white/20 border-white/30 text-white font-bold shadow-xs'
                                    : 'bg-white/5 border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-white/10'
                                }`}
                              >
                                {s}x
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-zinc-400">
                        <span>{t('精修:')}</span>
                        <span className="font-mono text-zinc-200 font-medium">
                          
                          {t('单步 σ 0.6')}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div style={{ flex: 1 }} />
                  )}
                </div>
              ) : (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#555', textAlign: 'center', lineHeight: 1.5 }}>
                  
                  {t('连接视频生成或视频增强节点')}
                </div>
              )}

              <NodeErrorBanner
                error={data.status === 'error' ? (data.error || t('视频超分增强失败')) : null}
                onClear={() => updateNodeData(id, { status: 'idle', error: undefined })}
                title={t('视频超分增强错误')}
              />

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
                {hasLatent ? t('✦ 开始潜空间高清精炼') : t('开始增强视频')}
              </button>
            </div>
            <GeneratingLine active={isGenerating} jobId={data.jobId as string | undefined} steps={data.steps} statusText={batchInfo} onCancel={handleCancel} />
          </div>

          {showAlert && (
            <AlertModal
              title={t('分辨率限制')}
              message={t('当前视频分辨率已达到最大限制 ({v1}x{v2})，无法继续放大。', { v1: (connectedVideoWidth ?? 0) >= (connectedVideoHeight ?? 0) ? MAX_LONG_SIDE : MAX_SHORT_SIDE, v2: (connectedVideoWidth ?? 0) >= (connectedVideoHeight ?? 0) ? MAX_SHORT_SIDE : MAX_LONG_SIDE })}
              onClose={() => setShowAlert(false)}
            />
          )}
        </div>
      )}

      {/* Connection Handles (Permanently mounted to avoid unmount edge breaks) */}
      <IconHandle type="target" id="in-video" portType="video" nodeId={id} />
      {/* Boards for the refine (used when 参考图 is 只用连线的图, in wiring order).
          The backend always honoured edges here; without the port the canvas
          could neither draw them nor let anyone wire one. */}
      <IconHandle type="target" id="in-ref-image" portType="character" nodeId={id} style={{ top: '70%' }} title={t('增强参考图（按连线顺序；参考图选「只用连线的图」时生效）：小字/按键要清楚时追加一张只截那块的特写板')} />
      <IconHandle type="source" id="out-video" portType="video" nodeId={id} />
    </NodeShell>
  );
}

export default memo(VideoUpscaleNode, areNodePropsEqual);

function SettingsPanel({
  data,
  id,
  updateNodeData,
  hasLatent,
  connectedVideoWidth,
  connectedVideoHeight,
  untrimmedUrl,
  overlapAvailable = false,
  anchorState = 'none',
  anchorDetail = '',
  contextFrames = 0,
  wiredRefCount = 0,
  inline,
}: {
  data: VideoUpscaleNodeData;
  id: string;
  updateNodeData: any;
  hasLatent?: boolean;
  connectedVideoWidth?: number;
  connectedVideoHeight?: number;
  untrimmedUrl?: string | null;
  overlapAvailable?: boolean;
  anchorState?: 'ready' | 'missing' | 'mismatch' | 'none';
  anchorDetail?: string;
  contextFrames?: number;
  wiredRefCount?: number;
  inline?: boolean;
}) {
  // Always on: a chained shot is enhanced with its overlap, not a user choice
  // (2026-09-29: show it, do not let it be changed).
  const latentDisabled = useLatentUpscaleDisabled();
  const overlapOn = true;
  const refsMode = String(data.upscaleRefs || (wiredRefCount ? 'wired' : 'inherit')).toLowerCase();
  const currentScale = data.scaleBy ?? 2.0;
  const isLms = Math.abs(currentScale - 1.0) < 0.01;
  const isEsrgan = !isLms && (data.upscaleMethod === 'esrgan' || latentDisabled);
  // Every 2x+ run is the latent refine unless ESRGAN was chosen (a clip without a latent is encoded first).
  const isH3Latent = !isLms && !isEsrgan;

  const setScaleBy = (newScale: number) => {
    const s = Math.max(1.0, Math.min(4.0, Math.round(newScale * 10) / 10));
    const updates: any = { scaleBy: s };
    if (connectedVideoWidth && connectedVideoHeight) {
      const targetW = Math.round((connectedVideoWidth * s) / 16) * 16;
      const targetH = Math.round((connectedVideoHeight * s) / 16) * 16;
      updates.width = targetW;
      updates.height = targetH;
    }
    updateNodeData(id, updates);
  };

  let rows: Array<{
    label: string;
    value: number;
    set: (v: number) => void;
    min: number;
    max: number;
    step: number;
    hint?: string;
  }> = [];

  if (isH3Latent) {
    // Nothing to tune: this path runs a fixed single step at sigma 0.6 -> 0. Steps
    // and denoise were dropped rather than left inert, because a slider that moves
    // and changes nothing is worse than no slider.
    rows = [];
  } else {
    // Same-size LMS sharpening: source frame rate and length are the only knobs.
    rows = [
      {
        label: t('目标帧率 (Target FPS)'),
        value: data.targetFps ?? 0,
        set: (v: number) => updateNodeData(id, { targetFps: v }),
        min: 0,
        max: 120,
        step: 1,
        hint: t('0=保持原始帧率；设为60可自动RIFE插帧'),
      },
      {
        label: t('视频帧数 (Length)'),
        value: data.length ?? 0,
        set: (v: number) => updateNodeData(id, { length: v }),
        min: 0,
        max: 10000,
        step: 1,
        hint: t('0=处理完整视频；可限制只处理前N帧'),
      },
    ];
  }

  const inner = (
    <div className="nodrag select-none" onClick={(e) => e.stopPropagation()}>
      {!isLms && (
        <div className="nodrag mb-2 flex items-center gap-1 text-[11px]" title={t('H3 潜空间放大出问题时（例如近乎全黑的镜头出现粉色斑块）改用 ESRGAN：不经 H3，确定性放大，不添加细节')}>
          {([['h3_latent', t('H3 潜空间')], ['esrgan', 'ESRGAN']] as const).map(([key, text]) => (
            <button
              key={key}
              onClick={() => updateNodeData(id, { upscaleMethod: key === 'esrgan' ? 'esrgan' : undefined })}
              disabled={key === 'h3_latent' && latentDisabled}
              title={key === 'h3_latent' && latentDisabled ? t('这台机器的显存放不下这个底模，已禁用。') : undefined}
              className={`rounded px-2 py-0.5 border disabled:cursor-not-allowed disabled:opacity-30 ${(key === 'esrgan') === isEsrgan
                ? 'border-emerald-400/50 bg-emerald-400/15 text-emerald-100'
                : 'border-white/10 text-zinc-400 hover:text-zinc-200'}`}
            >
              {text}
            </button>
          ))}
        </div>
      )}

      {/* Auto-Matched Algorithm Header */}
      <div className="mb-2.5 pb-2 border-b border-white/[0.08]">
        {isEsrgan ? (
          <div>
            <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-amber-500/[0.10] border border-amber-300/20 text-zinc-100">
              <span className="text-[11px] font-semibold font-mono">{t('ESRGAN 放大')}</span>
              <span className="text-[9px] text-amber-200 font-mono">RealESRGAN x2</span>
            </div>
            <p className="mt-1 px-1 text-[9.5px] text-zinc-400 leading-tight">
              {t('不经 H3 潜空间：逐帧确定性放大，不会闪烁也不添加细节；沿用源音轨。')}
            </p>
          </div>
        ) : isLms ? (
          <div>
            <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-violet-500/[0.10] border border-violet-300/20 text-zinc-100">
              <span className="text-[11px] font-semibold font-mono">{t('LMS 1× AI 锐化')}</span>
              <span className="text-[9px] text-violet-200 font-mono">8-step</span>
            </div>
            <p className="mt-1 px-1 text-[9.5px] text-zinc-400 leading-tight">
              {t('源视频按时间轴编码为 guide latent；保持原尺寸并重新采样细节，输出沿用源音轨。')}
            </p>
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-white/[0.06] border border-white/15 text-zinc-200">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]" />
                <span className="text-[11px] font-semibold font-mono">{t('H3 潜空间二阶段精炼')}</span>
              </div>
              <span className="text-[9px] px-1.5 py-0.2 rounded bg-white/10 text-zinc-300 font-mono">
                
                {t('自动匹配 ⚡')}
              </span>
            </div>
            <p className="mt-1 px-1 text-[9.5px] text-zinc-400 leading-tight">
              
              {t('✦ 检测到上游 H3 潜变量缓存：在未解码的 3D 时空潜空间里放大，再按放大后的尺寸重采样一步。')}
            </p>
            <p className="mt-1 px-1 text-[9px] text-zinc-500 font-mono leading-tight">
              
              {t('单步 σ 0.6→0 · sa_solver · shift 6/3 · 时间分块 85/17 锚定 0.999')}
            </p>
          </div>
        )}
      </div>

      {overlapAvailable && !isEsrgan && (
        <label className="nodrag mb-2 flex items-center gap-1.5 text-[11px] text-zinc-300" title={t('用含接续重叠帧的完整文件做高清，剪辑台里仍可拉出重叠帧')}>
          <input
            type="checkbox"
            checked={overlapOn}
            disabled
            readOnly
          />
          {t('含重叠帧（前 {n} 帧）', { n: contextFrames })}
        </label>
      )}

      {anchorState !== 'none' && !isEsrgan && (
        <div className={`mb-2 text-[11px] ${anchorState === 'ready' ? 'text-emerald-300' : 'text-amber-300'}`}>
          {anchorState === 'ready' ? t('接缝对齐：接上一段的高清') : anchorState === 'mismatch' ? t('上一段的高清是 {a}，这一段接的是 {b}：先给上一段的 {b} 重做高清，接缝才能对齐', { a: anchorDetail.split('>')[0] || '?', b: anchorDetail.split('>')[1] || '?' }) : t('上一段还没做高清，先做上一段接缝才能对齐')}
        </div>
      )}

      {hasLatent && !isEsrgan && (
        <label className="nodrag mb-2 flex items-center gap-1.5 text-[11px] text-zinc-300" title={t('潜空间超分参考哪些图：沿用源视频节点当前连着的参考图、只用接到本节点参考图口的图，或不用参考（最快）')}>
          {t('参考图')}
          <select
            className="nodrag rounded bg-black/40 border border-white/10 px-1 py-0.5 text-[11px]"
            value={refsMode}
            onChange={(e) => updateNodeData(id, { upscaleRefs: e.target.value })}
          >
            <option value="inherit">{t('沿用源视频')}</option>
            <option value="wired">{t('只用连线的图')}（{wiredRefCount}）</option>
            <option value="none">{t('不用参考')}</option>
          </select>
        </label>
      )}

      {/* Latent Scale Selector with Quick Presets */}
      {(
        <div className="mb-2 pb-2 border-b border-white/[0.08]">
          <div className="flex justify-between items-center mb-1.5 text-[11px] text-zinc-300">
            <span className="font-medium">{t('放大倍率 (Scale)')}</span>
            <div className="flex items-center gap-1">
              <input
                type="number"
                className="nodrag"
                style={{
                  width: 54,
                  background: 'rgba(255,255,255,0.08)',
                  border: 'none',
                  borderRadius: 6,
                  padding: '2px 6px',
                  textAlign: 'right',
                  color: '#fff',
                  fontSize: 11,
                  outline: 'none',
                }}
                value={currentScale}
                min={1.0}
                max={4.0}
                step={0.1}
                onChange={(e) => setScaleBy(+e.target.value)}
                onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
                onBlur={() => window.dispatchEvent(new Event('inputBlurred'))}
              />
              <span className="text-[10px] text-zinc-500 font-mono">x</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {[1.0, 1.5, 2.0, 2.5, 3.0].map((s) => {
              const isRecommended = Math.abs(s - H3_LATENT_RECOMMENDED_SCALE) < 0.05;
              const isSelected = Math.abs(currentScale - s) < 0.05;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setScaleBy(s);
                  }}
                  title={Math.abs(s - 1.0) < 0.01
                    ? t('同尺寸 LMS guide-latent 锐化，固定使用默认 8 步并保留源音轨')
                    : isRecommended
                    ? t('权重与工作流推荐：latent 超分构建器的 scale_by 默认值，3D latent upscaler 按此倍率标定')
                    : undefined}
                  className={`nodrag relative flex-1 py-1 text-[10px] font-mono rounded-md border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-white/20 border-white/40 text-white font-bold shadow-sm'
                      : isRecommended
                        ? 'bg-white/[0.04] border-emerald-400/40 text-zinc-300 hover:text-white hover:bg-white/[0.08]'
                        : 'bg-white/[0.04] border-white/10 text-zinc-400 hover:text-white hover:bg-white/[0.08]'
                  }`}
                >
                  {s.toFixed(1)}x
                  {isRecommended && (
                    <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.9)]" />
                  )}
                </button>
              );
            })}
          </div>
          <div className="mt-1 text-[9px] text-zinc-500">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 align-middle mr-1" />
            
            {t('推荐')} {H3_LATENT_RECOMMENDED_SCALE.toFixed(1)}{t('x — 构建器默认值，权重按此倍率标定')}
          </div>
        </div>
      )}

      {/* Dynamic parameter rows */}
      {rows.map(({ label: lbl, value, set, min, max, step, hint }) => (
        <div key={lbl} className="flex justify-between items-center mb-1.5 text-[11px] text-zinc-300" title={hint}>
          <span className="truncate pr-1">{lbl}</span>
          <input type="number" className="nodrag"
            style={{
              width: 72,
              background: 'rgba(255,255,255,0.08)',
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

      {/* Seed Control */}
      <div className="pt-2 mt-2 border-t border-white/10">
        <SeedControl
          seed={data.seed as number | undefined}
          seedMode={data.seedMode as any}
          onChange={(newSeed, newMode) => {
            updateNodeData(id, { seed: newSeed, seedMode: newMode });
            window.dispatchEvent(new Event('takeSnapshot'));
          }}
        />
      </div>
    </div>
  );

  if (inline) return <>{inner}</>;

  return (
    <div style={{ background: '#1c1c1c', borderRadius: '0 0 20px 20px', padding: '12px 14px 14px', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
      {inner}
    </div>
  );
}

function UpscaleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="1" y="5" width="5" height="7" rx="1" stroke="#666" strokeWidth="1.2" />
      <rect x="7" y="1" width="5" height="7" rx="1" stroke="#aaa" strokeWidth="1.2" />
      <path d="M9.5 3.5L9.5 1.5M9.5 1.5L8 3M9.5 1.5L11 3" stroke="#aaa" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
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

function SmallCancelIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M2 2l7 7M9 2L2 9" />
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

const ScreenshotIcon = CameraIcon;
