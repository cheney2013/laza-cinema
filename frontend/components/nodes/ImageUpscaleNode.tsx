'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GearIcon } from '@/components/ui/icons';
import { NodeProps, useReactFlow } from '@xyflow/react';

import IconHandle from './IconHandle';
import NodeShell from './NodeShell';
import GeneratingLine from './GeneratingLine';
import NodeErrorBanner from './NodeErrorBanner';
import { NodeActionButton, NodeHeaderIconButton } from './nodeChrome';
import {
  MediaBottomBar,
  MediaDownloadIcon,
  MediaEmptyState,
  MediaIconButton,
  MediaMaximizeIcon,
  MediaMetaChip,
  MediaTopBar,
} from './mediaChrome';
import { showAlert } from '@/components/ui/Dialog';
import { cardBody, defaultShadow, header, label, selectedShadow } from './PromptNode';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useJobResult } from '@/hooks/useJobPoller';
import { useAutoHeightNode } from '@/hooks/useAutoHeightNode';
import { useSyncedText } from '@/hooks/useSyncedText';
import { api } from '@/lib/api';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { t } from '@/lib/i18n';
import { useStore } from '@/lib/store';
import { ImageUpscaleNode as ImageUpscaleNodeType } from '@/lib/types';
import { areNodePropsEqual, downloadFile } from '@/lib/utils';

const abs = (u: string) => (u.startsWith('http') || u.startsWith('data:') ? u : `${API_BASE}${u}`);

/** The two weights installed under ComfyUI's upscale_models/. */
const MODELS = [
  { id: 'RealESRGAN_x2.pth', label: '写实 ×2', title: 'RealESRGAN_x2。照片和写实画面，放大两倍，不改内容。' },
  { id: 'realesr-animevideov3.pth', label: '动漫 ×4', title: 'realesr-animevideov3。动漫、线稿和平涂画面，放大四倍。' },
] as const;

const MODES = [
  { id: 'upscale', label: '只放大', title: 'RealESRGAN 放大，不重画，内容完全不变。' },
  { id: 'detail', label: '补细节', title: 'Qwen-Image 2.1 在原尺寸上重绘细节：皮肤纹理、发丝、布料、边缘。构图、人物、颜色、光线保持不变。' },
  { id: 'both', label: '放大+补细节', title: '先 RealESRGAN 放大，再让 Qwen 在放大后的尺寸上补细节。' },
] as const;

const EDGES = [
  { value: 0, label: '模型原生倍率' },
  { value: 2048, label: '长边 2048' },
  { value: 2752, label: '长边 2752' },
  { value: 3840, label: '长边 3840 (4K)' },
] as const;

/**
 * Image upscale: one still in, the same still larger and cleaner out.
 *
 * RealESRGAN is deterministic and does not repaint, so the picture keeps its content
 * and its look; that is the point of choosing it over a diffusion pass. The long-edge
 * choice resamples the model's fixed factor down to a delivery size.
 */
function ImageUpscaleNode({ id, data, selected }: NodeProps<ImageUpscaleNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  const comfyuiOnline = useStore((s) => s.comfyuiOnline);
  const cancelledRef = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const sourceUrl = connected
    .filter((n) => n.targetHandle === 'in-image')
    .map((n) => (n.generatedUrl || n.url) as string | undefined)
    .find((u): u is string => Boolean(u));

  const mode = (data.mode as 'upscale' | 'detail' | 'both') || 'upscale';
  const usesEsrgan = mode !== 'detail';
  const usesQwen = mode !== 'upscale';
  const [prompt, setPrompt] = useSyncedText((data.prompt as string) || '');
  const modelName = (data.modelName as string) || MODELS[0].id;
  const targetLongEdge = (data.targetLongEdge as number) || 0;

  const jobResult = useJobResult(data.jobId as string | undefined);
  useEffect(() => {
    if (!jobResult || cancelledRef.current) return;
    if (jobResult.status === 'done' && jobResult.url) {
      updateNodeData(id, { status: 'done', generatedUrl: jobResult.url as string, jobId: undefined });
    } else if (jobResult.status === 'error') {
      updateNodeData(id, { status: 'error', error: (jobResult.error as string) || t('放大失败'), jobId: undefined });
    } else if (jobResult.status === 'cancelled') {
      updateNodeData(id, { status: 'idle', error: undefined, jobId: undefined });
    }
  }, [jobResult, id, updateNodeData]);

  const busy = data.status === 'generating';
  const ready = Boolean(sourceUrl);

  const run = useCallback(async () => {
    if (!sourceUrl || busy) return;
    cancelledRef.current = false;
    updateNodeData(id, { status: 'generating', error: undefined });
    try {
      const { job_id } = await api.upscaleImage({
        image_url: abs(sourceUrl),
        mode,
        model_name: modelName,
        target_long_edge: targetLongEdge,
        ...(usesQwen && (data.prompt as string)?.trim() ? { prompt: data.prompt as string } : {}),
      });
      updateNodeData(id, { jobId: job_id });
    } catch (error: any) {
      updateNodeData(id, { status: 'error', error: error?.message || t('提交失败'), jobId: undefined });
    }
  }, [sourceUrl, busy, mode, modelName, targetLongEdge, usesQwen, data.prompt, id, updateNodeData]);

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

  return (
    <NodeShell nodeId={id} spec={sizing.spec} selected={selected} onResizeEnd={sizing.onResizeEnd} autoHeight>
      <div className="node-shell-headwrap" style={{ position: 'relative', flex: '0 0 auto' }}>
        <div style={header} data-chrome-row="header" className="node-shell-header flex items-center justify-between">
          <div className="flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.05] px-2 py-0.5 text-zinc-300">
            <UpscaleIcon />
            <span style={label} className="text-zinc-200" data-chrome="label">{t('图片超清')}</span>
          </div>
          <div className="flex items-center gap-1">
            <MediaMetaChip title={t('放大后的尺寸')}>
              {data.width && data.height ? `${data.width}×${data.height}` : t(MODES.find((m) => m.id === mode)?.label ?? '只放大')}
            </MediaMetaChip>
            <NodeHeaderIconButton active={showSettings} onClick={() => setShowSettings((v) => !v)} title={t('模型与目标尺寸')}>
              <GearIcon />
            </NodeHeaderIconButton>
          </div>
        </div>

        {showSettings && (
          <div data-chrome-row="settings" className="node-shell-drawer nodrag nowheel p-3 space-y-2.5 text-[10px] animate-in fade-in duration-150">
            <div className="space-y-1">
              <span className="text-zinc-400">{t('方式')}</span>
              <div className="grid grid-cols-3 gap-1.5">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    title={t(m.title)}
                    onClick={() => updateNodeData(id, { mode: m.id })}
                    className={`nodrag py-1 px-1 text-[10px] rounded-lg border transition-colors cursor-pointer ${mode === m.id
                        ? 'bg-white/20 border-white/40 text-white font-semibold shadow-xs'
                        : 'bg-white/[0.03] border-white/10 text-zinc-400 hover:text-white hover:bg-white/[0.08]'
                      }`}
                  >
                    {t(m.label)}
                  </button>
                ))}
              </div>
            </div>
            {usesEsrgan && (<>
            <div className="space-y-1">
              <span className="text-zinc-400">{t('模型')}</span>
              <div className="grid grid-cols-2 gap-1.5">
                {MODELS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    title={t(m.title)}
                    onClick={() => updateNodeData(id, { modelName: m.id })}
                    className={`nodrag py-1 px-1.5 text-[10px] rounded-lg border transition-colors cursor-pointer ${modelName === m.id
                        ? 'bg-white/20 border-white/40 text-white font-semibold shadow-xs'
                        : 'bg-white/[0.03] border-white/10 text-zinc-400 hover:text-white hover:bg-white/[0.08]'
                      }`}
                  >
                    {t(m.label)}
                  </button>
                ))}
              </div>
            </div>
            <label className="block space-y-1">
              <span className="text-zinc-400">{t('输出尺寸')}</span>
              <select
                value={targetLongEdge}
                onChange={(e) => updateNodeData(id, { targetLongEdge: Number(e.target.value) })}
                className="w-full rounded border border-white/10 bg-black/30 px-1.5 py-1 text-zinc-200"
              >
                {EDGES.map((e) => <option key={e.value} value={e.value}>{t(e.label)}</option>)}
              </select>
            </label>
            </>)}
            {usesQwen && (
              <label className="block space-y-1">
                <span className="text-zinc-400">{t('补细节提示词（留空用内置的）')}</span>
                <textarea
                  rows={3}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onBlur={() => { updateNodeData(id, { prompt }); window.dispatchEvent(new Event('inputBlurred')); }}
                  onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
                  placeholder={t('内置：保持构图、人物、颜色、光线不变，只恢复皮肤、发丝、布料、边缘的细节。自定义时用 <image 1> 指这张图。')}
                  className="w-full resize-none rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-200 outline-none focus:border-white/25"
                />
              </label>
            )}
            <p className="text-[9px] leading-relaxed text-zinc-500">
              {usesQwen
                ? t('补细节是 Qwen 重绘整张图，输出和输入一样大；皮肤、小物件的纹理可能和原图有出入，用之前对比一下。')
                : t('RealESRGAN 不重画：内容、构图和色调都不变，只是更大更清晰。长边选项把模型的固定倍率缩放到指定尺寸，保持比例。')}
            </p>
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
              alt={t('放大后的图片')}
              draggable={false}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                if (w !== data.width || h !== data.height) updateNodeData(id, { width: w, height: h });
                sizing.onMediaSize(w, h);
              }}
              className="node-shell-media block h-full w-full bg-black object-contain"
            />
            <MediaTopBar visible={hovered}>
              <MediaIconButton title={t('放大查看')} onClick={() => setShowPreview(true)}>
                <MediaMaximizeIcon />
              </MediaIconButton>
              <MediaIconButton
                title={t('下载图片')}
                onClick={() => void downloadFile(imageUrl, 'upscaled.png', data.alias as string | undefined)
                  .catch((error) => void showAlert(error.message))}
              >
                <MediaDownloadIcon />
              </MediaIconButton>
            </MediaTopBar>
          </div>
        ) : (
          <MediaEmptyState
            icon={<UpscaleIcon size={16} />}
            title={t('图片超清')}
            hint={t('左侧接一张图，点放大。')}
            className="pb-[70px]"
          />
        )}

        <GeneratingLine active={busy} jobId={data.jobId} statusText={t(mode === 'upscale' ? '正在放大图片' : '正在处理图片')} onCancel={cancel} />
        <NodeErrorBanner error={data.status === 'error' ? data.error : null} onClear={() => updateNodeData(id, { status: 'idle', error: undefined })} />

        <MediaBottomBar visible={hovered || !imageUrl}>
          <NodeActionButton accent="sky" grow onClick={() => void run()} disabled={!ready || busy || !comfyuiOnline}>
            {!ready ? t('先接一张图') : data.generatedUrl ? t('重新处理') : mode === 'detail' ? t('补细节') : t('放大')}
          </NodeActionButton>
        </MediaBottomBar>
      </div>

      <IconHandle type="target" id="in-image" portType="image" nodeId={id} title={t('要放大的图片')} />
      <IconHandle type="source" id="out-image" portType="image" nodeId={id} title={t('放大后的图片')} />

      {showPreview && imageUrl && createPortal((
        <div
          className="nodrag fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 p-6 backdrop-blur-md"
          onClick={() => setShowPreview(false)}
        >
          <div className="relative flex max-h-[92vh] max-w-[92vw] items-center justify-center" onClick={(e) => e.stopPropagation()}>
            <img src={imageUrl} alt={t('放大后的图片')} className="block h-auto max-h-[92vh] w-auto max-w-[92vw] object-contain" />
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

function UpscaleIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  );
}

export default memo(ImageUpscaleNode, areNodePropsEqual);
