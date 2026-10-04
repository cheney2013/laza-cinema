'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { NodeProps, useReactFlow } from '@xyflow/react';

import IconHandle from './IconHandle';
import NodeShell from './NodeShell';
import GeneratingLine from './GeneratingLine';
import NodeErrorBanner from './NodeErrorBanner';
import { cardBody, defaultShadow, header, label, selectedShadow } from './PromptNode';
import { SeedControl, resolveSeedForGeneration } from './SeedControl';
import { showAlert } from '@/components/ui/Dialog';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult } from '@/hooks/useJobPoller';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import { api } from '@/lib/api';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { t } from '@/lib/i18n';
import { useStore } from '@/lib/store';
import { CharacterSheetNode as CharacterSheetNodeType } from '@/lib/types';
import { areNodePropsEqual } from '@/lib/utils';

/** Portrait is the house format: a landscape full body comes out too small (定妆板用竖屏). */
const SIZES = [
  { id: 'portrait', label: '竖屏 768×1376（推荐）', width: 768, height: 1376 },
  { id: 'landscape', label: '横屏 1376×768', width: 1376, height: 768 },
] as const;

const SUBJECTS = [
  { id: 'person', label: '人' },
  { id: 'man', label: '男性' },
  { id: 'woman', label: '女性' },
  { id: 'girl', label: '女孩' },
  { id: 'boy', label: '男孩' },
] as const;

const abs = (u: string) => (u.startsWith('http') || u.startsWith('data:') ? u : `${API_BASE}${u}`);

/**
 * A character sheet: four synchronized views (front, profile, back, face) from
 * one H3 pass, enhanced and composed into one reference image. Identity and
 * costume are separate fields because they are separate facts: make-up belongs
 * to the person, a coat to the costume.
 */
function CharacterSheetNode({ id, data, selected }: NodeProps<CharacterSheetNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const projectId = useStore((s) => s.currentProjectId);
  const cancelledRef = useRef(false);
  const [showTurnaround, setShowTurnaround] = useState(false);
  const [filed, setFiled] = useState(false);

  const face = connected.find((n) => n.targetHandle === 'in-face');
  const faceUrl = (face?.generatedUrl || face?.url) as string | undefined;
  const base = connected.find((n) => n.targetHandle === 'in-base');
  const baseUrl = (base?.generatedUrl || base?.url) as string | undefined;
  const props = connected.filter((n) => n.targetHandle === 'in-prop');
  const propDescriptions = (data.propDescriptions || {}) as Record<string, string>;

  const jobResult = useJobResult(data.jobId as string | undefined);
  useEffect(() => {
    if (!jobResult || cancelledRef.current) return;
    if (jobResult.status === 'done' && jobResult.url) {
      updateNodeData(id, {
        status: 'done',
        generatedUrl: jobResult.url as string,
        turnaroundUrl: (jobResult as any).turnaround_url as string | undefined,
        compiledPrompt: (jobResult as any).compiled_prompt as string | undefined,
        jobId: undefined,
      });
      setFiled(false);
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || t('定妆照生成失败'), jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', error: undefined, jobId: undefined });
    }
  }, [jobResult, id, updateNodeData]);

  const size = SIZES.find((s) => s.width === data.width && s.height === data.height) ?? SIZES[0];
  const missingProp = props.find((p) => !(propDescriptions[p.id] || '').trim());
  const ready = Boolean((data.identity || '').trim() && (data.costume || '').trim() && !missingProp);
  const busy = data.status === 'generating';

  const run = useCallback(async () => {
    if (!ready || busy) return;
    cancelledRef.current = false;
    const { effectiveSeed, nextSeedToStore } = resolveSeedForGeneration(data.seed, data.seedMode, 81000);
    updateNodeData(id, { status: 'generating', error: undefined, seed: nextSeedToStore });
    try {
      const { job_id } = await api.generateCharacterSheet({
        identity: data.identity || '',
        costume: data.costume || '',
        subject_noun: data.subjectNoun || 'person',
        face_image_url: faceUrl ? abs(faceUrl) : null,
        base_sheet_url: baseUrl ? abs(baseUrl) : null,
        engine: (data.engine as 'qwen' | 'h3') || 'qwen',
        props: props
          .filter((p) => p.generatedUrl || p.url)
          .map((p) => ({ image_url: abs((p.generatedUrl || p.url) as string), description: propDescriptions[p.id].trim() })),
        width: size.width,
        height: size.height,
        steps: data.steps || 4,
        seed: effectiveSeed,
      });
      updateNodeData(id, { jobId: job_id });
    } catch (error: any) {
      updateNodeData(id, { status: 'error', error: error?.message || t('提交失败'), jobId: undefined });
    }
  }, [ready, busy, data, faceUrl, props, propDescriptions, size, id, updateNodeData]);

  const cancel = useCallback(async () => {
    cancelledRef.current = true;
    if (data.jobId) await api.cancelJob(data.jobId as string).catch(() => {});
    updateNodeData(id, { status: 'idle', jobId: undefined });
  }, [data.jobId, id, updateNodeData]);

  /** File the finished sheet in the film's production bible as a cast entry. */
  const fileInBible = async () => {
    if (!projectId || !data.generatedUrl) return;
    try {
      const img = new Image();
      img.src = abs(data.generatedUrl as string);
      await img.decode().catch(() => {});
      await api.addBibleEntry(projectId, {
        kind: 'cast',
        name: (data.identity || '').split(/[，,。.]/)[0].slice(0, 40) || t('定妆照'),
        notes: `${t('身份')}：${data.identity}\n${t('服装')}：${data.costume}`,
        url: data.generatedUrl as string,
        mediaType: 'image',
        width: img.naturalWidth || undefined,
        height: img.naturalHeight || undefined,
      });
      setFiled(true);
    } catch (e) {
      void showAlert(t('收录失败：{error}', { error: (e as Error).message }), { title: t('资料库'), danger: true });
    }
  };

  const sizing = useNodeSizing({
    id,
    type: 'characterSheet',
    rows: ['header'],
    paddingX: 0,
    ratioSources: [],
    hasMedia: false,
    userWidth: data.userWidth,
  });

  const field = 'w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-200 outline-none focus:border-white/25 resize-none';

  return (
    <NodeShell nodeId={id} spec={sizing.spec} selected={selected} onResizeEnd={sizing.onResizeEnd} shellRef={sizing.shellRef}>
      <div style={header} data-chrome-row="header" className="node-shell-header flex items-center justify-between">
        <div className="flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.05] px-2 py-0.5">
          <span aria-hidden>🧍</span>
          <span style={label}>{t('定妆照')}</span>
        </div>
        <span className="text-[9px] text-zinc-500">{t('正面 · 侧面 · 背面 · 脸部特写')}</span>
      </div>

      <div
        style={{ ...cardBody, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: selected ? selectedShadow : defaultShadow }}
      >
        <div data-shell-content className="nodrag nowheel flex-1 min-h-0 overflow-y-auto p-3 space-y-2.5">
          {/* Result */}
          {data.generatedUrl ? (
            <div className="space-y-1.5">
              <div className="overflow-hidden rounded-lg bg-black">
                {showTurnaround && data.turnaroundUrl ? (
                  <video src={abs(data.turnaroundUrl as string)} autoPlay loop muted playsInline className="block max-h-[360px] w-full object-contain" />
                ) : (
                  <img src={abs(data.generatedUrl as string)} alt={t('定妆照')} className="block max-h-[360px] w-full object-contain" draggable={false} />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                {data.turnaroundUrl && (
                  <button onClick={() => setShowTurnaround((v) => !v)} className="rounded border border-white/10 px-2 py-1 text-zinc-300 hover:bg-white/10">
                    {showTurnaround ? t('看定妆照') : t('看四视图原视频')}
                  </button>
                )}
                <button
                  onClick={() => void fileInBible()}
                  disabled={filed || !projectId}
                  className="rounded border border-sky-400/30 bg-sky-400/10 px-2 py-1 text-sky-200 hover:bg-sky-400/20 disabled:opacity-50"
                >
                  {filed ? t('已收录到资料库') : t('收录到资料库')}
                </button>
              </div>
            </div>
          ) : (
            !busy && (
              <div className="rounded-lg border border-dashed border-white/10 bg-black/20 px-3 py-2 text-[10px] leading-relaxed text-zinc-500">
                {t('一次生成四个同步视图（正面全身、正侧、背面全身、脸部特写），再合成一张定妆照。')}
              </div>
            )
          )}

          {/* Who */}
          <label className="block space-y-1">
            <span className="text-[10px] font-medium text-zinc-300">{t('身份（换什么衣服都不变的）')}</span>
            <textarea
              rows={3}
              value={data.identity || ''}
              onChange={(e) => updateNodeData(id, { identity: e.target.value })}
              onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
              onBlur={() => window.dispatchEvent(new Event('inputBlurred'))}
              placeholder={t('年龄、脸型、发型发色、体型、妆容或疤痕等，例如：三十岁左右的女人，齐肩黑发，圆脸，右眉上方有颗小痣…')}
              className={field}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-medium text-zinc-300">{t('服装（这部戏里穿的）')}</span>
            <textarea
              rows={3}
              value={data.costume || ''}
              onChange={(e) => updateNodeData(id, { costume: e.target.value })}
              onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
              onBlur={() => window.dispatchEvent(new Event('inputBlurred'))}
              placeholder={t('从上到下写清楚，例如：米色风衣敞着，白衬衫，深灰西裤，黑色短靴，斜挎一只棕色皮包…')}
              className={field}
            />
          </label>
          <p className="text-[9px] leading-relaxed text-zinc-600">
            {t('两边都只写“有什么”，不要写“不要什么”——写出来的东西会被画出来。')}
          </p>

          {/* References */}
          <div className="space-y-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-zinc-300">{t('脸部参考')}</span>
              <span className={faceUrl ? 'text-emerald-300' : 'text-zinc-600'}>{faceUrl ? t('已连接') : t('可选，连左侧「脸」接口')}</span>
            </div>
            {faceUrl && (
              <div className="flex items-center gap-2">
                <img src={abs(faceUrl)} alt="" className="h-12 w-12 rounded object-cover" />
                <span className="text-[9px] leading-relaxed text-amber-200/80">
                  {t('要用只有头部的裁切图：全身图会把它的衣服带进结果，服装描述就不管用了。')}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between pt-1 text-[10px]">
              <span className="text-zinc-300">{t('关键道具')}</span>
              <span className="text-zinc-600">{props.length ? t('{n} 件', { n: props.length }) : t('可选，连左侧「道具」接口，可接多个')}</span>
            </div>
            {props.map((p) => (
              <div key={p.id} className="flex items-center gap-2">
                {(p.generatedUrl || p.url) && (
                  <img src={abs((p.generatedUrl || p.url) as string)} alt="" className="h-10 w-10 flex-none rounded object-cover" />
                )}
                <input
                  value={propDescriptions[p.id] || ''}
                  onChange={(e) => updateNodeData(id, { propDescriptions: { ...propDescriptions, [p.id]: e.target.value } })}
                  onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
                  onBlur={() => window.dispatchEvent(new Event('inputBlurred'))}
                  placeholder={t('这件道具是什么、在身上哪里，例如：斜挎在右肩的棕色皮包')}
                  className={`${field} ${propDescriptions[p.id]?.trim() ? '' : 'border-amber-400/40'}`}
                />
              </div>
            ))}
          </div>

          {/* Settings */}
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <label className="space-y-1">
              <span className="text-zinc-400">{t('画幅')}</span>
              <select
                value={size.id}
                onChange={(e) => {
                  const s = SIZES.find((x) => x.id === e.target.value) ?? SIZES[0];
                  updateNodeData(id, { width: s.width, height: s.height });
                }}
                className="w-full rounded bg-black/30 border border-white/10 px-1.5 py-1 text-zinc-200"
              >
                {SIZES.map((s) => <option key={s.id} value={s.id}>{t(s.label)}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-zinc-400">{t('人物')}</span>
              <select
                value={data.subjectNoun || 'person'}
                onChange={(e) => updateNodeData(id, { subjectNoun: e.target.value })}
                className="w-full rounded bg-black/30 border border-white/10 px-1.5 py-1 text-zinc-200"
              >
                {SUBJECTS.map((s) => <option key={s.id} value={s.id}>{t(s.label)}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div data-chrome-row="actions" className="space-y-1.5 border-t border-white/[0.06] p-2.5">
          <SeedControl compact seed={data.seed} seedMode={data.seedMode} onChange={(seed, seedMode) => updateNodeData(id, { seed, seedMode })} />
          <button
            onClick={() => void run()}
            disabled={!ready || busy || !comfyuiOnline}
            className="w-full rounded-xl border border-white/15 bg-white/10 py-2 text-xs font-semibold text-white hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
            title={missingProp ? t('每件道具都要写一句描述') : undefined}
          >
            {!((data.identity || '').trim() && (data.costume || '').trim())
              ? t('先填写身份和服装')
              : missingProp
              ? t('给道具写上描述')
              : data.generatedUrl ? t('重新生成定妆照') : t('生成定妆照')}
          </button>
        </div>

        <GeneratingLine active={busy} jobId={data.jobId} statusText={t('正在生成四视图并合成定妆照')} onCancel={cancel} />
        <NodeErrorBanner error={data.status === 'error' ? data.error : null} onClear={() => updateNodeData(id, { status: 'idle', error: undefined })} />
      </div>

      <IconHandle type="target" id="in-base" portType="image" nodeId={id} style={{ top: '15%' }} title={t('原定妆照（派生版从它改，服装细节不变）')} />
      <IconHandle type="target" id="in-face" portType="image" nodeId={id} style={{ top: '30%' }} title={t('脸部参考（只含头部的裁切图）')} />
      <IconHandle type="target" id="in-prop" portType="image" nodeId={id} style={{ top: '55%' }} title={t('关键道具参考（可多个）')} />
      <IconHandle type="source" id="out-image" portType="image" nodeId={id} title={t('定妆照')} />
    </NodeShell>
  );
}

export default memo(CharacterSheetNode, areNodePropsEqual);
