'use client';

import { useState, useCallback, useEffect, memo } from 'react';
import { areNodePropsEqual } from '@/lib/utils';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { ReangleNode as ReangleNodeType, ReangleKeyframe } from '@/lib/types';
import { cardBody, header, label, selectedShadow, defaultShadow } from './PromptNode';
import NodeShell from './NodeShell';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import GeneratingLine from './GeneratingLine';
import VideoAssetPlayer from './VideoAssetPlayer';
import { NodeActionButton, NodeActionRow } from './nodeChrome';
import NodeErrorBanner from './NodeErrorBanner';
import { SeedControl, resolveSeedForGeneration } from './SeedControl';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult, useActiveBatchInfo } from '@/hooks/useJobPoller';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { t } from '@/lib/i18n';
import { CameraOrbitPad, CameraPlan, CameraShot, keyframesToShots, shotsToKeyframes } from './ReangleCameraPad';

/**
 * 换机位 · CrossView — an accepted clip seen from another camera.
 *
 * The performance, timing and sound are the source clip's; only the camera moves.
 * The backend depth-warps the clip to the new camera (MoGe + CrossViewWarp) inside
 * the graph and pins the render to that warp, with the clip itself as a silent
 * reference for identity and look; the source's audio is muxed back afterwards.
 *
 * Measured 2026-09-21 on the TLOU clips: identity, costume and set hold at 20-90
 * degrees. What the source camera never saw is invented — reference images on
 * in-ref-image (a set plate, character sheets) steer that fill. A large object right
 * at the lens is the weak case. The keyframe list cuts between several cameras in one
 * clip (two keyframes on adjacent frames = a hard cut); a cut can land 1-3 frames early.
 */

function CameraIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7h11v10H3z" />
      <path d="M14 10l6-3v10l-6-3" />
      <path d="M8 3a9 9 0 0 1 9 3" />
    </svg>
  );
}

function ReangleNode({ id, data, selected }: NodeProps<ReangleNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);

  const batchInfo = useActiveBatchInfo(data.jobId as string | undefined);
  const jobResult = useJobResult(data.jobId as string | undefined);

  const source = connected.find((n) => n.targetHandle === 'in-video');
  const sourceUrl = (source?.generatedUrl || source?.url) as string | undefined;
  // Edge order is the order the backend mounts them in.
  const refUrls = connected
    .filter((n) => n.targetHandle === 'in-ref-image')
    .map((n) => (n.generatedUrl || n.url) as string)
    .filter(Boolean);

  const keyframes = (data.keyframes as ReangleKeyframe[] | undefined) || [];
  const shots = keyframesToShots(keyframes);
  const [selShot, setSelShot] = useState(0);
  const [showPad, setShowPad] = useState(false);
  const setShots = (next: CameraShot[]) => updateNodeData(id, { keyframes: shotsToKeyframes(next) });
  const cur = shots[Math.min(selShot, shots.length - 1)];
  const padAz = cur ? cur.az : (data.azimuth as number);
  const padEl = cur ? cur.el : (data.elevation as number);
  const setAngle = (az: number, el: number) => {
    if (cur) setShots(shots.map((s, i) => (s === cur ? { ...s, az, el } : s)));
    else updateNodeData(id, { azimuth: az, elevation: el });
  };

  const [previewError, setPreviewError] = useState<string | null>(null);
  // The source frame the preview shows: the one the user picked, else the start.
  const previewFrame = (data.previewFrame as number | undefined) ?? ((data.startFrame as number) || 0);
  // The rendered still for that frame and angle (a 22-frame job, see /reangle/still).
  // Kept in node data, so the frame (and a render still running) survives a
  // reload or a scene switch like any other output.
  // One still per camera: key "pad" for the single-angle node, else the shot's
  // start frame, so each shot's frame shows under its own row.
  type StillInfo = { url: string; az: number; el: number; frame: number };
  type StillJobInfo = { id: string; az: number; el: number; frame: number; key: string };
  const stills = (data.stills as Record<string, StillInfo> | undefined) ?? {};
  const stillJob = (data.stillJob as StillJobInfo | undefined) ?? null;
  const still = stills.pad ?? null;
  const setStillJob = (v: StillJobInfo | null) => updateNodeData(id, { stillJob: v ?? undefined });
  const stillResult = useJobResult(stillJob?.id);
  useEffect(() => {
    if (!stillResult || !stillJob) return;
    if (stillResult.status === 'done' && stillResult.url) {
      // One image per camera: keep "pad" and the current shots' keys, drop the rest
      // (shots deleted since, or keys from before shots were keyed by position).
      const live = new Set(['pad', ...shots.map((_, i) => `shot${i}`)]);
      const kept = Object.fromEntries(Object.entries(stills).filter(([k]) => live.has(k)));
      updateNodeData(id, {
        stills: { ...kept, [stillJob.key]: { url: stillResult.url as string, az: stillJob.az, el: stillJob.el, frame: stillJob.frame } },
        stillJob: undefined,
      });
    } else if (stillResult.status === 'error' || stillResult.status === 'cancelled') {
      if (stillResult.status === 'error') setPreviewError((stillResult.error as string) || t('渲染失败'));
      setStillJob(null);
    }
  }, [stillResult]); // eslint-disable-line react-hooks/exhaustive-deps
  // Render the preview frame for real, with the node's own settings.
  // Rotation centre: unset = the warp estimates it from the middle of the frame.
  const pivot = data.pivotZ != null && data.pivotZ !== ''
    ? { x: Number(data.pivotX) || 0, y: Number(data.pivotY) || 0, z: Number(data.pivotZ) }
    : null;
  // The camera that frame is seen from: with a shot list, the last shot that has
  // started by then (keyframe f counts from 1 at startFrame); else the pad's angle.
  const stillCamera = () => {
    if (!keyframes.length) return { az: padAz, el: padEl, dist: (data.distance as number) || 1 };
    const rel = previewFrame - ((data.startFrame as number) || 0) + 1;
    const sorted = [...keyframes].sort((x, y) => x.f - y.f);
    const k = [...sorted].reverse().find((kf) => kf.f <= rel) ?? sorted[0];
    return { az: k.az, el: k.el, dist: k.dist || 1 };
  };
  const runStill = async (frame = previewFrame, cam = stillCamera(), key = 'pad') => {
    if (!sourceUrl) return;
    setPreviewError(null);
    try {
      const { job_id } = await api.reangleStill({
        video_url: sourceUrl, frame,
        azimuth: cam.az, elevation: cam.el, distance: cam.dist,
        ref_image_urls: refUrls, prompt: (data.prompt as string) || 'crossview',
        lora_strength: (data.loraStrength as number) ?? 0.8,
        megapixels: (data.megapixels as number) ?? 0.5,
        steps: (data.steps as number) || 8, seed: (data.seed as number) ?? 81000,
        pivot, smooth_depth: Boolean(data.smoothDepth),
      });
      setStillJob({ id: job_id, az: cam.az, el: cam.el, frame, key });
    } catch (e: any) {
      setPreviewError(e?.message || t('渲染失败'));
    }
  };
  const stillStale = still && (still.az !== padAz || still.el !== padEl || still.frame !== previewFrame);

  useEffect(() => {
    if (!jobResult) return;
    if (jobResult.status === 'done' && jobResult.url) {
      updateNodeData(id, { status: 'done', generatedUrl: jobResult.url as string, jobId: undefined });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || t('换机位失败'), jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
    }
  }, [jobResult]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async () => {
    if (!sourceUrl) return;
    const { effectiveSeed, nextSeedToStore } = resolveSeedForGeneration(
      data.seed as number | undefined,
      data.seedMode as any,
    );
    updateNodeData(id, { status: 'generating', error: undefined, seed: nextSeedToStore });
    try {
      const { job_id } = await api.reangle({
        video_url: sourceUrl,
        start_frame: (data.startFrame as number) || 0,
        length: (data.length as number) || 0,
        azimuth: data.azimuth as number,
        elevation: data.elevation as number,
        distance: (data.distance as number) || 1,
        keyframes,
        ref_image_urls: refUrls,
        prompt: (data.prompt as string) || 'crossview',
        lora_strength: (data.loraStrength as number) ?? 0.8,
        megapixels: (data.megapixels as number) ?? 0.5,
        steps: (data.steps as number) || 8,
        seed: effectiveSeed,
        keep_source_audio: data.keepSourceAudio !== false,
        pivot, smooth_depth: Boolean(data.smoothDepth),
      });
      updateNodeData(id, { jobId: job_id });
    } catch (e: any) {
      updateNodeData(id, { status: 'error', error: e?.message || t('提交失败') });
    }
  }, [sourceUrl, refUrls, keyframes, data, id, updateNodeData]);

  const busy = data.status === 'generating';
  // Stop the render on the backend too; otherwise the GPU keeps working on a
  // clip nobody is waiting for and the next job queues behind it.
  const cancelRun = () => {
    const jobId = data.jobId as string | undefined;
    if (jobId) api.cancelJob(jobId).catch(() => {});
    updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
  };
  const cancelStill = () => {
    if (stillJob?.id) api.cancelJob(stillJob.id).catch(() => {});
    setStillJob(null);
  };
  const ready = Boolean(sourceUrl);
  const multiCam = shots.length > 0;

  const [isHovered, setIsHovered] = useState(false);

  const sizing = useNodeSizing({
    id,
    type: 'videoReangle',
    rows: ['header'],
    paddingX: 0,
    ratioSources: [
      { width: data.width as number | undefined, height: data.height as number | undefined },
    ],
    hasMedia: Boolean(data.generatedUrl),
    userWidth: data.userWidth as number | undefined,
    // The camera panel is content: opening it, or a rendered frame arriving, grows the node.
    growToContent: true,
  });

  const num = (key: string, value: number, min: number, max: number, step: number, title: string, text: string) => (
    <label className="flex items-center gap-1 text-[9px] text-zinc-400 shrink-0" title={title}>
      {text}
      <input
        type="number" min={min} max={max} step={step} value={value}
        onChange={(e) => updateNodeData(id, { [key]: parseFloat(e.target.value) || 0 })}
        className="w-11 bg-white/5 border border-white/10 rounded px-1 py-0.5 font-mono text-[9px] text-zinc-300 disabled:opacity-40"
      />
    </label>
  );

  const cameraControls = (
    <>
      <CameraOrbitPad az={padAz} el={padEl} onChange={setAngle} />
      {!multiCam && (
      <div className="nodrag nopan flex items-start gap-2">
        {num('previewFrame', previewFrame, 0, 100000, 1, t('要渲染原片的哪一帧'), t('预览帧'))}
        <button onClick={() => (stillJob?.key === 'pad' ? cancelStill() : runStill())}
                disabled={!sourceUrl || (Boolean(stillJob) && stillJob?.key !== 'pad') || !comfyuiOnline}
                title={t('用节点当前的设置把预览帧真正渲染出来（跑 5 帧取第一帧）')}
                className="shrink-0 px-1.5 py-0.5 rounded text-[9px] border border-teal-400/40 text-teal-200 bg-teal-500/10 hover:bg-teal-500/20 disabled:opacity-40">
          {stillJob?.key === 'pad' ? t('中断渲染') : t('渲染此帧')}
        </button>
        {previewError && <span className="text-[9px] text-red-300/90">{previewError}</span>}
      </div>
      )}
      {multiCam && previewError && <span className="text-[9px] text-red-300/90">{previewError}</span>}
      <div className="nodrag nopan flex flex-col gap-1.5">
        <PivotControl
          z={pivot ? pivot.z : null}
          x={Number(data.pivotX) || 0}
          y={Number(data.pivotY) || 0}
          onChange={(patch) => updateNodeData(id, patch)}
        />
        <label className="flex items-center gap-1 text-[9px] text-zinc-400 cursor-pointer"
               title={t('深度平滑：变形里的碎洞更少')}>
          <input type="checkbox" checked={Boolean(data.smoothDepth)}
            onChange={(e) => updateNodeData(id, { smoothDepth: e.target.checked })} />
          {t('深度平滑')}
        </label>
      </div>
      {!multiCam && (still || (stillJob && stillJob.key === 'pad')) && (
        <div className={`nodrag nopan flex items-start gap-1.5 ${stillStale && !stillJob ? 'opacity-40' : ''}`}>
          {still && <img src={`${API_BASE}${still.url}`} alt="" className="w-[240px] rounded border border-white/10" />}
          <div className="text-[9px] leading-snug text-zinc-500">
            {stillJob ? t('渲染这一帧中…')
              : stillStale ? t('角度或帧已改，点「渲染此帧」重新渲染')
              : `${t('渲染结果')} · ${t('第')} ${still!.frame} ${t('帧')} · ${still!.az}° / ${still!.el}°`}
          </div>
        </div>
      )}
      <CameraPlan shots={shots} selected={Math.min(selShot, Math.max(0, shots.length - 1))} onSelect={setSelShot}
                  onChange={setShots} az={padAz} el={padEl}
                  startFrame={(data.startFrame as number) || 0}
                  renderBelow={(shot, i) => {
                    // The shot's own first frame, seen from the shot's own camera. Keyed by
                    // position, so editing the frame keeps (and dims) the image instead of losing it.
                    const key = `shot${i}`;
                    const frame = ((data.startFrame as number) || 0) + shot.f - 1;
                    const s = stills[key];
                    const running = stillJob?.key === key;
                    const stale = s && (s.az !== shot.az || s.el !== shot.el || s.frame !== frame);
                    // A move that starts later is rendered at its end camera; the frame is the shot's own.
                    return (
                      <div className="flex items-start gap-1.5 pl-9 pb-1">
                        <button onClick={() => (running ? cancelStill() : runStill(frame, { az: shot.az, el: shot.el, dist: 1 }, key))}
                                disabled={!sourceUrl || (Boolean(stillJob) && !running) || !comfyuiOnline}
                                title={t('把这个机位开始的那一帧渲染出来')}
                                className="shrink-0 px-1.5 py-0.5 rounded text-[9px] border border-teal-400/40 text-teal-200 bg-teal-500/10 hover:bg-teal-500/20 disabled:opacity-40">
                          {running ? t('中断') : t('渲染')}
                        </button>
                        {s && <img src={`${API_BASE}${s.url}`} alt=""
                                   className={`w-[200px] rounded border border-white/10 ${stale && !running ? 'opacity-40' : ''}`} />}
                        {stale && !running && <span className="text-[9px] text-zinc-500">{t('角度或帧已改，重新渲染')}</span>}
                      </div>
                    );
                  }} />
    </>
  );

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
          <CameraIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('换机位 · CrossView')}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[8px] font-mono text-violet-300 bg-violet-500/15 border border-violet-500/30 px-1.5 py-0.5 rounded-full"
                title={t('表演、节奏和声音都来自原片，只换机位')}>
            {multiCam ? t('多机位') : `${data.azimuth}° / ${data.elevation}°`}
          </span>
          <span className="text-[10px] font-mono text-zinc-400 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">
            {refUrls.length} {t('参考')}
          </span>
        </div>
      </div>

      <div
        style={{ ...cardBody, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative',
                 boxShadow: selected ? selectedShadow : defaultShadow }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {data.generatedUrl ? (
          <VideoAssetPlayer
            nodeId={id}
            src={`${API_BASE}${data.generatedUrl}`}
            fps={data.fps as number | undefined}
            onMediaSize={sizing.onMediaSize}
          />
        ) : (
          <div className="node-shell-content flex-1 min-h-0 overflow-y-auto flex flex-col gap-2 px-2.5 pt-2 pb-2">
            <div className="text-[10px] text-zinc-500">
              {!source ? t('接入已验收的片段')
                : !sourceUrl ? <span className="text-amber-300/90">{t('上游节点还没有输出，先运行它（比如剪切节点点「剪切」）')}</span>
                :t('表演、节奏和声音都来自原片，只换机位。拖紫点选新机位。')}
            </div>
            {cameraControls}
          </div>
        )}

        {data.generatedUrl && showPad && (
          <div className="node-shell-content shrink-0 mx-1.5 mt-1.5 mb-9 p-2 rounded-lg bg-zinc-950/90 border border-white/10 flex flex-col gap-2">
            {cameraControls}
          </div>
        )}

        <GeneratingLine active={busy} jobId={data.jobId as string | undefined} statusText={batchInfo || '生成中'} />
        <NodeErrorBanner error={data.error as string | undefined} onClear={() => updateNodeData(id, { error: undefined })} />

        <NodeActionRow visible={isHovered || !data.generatedUrl}>
          {data.generatedUrl && (
            <NodeActionButton onClick={() => setShowPad((v) => !v)}>
              {showPad ? t('收起机位') : t('机位')}
            </NodeActionButton>
          )}
          {num('startFrame', (data.startFrame as number) || 0, 0, 100000, 1, t('从原片第几帧开始；长度按 H3 的 17k+5 帧取到原片能给的最多'), t('起始帧'))}
          <SeedControl
            seed={data.seed as number | undefined}
            seedMode={data.seedMode as any}
            onChange={(newSeed, newMode) => updateNodeData(id, { seed: newSeed, seedMode: newMode })}
            compact
          />
          {busy ? (
            <NodeActionButton grow onClick={cancelRun}>{t('中断')}</NodeActionButton>
          ) : (
            <NodeActionButton accent="teal" grow onClick={run} disabled={!ready || !comfyuiOnline}>
              {t('生成')}
            </NodeActionButton>
          )}
        </NodeActionRow>
      </div>

      <IconHandle type="target" id="in-video" portType="video" nodeId={id} style={{ top: '35%' }} title={t('已验收的片段（表演和声音都保留）')} />
      <IconHandle type="target" id="in-ref-image" portType="character" nodeId={id} style={{ top: '65%' }} title={t('环境板/定妆板（可选，按连线顺序）：引导新露出区域的样子')} />
      <IconHandle type="source" id="out-video" portType="video" nodeId={id} title={t('输出新机位视频')} />
    </NodeShell>
  );
}

const PIVOT_PRESETS: { z: number; label: string; hint: string }[] = [
  { z: 0.5, label: '贴身', hint: '主体几乎贴着镜头' },
  { z: 0.8, label: '前排', hint: '车里从后座看前排、近景人物' },
  { z: 1.5, label: '室内', hint: '房间里的中近景' },
  { z: 4, label: '远景', hint: '主体在几米开外' },
];

/**
 * Where the camera orbits: automatic (the middle of the frame) or a distance
 * ahead of the lens. Automatic fails whenever the middle of the frame is far
 * away -- looking out of a car it lands on the road and nothing moves.
 */
function PivotControl({ z, x, y, onChange }: {
  z: number | null; x: number; y: number;
  onChange: (patch: Record<string, number | null>) => void;
}) {
  const [fine, setFine] = useState(false);
  const manual = z != null;
  // Log scale: 0.3 m .. 8 m across the slider, so the near end has room.
  const toSlider = (m: number) => Math.round((Math.log(m / 0.3) / Math.log(8 / 0.3)) * 100);
  const fromSlider = (v: number) => Math.round(0.3 * Math.pow(8 / 0.3, v / 100) * 20) / 20;
  const chip = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-[9px] border ${active
      ? 'border-violet-400/60 bg-violet-500/25 text-violet-100'
      : 'border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10'}`;
  return (
    <div className="flex flex-col gap-1 text-[9px] text-zinc-400">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-zinc-300 mr-0.5">{t('绕哪里转')}</span>
        <button className={chip(!manual)} onClick={() => onChange({ pivotZ: null })}
                title={t('取画面正中那一点。画面正中很远时（从车里往外拍）会转不动')}>{t('自动')}</button>
        {PIVOT_PRESETS.map((p) => (
          <button key={p.z} className={chip(manual && Math.abs((z as number) - p.z) < 0.01)}
                  onClick={() => onChange({ pivotZ: p.z })} title={t(p.hint)}>
            {t(p.label)} {p.z}m
          </button>
        ))}
      </div>
      {manual && (
        <div className="flex items-center gap-1.5">
          <input type="range" min={0} max={100} value={toSlider(z as number)}
                 onChange={(e) => onChange({ pivotZ: fromSlider(+e.target.value) })}
                 className="flex-1 accent-violet-400" />
          <span className="font-mono text-zinc-300 w-10 text-right">{(z as number).toFixed(2)}m</span>
          <button className="text-zinc-500 hover:text-zinc-300" onClick={() => setFine((v) => !v)}>
            {fine ? t('收起') : t('微调')}
          </button>
        </div>
      )}
      {manual && fine && (
        <div className="flex items-center gap-2">
          {([['pivotX', x, t('左右')], ['pivotY', y, t('上下')]] as const).map(([k, v, lbl]) => (
            <label key={k} className="flex items-center gap-1">
              {lbl}
              <input type="number" step={0.05} value={v}
                     onChange={(e) => onChange({ [k]: parseFloat(e.target.value) || 0 })}
                     className="w-12 bg-white/5 border border-white/10 rounded px-1 py-0.5 font-mono text-zinc-300" />
              m
            </label>
          ))}
        </div>
      )}
      <div className="text-zinc-500 leading-snug">
        {manual
          ? t('镜头绕着离镜头这么远的一点转：填你想绕着转的那个人离镜头多远')
          : t('自动取画面正中；从车里往外拍、画面正中是远处时一定要选一个距离')}
      </div>
    </div>
  );
}

export default memo(ReangleNode, areNodePropsEqual);
