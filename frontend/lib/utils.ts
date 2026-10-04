import { BACKEND_URL } from './config';
import { type DownloadProgress, nativeDownloadUrl, readResponse, writeResponse } from './download';

/**
 * Resizes an image file if its longest side exceeds maxDimension,
 * maintaining aspect ratio.
 */
export async function resizeImageIfNeeded(file: File, maxDimension: number = 512): Promise<File | Blob> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const { width, height } = img;
        if (width <= maxDimension && height <= maxDimension) {
          resolve(file);
          return;
        }

        let newWidth = width;
        let newHeight = height;

        if (width > height) {
          newWidth = maxDimension;
          newHeight = (height * maxDimension) / width;
        } else {
          newHeight = maxDimension;
          newWidth = (width * maxDimension) / height;
        }

        const canvas = document.createElement('canvas');
        canvas.width = newWidth;
        canvas.height = newHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(file);
          return;
        }

        ctx.drawImage(img, 0, 0, newWidth, newHeight);
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(new File([blob], file.name, { type: file.type }));
            } else {
              resolve(file);
            }
          },
          file.type,
          0.9
        );
      };
      img.onerror = () => resolve(file);
    };
    reader.onerror = () => resolve(file);
  });
}

/** Download a remote asset without navigating the current tab. */
/**
 * A download name built from a node's alias: characters Windows and macOS refuse
 * in file names become "_", and the file's own extension is kept.
 */
export function aliasFileName(alias: string | null | undefined, url: string): string | null {
  const base = String(alias ?? '').trim().replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/[. ]+$/, '');
  if (!base) return null;
  const ext = url.split('?')[0].match(/\.([A-Za-z0-9]{1,5})$/)?.[1];
  return ext && !base.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${base}.${ext}` : base;
}

/**
 * Download a file; `alias` (a node's alias), when set, names it instead of the server's file name.
 *
 * With `onProgress` the caller is showing a progress readout, which is for files big enough to need
 * one. Where the browser offers a save dialog (Chromium on https or localhost) it is asked first and
 * the file is streamed straight to disk as it arrives; anywhere else the pieces are collected into one
 * Blob, still with progress. Cancelling the dialog ends the download quietly. Without `onProgress` it
 * is the plain download it always was.
 */
export async function downloadFile(
  url: string,
  fallbackName: string,
  alias?: string | null,
  onProgress?: DownloadProgress,
): Promise<void> {
  const name = aliasFileName(alias, url) || decodeURIComponent(url.split('/').pop()?.split('?')[0] || fallbackName);

  // Asked before anything is awaited: the picker needs the click that started this to still count.
  let handle: { createWritable(): Promise<{ write(c: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> } | undefined;
  const picker = onProgress && typeof window !== 'undefined' && window.isSecureContext
    ? (window as unknown as { showSaveFilePicker?: (options: object) => Promise<typeof handle> }).showSaveFilePicker
    : undefined;
  if (picker) {
    try {
      handle = await picker.call(window, { suggestedName: name });
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return;
      handle = undefined;
    }
  }

  // No save dialog to stream into (iPhone, Android, Firefox): let the browser download it itself instead of
  // buffering it here. It shows its own progress, so there is nothing to report.
  const native = handle ? null : nativeDownloadUrl(url, name, BACKEND_URL);
  if (native) {
    const link = document.createElement('a');
    link.href = native;
    link.download = name;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);

  if (handle) {
    const file = await handle.createWritable();
    try {
      await writeResponse(response, file, onProgress);
    } catch (error) {
      await file.abort().catch(() => undefined);
      throw error;
    }
    return;
  }

  const blobUrl = URL.createObjectURL(onProgress ? await readResponse(response, onProgress) : await response.blob());
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

/**
 * Put an image on the clipboard, ready to paste into chat apps, editors or another canvas.
 * Browsers only accept image/png there, so anything else is redrawn as PNG first.
 * Needs a secure context (localhost or HTTPS): over plain-HTTP Tailscale the
 * browser offers no image clipboard at all, and the error says so.
 */
export async function copyImageToClipboard(url: string): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error(t('当前地址不支持复制图片（需要 localhost 或 HTTPS），请改用下载'));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Copy failed (${response.status})`);
  let blob = await response.blob();
  if (blob.type !== 'image/png') {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('PNG encode failed'))), 'image/png'));
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** Copy text on HTTPS, localhost, LAN HTTP, and older embedded browsers. */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (!text) throw new Error(t('没有可复制的内容'));

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Clipboard API is commonly denied on non-HTTPS LAN addresses. Fall
      // through to the synchronous selection-based implementation.
    }
  }

  if (typeof document === 'undefined') throw new Error(t('当前环境不支持复制'));
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error(t('浏览器拒绝了剪贴板访问，请手动选择文本复制'));
}

import { type NodeProps } from '@xyflow/react';
import { t } from './i18n';

export function areNodePropsEqual(prevProps: any, nextProps: any): boolean {
  // Quick reference checks for commonly changed fields
  if (
    prevProps.id !== nextProps.id ||
    prevProps.selected !== nextProps.selected ||
    prevProps.width !== nextProps.width ||
    prevProps.height !== nextProps.height
  ) {
    return false;
  }

  const prevData = prevProps.data || {};
  const nextData = nextProps.data || {};

  // Core status & lifecycle
  if (
    prevData.status !== nextData.status ||
    prevData.jobId !== nextData.jobId ||
    prevData.error !== nextData.error ||
    prevData.progress !== nextData.progress
  ) {
    return false;
  }

  // URLs & Media assets
  if (
    prevData.generatedUrl !== nextData.generatedUrl ||
    prevData.previewUrl !== nextData.previewUrl ||
    prevData.url !== nextData.url ||
    prevData.comfyFilename !== nextData.comfyFilename
  ) {
    return false;
  }

  // Text & Prompts
  if (
    prevData.text !== nextData.text ||
    prevData.prompt !== nextData.prompt ||
    prevData.userIntent !== nextData.userIntent ||
    prevData.label !== nextData.label
  ) {
    return false;
  }

  // Dimensions & Generation configs
  if (
    prevData.width !== nextData.width ||
    prevData.height !== nextData.height ||
    prevData.steps !== nextData.steps ||
    prevData.length !== nextData.length ||
    prevData.duration !== nextData.duration ||
    prevData.editMode !== nextData.editMode ||
    prevData.audioStrategy !== nextData.audioStrategy
  ) {
    return false;
  }


  // Reference-image mode changes affect controls and generation inputs.
  if (
    prevData.useFirstFrame !== nextData.useFirstFrame ||
    prevData.firstFrameNodeId !== nextData.firstFrameNodeId ||
    prevData.refImageOrder !== nextData.refImageOrder
  ) {
    return false;
  }

  // Catch-all shallow compare over every remaining data key.
  //
  // The checks above are a fast path for the fields that change most often. They
  // are NOT the full set: a field that is written but never compared here makes
  // the node skip its re-render entirely, so the store and the autosave update
  // while the UI silently keeps showing the old value. That is what happened to
  // `method`/`repair` on the upscale node -- clicking an algorithm did nothing
  // visible until some *other* field happened to change and dragged a render
  // along with it. 25 fields were in that state (scaleBy, denoiseStrength, seed,
  // alias, plyUrl, poseImageUrl, cfg, ...), so enumerate instead of listing.
  const keys = new Set([...Object.keys(prevData), ...Object.keys(nextData)]);
  for (const key of keys) {
    if (prevData[key] !== nextData[key]) {
      return false;
    }
  }

  return true;
}
