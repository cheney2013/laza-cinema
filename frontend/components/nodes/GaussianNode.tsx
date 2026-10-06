'use client';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { NodeProps, useReactFlow, useConnection } from '@xyflow/react';
import { GaussianNode as GaussianNodeType } from '@/lib/types';
import { api } from '@/lib/api';
import { BACKEND_URL } from '@/lib/config';
import IconHandle from './IconHandle';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { cardBody, header, label, selectedShadow, defaultShadow } from './PromptNode';
import NodeShell from './NodeShell';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import { NodeHeaderIconButton } from './nodeChrome';
import { GearIcon } from '@/components/ui/icons';
import GeneratingLine from './GeneratingLine';
import { useJobResult } from '@/hooks/useJobPoller';
import { t } from '@/lib/i18n';
import { routeScaledData } from '@/lib/routeScale';

const HEADER_BG = 'rgba(20,20,20,0.97)';

const TRAJECTORIES = [
  { id: 'ring', label: '环视加横移（推荐）', hint: '沿 1.5 m 的小圆朝外走一圈：四周都看得到，附近一两米内可以移动机位' },
  { id: 'orbit', label: '推近再往左绕', hint: '往前推 5 m，再绕前方 10 m 处往左转 360°：看物体的背面' },
  { id: 'pan', label: '原地转一圈', hint: '只转不移：得到一张环形全景，离开原地就会穿帮' },
] as const;

function GaussianNode({ id, data, selected }: NodeProps<GaussianNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connection = useConnection();
  const isConnecting = connection.inProgress;

  const connected = useConnectedInputs(id);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [scale, setScale] = useState(0.3);

  // The viewer (a WebGL page holding millions of gaussians) loads only when asked: a canvas with several of these
  // nodes would otherwise load them all at once. A model that arrives while the node is open (just generated, or a
  // different file) is shown right away.
  const [viewerActive, setViewerActive] = useState(false);
  const plyBefore = useRef<string | null | undefined>(data.plyUrl);
  useEffect(() => {
    if (data.plyUrl && data.plyUrl !== plyBefore.current) setViewerActive(true);
    plyBefore.current = data.plyUrl;
  }, [data.plyUrl]);

  const cancelledRef = useRef(false);

  const isReady = data.status === 'ready' || data.status === 'done' || data.status === 'generating' || data.status === 'error';
  const isCapturing = data.status === 'capturing';

  const currentShadow = selected ? selectedShadow : defaultShadow;

  const iframeReadyRef = useRef(false);
  // hand adjustment of the clips added at the route's ends: the viewer shows the panel and moves them live; 应用 comes
  // back here and goes to /adjust-route (cached runs only, no GPU)
  const [adjusting, setAdjusting] = useState(false);
  const adjustOnLoadRef = useRef(false);
  const adjustApplyRef = useRef<((adjustments: Record<string, Record<string, number>>) => void) | null>(null);
  // the ruler: two points picked in the viewer and the real length between them give the route's unit; 应用 comes
  // back here and goes to /rescale-route (the same shape in that unit, no GPU)
  const [measuring, setMeasuring] = useState(false);
  const rulerOnLoadRef = useRef(false);
  const rulerApplyRef = useRef<((metresPerUnit: number) => void) | null>(null);

  const plyFilenameRef = useRef(data.plyFilename);
  useEffect(() => { plyFilenameRef.current = data.plyFilename; }, [data.plyFilename]);

  const engine = data.engine ?? 'sharp';
  const isWorld = engine === 'flashworld';

  const worldResult = useJobResult(data.worldJobId as string | undefined);
  useEffect(() => {
    if (!worldResult) return;
    if (worldResult.status === 'done' && worldResult.url) {
      const url = worldResult.url as string;
      updateNodeData(id, {
        plyUrl: url,
        plyFilename: url.split('/').pop() || null,
        // route jobs name their result ("WorldMirror · 路线 + 转身补洞"); a FlashWorld run is named by its trajectory
        plyOriginalName: ((worldResult as any).name as string) || `FlashWorld · ${data.worldTrajectory ?? 'ring'}`,
        worldVideoUrl: (worldResult as any).video_url,
        ...((worldResult as any).base_url ? { routeBasePly: (worldResult as any).base_url as string } : {}),
        ...((worldResult as any).core_url ? { routeCorePly: (worldResult as any).core_url as string } : {}),
        // a route build reports where its cameras jump (the reconstruction lost track): shown on the node
        ...(Array.isArray((worldResult as any).pose_breaks) ? { routePoseBreaks: (worldResult as any).pose_breaks } : {}),
        // a route put into another unit: the hand adjustments' metres and a rebuild's unit follow it
        ...routeScaledData(data, worldResult as any),
        // where each added clip went, so the next run needs no matching for it
        ...(Array.isArray((worldResult as any).extensions) ? {
          routeExtendWhere: Object.fromEntries(((worldResult as any).extensions as any[])
            .filter((e) => e.url).map((e) => [e.url as string, e.where as string])),
        } : {}),
        status: 'loading',
        worldJobId: undefined,
        worldJobKind: undefined,
      });
    } else if (worldResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (worldResult.error as string) || t('生成失败'), worldJobId: undefined, worldJobKind: undefined });
    } else if (worldResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', worldJobId: undefined, worldJobKind: undefined, error: undefined });
    }
  }, [worldResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // The SHARP model run is a queued job too (pin, cancel and progress like the others).
  const sharpResult = useJobResult(data.sharpJobId as string | undefined);
  useEffect(() => {
    if (!sharpResult) return;
    if (sharpResult.status === 'done' && sharpResult.url) {
      updateNodeData(id, {
        plyUrl: sharpResult.url as string,
        plyFilename: (sharpResult as any).filename,
        plyOriginalName: (sharpResult as any).original_name,
        status: 'loading',
        sharpJobId: undefined,
      });
    } else if (sharpResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (sharpResult.error as string) || t('生成失败'), sharpJobId: undefined });
    } else if (sharpResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', sharpJobId: undefined, error: undefined });
    }
  }, [sharpResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // Get input image URL
  const connectedImageNode = connected.find((n) => n.type === 'image' || n.type === 'gaussian' || n.type === 'inpaint' || n.type === 'preview');
  const targetImageUrl = connectedImageNode ? (connectedImageNode.generatedUrl || connectedImageNode.url) : null;

  // Turn videos on in-video: pans that start on a frame of the route splat this node holds. The backend finds that
  // frame, bends each turn onto the route's street and adds it (route_gs.append_route_turn). They always go onto
  // the route without turns (routeBasePly), so running again replaces the turns instead of stacking them.
  const turnInputs = connected.filter((n) => n.targetHandle === 'in-video' && (n.generatedUrl || n.url));
  const turnClips = turnInputs.map((n) => (n.generatedUrl || n.url) as string);
  const turnIds = turnInputs.map((n) => n.id);
  const routeBase = (data.routeBasePly as string | undefined)
    || (typeof data.plyUrl === 'string' && data.plyUrl.includes('/route_') ? data.plyUrl : undefined);
  // compared by clip file, not node id: a turn re-rendered in place keeps its id
  const turnsPending = turnClips.length > 0 && Boolean(routeBase) && !data.worldJobId
    && (data.routeTurnUrls ?? []).join('|') !== turnClips.join('|');
  // Clips on in-route continue the route at its start or end: one that starts on the route's last frame goes after
  // it, one that ends on its first goes before it (route_gs.extend_route). They always go onto the route as it was
  // built (routeCorePly), and the turns on in-video are put back on afterwards.
  const extendInputs = connected.filter((n) => n.targetHandle === 'in-route' && (n.generatedUrl || n.url));
  const extendClips = extendInputs.map((n) => (n.generatedUrl || n.url) as string);
  const extendIds = extendInputs.map((n) => n.id);
  const routeCore = (data.routeCorePly as string | undefined) || routeBase;
  const extendPending = extendClips.length > 0 && Boolean(routeCore) && !data.worldJobId
    && (data.routeExtendUrls ?? []).join('|') !== extendClips.join('|');

  // Backfill sourceImageUrl for existing nodes
  useEffect(() => {
    if (data.plyUrl && !data.sourceImageUrl && targetImageUrl) {
      updateNodeData(id, { sourceImageUrl: targetImageUrl });
    }
  }, [data.plyUrl, data.sourceImageUrl, targetImageUrl, id, updateNodeData]);

  const isOutdated = !!(data.plyUrl && targetImageUrl && data.sourceImageUrl && targetImageUrl !== data.sourceImageUrl);

  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const msg = e.data;
      if (!msg || !msg.type) return;

      if (msg.type === 'MESH_LOADED') {
        updateNodeData(id, { status: 'ready', error: undefined });
        setAdjusting(false);
        setMeasuring(false);
        if (adjustOnLoadRef.current) {
          adjustOnLoadRef.current = false;
          iframeRef.current?.contentWindow?.postMessage({ type: 'ROUTE_ADJUST_START' }, '*');
        } else if (rulerOnLoadRef.current) {
          rulerOnLoadRef.current = false;
          iframeRef.current?.contentWindow?.postMessage({ type: 'ROUTE_RULER_START' }, '*');
        }
      } else if (msg.type === 'ROUTE_ADJUST_STARTED') {
        setAdjusting(true);
      } else if (msg.type === 'ROUTE_ADJUST_EXIT') {
        setAdjusting(false);
      } else if (msg.type === 'ROUTE_ADJUST_ERROR') {
        setAdjusting(false);
        updateNodeData(id, { error: msg.error });
      } else if (msg.type === 'ROUTE_ADJUST_APPLY') {
        adjustApplyRef.current?.(msg.adjustments || {});
      } else if (msg.type === 'ROUTE_RULER_STARTED') {
        setMeasuring(true);
      } else if (msg.type === 'ROUTE_RULER_EXIT') {
        setMeasuring(false);
      } else if (msg.type === 'ROUTE_RULER_ERROR') {
        setMeasuring(false);
        updateNodeData(id, { error: msg.error });
      } else if (msg.type === 'ROUTE_RULER_APPLY') {
        setMeasuring(false);
        if (typeof msg.metres_per_unit === 'number' && msg.metres_per_unit > 0) rulerApplyRef.current?.(msg.metres_per_unit);
      } else if (msg.type === 'MESH_ERROR') {
        updateNodeData(id, { status: 'error', error: msg.error || 'Load failed' });
      } else if (msg.type === 'CAPTURE_RESULT') {
        if (!msg.image) return;
        try {
          // Upload capture
          const result = await api.captureGaussian(msg.image, plyFilenameRef.current || 'scene');
          const captureUrl = result.url;
          // The capture is the output: the coarse new view that a Qwen node with 换机位 (AnyAngle)
          // takes as <image 2>, the original as <image 1>. (The node no longer re-generates it.)
          updateNodeData(id, { generatedUrl: captureUrl, status: 'done' });
        } catch (err: any) {
          updateNodeData(id, { status: 'error', error: err.message });
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [id, updateNodeData, targetImageUrl]);

  const sendLoadToIframe = useCallback(() => {
    if (iframeRef.current?.contentWindow && data.plyUrl) {
      iframeRef.current.contentWindow.postMessage(
        { type: 'LOAD_PLY_URL', url: `${BACKEND_URL}${data.plyUrl}` },
        '*'
      );
    }
  }, [data.plyUrl]);

  const handleIframeLoad = useCallback(() => {
    iframeReadyRef.current = true;
    if (data.plyUrl) {
      sendLoadToIframe();
    }
  }, [data.plyUrl, sendLoadToIframe]);

  useEffect(() => {
    if (!data.plyUrl) return;
    if (!iframeReadyRef.current) return;
    sendLoadToIframe();
  }, [data.plyUrl, sendLoadToIframe]);

  useEffect(() => {
    if (!data.plyUrl) {
      iframeReadyRef.current = false;
    }
  }, [data.plyUrl]);

  const handleGeneratePly = useCallback(async () => {
    if (!targetImageUrl) return;
    updateNodeData(id, { status: 'loading', error: undefined, generatedUrl: null });
    if (isWorld) {
      try {
        const { job_id } = await api.generateWorldGaussian({
          image_url: targetImageUrl,
          prompt: (data.worldPrompt as string) || '',
          trajectory: data.worldTrajectory ?? 'ring',
          ...(data.worldTrajectory === 'orbit'
            ? { distance: Number(data.worldDistance) || 10, degrees: Number(data.worldDegrees) || 360 } : {}),
        });
        updateNodeData(id, { worldJobId: job_id, sourceImageUrl: targetImageUrl, plyUrl: null });
      } catch (err: any) {
        updateNodeData(id, { status: 'error', error: err.message });
      }
      return;
    }
    try {
      const { job_id } = await api.generateGaussianModelJob(targetImageUrl);
      updateNodeData(id, { sharpJobId: job_id, sourceImageUrl: targetImageUrl, plyUrl: null });
    } catch (err: any) {
      updateNodeData(id, { status: 'error', error: err.message });
    }
  }, [id, targetImageUrl, updateNodeData, isWorld, data.worldPrompt, data.worldTrajectory, data.worldDistance, data.worldDegrees]);

  const handleAppendTurn = useCallback(async () => {
    if (!routeBase || turnClips.length === 0) return;
    updateNodeData(id, { status: 'loading', error: undefined });
    try {
      const { job_id } = await api.appendRouteTurn({ route_ply_url: routeBase, turn_clip_urls: turnClips });
      updateNodeData(id, { worldJobId: job_id, worldJobKind: 'routeTurn', routeBasePly: routeBase, routeTurns: turnIds, routeTurnUrls: turnClips });
    } catch (err: any) {
      updateNodeData(id, { status: 'error', error: err.message });
    }
  }, [id, routeBase, turnClips, turnIds, updateNodeData]);

  const handleExtendRoute = useCallback(async () => {
    if (!routeCore || extendClips.length === 0) return;
    updateNodeData(id, { status: 'loading', error: undefined });
    try {
      const { job_id } = await api.extendRoute({
        route_ply_url: routeCore, clip_urls: extendClips, turn_clip_urls: turnClips,
        // hand adjustments stay with their clips; a clip placed before needs no matching again
        adjustments: data.routeExtendAdjust ?? {}, placements: data.routeExtendWhere ?? {},
      });
      updateNodeData(id, {
        worldJobId: job_id, worldJobKind: 'routeExtend', routeExtends: extendIds, routeExtendUrls: extendClips,
        routeTurns: turnIds, routeTurnUrls: turnClips,
      });
    } catch (err: any) {
      updateNodeData(id, { status: 'error', error: err.message });
    }
  }, [id, routeCore, extendClips, extendIds, turnClips, turnIds, updateNodeData, data.routeExtendAdjust, data.routeExtendWhere]);

  const hasAddedClips = (data.routeExtendUrls?.length ?? 0) > 0 && typeof data.plyUrl === 'string';
  const handleStartAdjust = useCallback(() => {
    if (!hasAddedClips) return;
    if (!viewerActive || !iframeReadyRef.current || data.status !== 'ready') {
      adjustOnLoadRef.current = true;           // opens once the viewer has the route on screen
      setViewerActive(true);
      return;
    }
    iframeRef.current?.contentWindow?.postMessage({ type: 'ROUTE_ADJUST_START' }, '*');
  }, [hasAddedClips, viewerActive, data.status]);

  adjustApplyRef.current = async (adjustments) => {
    if (!data.plyUrl) return;
    updateNodeData(id, { status: 'loading', error: undefined });
    try {
      const { job_id } = await api.adjustRoute({
        route_ply_url: data.plyUrl as string, adjustments, turn_clip_urls: data.routeTurnUrls ?? [],
      });
      updateNodeData(id, { worldJobId: job_id, worldJobKind: 'routeAdjust', routeExtendAdjust: adjustments });
    } catch (err: any) {
      updateNodeData(id, { status: 'error', error: err.message });
    }
  };

  const isRoute = typeof data.plyUrl === 'string' && data.plyUrl.includes('/route');
  const handleStartRuler = useCallback(() => {
    if (!isRoute) return;
    if (!viewerActive || !iframeReadyRef.current || data.status !== 'ready') {
      rulerOnLoadRef.current = true;            // opens once the viewer has the route on screen
      setViewerActive(true);
      return;
    }
    iframeRef.current?.contentWindow?.postMessage({ type: 'ROUTE_RULER_START' }, '*');
  }, [isRoute, viewerActive, data.status]);

  rulerApplyRef.current = async (metresPerUnit) => {
    if (!data.plyUrl) return;
    updateNodeData(id, { status: 'loading', error: undefined });
    try {
      const { job_id } = await api.rescaleRoute({ route_ply_url: data.plyUrl as string, metres_per_unit: metresPerUnit });
      updateNodeData(id, { worldJobId: job_id, worldJobKind: 'routeScale' });
    } catch (err: any) {
      updateNodeData(id, { status: 'error', error: err.message });
    }
  };

  const handleCancel = useCallback(async () => {
    cancelledRef.current = true;
    for (const jobId of [data.worldJobId, data.sharpJobId]) {
      if (jobId) {
        try { await api.cancelJob(jobId as string); } catch {}
      }
    }
    updateNodeData(id, { status: 'ready', worldJobId: undefined, worldJobKind: undefined, sharpJobId: undefined, error: undefined });
  }, [id, updateNodeData, data.worldJobId, data.sharpJobId]);

  const handleGenerate = useCallback(() => {
    if (!iframeRef.current || !isReady) return;
    cancelledRef.current = false;
    updateNodeData(id, { status: 'capturing', error: undefined });
    iframeRef.current.contentWindow?.postMessage({ type: 'CAPTURE' }, '*');
  }, [id, isReady, updateNodeData]);

  const handleResetCamera = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'RESET_CAMERA' }, '*');
  }, []);

  const viewerUrl = `${BACKEND_URL}/gaussian/viewer?hide_controls=true`;
  const showOverlay = isHovered || selected;

  // 3DGS 视口是等比取景框，没有固有画幅 —— 用 data.width/height（截图分辨率）作比例来源
  const sizing = useNodeSizing({
    id,
    type: 'gaussian',
    rows: ['header', 'settings'],
    activeRows: ['header', ...(showSettings ? ['settings'] : [])],
    paddingX: 0,
    ratioSources: [
      { width: data.width as number | undefined, height: data.height as number | undefined },
    ],
    userWidth: data.userWidth,
  });

  // engine, trajectory and scene description: in the empty state and in the settings drawer
  const settingsControls = (
        <div className="nodrag nowheel" style={{ width: '100%', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}>
          <select
            value={engine}
            onChange={(e) => updateNodeData(id, { engine: e.target.value as 'sharp' | 'flashworld' })}
            className="w-full rounded border border-white/10 bg-black/40 px-1.5 py-1 text-zinc-200"
          >
            <option value="sharp">{t('SHARP · 只重建这张图（秒级）')}</option>
            <option value="flashworld">{t('FlashWorld · 补全整个场景（约 5 分钟）')}</option>
          </select>
          {isWorld && (
            <>
              <select
                value={data.worldTrajectory ?? 'ring'}
                onChange={(e) => updateNodeData(id, { worldTrajectory: e.target.value as 'ring' | 'orbit' | 'pan' })}
                title={t((TRAJECTORIES.find((x) => x.id === (data.worldTrajectory ?? 'ring')) ?? TRAJECTORIES[0]).hint)}
                className="w-full rounded border border-white/10 bg-black/40 px-1.5 py-1 text-zinc-200"
              >
                {TRAJECTORIES.map((x) => <option key={x.id} value={x.id}>{t(x.label)}</option>)}
              </select>
              {data.worldTrajectory === 'orbit' && (
                <div className="flex items-center gap-2 text-zinc-300">
                  <label className="flex flex-1 items-center gap-1" title={t('轴心离画面相机多远（米）。拍近处的人物写 1.5 左右，默认 10 是给远景用的')}>
                    {t('轴心距离')}
                    <input type="number" step="0.5" min="0.5" value={Number(data.worldDistance) || 10}
                      onChange={(e) => updateNodeData(id, { worldDistance: parseFloat(e.target.value) || 10 })}
                      className="w-full rounded border border-white/10 bg-black/40 px-1 py-0.5 text-zinc-200" />
                  </label>
                  <label className="flex flex-1 items-center gap-1" title={t('往左绕轴心转多少度，360 是整圈')}>
                    {t('绕转角度')}
                    <input type="number" step="5" min="10" max="360" value={Number(data.worldDegrees) || 360}
                      onChange={(e) => updateNodeData(id, { worldDegrees: parseFloat(e.target.value) || 360 })}
                      className="w-full rounded border border-white/10 bg-black/40 px-1 py-0.5 text-zinc-200" />
                  </label>
                </div>
              )}
              <textarea
                rows={3}
                defaultValue={(data.worldPrompt as string) || ''}
                onBlur={(e) => { updateNodeData(id, { worldPrompt: e.target.value }); window.dispatchEvent(new Event('inputBlurred')); }}
                onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
                placeholder={t('英文描述整个场景，包括画外看不到的部分：光线、时段、街道或房间的样子')}
                className="w-full resize-none rounded border border-white/10 bg-black/40 px-1.5 py-1 text-zinc-200"
              />
            </>
          )}
        </div>
  );

  return (
    <NodeShell
      nodeId={id}
      spec={sizing.spec}
      selected={selected}
      onResizeEnd={sizing.onResizeEnd}
      shellRef={sizing.shellRef}
    >
      <div className="node-shell-headwrap" style={{ position: 'relative', flex: '0 0 auto' }}>
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
          <GaussianIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('高斯模型 (3DGS)')}</span>
        </div>
        {data.plyOriginalName && (
          <span style={{ fontSize: 9, color: '#888', background: 'rgba(255,255,255,0.05)', padding: '1px 6px', borderRadius: 8, marginLeft: 4, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {data.plyOriginalName}
          </span>
        )}
        <div style={{ marginLeft: 'auto' }}>
          <NodeHeaderIconButton active={showSettings} onClick={() => setShowSettings(!showSettings)} title={t('高斯模型设置')}>
            <GearIcon />
          </NodeHeaderIconButton>
        </div>
      </div>

      {showSettings && (
        <div data-chrome-row="settings" className="node-shell-drawer nodrag nowheel p-3 text-xs animate-in fade-in duration-150">
          {settingsControls}
          <button
            onClick={() => { setShowSettings(false); void handleGeneratePly(); }}
            disabled={!targetImageUrl || data.status === 'loading' || Boolean(data.worldJobId || data.sharpJobId)}
            className={`mt-2 w-full rounded-lg px-3 py-1.5 text-xs font-medium ${targetImageUrl ? 'border border-white/15 bg-white/10 text-white hover:bg-white/20' : 'cursor-not-allowed bg-white/5 text-zinc-600'}`}
            title={t('用当前的引擎和设置，对连着的图重新生成高斯模型')}
          >
            {data.plyUrl ? t('重新生成高斯模型') : t('生成高斯模型')}
          </button>
          {turnClips.length > 0 && (
            <button
              onClick={() => { setShowSettings(false); void handleAppendTurn(); }}
              disabled={!routeBase || data.status === 'loading' || Boolean(data.worldJobId || data.sharpJobId)}
              className={`mt-2 w-full rounded-lg px-3 py-1.5 text-xs font-medium ${routeBase ? 'border border-white/15 bg-white/10 text-white hover:bg-white/20' : 'cursor-not-allowed bg-white/5 text-zinc-600'}`}
              title={routeBase ? t('连着的转身视频会自动找到它在路线上的起始帧，掰正后接进这条路线高斯（约 5 分钟）') : t('这个节点还没有路线高斯（route_*.ply）')}
            >
              {t('接转身视频（补身后）')}
            </button>
          )}
          {extendClips.length > 0 && (
            <button
              onClick={() => { setShowSettings(false); void handleExtendRoute(); }}
              disabled={!routeCore || data.status === 'loading' || Boolean(data.worldJobId || data.sharpJobId)}
              className={`mt-2 w-full rounded-lg px-3 py-1.5 text-xs font-medium ${routeCore ? 'border border-white/15 bg-white/10 text-white hover:bg-white/20' : 'cursor-not-allowed bg-white/5 text-zinc-600'}`}
              title={routeCore ? t('连着的路线视频会自动判断接在路线开头还是末尾，对齐后接上，转身视频重新接回（约 5 分钟）') : t('这个节点还没有路线高斯（route_*.ply）')}
            >
              {t('接路线视频（开头/末尾）')}
            </button>
          )}
          {hasAddedClips && (
            <button
              onClick={() => { setShowSettings(false); handleStartAdjust(); }}
              disabled={data.status === 'loading' || Boolean(data.worldJobId || data.sharpJobId) || adjusting}
              className="mt-2 w-full rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20"
              title={t('在查看器里用滑条，绕接缝处的相机调整接上去那段的比例、方向和位置；应用后重新合成，不占显卡')}
            >
              {t('手动调整接段')}
            </button>
          )}
          {isRoute && (
            <button
              onClick={() => { setShowSettings(false); handleStartRuler(); }}
              disabled={data.status === 'loading' || Boolean(data.worldJobId || data.sharpJobId) || measuring || adjusting}
              className="mt-2 w-full rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20"
              title={t('在查看器里点两个点（比如路锥的锥尖和锥底），填上实际长度，按它改整条路线的比例；形状不变，不占显卡')}
            >
              {t('量尺定比例')}
            </button>
          )}
        </div>
      )}
      </div>

      <div data-node-media style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          style={{ ...cardBody, width: '100%', height: '100%', overflow: 'visible', display: 'flex', flexDirection: 'column', background: 'transparent' }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {/* Internal wrapper with hidden overflow for iframe */}
          <div className="nodrag" style={{ position: 'relative', flex: 1, borderRadius: 20, overflow: 'hidden', boxShadow: currentShadow, background: 'rgba(0,0,0,0.2)' }}>

            {data.plyUrl && viewerActive ? (
              <iframe
                ref={iframeRef}
                src={viewerUrl}
                onLoad={handleIframeLoad}
                title="Gaussian Splat Viewer"
                style={{ width: '100%', height: '100%', border: 'none', display: 'block', pointerEvents: isConnecting ? 'none' : 'auto' }}
                allow="cross-origin-isolated; fullscreen"
                sandbox="allow-scripts allow-same-origin allow-forms"
              />
            ) : data.plyUrl ? (
              <div
                className="nodrag"
                style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 20 }}
              >
                <div className="w-10 h-10 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-zinc-500">
                  <GaussianIcon />
                </div>
                <div style={{ fontSize: 12, color: '#a1a1aa', textAlign: 'center', lineHeight: 1.5, wordBreak: 'break-all' }}>
                  {(data.plyOriginalName as string) || (data.plyFilename as string) || t('高斯模型')}
                </div>
                <button
                  onClick={() => setViewerActive(true)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/20 text-white border border-white/15 cursor-pointer"
                  title={t('点击后才加载查看器，打开画布时不会自动加载')}
                >
                  {t('点击加载')}
                </button>
              </div>
            ) : (
              <div
                className="nodrag"
                style={{
                  width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: 12, padding: 20,
                  background: 'rgba(0,0,0,0.2)', transition: 'background 0.2s',
                }}
              >
                <div className="w-10 h-10 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-zinc-500">
                  <GaussianIcon />
                </div>
                <div style={{ fontSize: 12, color: '#71717a', textAlign: 'center', lineHeight: 1.5 }}>
                  
                  {t('连接图像以生成 3DGS 高斯模型')}
                </div>
                {settingsControls}
                <button
                  onClick={handleGeneratePly}
                  disabled={!targetImageUrl || data.status === 'loading'}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${targetImageUrl ? 'bg-white/10 hover:bg-white/20 text-white border border-white/15 cursor-pointer' : 'bg-white/5 text-zinc-600 border border-transparent cursor-not-allowed'}`}
                >
                  
                  {t('生成高斯模型')}
                </button>
              </div>
            )}

            {isOutdated && (
              <div style={{
                position: 'absolute', top: 12, left: 0, right: 0, zIndex: 45,
                display: 'flex', justifyContent: 'center', pointerEvents: 'none'
              }}>
                <button
                  className="nodrag"
                  onClick={handleGeneratePly}
                  disabled={data.status === 'loading' || isCapturing}
                  style={{
                    padding: '6px 14px', borderRadius: 20, pointerEvents: 'auto',
                    background: 'rgba(80,140,255,0.95)', color: '#fff',
                    border: '1px solid rgba(255,255,255,0.2)', fontSize: 12, fontWeight: 500,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
                    cursor: (data.status === 'loading' || isCapturing) ? 'not-allowed' : 'pointer',
                    opacity: (data.status === 'loading' || isCapturing) ? 0.7 : 1, transition: 'all 0.2s',
                  }}
                >
                  
                  {t('输入已更改，重新生成模型')}
                </button>
              </div>
            )}

            {extendPending && !isOutdated && (
              <div style={{
                position: 'absolute', top: 12, left: 0, right: 0, zIndex: 45,
                display: 'flex', justifyContent: 'center', pointerEvents: 'none'
              }}>
                <button
                  className="nodrag"
                  onClick={handleExtendRoute}
                  disabled={data.status === 'loading' || isCapturing}
                  title={t('连着的路线视频会自动判断接在路线开头还是末尾，对齐后接上，转身视频重新接回（约 5 分钟）')}
                  style={{
                    padding: '6px 14px', borderRadius: 20, pointerEvents: 'auto',
                    background: 'rgba(20,184,166,0.95)', color: '#fff',
                    border: '1px solid rgba(255,255,255,0.2)', fontSize: 12, fontWeight: 500,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
                    cursor: (data.status === 'loading' || isCapturing) ? 'not-allowed' : 'pointer',
                    opacity: (data.status === 'loading' || isCapturing) ? 0.7 : 1, transition: 'all 0.2s',
                  }}
                >
                  {t('接路线视频（开头/末尾）')}
                </button>
              </div>
            )}

            {/* the route-clip button puts the turns back on too, so it stands in for this one */}
            {turnsPending && !extendPending && !isOutdated && (
              <div style={{
                position: 'absolute', top: 12, left: 0, right: 0, zIndex: 45,
                display: 'flex', justifyContent: 'center', pointerEvents: 'none'
              }}>
                <button
                  className="nodrag"
                  onClick={handleAppendTurn}
                  disabled={data.status === 'loading' || isCapturing}
                  title={t('连着的转身视频会自动找到它在路线上的起始帧，掰正后接进这条路线高斯（约 5 分钟）')}
                  style={{
                    padding: '6px 14px', borderRadius: 20, pointerEvents: 'auto',
                    background: 'rgba(20,184,166,0.95)', color: '#fff',
                    border: '1px solid rgba(255,255,255,0.2)', fontSize: 12, fontWeight: 500,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
                    cursor: (data.status === 'loading' || isCapturing) ? 'not-allowed' : 'pointer',
                    opacity: (data.status === 'loading' || isCapturing) ? 0.7 : 1, transition: 'all 0.2s',
                  }}
                >
                  {t('接转身视频（补身后）')}
                </button>
              </div>
            )}

            {(data.status === 'loading' || isCapturing) && (
              <div style={{
                position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 10, zIndex: 50,
              }}>
                <Spinner />
                <span style={{ fontSize: 12, color: '#aaa' }}>
                  {isCapturing ? t('正在截图中...')
                    : data.worldJobId && data.worldJobKind === 'routeTurn' ? t('转身视频重建、掰正后接到路线上，约 5 分钟...')
                    : data.worldJobId && data.worldJobKind === 'routeExtend' ? t('路线视频重建、对齐后接到路线上，约 5 分钟...')
                    : data.worldJobId && data.worldJobKind === 'routeAdjust' ? t('按手动调整重新合成路线...')
                    : data.worldJobId && data.worldJobKind === 'routeScale' ? t('按新比例重写路线...')
                    : data.worldJobId ? t('FlashWorld 生成中，约 5 分钟...')
                    : data.sharpJobId ? t('正在生成高斯模型...') : t('正在加载模型...')}
                </span>
                {/* queue position, progress, 置顶 and cancel for the model job */}
                {Boolean(data.worldJobId || data.sharpJobId) && (
                  <GeneratingLine active jobId={(data.worldJobId || data.sharpJobId) as string} steps={1} onCancel={handleCancel} />
                )}
              </div>
            )}

            {data.plyUrl && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, padding: '14px 10px 8px',
                background: 'linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 100%)',
                display: 'flex', alignItems: 'center', gap: 6,
                opacity: showOverlay ? 1 : 0, transition: 'opacity 0.2s', pointerEvents: showOverlay ? 'auto' : 'none', zIndex: 20,
              }}>
                <button className="nodrag" onClick={handleResetCamera} title={t('重置相机视角')} style={iconBtn}>
                  <ResetIcon />
                </button>
                <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)' }} />
                <div className="nodrag" style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#aaa', fontSize: 11, flex: 1 }}>
                  <span title={t('点云缩放')}>{t('大小')}</span>
                  <input
                    type="range"
                    min="0.01" max="1" step="0.01"
                    value={scale}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setScale(v);
                      iframeRef.current?.contentWindow?.postMessage({ type: 'SET_SCALE', scale: v }, '*');
                    }}
                    style={{ flex: 1, minWidth: 0, cursor: 'pointer', accentColor: '#7ab4ff' }}
                  />
                </div>

                {data.generatedUrl && (
                  <a href={`${BACKEND_URL}${data.generatedUrl}`} download style={{ ...iconBtn, textDecoration: 'none' }} onClick={e => e.stopPropagation()}>
                    <DownloadIcon />
                  </a>
                )}

                <button
                  className="nodrag"
                  onClick={handleGenerate}
                  disabled={!isReady}
                  style={{
                    marginTop: 0, padding: '6px 12px', borderRadius: 8,
                    background: isReady ? 'rgba(80,140,255,0.3)' : 'rgba(255,255,255,0.06)',
                    border: isReady ? '1px solid rgba(80,140,255,0.4)' : '1px solid transparent',
                    color: isReady ? '#7ab4ff' : '#666',
                    fontSize: 12, fontWeight: 500,
                    cursor: !isReady ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit', transition: 'background 0.2s, color 0.2s',
                    display: 'flex', alignItems: 'center', gap: 4
                  }}
                >
                  <CameraIcon />  {t('截取当前视角')}
                </button>
              </div>
            )}

            {data.generatedUrl && (
              <div style={{
                position: 'absolute', top: 8, left: 8, width: 64, height: 48, borderRadius: 5, overflow: 'hidden',
                border: '1px solid rgba(255,255,255,0.3)', boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
                zIndex: 20, opacity: showOverlay ? 1 : 0.7, transition: 'opacity 0.2s',
              }}>
                <img src={`${BACKEND_URL}${data.generatedUrl}`} alt="captured" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
            )}

            {Array.isArray(data.routePoseBreaks) && data.routePoseBreaks.length > 0 && data.status !== 'error' && (
              <div style={{
                position: 'absolute', top: 48, left: 12, right: 12, zIndex: 40,
                padding: '6px 10px', fontSize: 11, textAlign: 'center', color: '#fbbf24',
                background: 'rgba(24, 18, 6, 0.92)', backdropFilter: 'blur(10px)',
                borderRadius: 8, border: '1px solid rgba(251,191,36,0.3)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)', pointerEvents: 'none'
              }}>
                {data.routePoseBreaks.map((b) => t('第 {v1} 段视频 {v2}–{v3} s 处重建跟丢：相机跳了 {v4} m，这一段的位置不可信',
                  { v1: b.clip + 1, v2: b.from_s, v3: b.to_s, v4: b.jump_m })).join('；')}
              </div>
            )}

            {data.status === 'error' && data.error && (
              <div style={{
                position: 'absolute', top: 12, left: 12, right: 12, zIndex: 40,
                padding: '6px 10px', fontSize: 11, textAlign: 'center', color: '#f87171',
                background: 'rgba(20, 10, 12, 0.92)', backdropFilter: 'blur(10px)',
                borderRadius: 8, border: '1px solid rgba(248,113,113,0.3)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)', pointerEvents: 'none'
              }}>
                {data.error}
              </div>
            )}

          </div>

          <IconHandle type="target" id="in-route-source" portType="video" nodeId={id} style={{ top: '28%' }} title={t('路线源视频（按连线顺序建成路线高斯）')} />
          <IconHandle type="target" id="in-image" portType="image" nodeId={id} style={{ top: '50%' }} />
          <IconHandle type="target" id="in-video" portType="video" nodeId={id} style={{ top: '72%' }} title={t('转身视频（接到路线高斯上）')} />
          <IconHandle type="target" id="in-route" portType="video" nodeId={id} style={{ top: '88%' }} title={t('路线视频（接在路线开头或末尾）')} />
          <IconHandle type="source" id="out-image" portType="image" nodeId={id} style={{ top: '35%' }} title={t('当前视图截图')} />
          <IconHandle type="source" id="out-gaussian" portType="gaussian" nodeId={id} style={{ top: '65%' }} title={t('高斯点云')} />
        </div>
      </div>
    </NodeShell>
  );
}

export default memo(GaussianNode);

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    idle: { label: t('空闲'), color: '#888' },
    loading: { label: t('加载中'), color: '#eee' },
    ready: { label: '就绪', color: '#eee' },
    capturing: { label: t('截图中'), color: '#eee' },
    generating: { label: t('生成中'), color: '#eee' },
    done: { label: '完成', color: '#eee' },
    error: { label: t('错误'), color: '#f87171' },
  };
  const s = map[status] || map.idle;
  return (
    <span style={{
      marginLeft: 'auto', fontSize: 9, fontWeight: 600, color: s.color,
      background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
      padding: '1px 6px', borderRadius: 6,
    }}>
      {s.label}
    </span>
  );
}

function Spinner() {
  return (
    <div style={{
      width: 28, height: 28, border: '2.5px solid rgba(255,255,255,0.1)',
      borderTopColor: '#ffffff', borderRadius: '50%',
      animation: 'gaussian-spin 0.7s linear infinite',
    }}>
      <style>{`@keyframes gaussian-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)',
  color: 'rgba(255,255,255,0.7)', borderRadius: 7, padding: '4px 6px', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.15s, color 0.15s',
};

function GaussianIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <circle cx="6.5" cy="6.5" r="2.5" fill="none" stroke="#ccc" strokeWidth="1.2" />
      <circle cx="6.5" cy="6.5" r="1" fill="#ccc" />
      <circle cx="3" cy="3.5" r="0.8" fill="#ccc" opacity="0.5" />
      <circle cx="10" cy="3.5" r="0.8" fill="#ccc" opacity="0.5" />
      <circle cx="3" cy="9.5" r="0.8" fill="#ccc" opacity="0.5" />
      <circle cx="10" cy="9.5" r="0.8" fill="#ccc" opacity="0.5" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}
