'use client';

import { useState, useCallback, useEffect, memo } from 'react';
import { areNodePropsEqual } from '@/lib/utils';
import { NodeProps, useReactFlow } from '@xyflow/react';
import IconHandle from './IconHandle';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { AudioRefineNode as AudioRefineNodeType } from '@/lib/types';
import { cardBody, header, label, selectedShadow, defaultShadow } from './PromptNode';
import NodeShell from './NodeShell';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import GeneratingLine from './GeneratingLine';
import VideoAssetPlayer from './VideoAssetPlayer';
import { NodeActionButton, NodeActionRow } from './nodeChrome';
import NodeErrorBanner from './NodeErrorBanner';
import { SeedControl } from './SeedControl';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult, useActiveBatchInfo } from '@/hooks/useJobPoller';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { t } from '@/lib/i18n';

/**
 * 声音精修 — the sound of any clip done again, its picture kept exactly as it is.
 *
 * The clip on in-video can be a render, an edit, a trim or an upload: it is encoded here, its picture
 * is frozen and only the audio is re-noised and denoised again against it (ComfyUI-H3-AudioRefine);
 * the result is the original file's picture stream with the new sound laid under it.
 *
 * What the sound is made against comes from the H3 node upstream (the prompt that made the clip, its
 * references, its audio locks) unless this node has a prompt of its own, which replaces all of it;
 * then only the wires on in-ref-image / in-ref-audio count.
 *
 * 精修 keeps the lines and cleans the sound. 重做 makes a new soundtrack and can turn a spoken line
 * into a whisper, so lock the lines first (audio locks on the H3 node). The lips keep following the
 * OLD sound: a line whose timing changes can drift out of sync with the mouth.
 */

const MODES = [
  { id: 'polish', text: '精修', hint: '4 步 · 降噪 0.5：保留台词，把声音洗干净' },
  { id: 'reroll', text: '重做', hint: '8 步 · 降噪 1.0：整条声音重新生成，台词可能变成耳语，先锁台词' },
] as const;

function SpeakerIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H3v6h3l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

function AudioRefineNode({ id, data, selected }: NodeProps<AudioRefineNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const projectId = useStore((s) => s.currentProjectId);
  const sceneId = useStore((s) => s.currentSceneId);

  const batchInfo = useActiveBatchInfo(data.jobId as string | undefined);
  const jobResult = useJobResult(data.jobId as string | undefined);

  const source = connected.find((n) => n.targetHandle === 'in-video');
  const sourceUrl = (source?.generatedUrl || source?.url) as string | undefined;
  const refCount = connected.filter((n) => n.targetHandle === 'in-ref-image' || n.targetHandle === 'in-ref-audio').length;
  const [showPrompt, setShowPrompt] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [sending, setSending] = useState(false);

  const mode = (data.mode as string) === 'reroll' ? 'reroll' : 'polish';
  const ownPrompt = String(data.prompt || '').trim();
  const info = data.refineInfo as { inheritedFrom?: string | null; overridden?: boolean; images?: number; audios?: number; locks?: number } | undefined;

  // The run itself goes through the canvas server (it works out the conditioning from the canvas and
  // writes the result back); this picks the result up too if the page is the first to see it.
  useEffect(() => {
    if (!jobResult) return;
    if (jobResult.status === 'done' && jobResult.url) {
      updateNodeData(id, {
        status: 'done', generatedUrl: jobResult.url as string, jobId: undefined, error: undefined,
        // a chained shot is served cut; the full file with the overlap is for the cut room
        untrimmedUrl: ((jobResult as any).untrimmed_url as string | undefined) ?? undefined,
        contextFrames: ((jobResult as any).context_frames as number | undefined) ?? undefined,
        overlapFrames: ((jobResult as any).context_frames as number | undefined) ?? undefined,
      });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || t('声音精修失败'), jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
    }
  }, [jobResult]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async () => {
    if (!sourceUrl || !projectId) return;
    setSending(true);
    updateNodeData(id, { status: 'generating', error: undefined });
    try {
      await api.runAudioRefine(projectId, id, sceneId || undefined);
    } catch (e: any) {
      updateNodeData(id, { status: 'error', error: e?.message || t('提交失败') });
    } finally {
      setSending(false);
    }
  }, [sourceUrl, projectId, sceneId, id, updateNodeData]);

  const busy = data.status === 'generating';
  const cancelRun = () => {
    const jobId = data.jobId as string | undefined;
    if (jobId) api.cancelJob(jobId).catch(() => {});
    updateNodeData(id, { status: 'idle', jobId: undefined, error: undefined });
  };
  const ready = Boolean(sourceUrl) && Boolean(projectId);

  const sizing = useNodeSizing({
    id,
    type: 'audioRefine',
    rows: ['header'],
    paddingX: 0,
    ratioSources: [{ width: data.width as number | undefined, height: data.height as number | undefined }],
    hasMedia: Boolean(data.generatedUrl),
    userWidth: data.userWidth as number | undefined,
    growToContent: true,
  });

  const num = (key: string, value: number, min: number, max: number, step: number, title: string, text: string, fallback: number) => (
    <label className="flex items-center gap-1 text-[9px] text-zinc-400 shrink-0" title={title}>
      {text}
      <input
        type="number" min={min} max={max} step={step} value={value || ''} placeholder={String(fallback)}
        onChange={(e) => updateNodeData(id, { [key]: parseFloat(e.target.value) || 0 })}
        className="w-11 bg-white/5 border border-white/10 rounded px-1 py-0.5 font-mono text-[9px] text-zinc-300 disabled:opacity-40"
      />
    </label>
  );

  const badge = ownPrompt
    ? { text: t('自写提示词'), title: t('这个节点自己的提示词替换了上游的一切；只有连到 in-ref-image / in-ref-audio 的参考有效') }
    : info?.inheritedFrom
      ? { text: `${t('继承自')} ${info.inheritedFrom}`, title: t('提示词、参考和音频锁来自上游这个 H3 节点（它出这条片时实际用的那一份）') }
      : { text: t('继承上游 H3'), title: t('沿上游找最近的 H3 视频节点，用它出片时的提示词、参考和音频锁；上游没有 H3 节点时必须自己写提示词') };

  const controls = (
    <div className="nodrag nopan flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {MODES.map((m) => (
          <button
            key={m.id}
            title={t(m.hint)}
            onClick={() => updateNodeData(id, { mode: m.id })}
            className={`px-1.5 py-0.5 rounded text-[9px] border ${mode === m.id
              ? 'border-sky-400/60 bg-sky-500/25 text-sky-100'
              : 'border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10'}`}
          >
            {t(m.text)}
          </button>
        ))}
        {num('steps', (data.steps as number) || 0, 0, 20, 1, t('0 = 按模式（精修 4 步，重做 8 步）'), t('步数'), mode === 'reroll' ? 8 : 4)}
        {num('denoise', (data.denoise as number) || 0, 0, 1, 0.05, t('0 = 按模式（精修 0.5，重做 1.0）'), t('降噪'), mode === 'reroll' ? 1 : 0.5)}
      </div>
      <button
        className="self-start text-[9px] text-zinc-500 hover:text-zinc-300"
        onClick={() => setShowPrompt((v) => !v)}
        title={t('留空 = 用上游 H3 节点出片时的提示词；写了就替换上游的一切')}
      >
        {showPrompt || ownPrompt ? '▾' : '▸'} {t('自己写提示词（可选）')}
      </button>
      {(showPrompt || ownPrompt) && (
        <textarea
          value={String(data.prompt || '')}
          onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
          placeholder={t('描述这条声音：台词（<d>…</d>）和环境声。按 H3 提示词格式写。')}
          rows={4}
          data-node-expand
          className="shrink-0 w-full bg-white/5 border border-white/10 rounded px-1.5 py-1 text-[10px] text-zinc-200 resize-y"
        />
      )}
      <div className="text-[9px] leading-snug text-zinc-500">
        {t('画面原样保留（直接复制画面流）；口型仍照旧声音，台词时间变了可能对不上嘴。上游有连在后面的链式镜头时，它们还带着旧声音的尾巴，要重跑。')}
      </div>
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
          <SpeakerIcon />
          <span style={label} className="text-zinc-200" data-chrome="label">{t('声音精修')}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[8px] font-mono text-sky-300 bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.5 rounded-full" title={badge.title}>
            {badge.text}
          </span>
          <span className="text-[10px] font-mono text-zinc-400 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">
            {refCount} {t('参考')}
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
              {!source ? t('接入要修复声音的片段（任意 H3 视频：成片、修补、剪切、上传都行）')
                : !sourceUrl ? <span className="text-amber-300/90">{t('上游节点还没有输出，先运行它')}</span>
                : t('画面不动，只把声音重做一遍。')}
            </div>
            {controls}
          </div>
        )}

        {data.generatedUrl && (
          <div className="node-shell-content shrink-0 mx-1.5 mt-1.5 mb-9 p-2 rounded-lg bg-zinc-950/90 border border-white/10">
            {controls}
          </div>
        )}

        <GeneratingLine active={busy} jobId={data.jobId as string | undefined} statusText={batchInfo || t('生成中')} />
        <NodeErrorBanner error={data.error as string | undefined} onClear={() => updateNodeData(id, { error: undefined })} />

        <NodeActionRow visible={isHovered || !data.generatedUrl}>
          <SeedControl
            seed={data.seed as number | undefined}
            seedMode={data.seedMode as any}
            onChange={(newSeed, newMode) => updateNodeData(id, { seed: newSeed, seedMode: newMode })}
            compact
          />
          {busy ? (
            <NodeActionButton grow onClick={cancelRun}>{t('中断')}</NodeActionButton>
          ) : (
            <NodeActionButton accent="teal" grow onClick={run} disabled={!ready || !comfyuiOnline || sending}>
              {t('重做声音')}
            </NodeActionButton>
          )}
        </NodeActionRow>
      </div>

      <IconHandle type="target" id="in-video" portType="video" nodeId={id} style={{ top: '30%' }} title={t('要修复声音的片段（画面保留）')} />
      <IconHandle type="target" id="in-ref-image" portType="character" nodeId={id} style={{ top: '52%' }} title={t('参考图（可选，接在继承的参考后面；自写提示词时只有这里的有效）')} />
      <IconHandle type="target" id="in-ref-audio" portType="audio" nodeId={id} style={{ top: '74%' }} title={t('声音参考（可选，<Audio N>）')} />
      <IconHandle type="source" id="out-video" portType="video" nodeId={id} title={t('输出：原画面 + 新声音')} />
    </NodeShell>
  );
}

export default memo(AudioRefineNode, areNodePropsEqual);
