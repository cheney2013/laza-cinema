'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { GearIcon } from '@/components/ui/icons';
import { createPortal } from 'react-dom';
import { NodeProps, useReactFlow } from '@xyflow/react';

import IconHandle from './IconHandle';
import NodeShell from './NodeShell';
import GeneratingLine from './GeneratingLine';
import NodeErrorBanner from './NodeErrorBanner';
import { NodeActionButton, NodeHeaderIconButton } from './nodeChrome';
import {
  MediaBottomBar,
  MediaCheckIcon,
  MediaCopyIcon,
  MediaDownloadIcon,
  MediaEmptyState,
  MediaIconButton,
  MediaMaximizeIcon,
  MediaMetaChip,
  MediaTopBar,
} from './mediaChrome';
import { showAlert } from '@/components/ui/Dialog';
import { cardBody, defaultShadow, header, label, selectedShadow } from './PromptNode';
import { SeedControl, resolveSeedForGeneration } from './SeedControl';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult } from '@/hooks/useJobPoller';
import { useAutoHeightNode } from '@/hooks/useAutoHeightNode';
import { useSyncedText } from '@/hooks/useSyncedText';
import { api } from '@/lib/api';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { t } from '@/lib/i18n';
import { useStore } from '@/lib/store';
import { QwenImageNode as QwenImageNodeType } from '@/lib/types';
import { areNodePropsEqual, copyImageToClipboard, downloadFile } from '@/lib/utils';

/** Only used when nothing is wired in: with a reference the canvas follows it. */
const SIZES = [
  { id: 'landscape', label: '横屏 1376×768', width: 1376, height: 768 },
  { id: 'portrait', label: '竖屏 768×1376', width: 768, height: 1376 },
  { id: 'square', label: '方形 1024×1024', width: 1024, height: 1024 },
] as const;

const abs = (u: string) => (u.startsWith('http') || u.startsWith('data:') ? u : `${API_BASE}${u}`);

/**
 * AnyAngle re-shoots reference 1 at the camera of reference 2, a coarse render of
 * the new view (a gaussian viewer capture, a grey-box render). The order is the
 * one measured to work -- the reverse of the LoRA card's wording -- and the prompt
 * is the card's sentence. Tested at LoRA 1.0, cfg 3, 25 steps (2026-09-28).
 */
const ANY_ANGLE_LORA = 'QI2.1_AnyAngle.safetensors';
const ANY_ANGLE_PROMPT = 'Change the camera angle from <image2> to <image1>.';

/**
 * Base models (keys of QWEN_IMAGE_21_BASE_MODELS in backend/workflow_builders.py).
 * Noct Q Anime is a merged checkpoint on the same graph; its own workflow runs
 * cfg 3 with this negative prompt, and prompts start "An anime illustration of…".
 */
const BASE_MODELS = [
  { id: 'qwen21', label: 'Qwen 2.1', title: 'qwen_image_2.1_int8_convrot。官方原版（INT8，比 bf16 小一半），写实照片与改图都用它。' },
  { id: 'noctAnime', label: 'Noct 动漫', title: 'NoctQA_V1_int8_convrot。Qwen 2.1 的动漫合并底模（无审查，仅限非商用）。cfg 固定 3，提示词以 An anime illustration of… 开头。' },
] as const;
const ANIME_NEGATIVE = 'low quality, low resolution, blurry, jpeg artifacts, washed-out colors, sloppy lines, messy line art, extra fingers, missing fingers, badly drawn hands, deformed anatomy, 3d render, photograph, photorealistic';

/**
 * Qwen-Image-2.1: a still, from text alone or edited against up to ten references.
 *
 * The reference port takes several connections and **their order is the model's
 * `<image 1>`, `<image 2>` …**, exactly as edge order is `<Picture N>` for H3.
 * The prompt says which reference governs what; without that a second reference
 * tends to supply only material and not the thing you meant.
 *
 * With any reference connected the output takes reference 1's aspect ratio and
 * the size selector is ignored — that is the model's own edit behaviour, not a
 * choice made here.
 */
function QwenImageNode({ id, data, selected }: NodeProps<QwenImageNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const cancelledRef = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied] = useState(false);

  // Edge order is the reference numbering; useConnectedInputs preserves it.
  const refs = connected
    .filter((n) => n.targetHandle === 'in-ref')
    .map((n) => (n.generatedUrl || n.url) as string | undefined)
    .filter((u): u is string => Boolean(u));

  const [prompt, setPrompt] = useSyncedText((data.prompt as string) || '');
  const baseModel = (data.baseModel as string) || 'qwen21';
  const [negative, setNegative] = useSyncedText((data.negativePrompt as string) || '');

  const jobResult = useJobResult(data.jobId as string | undefined);
  useEffect(() => {
    if (!jobResult || cancelledRef.current) return;
    if (jobResult.status === 'done' && jobResult.url) {
      // The backend moves the seed off any seed a reference was made with; record
      // the one that actually ran so the node's seed matches the picture.
      const usedSeed = typeof jobResult.seed === 'number' ? { seed: jobResult.seed as number } : {};
      updateNodeData(id, { status: 'done', generatedUrl: jobResult.url as string, jobId: undefined, ...usedSeed });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || t('生成失败'), jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', error: undefined, jobId: undefined });
    }
  }, [jobResult, id, updateNodeData]);

  const size = SIZES.find((s) => s.width === data.width && s.height === data.height) ?? SIZES[0];
  const ready = Boolean((data.prompt as string || '').trim());
  const busy = data.status === 'generating';

  const run = useCallback(async () => {
    if (!ready || busy) return;
    cancelledRef.current = false;
    const { effectiveSeed, nextSeedToStore } = resolveSeedForGeneration(data.seed, data.seedMode, 81000);
    updateNodeData(id, { status: 'generating', error: undefined, seed: nextSeedToStore });
    try {
      const { job_id } = await api.generateQwenImage({
        prompt: (data.prompt as string) || '',
        reference_urls: refs.map(abs),
        negative_prompt: (data.negativePrompt as string) || '',
        width: size.width,
        height: size.height,
        steps: (data.steps as number) || 25,
        cfg: data.anyAngle || baseModel === 'noctAnime' ? 3.0 : typeof data.cfg === 'number' ? (data.cfg as number) : 1.0,
        seed: effectiveSeed,
        base_model: baseModel,
        ...(data.anyAngle ? { lora_name: ANY_ANGLE_LORA, lora_strength: 1.0 } : {}),
      });
      updateNodeData(id, { jobId: job_id });
    } catch (error: any) {
      updateNodeData(id, { status: 'error', error: error?.message || t('提交失败'), jobId: undefined });
    }
  }, [ready, busy, data, baseModel, refs, size, id, updateNodeData]);

  const cancel = useCallback(async () => {
    cancelledRef.current = true;
    if (data.jobId) await api.cancelJob(data.jobId as string).catch(() => {});
    updateNodeData(id, { status: 'idle', jobId: undefined });
  }, [data.jobId, id, updateNodeData]);

  // Only the width is kept; the picture's box has the picture's own ratio (hooks/useAutoHeightNode).
  const sizing = useAutoHeightNode({
    id,
    ratioSources: [{ width: data.width as number | undefined, height: data.height as number | undefined }],
    hasMedia: Boolean(data.generatedUrl),
    mediaHidden: showSettings,
    userWidth: data.userWidth,
    defaultW: 320,
  });

  const imageUrl = data.generatedUrl ? abs(data.generatedUrl as string) : null;
  const field =
    'w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-200 outline-none focus:border-white/25 resize-none';

  return (
    <NodeShell nodeId={id} spec={sizing.spec} selected={selected} onResizeEnd={sizing.onResizeEnd} autoHeight>
      {/* 功能区与设置抽屉。抽屉是流内一行：打开撑高节点，关上还原 */}
      <div className="node-shell-headwrap" style={{ position: 'relative', flex: '0 0 auto' }}>
        <div style={header} data-chrome-row="header" className="node-shell-header flex items-center justify-between">
          <div className="flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.05] px-2 py-0.5 text-zinc-300">
            <ImageIcon />
            <span style={label} className="text-zinc-200" data-chrome="label">{t('生成图片')}</span>
          </div>
          <div className="flex items-center gap-1">
            <MediaMetaChip title={t('连线顺序就是 <image N>')}>
              {data.anyAngle ? t('换机位 · {n} 张参考', { n: refs.length })
                : refs.length ? t('改图 · {n} 张参考', { n: refs.length }) : t('文生图')}
            </MediaMetaChip>
            <NodeHeaderIconButton active={showSettings} onClick={() => setShowSettings((v) => !v)} title={t('反向提示词、画幅、步数、参考图顺序')}>
              <GearIcon />
            </NodeHeaderIconButton>
          </div>
        </div>

        {showSettings && (
          <div data-chrome-row="settings" className="node-shell-drawer nodrag nowheel p-3 space-y-2.5 text-[10px] animate-in fade-in duration-150">
            <label className="block space-y-1">
              <span className="font-medium text-zinc-300">{t('反向提示词（可留空）')}</span>
              <textarea
                rows={2}
                value={negative}
                onChange={(e) => setNegative(e.target.value)}
                onBlur={() => { updateNodeData(id, { negativePrompt: negative }); window.dispatchEvent(new Event('inputBlurred')); }}
                onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
                placeholder={t('不想要的东西。这个模型吃否定句，和 H3 不一样。')}
                className={field}
              />
            </label>

            <div className="space-y-1">
              <span className="text-zinc-400">{t('底模')}</span>
              <div className="grid grid-cols-2 gap-1.5">
                {BASE_MODELS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    title={t(m.title)}
                    onClick={() => {
                      const neg = ((data.negativePrompt as string) || '').trim();
                      updateNodeData(id, {
                        baseModel: m.id,
                        ...(m.id === 'noctAnime' && !neg ? { negativePrompt: ANIME_NEGATIVE } : {}),
                      });
                    }}
                    className={`nodrag py-1 px-1.5 text-[10px] rounded-lg border transition-colors cursor-pointer ${baseModel === m.id
                        ? 'bg-white/20 border-white/40 text-white font-semibold shadow-xs'
                        : 'bg-white/[0.03] border-white/10 text-zinc-400 hover:text-white hover:bg-white/[0.08]'
                      }`}
                  >
                    {t(m.label)}
                  </button>
                ))}
              </div>
              {baseModel === 'noctAnime' && (
                <span className="block text-[9px] leading-relaxed text-zinc-500">
                  {t('提示词以 An anime illustration of… 开头，不写 anime 会出照片。cfg 固定 3。')}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-zinc-400">{t('画幅（只在没有参考图时生效）')}</span>
                <select
                  value={size.id}
                  disabled={refs.length > 0}
                  onChange={(e) => {
                    const s = SIZES.find((x) => x.id === e.target.value) ?? SIZES[0];
                    updateNodeData(id, { width: s.width, height: s.height });
                  }}
                  className="w-full rounded border border-white/10 bg-black/30 px-1.5 py-1 text-zinc-200 disabled:opacity-40"
                >
                  {SIZES.map((s) => <option key={s.id} value={s.id}>{t(s.label)}</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-zinc-400">{t('步数')}</span>
                <input
                  type="number"
                  min={4}
                  max={60}
                  value={(data.steps as number) || 25}
                  onChange={(e) => updateNodeData(id, { steps: Math.max(4, Math.min(60, Number(e.target.value) || 25)) })}
                  onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
                  onBlur={() => window.dispatchEvent(new Event('inputBlurred'))}
                  className="w-full rounded border border-white/10 bg-black/30 px-1.5 py-1 text-zinc-200"
                />
              </label>
            </div>

            <label className="flex items-start gap-2 rounded-lg border border-white/10 bg-black/20 p-2">
              <input
                type="checkbox"
                checked={Boolean(data.anyAngle)}
                onChange={(e) => {
                  const on = e.target.checked;
                  const current = ((data.prompt as string) || '').trim();
                  updateNodeData(id, {
                    anyAngle: on,
                    ...(on && !current ? { prompt: ANY_ANGLE_PROMPT } : {}),
                  });
                }}
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="block font-medium text-zinc-200">{t('换机位（AnyAngle）')}</span>
                <span className="block text-[9px] leading-relaxed text-zinc-500">
                  {t('第 1 张接原图，第 2 张接新机位的粗图（高斯查看器截图或灰模渲染）。提示词用 Change the camera angle from <image2> to <image1>.，cfg 固定 3。')}
                </span>
                {data.anyAngle && refs.length !== 2 && (
                  <span className="block text-[9px] text-amber-300">{t('需要正好 2 张参考图，现在是 {n} 张', { n: refs.length })}</span>
                )}
              </span>
            </label>

            {/* References, in the order the model will number them */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-zinc-300">{t('参考图')}</span>
                <span className={refs.length ? 'text-emerald-300' : 'text-zinc-600'}>
                  {refs.length ? t('{n} 张，连线顺序就是编号', { n: refs.length }) : t('可选，连左侧接口，可接多个')}
                </span>
              </div>
              {refs.length > 0 && (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {refs.map((u, i) => (
                      <div key={`${u}-${i}`} className="relative">
                        <img src={abs(u)} alt="" className="h-12 w-12 rounded object-cover" />
                        <span className="absolute bottom-0 left-0 rounded-tr bg-black/70 px-1 font-mono text-[9px] text-zinc-200">{i + 1}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[9px] leading-relaxed text-zinc-500">
                    {t('提示词里用 <image 1>、<image 2> 指它们，并写清每张管哪些表面。画幅跟第 1 张，上面的画幅选择不生效。')}
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div data-node-media
        style={{ ...cardBody, flex: '0 0 auto', aspectRatio: String(sizing.ratio), display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', boxShadow: selected ? selectedShadow : defaultShadow }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {imageUrl ? (
          <div className="relative flex-1 min-h-0 overflow-hidden bg-black">
            <img
              src={imageUrl}
              alt={t('生成的图片')}
              draggable={false}
              onLoad={(e) => sizing.onMediaSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
              className="node-shell-media block h-full w-full bg-black object-contain"
            />
            <MediaTopBar visible={hovered}>
              <MediaIconButton title={t('放大查看')} onClick={() => setShowPreview(true)}>
                <MediaMaximizeIcon />
              </MediaIconButton>
              <MediaIconButton
                title={copied ? t('已复制') : t('复制图片')}
                onClick={() => void copyImageToClipboard(imageUrl)
                  .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
                  .catch((error) => void showAlert(error.message))}
              >
                {copied ? <MediaCheckIcon /> : <MediaCopyIcon />}
              </MediaIconButton>
              <MediaIconButton
                title={t('下载图片')}
                onClick={() => void downloadFile(imageUrl, 'qwen-image.png', data.alias as string | undefined)
                  .catch((error) => void showAlert(error.message))}
              >
                <MediaDownloadIcon />
              </MediaIconButton>
            </MediaTopBar>
          </div>
        ) : (
          <MediaEmptyState
            icon={<ImageIcon size={16} />}
            title={refs.length ? t('照着参考图改') : t('文生图')}
            hint={t('不接参考图就是文生图；接上参考图就是照着它改，最多十张。')}
            className="pb-[110px]"
          />
        )}

        <GeneratingLine active={busy} jobId={data.jobId} statusText={t('正在生成图片')} onCancel={cancel} />
        <NodeErrorBanner error={data.status === 'error' ? data.error : null} onClear={() => updateNodeData(id, { status: 'idle', error: undefined })} />

        <MediaBottomBar column visible={hovered || !imageUrl}>
          <textarea
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => { updateNodeData(id, { prompt }); window.dispatchEvent(new Event('inputBlurred')); }}
            onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
            placeholder={t('要画成什么样。改图时点名改哪一件、哪个部位，其余的逐个说清不动；原有造型要正面描述，不能只说“保持原样”。')}
            className="nowheel w-full resize-none rounded-lg border border-white/10 bg-black/50 px-2 py-1.5 text-[10px] leading-relaxed text-zinc-200 outline-none backdrop-blur-md focus:border-white/25"
          />
          <div className="flex items-center gap-2">
            <SeedControl compact seed={data.seed} seedMode={data.seedMode} onChange={(seed, seedMode) => updateNodeData(id, { seed, seedMode })} />
            <NodeActionButton accent="violet" grow onClick={() => void run()} disabled={!ready || busy || !comfyuiOnline}>
              {!ready ? t('先写提示词') : data.generatedUrl ? t('重新生成') : refs.length ? t('照着参考图改') : t('生成图片')}
            </NodeActionButton>
          </div>
        </MediaBottomBar>
      </div>

      <IconHandle type="target" id="in-ref" portType="image" nodeId={id} title={t('参考图（可多个，连线顺序就是 <image N>）')} />
      <IconHandle type="source" id="out-image" portType="image" nodeId={id} title={t('生成的图片')} />

      {showPreview && imageUrl && createPortal((
        <div
          className="nodrag fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 p-6 backdrop-blur-md"
          onClick={() => setShowPreview(false)}
        >
          <div className="relative flex max-h-[92vh] max-w-[92vw] items-center justify-center" onClick={(e) => e.stopPropagation()}>
            <img src={imageUrl} alt={t('生成的图片')} className="block h-auto max-h-[92vh] w-auto max-w-[92vw] object-contain" />
            <button
              type="button"
              onClick={() => setShowPreview(false)}
              className="absolute right-3 top-3 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm hover:bg-black/80"
              title={t('关闭')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>
      ), document.body)}
    </NodeShell>
  );
}

function ImageIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}


export default memo(QwenImageNode, areNodePropsEqual);
