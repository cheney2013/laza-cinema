'use client';

import { useState, useCallback, useEffect, memo } from 'react';
import { areNodePropsEqual } from '@/lib/utils';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { OrbitNode as OrbitNodeType } from '@/lib/types';
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

/**
 * 360 环绕 — one picture, circled by the camera while the scene stays frozen.
 *
 * The 360-Orbit LoRA on H3 FL2VA (pablodawson/MiniMax-H3-360-Orbit-LoRA). The picture on in-image is both
 * the first and the last frame, which is the wiring the LoRA was trained with, and the prompt is the one
 * sentence it was trained on, so the node has no prompt of its own. Defaults are the official Space's (28 steps, no speed LoRA, fixed by the base).
 *
 * Measured 2026-10-05: the swing is about +-120 degrees, not a full turn. A frame with a clear subject in the
 * middle holds better than a wide street; whatever the picture never showed is invented.
 */

/** The official Space's canvases (width x height), the sizes the LoRA was checked at. */
const CANVASES: [number, number, string][] = [
  [768, 768, '1:1'], [1024, 1024, '1:1 max'], [544, 544, '1:1 fast'],
  [960, 544, '16:9 fast'], [1024, 576, '16:9 fast'], [1152, 640, '16:9'], [1280, 704, '16:9'], [1344, 768, '16:9 full'],
  [544, 960, '9:16 fast'], [640, 1152, '9:16'], [768, 1344, '9:16 full'],
  [768, 576, '4:3 fast'], [1024, 768, '4:3 full'], [576, 768, '3:4 fast'], [768, 1024, '3:4 full'],
  [1152, 512, '21:9 fast'], [1536, 672, '21:9 full'],
];

function OrbitIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="12" rx="9" ry="4" />
      <circle cx="12" cy="12" r="2" />
      <path d="M19 9l2 1-2 2" />
    </svg>
  );
}

function OrbitNode({ id, data, selected }: NodeProps<OrbitNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);

  const batchInfo = useActiveBatchInfo(data.jobId as string | undefined);
  const jobResult = useJobResult(data.jobId as string | undefined);

  const source = connected.find((n) => n.targetHandle === 'in-image');
  const sourceUrl = (source?.generatedUrl || source?.url) as string | undefined;

  useEffect(() => {
    if (!jobResult) return;
    if (jobResult.status === 'done' && jobResult.url) {
      updateNodeData(id, { status: 'done', generatedUrl: jobResult.url as string, jobId: undefined });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || t('环绕失败'), jobId: undefined });
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
      const { job_id } = await api.orbit({
        image_url: sourceUrl,
        width: (data.width as number) || 768,
        height: (data.height as number) || 768,
        duration: (data.duration as number) || 3,
        seed: effectiveSeed,
        lora_strength: (data.loraStrength as number) ?? 1,
      });
      updateNodeData(id, { jobId: job_id });
    } catch (e: any) {
      updateNodeData(id, { status: 'error', error: e?.message || t('提交失败') });
    }
  }, [sourceUrl, data, id, updateNodeData]);

  const busy = data.status === 'generating';
  // Stop the render on the backend too; otherwise the GPU keeps working on a clip nobody is waiting for.
  const cancelRun = () => {
    const jobId = data.jobId as string | undefined;
    if (jobId) api.cancelJob(jobId).catch(() => {});
    updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
  };
  const ready = Boolean(sourceUrl);
  const [isHovered, setIsHovered] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const sizing = useNodeSizing({
    id,
    type: 'videoOrbit',
    rows: ['header'],
    paddingX: 0,
    ratioSources: [
      { width: data.width as number | undefined, height: data.height as number | undefined },
    ],
    hasMedia: Boolean(data.generatedUrl),
    userWidth: data.userWidth as number | undefined,
    growToContent: true,
  });

  const canvasKey = `${data.width}x${data.height}`;
  const field = 'bg-white/5 border border-white/10 rounded px-1 py-0.5 font-mono text-[9px] text-zinc-300 disabled:opacity-40';
  const settings = (
    <div className="nodrag nopan flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[9px] text-zinc-400">
      <label className="flex items-center gap-1" title={t('画幅：官方 Space 提供的尺寸')}>
        {t('画幅')}
        <select className={field} value={canvasKey} disabled={busy}
                onChange={(e) => {
                  const [w, h] = e.target.value.split('x').map(Number);
                  updateNodeData(id, { width: w, height: h });
                }}>
          {CANVASES.map(([w, h, tag]) => <option key={`${w}x${h}`} value={`${w}x${h}`}>{w}x{h} · {tag}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1" title={t('秒数，向上取到 17k+5 帧；官方默认 3 秒')}>
        {t('秒数')}
        <input type="number" min={1} max={10} step={0.5} className={`${field} w-11`} value={(data.duration as number) || 3}
               disabled={busy} onChange={(e) => updateNodeData(id, { duration: parseFloat(e.target.value) || 3 })} />
      </label>
      <label className="flex items-center gap-1" title={t('环绕 LoRA 强度，官方默认 1.0')}>
        LoRA
        <input type="number" min={0} max={1.5} step={0.1} className={`${field} w-11`} value={(data.loraStrength as number) ?? 1}
               disabled={busy} onChange={(e) => updateNodeData(id, { loraStrength: parseFloat(e.target.value) || 0 })} />
      </label>
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
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
          <OrbitIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('360 环绕')}</span>
        </div>
        <span className="text-[8px] font-mono text-sky-300 bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.5 rounded-full"
              title={t('实测：镜头摆动约 ±120°，不是完整一圈')}>
          ±120°
        </span>
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
              {!source ? t('接入一张图片')
                : !sourceUrl ? <span className="text-amber-300/90">{t('上游节点还没有输出，先运行它')}</span>
                : t('这张图同时是首帧和末帧，镜头绕着定格的场景转。画面中间有清楚的主体效果最好。')}
            </div>
            {settings}
          </div>
        )}

        {data.generatedUrl && showSettings && (
          <div className="node-shell-content shrink-0 mx-1.5 mt-1.5 mb-9 p-2 rounded-lg bg-zinc-950/90 border border-white/10">
            {settings}
          </div>
        )}

        <GeneratingLine active={busy} jobId={data.jobId as string | undefined} statusText={batchInfo || '生成中'} />
        <NodeErrorBanner error={data.error as string | undefined} onClear={() => updateNodeData(id, { error: undefined })} />

        <NodeActionRow visible={isHovered || !data.generatedUrl}>
          {data.generatedUrl && (
            <NodeActionButton onClick={() => setShowSettings((v) => !v)}>
              {showSettings ? t('收起设置') : t('设置')}
            </NodeActionButton>
          )}
          <SeedControl
            seed={data.seed as number | undefined}
            seedMode={data.seedMode as any}
            onChange={(newSeed, newMode) => updateNodeData(id, { seed: newSeed, seedMode: newMode })}
            compact
          />
          {busy ? (
            <NodeActionButton grow onClick={cancelRun}>{t('中断')}</NodeActionButton>
          ) : (
            <NodeActionButton accent="sky" grow onClick={run} disabled={!ready || !comfyuiOnline}>
              {t('生成')}
            </NodeActionButton>
          )}
        </NodeActionRow>
      </div>

      <IconHandle type="target" id="in-image" portType="image" nodeId={id} title={t('要环绕的图片（同时作首帧和末帧）')} />
      <IconHandle type="source" id="out-video" portType="video" nodeId={id} title={t('输出环绕视频')} />
    </NodeShell>
  );
}

export default memo(OrbitNode, areNodePropsEqual);
