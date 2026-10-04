'use client';

import { useState, useCallback, useEffect, memo } from 'react';
import { provides } from '@/lib/nodeRegistry';
import { areNodePropsEqual } from '@/lib/utils';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { CharswapNode as CharswapNodeType } from '@/lib/types';
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
 * Swap the performer in a clip for the person in one still — Viggle-Animate.
 *
 * Two inputs and nothing else: the still decides who, the driving clip decides
 * everything else — blocking, camera, handheld motion, the set, the light, the other
 * people. **There is no prompt on this route.** The model's text encoder is replaced by a
 * frozen 362-token embedding, so this node deliberately has no prompt port: a prompt
 * field here would be a control that does nothing.
 *
 * It replaced the Ref2VA + matting route on 2026-09-07 because it lands the swap with no
 * matting on the case that route needs matting for (a reference in the same wardrobe as
 * the source performer), holding identity across the whole clip with no bleed from the
 * reference still's own background.
 *
 * Two things it will not do, both measured, both worth knowing before wiring it:
 *   * The face is a **blend** — hair and fringe come from the still, the bone structure
 *     stays the driving performer's. Nothing in the parameters moves this.
 *   * **Held props are lost.** Whatever the performer is holding is repainted away with
 *     them. A shot whose story is a raised prop belongs on the Ref2VA route.
 */

function SwapIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h13l-3-3" />
      <path d="M20 16H7l3 3" />
    </svg>
  );
}

function CharswapNode({ id, data, selected }: NodeProps<CharswapNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);

  const batchInfo = useActiveBatchInfo(data.jobId as string | undefined);
  const jobResult = useJobResult(data.jobId as string | undefined);

  const driveNode = connected.find((n) => provides(n, 'video'));
  const driveUrl = (driveNode?.generatedUrl || driveNode?.url) as string | undefined;

  const refUrl = connected
    .filter((n) => provides(n, 'character'))
    .map((n) => (n.generatedUrl || n.url) as string)
    .find(Boolean);

  useEffect(() => {
    if (!jobResult) return;
    if (jobResult.status === 'done' && jobResult.url) {
      updateNodeData(id, { status: 'done', generatedUrl: jobResult.url as string, jobId: undefined });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || t('换人失败'), jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
    }
  }, [jobResult]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async () => {
    if (!driveUrl || !refUrl) return;
    const { effectiveSeed, nextSeedToStore } = resolveSeedForGeneration(
      data.seed as number | undefined,
      data.seedMode as any,
    );
    updateNodeData(id, { status: 'generating', error: undefined, seed: nextSeedToStore });
    try {
      const { job_id } = await api.charswap({
        video_url: driveUrl,
        character_image_url: refUrl,
        // 0 lets the backend read the clip's own length; a cap above it mosaics.
        length: (data.length as number) || 0,
        seed: effectiveSeed,
        megapixels: (data.megapixels as number) ?? 0.8,
      });
      updateNodeData(id, { jobId: job_id });
    } catch (e: any) {
      updateNodeData(id, { status: 'error', error: e?.message || t('提交失败') });
    }
  }, [driveUrl, refUrl, data, id, updateNodeData]);

  const busy = data.status === 'generating';
  const ready = Boolean(driveUrl) && Boolean(refUrl);

  const [isHovered, setIsHovered] = useState(false);

  const sizing = useNodeSizing({
    id,
    type: 'charswap',
    rows: ['header'],
    paddingX: 0,
    ratioSources: [
      { width: data.width as number | undefined, height: data.height as number | undefined },
    ],
    hasMedia: Boolean(data.generatedUrl),
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
          <SwapIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('换人 · Viggle')}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[8px] font-mono text-amber-300 bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 rounded-full"
                title={t('这条链没有提示词：身份只来自参考图，其余全来自驱动视频。人物手里拿着的东西会被一起重绘掉')}>
            
            {t('无提示词 · 道具会丢')}
          </span>
          <span className="text-[10px] font-mono text-zinc-400 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">
            4  {t('步')}
          </span>
        </div>
      </div>

      <div
        style={{ ...cardBody, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
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
          <div className="flex-1 flex flex-col items-center justify-center gap-1 px-4 text-center">
            <div className="text-[11px] text-zinc-500">
              {!driveUrl
                ? t('接入驱动视频')
                : !refUrl
                  ? t('接入角色参考图')
                  : t('就绪')}
            </div>
            <div className="text-[9px] text-zinc-600 leading-relaxed">
              
              {t('参考图决定是谁，驱动视频决定走位、机位、')}<br />{t('场景和其他人。不用抠图，也没有提示词')}
            </div>
          </div>
        )}

        <GeneratingLine active={busy} jobId={data.jobId as string | undefined} statusText={batchInfo || '生成中'} />
        <NodeErrorBanner error={data.error as string | undefined} onClear={() => updateNodeData(id, { error: undefined })} />

        <NodeActionRow visible={isHovered || !data.generatedUrl}>
          <SeedControl
            seed={data.seed as number | undefined}
            seedMode={data.seedMode as any}
            onChange={(newSeed, newMode) => updateNodeData(id, { seed: newSeed, seedMode: newMode })}
            compact
          />
          <NodeActionButton accent="teal" grow onClick={run} disabled={!ready || busy || !comfyuiOnline}>
            
            {t('生成')}
          </NodeActionButton>
        </NodeActionRow>
      </div>

      <IconHandle type="target" id="in-video" portType="video" nodeId={id} style={{ top: '35%' }} title={t('驱动视频（走位、机位、场景、其他人都来自它）')} />
      <IconHandle type="target" id="in-character" portType="character" nodeId={id} style={{ top: '65%' }} title={t('角色参考图（只决定换成谁）')} />
      <IconHandle type="source" id="out-video" portType="video" nodeId={id} title={t('输出换人后的视频')} />
    </NodeShell>
  );
}

export default memo(CharswapNode, areNodePropsEqual);
