'use client';

import { memo, useCallback, useRef, useState } from 'react';
import { NodeProps, useReactFlow } from '@xyflow/react';

import IconHandle from './IconHandle';
import NodeShell from './NodeShell';
import GeneratingLine from './GeneratingLine';
import NodeErrorBanner from './NodeErrorBanner';
import { NodeActionButton } from './nodeChrome';
import {
  MediaBottomBar,
  MediaDownloadIcon,
  MediaEmptyState,
  MediaIconButton,
  MediaMetaChip,
  MediaTopBar,
} from './mediaChrome';
import { showAlert } from '@/components/ui/Dialog';
import { cardBody, defaultShadow, header, label, selectedShadow } from './PromptNode';
import { useConnectedInputs } from '@/hooks/useConnectedInputs';
import { useAutoHeightNode } from '@/hooks/useAutoHeightNode';
import { useSyncedText } from '@/hooks/useSyncedText';
import { api } from '@/lib/api';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { t } from '@/lib/i18n';
import { TitleBlockNode as TitleBlockNodeType } from '@/lib/types';
import { areNodePropsEqual, downloadFile } from '@/lib/utils';

const abs = (u: string) => (u.startsWith('http') || u.startsWith('data:') ? u : `${API_BASE}${u}`);

/** A number field that commits on blur, so typing "800" does not rebuild at "8" and "80". */
function NumberField({ title, value, min, onCommit }: { title: string; value: number; min: number; onCommit: (v: number) => void }) {
  const [text, setText] = useSyncedText(String(value));
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n) && n >= min) onCommit(n);
    else setText(String(value));
  };
  return (
    <label className="block space-y-1">
      <span className="text-zinc-400">{title}</span>
      <input
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="nodrag w-full rounded border border-white/10 bg-black/30 px-1.5 py-1 text-zinc-200 outline-none focus:border-white/25"
      />
    </label>
  );
}

/**
 * Title block: a transparent image as tall as the cover, the logo at the top and one line of real text at
 * the bottom, inset by the same margin on every side (tools/title_block.py `build`). Typed text and fixed
 * margins mean the line can change without the layout drifting; set the result on a clean cover plate.
 */
function TitleBlockNode({ id, data, selected }: NodeProps<TitleBlockNodeType>) {
  const { updateNodeData } = useReactFlow();
  const connected = useConnectedInputs(id);
  const [hovered, setHovered] = useState(false);
  const runRef = useRef(0);

  const logoUrl = connected
    .filter((n) => n.targetHandle === 'in-image')
    .map((n) => (n.generatedUrl || n.url) as string | undefined)
    .find((u): u is string => Boolean(u));

  const plateUrl = connected
    .filter((n) => n.targetHandle === 'in-plate')
    .map((n) => (n.generatedUrl || n.url) as string | undefined)
    .find((u): u is string => Boolean(u));
  const side = data.side === 'right' ? 'right' : 'left';

  const [line, setLine] = useSyncedText((data.line as string) || '');
  const blockHeight = (data.blockHeight as number) || 1536;
  const margin = (data.margin as number) ?? 104;
  const contentWidth = (data.contentWidth as number) || 600;
  const lineWidth = (data.lineWidth as number) || 0;
  const lineHeightScale = (data.lineHeightScale as number) || 1.5;

  const busy = data.status === 'generating';
  const ready = Boolean(logoUrl);

  const run = useCallback(async () => {
    if (!logoUrl || busy) return;
    const ticket = ++runRef.current;
    updateNodeData(id, { status: 'generating', error: undefined, line });
    try {
      const result = await api.buildTitleBlock({
        logo_url: abs(logoUrl),
        line,
        height: blockHeight,
        margin,
        content_width: contentWidth,
        line_width: lineWidth,
        line_height_scale: lineHeightScale,
        ...(plateUrl ? { plate_url: abs(plateUrl), side } : {}),
      });
      if (ticket !== runRef.current) return;
      updateNodeData(id, { status: 'done', generatedUrl: result.url, width: result.width, height: result.height });
    } catch (error: any) {
      if (ticket !== runRef.current) return;
      updateNodeData(id, { status: 'error', error: error?.message || t('生成失败') });
    }
  }, [logoUrl, plateUrl, side, busy, line, blockHeight, margin, contentWidth, lineWidth, lineHeightScale, id, updateNodeData]);

  const sizing = useAutoHeightNode({
    id,
    ratioSources: [{ width: data.width as number | undefined, height: data.height as number | undefined }],
    hasMedia: Boolean(data.generatedUrl),
    mediaHidden: false,
    userWidth: data.userWidth,
    defaultW: 320,
  });

  const imageUrl = data.generatedUrl ? abs(data.generatedUrl as string) : null;

  return (
    <NodeShell nodeId={id} spec={sizing.spec} selected={selected} onResizeEnd={sizing.onResizeEnd} autoHeight>
      <div className="node-shell-headwrap" style={{ position: 'relative', flex: '0 0 auto' }}>
        <div style={header} data-chrome-row="header" className="node-shell-header flex items-center justify-between">
          <div className="flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.05] px-2 py-0.5 text-zinc-300">
            <span style={label} className="text-zinc-200" data-chrome="label">{t('标题块')}</span>
          </div>
          <MediaMetaChip title={t('标题块的尺寸')}>
            {data.width && data.height ? `${data.width}×${data.height}` : `${blockHeight}px`}
          </MediaMetaChip>
        </div>

        <div data-chrome-row="settings" className="nodrag nowheel space-y-2 p-3 text-[10px]">
          <label className="block space-y-1">
            <span className="text-zinc-400">{t('小字（真实文字，中英混排按墨迹居中）')}</span>
            <input
              value={line}
              onChange={(e) => setLine(e.target.value)}
              onBlur={() => { updateNodeData(id, { line }); window.dispatchEvent(new Event('inputBlurred')); }}
              onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
              placeholder="FILM 1【中字】"
              className="w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-white/25"
            />
          </label>
          <div className="space-y-1">
            <span className="text-zinc-400">{plateUrl ? t('贴在底图的哪一侧') : t('贴在底图的哪一侧（接上底图后生效）')}</span>
            <div className="grid grid-cols-2 gap-1.5">
              {(['left', 'right'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => updateNodeData(id, { side: value })}
                  className={`nodrag cursor-pointer rounded-lg border px-1 py-1 text-[10px] transition-colors ${side === value
                      ? 'border-white/40 bg-white/20 font-semibold text-white'
                      : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:bg-white/[0.08] hover:text-white'}`}
                >
                  {value === 'left' ? t('左侧') : t('右侧')}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumberField title={t('字标宽度')} value={contentWidth} min={16} onCommit={(v) => updateNodeData(id, { contentWidth: v })} />
            <NumberField title={t('小字宽度（0=同字标，越宽越大）')} value={lineWidth} min={0} onCommit={(v) => updateNodeData(id, { lineWidth: v })} />
            <NumberField title={t('小字纵向拉伸')} value={lineHeightScale} min={0.5} onCommit={(v) => updateNodeData(id, { lineHeightScale: v })} />
            <NumberField title={t('边距')} value={margin} min={0} onCommit={(v) => updateNodeData(id, { margin: v })} />
            <NumberField title={t('高度（同封面）')} value={blockHeight} min={256} onCommit={(v) => updateNodeData(id, { blockHeight: v })} />
          </div>
        </div>
      </div>

      <div
        data-node-media
        style={{ ...cardBody, flex: '0 0 auto', aspectRatio: String(sizing.ratio), display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', boxShadow: selected ? selectedShadow : defaultShadow }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {imageUrl ? (
          <div className="relative min-h-0 flex-1 overflow-hidden bg-[repeating-conic-gradient(#222_0%_25%,#2c2c2c_0%_50%)] bg-[length:16px_16px]">
            <img
              src={imageUrl}
              alt={t('标题块')}
              draggable={false}
              onLoad={(e) => sizing.onMediaSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
              className="node-shell-media block h-full w-full object-contain"
            />
            <MediaTopBar visible={hovered}>
              <MediaIconButton
                title={t('下载图片')}
                onClick={() => void downloadFile(imageUrl, 'title_block.png', data.alias as string | undefined)
                  .catch((error) => void showAlert(error.message))}
              >
                <MediaDownloadIcon />
              </MediaIconButton>
            </MediaTopBar>
          </div>
        ) : (
          <MediaEmptyState title={t('标题块')} hint={t('左侧接字标素材（和可选的底图），写一行小字，点生成。')} className="pb-[70px]" />
        )}

        <GeneratingLine active={busy} statusText={t('正在生成标题块')} onCancel={() => { runRef.current++; updateNodeData(id, { status: 'idle' }); }} />
        <NodeErrorBanner error={data.status === 'error' ? data.error : null} onClear={() => updateNodeData(id, { status: 'idle', error: undefined })} />

        <MediaBottomBar visible={hovered || !imageUrl}>
          <NodeActionButton accent="sky" grow onClick={() => void run()} disabled={!ready || busy}>
            {!ready ? t('先接字标素材') : data.generatedUrl ? t('重新生成') : t('生成')}
          </NodeActionButton>
        </MediaBottomBar>
      </div>

      <IconHandle type="target" id="in-image" portType="image" nodeId={id} title={t('字标素材')} />
      <IconHandle type="target" id="in-plate" portType="image" nodeId={id} title={t('底图（可选）')} />
      <IconHandle type="source" id="out-image" portType="image" nodeId={id} title={plateUrl ? t('贴好的封面') : t('标题块')} />
    </NodeShell>
  );
}

export default memo(TitleBlockNode, areNodePropsEqual);
