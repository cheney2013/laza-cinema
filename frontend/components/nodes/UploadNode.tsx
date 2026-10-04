'use client';

import { memo, useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { NodeProps, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import { useDropzone } from 'react-dropzone';
import IconHandle from './IconHandle';
import { cardBody, header, label, defaultShadow, selectedShadow } from './PromptNode';
import NodeShell from './NodeShell';
import AudioPlayer from './AudioPlayer';
import VideoAssetPlayer from './VideoAssetPlayer';
import VideoPreviewModal from './VideoPreviewModal';
import { useAutoHeightNode } from '@/hooks/useAutoHeightNode';
import { AUDIO_CONTENT_H } from '@/lib/nodeSizing';
import { UploadNode as UploadNodeType } from '@/lib/types';
import { api } from '@/lib/api';
import { BACKEND_URL } from '@/lib/config';
import { useVersionedSrc } from '@/lib/assetVersions';
import { showAlert, showPrompt } from '@/components/ui/Dialog';
import {
  MediaEmptyState,
  MediaMetaChip,
  NATIVE_VIDEO_CHROME_OFF,
  MediaCheckIcon,
  MediaCloseIcon,
  MediaCopyIcon,
  MediaDownloadIcon,
  MediaIconButton,
  MediaMaximizeIcon,
  MediaSpinnerIcon,
  MediaTopBar,
  MediaUploadIcon,
} from './mediaChrome';
import { t } from '@/lib/i18n';
import { copyImageToClipboard, downloadFile } from '@/lib/utils';

const API_BASE = BACKEND_URL;

/**
 * 换掉或清空素材时，必须一起丢掉的东西。
 *
 * 恢复回来的生成上下文（参考图、潜空间）描述的是**某一个具体文件**。留在原地
 * 就会挂到新素材头上，而下游超分会照单全收 —— 拿另一条镜头的参考图去做纹理，
 * 出来的细节没人能解释。
 */
const CLEARED_PROVENANCE = {
  submittedResources: undefined,
  latentFilename: undefined,
  prompt: undefined,
  seed: undefined,
  length: undefined,
  // A different file is no longer the bible entry; the next entry update must not overwrite it.
  bibleId: undefined,
} as const;

function resolveUrl(url: string) {
  return url.startsWith('http') || url.startsWith('blob:') || url.startsWith('data:')
    ? url
    : `${API_BASE}${url}`;
}

/**
 * The tab over a node linked to the production bible. It grows as the canvas
 * zooms out, so bible references stay findable in an overview of the scene.
 */
function BibleTab() {
  return (
    <div
      className="node-bible-tab pointer-events-none select-none"
      title={t('资料库条目：在资料库更新版本时，这个节点会一起换')}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" />
        <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
      </svg>
      {t('资料库')}
    </div>
  );
}

function UploadNode({ id, data, selected }: NodeProps<UploadNodeType>) {
  const { updateNodeData, getNodes, setNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  // 画面区自己的悬停态：顶栏/中央钮的出现时机要和视频播放器一致（媒体矩形内），
  // 而别名徽标跟的是整个节点的悬停
  const [mediaHovered, setMediaHovered] = useState(false);

  const mediaType = (data.mediaType as 'image' | 'video' | 'audio' | undefined) ?? 'image';
  // Sound has nothing to look at: an audio clip is a strip (header + one player
  // row), not a media card sized by an aspect ratio.
  const isAudio = mediaType === 'audio' && Boolean(data.url);
  // Only the width is kept; a picture or video sits in a box with its own ratio, an audio strip has a fixed height
  // (hooks/useAutoHeightNode).
  const sizing = useAutoHeightNode({
    id,
    ratioSources: [{ width: data.width, height: data.height }],
    hasMedia: Boolean(data.url) && !isAudio,
    userWidth: data.userWidth,
    defaultW: 280,
  });
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const audioToggleRef = useRef<(() => void) | null>(null);
  // Label first: the alias already shows in the tag above the node.
  const audioName = String(data.label || data.alias || t('音频素材'));
  // Labels read "kind · detail"; zoomed out only the detail fits, and the kind is
  // the same on every strip in a column, so the part after the first " · " is shown.
  const audioShortName = audioName.includes(' · ') ? audioName.slice(audioName.indexOf(' · ') + 3) : audioName;
  const [audioPlaying, setAudioPlaying] = useState(false);

  const portType = mediaType;
  const currentShadow = selected ? selectedShadow : defaultShadow;

  const handleSetAlias = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const currentAlias = (data.alias as string) || '';
    const input = await showPrompt(t('设置素材全局唯一别名（如：主角、林夕、咖啡馆）'), {
      title: '设置别名',
      defaultValue: currentAlias,
      placeholder: '留空可清除别名',
    });
    if (input === null) return;
    const trimmed = input.trim();
    if (!trimmed) {
      updateNodeData(id, { alias: undefined });
      window.dispatchEvent(new Event('takeSnapshot'));
      return;
    }
    // Global uniqueness validation across all nodes
    const allNodes = getNodes();
    const duplicate = allNodes.find(
      (n) => n.id !== id && (n.data?.alias as string | undefined)?.trim().toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate) {
      void showAlert(t('别名「{v1}」已被其他节点占用！\n别名必须全局唯一，以便下游节点精准引用。', { v1: trimmed }), { title: t('别名冲突'), danger: true });
      return;
    }
    updateNodeData(id, { alias: trimmed });
    window.dispatchEvent(new Event('takeSnapshot'));
  }, [id, data.alias, getNodes, updateNodeData]);

  const handleMediaLoaded = useCallback((w: number, h: number) => {
    if (!w || !h) return;
    sizing.onMediaSize(w, h);
    if (data.width !== w || data.height !== h) {
      updateNodeData(id, { width: w, height: h });
    }
    // 尺寸变了 handle 的位置也要重算，否则连线端点会留在旧坐标
    requestAnimationFrame(() => updateNodeInternals(id));
  }, [data.width, data.height, id, updateNodeData, updateNodeInternals, sizing.onMediaSize]);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;
    setUploading(true);
    setErrorMsg(null);
    try {
      const extension = file.name.split('.').pop()?.toLowerCase();
      if (file.type.startsWith('audio/') || extension === 'm4a') {
        const result = await api.uploadVideoFile(file);
        updateNodeData(id, {
          ...CLEARED_PROVENANCE,
          url: result.url,
          mediaType: 'audio',
          width: undefined,
          height: undefined,
          fps: undefined,
          duration: result.duration || undefined,
        });
      } else if (file.type.startsWith('video/')) {
        const result = await api.uploadVideoFile(file);
        updateNodeData(id, { 
          ...CLEARED_PROVENANCE,
          url: result.url, 
          mediaType: 'video', 
          width: result.width || undefined, 
          height: result.height || undefined,
          fps: result.fps || undefined,
          duration: result.duration || undefined
        });
      } else {
        const dimensions = await new Promise<{ width: number; height: number }>((resolve) => {
          const img = new Image();
          img.src = URL.createObjectURL(file);
          img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(img.src); };
          img.onerror = () => resolve({ width: 0, height: 0 });
        });
        const { url } = await api.uploadStyleReference(file);
        updateNodeData(id, { 
          ...CLEARED_PROVENANCE,
          url, 
          mediaType: 'image',
          width: dimensions.width || undefined,
          height: dimensions.height || undefined,
          // 视频换成图片时，旧素材的时长/帧率必须一起走，否则标题栏会挂着上一个素材的元数据
          duration: undefined,
          fps: undefined
        });
      }
      window.dispatchEvent(new Event('takeSnapshot'));
    } catch (e: any) {
      setErrorMsg(e.message || t('上传素材失败'));
    } finally {
      setUploading(false);
    }
  }, [id, updateNodeData]);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: { 
      'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.bmp'], 
      'video/*': ['.mp4', '.mov', '.webm', '.mkv'],
      'audio/*': ['.m4a'],
    },
    multiple: false,
    disabled: uploading,
    noClick: !!data.url,
  });

  useEffect(() => {
    if (data.url && mediaType === 'image' && (!data.width || !data.height)) {
      const img = new Image();
      img.src = resolveUrl(data.url as string);
      img.onload = () => {
        if (img.naturalWidth && img.naturalHeight) {
          updateNodeData(id, { width: img.naturalWidth, height: img.naturalHeight });
        }
      };
    }
  }, [data.url, data.width, data.height, mediaType, id, updateNodeData]);

  // Uploading a portrait/landscape asset changes the node box after React Flow
  // has measured its handles. Re-measure once the resized DOM has committed so
  // edges terminate at the visible socket instead of its stale coordinates.
  useEffect(() => {
    const frame = requestAnimationFrame(() => updateNodeInternals(id));
    return () => cancelAnimationFrame(frame);
  }, [id, data.url, data.width, data.height, mediaType, updateNodeInternals]);

  const handleClear = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    updateNodeData(id, { ...CLEARED_PROVENANCE, url: null, mediaType: undefined, width: undefined, height: undefined, duration: undefined, fps: undefined });
    window.dispatchEvent(new Event('takeSnapshot'));
  }, [id, updateNodeData]);

  const hasFile = !!data.url;
  // 素材库把旧素材放回画布时，会从文件自身的元数据里恢复生成上下文。
  const provenance = useMemo(() => {
    const submitted = data.submittedResources as
      | { reference_images?: unknown[] }
      | undefined;
    const refs = submitted?.reference_images?.length ?? 0;
    const parts = [refs > 0 ? `${refs} 张参考图` : '', data.latentFilename ? '潜空间' : ''].filter(Boolean);
    return parts.length > 0 ? parts.join('、') : '';
  }, [data.submittedResources, data.latentFilename]);
  // Subscribes to in-place overwrites (cut room 覆盖原素材): the url string stays
  // the same, so without the version the <img> never asks the server again.
  const resolvedUrl = useVersionedSrc(data.url ? resolveUrl(data.url as string) : '');
  const [imageCopied, setImageCopied] = useState(false);

  return (
    <NodeShell
      nodeId={id}
      spec={sizing.spec}
      selected={selected}
      onResizeEnd={sizing.onResizeEnd}
      autoHeight
      className={data.bibleId ? 'node-bible' : undefined}
    >
      {Boolean(data.bibleId) && <BibleTab />}
      {isAudio && (
        /* Outline mode (zoomed out): the plate hides the player, so an audio strip
           shows a play button the height of the node and its name instead. Hidden
           at normal zoom by CSS; see .lod-audio in globals.css. */
        <div className="lod-audio">
          <button
            type="button"
            className="lod-audio-play nodrag"
            title={audioPlaying ? t('暂停') : t('播放')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); audioToggleRef.current?.(); }}
          >
            <svg viewBox="0 0 11 11" fill="currentColor" width="42%" height="42%">
              {audioPlaying
                ? (<><rect x="2" y="1.5" width="2.8" height="8" rx="1" /><rect x="6.2" y="1.5" width="2.8" height="8" rx="1" /></>)
                : <path d="M2.5 1.5l7 4-7 4V1.5z" />}
            </svg>
          </button>
          <span className="lod-audio-name" title={audioName}>{audioShortName}</span>
        </div>
      )}
      {/* ── Node Header with Category / Alias Badge ─────────────── */}
      <div style={header} data-chrome-row="header" className="upload-node-header node-shell-header flex items-center justify-between gap-1">
        <div className="upload-node-title flex items-center gap-1.5 min-w-0 overflow-hidden">
          {/* The alias shows above the node (NodeShell's tag). */}
            <button
              type="button"
              onClick={handleSetAlias}
              className="nodrag group flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] hover:border-white/20 text-zinc-300 transition-colors flex-shrink-0 cursor-pointer"
              title={t('点击设置全局唯一别名（供其他节点引用）')}
            >
              {hasFile ? (mediaType === 'video' ? <VideoIcon /> : mediaType === 'audio' ? <AudioIcon /> : <ImageIcon />) : <UploadIcon />}
              <span style={label} className={isAudio ? 'hidden' : 'text-zinc-200'} data-chrome="label">
                {hasFile
                  ? (mediaType === 'video' ? t('视频素材') : mediaType === 'audio' ? t('音频素材') : t('图片素材'))
                  : t('上传素材')}
              </span>
              <span className={isAudio ? 'hidden' : 'text-[10px] text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity ml-0.5'}>
                
                {t('+别名')}
              </span>
            </button>
          {isAudio ? (
            // A strip's title is the clip itself (who, which line), not the kind of node.
            <span className="text-[12px] font-medium text-zinc-200 truncate tracking-tight select-none" title={audioName}>
              {audioShortName}
            </span>
          ) : data.label && (
            <span className="text-[11px] font-medium text-zinc-400 truncate tracking-tight select-none" title={String(data.label)}>
              {String(data.label)}
            </span>
          )}
        </div>

        {hasFile && (
          <span className="upload-node-meta flex items-center gap-1 flex-shrink-0">
            {/*
              * 这个素材带着它当初的生成上下文（参考图、潜空间）。下游超分会读这些
              * 参考图取纹理，有没有会直接改变细节，所以必须看得见 —— 否则用户
              * 无从判断这次超分和当初那一版是不是同一个条件。
              */}
            {provenance && (
              <span
                className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-[1px] text-[9px] text-emerald-300 font-medium"
                title={t('带回了这个素材当初的生成信息：{v1}\n超分时会用同一批参考图，细节与原版一致', { v1: provenance })}
              >
                
                {t('生成信息')}
              </span>
            )}
            <MediaMetaChip>
              {data.width && data.height ? `${data.width}×${data.height}` : ''}
              {mediaType === 'video' && data.duration ? ` · ${data.duration.toFixed(1)}s` : ''}
              {mediaType === 'video' && data.fps ? ` · ${Math.round(data.fps)}fps` : ''}
              {mediaType === 'audio' && data.duration ? `${data.duration.toFixed(1)}s` : ''}
            </MediaMetaChip>
          </span>
        )}
      </div>

      <div
        style={{ position: 'relative', flex: '0 0 auto', ...(isAudio ? { height: AUDIO_CONTENT_H } : { aspectRatio: String(sizing.ratio) }) }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >

        <div 
          style={{ ...cardBody, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: currentShadow }}
        >
          {hasFile ? (
            /*
             * 有素材时整块画面就是拖放区（noClick 已开，点击不会误弹文件框），
             * 于是"换素材"既能点顶栏按钮，也能把文件直接甩到节点上。
             */
            <div
              {...getRootProps({
                className: `relative group overflow-hidden flex-1 flex flex-col rounded-2xl ${isAudio ? '' : 'bg-black/40'}`,
              })}
            >
              <input {...getInputProps()} />

              {mediaType === 'audio' ? (
                <div className="audio-strip relative flex-1 flex items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.035] px-2.5">
                  <AudioPlayer
                    src={resolvedUrl}
                    paused={showPreviewModal}
                    toggleRef={audioToggleRef}
                    // the hover buttons sit over the right end of the strip; make room so they don't cover the time readout
                    className={isHovered ? 'pr-[76px]' : undefined}
                    knownDuration={typeof data.duration === 'number' ? data.duration : undefined}
                    onPlayingChange={setAudioPlaying}
                    onDuration={(duration) => {
                      if (data.duration !== duration) updateNodeData(id, { duration });
                    }}
                  />
                  <MediaTopBar visible={isHovered}>
                    <MediaIconButton title={t('替换音频')} onClick={() => open()}>
                      {uploading ? <MediaSpinnerIcon /> : <MediaUploadIcon />}
                    </MediaIconButton>
                    <MediaIconButton title={t('移除音频')} danger onClick={handleClear}>
                      <MediaCloseIcon />
                    </MediaIconButton>
                  </MediaTopBar>
                </div>
              ) : mediaType === 'video' ? (
                <VideoAssetPlayer
                  nodeId={id}
                  src={resolvedUrl}
                  fps={data.fps as number | undefined}
                  uploading={uploading}
                  paused={showPreviewModal}
                  onMediaSize={handleMediaLoaded}
                  needsMetadata={!data.duration}
                  onDuration={(d) => {
                    if (!data.duration && d) updateNodeData(id, { duration: d });
                  }}
                  onReplace={open}
                  onRemove={handleClear}
                  onExpand={() => setShowPreviewModal(true)}
                />
              ) : (
                /*
                 * 图片与视频共用同一套画面外框：object-contain 不裁切素材，
                 * 悬停时右上浮出同一条顶栏（替换 / 放大 / 移除）。原先图片是整块
                 * 毛玻璃盖住画面 + 圆钮 + 角标，和视频完全两种语言。
                 */
                <div
                  className="relative flex-1 min-h-0 overflow-hidden rounded-2xl bg-black"
                  onMouseEnter={() => setMediaHovered(true)}
                  onMouseLeave={() => setMediaHovered(false)}
                >
                  <img
                    src={resolvedUrl}
                    alt="Uploaded"
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      handleMediaLoaded(img.naturalWidth, img.naturalHeight);
                    }}
                    className="node-shell-media w-full h-full object-contain bg-black block"
                  />

                  <MediaTopBar visible={mediaHovered}>
                    <MediaIconButton title={t('替换素材（也可直接把文件拖到节点上）')} onClick={() => open()}>
                      {uploading ? <MediaSpinnerIcon /> : <MediaUploadIcon />}
                    </MediaIconButton>
                    <MediaIconButton title={t('放大查看')} onClick={() => setShowPreviewModal(true)}>
                      <MediaMaximizeIcon />
                    </MediaIconButton>
                    <MediaIconButton
                      title={imageCopied ? t('已复制') : t('复制图片')}
                      onClick={() => void copyImageToClipboard(resolvedUrl)
                        .then(() => { setImageCopied(true); setTimeout(() => setImageCopied(false), 1500); })
                        .catch((error) => void showAlert(error.message))}
                    >
                      {imageCopied ? <MediaCheckIcon /> : <MediaCopyIcon />}
                    </MediaIconButton>
                    <MediaIconButton
                      title={t('下载图片')}
                      onClick={() => void downloadFile(resolvedUrl, 'image.png', data.alias as string | undefined)
                        .catch((error) => void showAlert(error.message))}
                    >
                      <MediaDownloadIcon />
                    </MediaIconButton>
                    <MediaIconButton title={t('移除素材')} danger onClick={handleClear}>
                      <MediaCloseIcon />
                    </MediaIconButton>
                  </MediaTopBar>
                </div>
              )}

              {/* 拖放中的落点提示 —— 视频形态下播放控制条占着悬停层，需要独立反馈 */}
              {isDragActive && (
                <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-1.5 bg-black/75 backdrop-blur-xs border-2 border-dashed border-white/60 rounded-2xl pointer-events-none">
                  <div className="w-9 h-9 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-white">
                    <UploadIcon />
                  </div>
                  <span className="text-[11px] text-white font-medium">{t('释放即可替换素材')}</span>
                </div>
              )}

              {uploading && (
                <div className="absolute inset-x-0 top-0 z-30 h-0.5 bg-white/70 animate-pulse pointer-events-none" />
              )}
            </div>
          ) : (
            <MediaEmptyState
              rootProps={getRootProps()}
              className="cursor-pointer hover:border-white/35 hover:bg-white/[0.04]"
              active={isDragActive}
              icon={<UploadIcon />}
              title={uploading ? t('正在解析上传…') : isDragActive ? t('释放即可载入素材') : t('点击或拖拽上传图片/视频')}
            >
              <input {...getInputProps()} />
              <div className="text-[9px] text-zinc-500 font-mono">PNG · JPG · WEBP · MP4 · MOV · M4A</div>
            </MediaEmptyState>
          )}

          {/* Inline Error Toast */}
          {errorMsg && (
            <div className="absolute top-2 left-2 right-2 z-40 px-2.5 py-1.5 text-[11px] text-rose-200 bg-rose-950/95 border border-rose-500/40 rounded-xl shadow-2xl flex items-center justify-between gap-2 backdrop-blur-md animate-in fade-in zoom-in-95 duration-150">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-rose-400 font-bold">✕</span>
                <span className="truncate">{errorMsg}</span>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setErrorMsg(null); }}
                className="text-rose-400 hover:text-white text-xs px-1 cursor-pointer"
              >
                ✕
              </button>
            </div>
          )}
        </div>

        <IconHandle type="source" portType={portType} nodeId={id} />
      </div>

      {/* Media Preview Modal. Video uses the studio's one player (D/F frame
          stepping, space, capture), the same as every generated clip. */}
      {showPreviewModal && resolvedUrl && mediaType === 'video' && (
        <VideoPreviewModal
          beforeUrl={null}
          afterUrl={resolvedUrl}
          fps={data.fps as number | undefined}
          onClose={() => setShowPreviewModal(false)}
        />
      )}
      {showPreviewModal && resolvedUrl && mediaType !== 'video' && createPortal((
        <div
          className="nodrag fixed inset-0 z-[9999] bg-black/85 backdrop-blur-md flex items-center justify-center p-6"
          onClick={() => setShowPreviewModal(false)}
        >
          <div
            className="relative max-w-[92vw] max-h-[92vh] flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="hidden">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-white">
                  {mediaType === 'audio' ? t('音频素材') : t('图片素材大图预览')}
                </span>
                {data.width && data.height && (
                  <span className="text-[10px] font-mono text-zinc-400 bg-white/5 px-1.5 py-0.5 rounded border border-white/10">
                    {data.width} × {data.height}
                  </span>
                )}
              </div>
              <button
                onClick={() => setShowPreviewModal(false)}
                className="w-6 h-6 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-xs cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="flex items-center justify-center overflow-hidden">
              {mediaType === 'audio' ? (
                <AudioPlayer src={resolvedUrl} autoPlay className="w-[min(720px,80vw)]" />
              ) : (
                <img src={resolvedUrl} alt="Preview" className="block max-h-[92vh] max-w-[92vw] w-auto h-auto object-contain" />
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowPreviewModal(false)}
              className="absolute top-3 right-3 w-9 h-9 flex items-center justify-center rounded-full bg-black/60 hover:bg-black/80 text-white text-2xl leading-none cursor-pointer backdrop-blur-sm"
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

export default memo(UploadNode);

function UploadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="14" height="16" rx="2" />
      <path d="M16 8l6-3v14l-6-3V8z" />
    </svg>
  );
}

function AudioIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  );
}
