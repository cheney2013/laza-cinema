'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import NodeShell from './NodeShell';
import GeneratingLine from './GeneratingLine';
import NodeErrorBanner from './NodeErrorBanner';
import { NodeActionButton, NodeActionRow } from './nodeChrome';
import { cardBody, defaultShadow, header, label, selectedShadow } from './PromptNode';
import { SeedControl, resolveSeedForGeneration } from './SeedControl';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult } from '@/hooks/useJobPoller';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import { useStore } from '@/lib/store';
import { api } from '@/lib/api';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { WardrobeSwapNode as WardrobeSwapNodeType } from '@/lib/types';
import { areNodePropsEqual } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { downscaleImageToDataUrl } from '@/lib/imageDownscale';

function WardrobeSwapNode({ id, data, selected }: NodeProps<WardrobeSwapNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const [hovered, setHovered] = useState(false);
  const cancelledRef = useRef(false);

  const person = connected.find((n) => n.targetHandle === 'in-person');
  const outfit = connected.find((n) => n.targetHandle === 'in-outfit');
  const personRef = (person?.generatedUrl || person?.url || person?.comfyFilename) as string | undefined;
  const outfitRef = (outfit?.generatedUrl || outfit?.url || outfit?.comfyFilename) as string | undefined;

  useEffect(() => {
    if (!person || data.generatedUrl || !person.width || !person.height) return;
    if (data.width !== person.width || data.height !== person.height) {
      updateNodeData(id, { width: person.width, height: person.height });
    }
  }, [person?.id, person?.width, person?.height, data.generatedUrl, data.width, data.height, id, updateNodeData]);

  const jobResult = useJobResult(data.jobId as string | undefined);
  useEffect(() => {
    if (!jobResult || cancelledRef.current) return;
    if (jobResult.status === 'done' && jobResult.url) {
      updateNodeData(id, { status: 'done', generatedUrl: jobResult.url as string, jobId: undefined });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || t('换装失败'), jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', error: undefined, jobId: undefined });
    }
  }, [jobResult, id, updateNodeData]);

  const run = useCallback(async () => {
    if (!personRef || !outfitRef || data.status === 'generating') return;
    cancelledRef.current = false;
    const { effectiveSeed, nextSeedToStore } = resolveSeedForGeneration(data.seed, data.seedMode, 81000);
    updateNodeData(id, { status: 'generating', error: undefined, seed: nextSeedToStore });
    try {
      let outfitDescription = data.outfitSource === outfitRef ? (data.outfitDescription || '') : '';
      if (!outfitDescription) {
        const absolute = outfitRef.startsWith('http') || outfitRef.startsWith('data:')
          ? outfitRef : `${API_BASE}${outfitRef}`;
        const imageDataUrl = await downscaleImageToDataUrl(absolute);
        const described = await api.describeSubject({ imageDataUrl, kind: 'person' });
        outfitDescription = described.description;
        updateNodeData(id, { outfitSource: outfitRef, outfitDescription });
      }
      let personDescription = data.personSource === personRef ? (data.personDescription || '') : '';
      if (!personDescription) {
        const absolute = personRef.startsWith('http') || personRef.startsWith('data:')
          ? personRef : `${API_BASE}${personRef}`;
        const imageDataUrl = await downscaleImageToDataUrl(absolute);
        const described = await api.describeSubject({ imageDataUrl, kind: 'person' });
        personDescription = described.description;
        updateNodeData(id, { personSource: personRef, personDescription });
      }
      const { job_id } = await api.wardrobeSwapH3({
        person_image_url: personRef,
        outfit_image_url: outfitRef,
        width: data.width,
        height: data.height,
        steps: data.steps,
        seed: effectiveSeed,
        detail: [outfitDescription, data.detail || ''].filter(Boolean).join(' '),
        person_detail: personDescription,
        extract_time: 0.75,
      });
      updateNodeData(id, { jobId: job_id });
    } catch (error: any) {
      updateNodeData(id, { status: 'error', error: error?.message || t('提交失败'), jobId: undefined });
    }
  }, [personRef, outfitRef, data, id, updateNodeData]);

  const sizing = useNodeSizing({
    id,
    type: 'wardrobeSwap',
    rows: ['header', 'actions'],
    paddingX: 0,
    ratioSources: [{ width: data.width, height: data.height }],
    hasMedia: Boolean(data.generatedUrl),
    userWidth: data.userWidth,
  });
  const ready = Boolean(personRef && outfitRef);
  const busy = data.status === 'generating';

  return (
    <NodeShell nodeId={id} spec={sizing.spec} selected={selected} onResizeEnd={sizing.onResizeEnd} shellRef={sizing.shellRef}>
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08]">
          <span aria-hidden>👗</span><span style={label}>{t('一键换装')}</span>
        </div>
        <span className="text-[8px] text-pink-300 bg-pink-500/10 border border-pink-500/25 px-1.5 py-0.5 rounded-full">{t('无需提示词')}</span>
      </div>
      <div style={{ ...cardBody, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: selected ? selectedShadow : defaultShadow }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        {data.generatedUrl ? (
          <img src={`${API_BASE}${data.generatedUrl}`} alt={t('换装结果')} className="w-full flex-1 min-h-0 object-contain" onLoad={(e) => sizing.onMediaSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} draggable={false} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-1 px-4 text-center">
            <div className="text-[11px] text-zinc-400">{!personRef ? t('接入人物原图') : !outfitRef ? t('接入服装参考') : t('可以换装')}</div>
            <div className="text-[9px] text-zinc-600 leading-relaxed">{t('保留人物、姿势与背景')}<br />{t('只从第二张图迁移服装')}</div>
          </div>
        )}
        <GeneratingLine active={busy} jobId={data.jobId} statusText={t('正在换装')} />
        <NodeErrorBanner error={data.error} onClear={() => updateNodeData(id, { error: undefined })} />
        <NodeActionRow visible={hovered || !data.generatedUrl}>
          <input value={data.detail || ''} onChange={(e) => updateNodeData(id, { detail: e.target.value })} placeholder={t('可选：衣服细节调整')} className="min-w-0 flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-[9px] text-zinc-300" />
          <SeedControl seed={data.seed} seedMode={data.seedMode} onChange={(seed, seedMode) => updateNodeData(id, { seed, seedMode })} compact />
          <NodeActionButton accent="violet" onClick={run} disabled={!ready || busy || !comfyuiOnline}>{t('换装')}</NodeActionButton>
        </NodeActionRow>
      </div>
      <IconHandle type="target" id="in-person" portType="image" nodeId={id} style={{ top: '38%' }} title={t('人物原图：身份、姿势、背景全部保留')} />
      <IconHandle type="target" id="in-outfit" portType="image" nodeId={id} style={{ top: '66%' }} title={t('服装参考：只提取衣服')} />
      <IconHandle type="source" id="out-image" portType="image" nodeId={id} title={t('换装后的静态图')} />
    </NodeShell>
  );
}

export default memo(WardrobeSwapNode, areNodePropsEqual);
