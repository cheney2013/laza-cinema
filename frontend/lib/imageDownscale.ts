import { t } from './i18n';
/**
 * Browser-side image downscaling.
 *
 * NVIDIA NIM caps inline base64 images at ~180 KB, and a full-resolution reference
 * frame blows past that. Resizing here rather than server-side keeps the project free
 * of a native image dependency (sharp).
 *
 * Fetched with `fetch` + `createImageBitmap` rather than `new Image()` with
 * `crossOrigin = 'anonymous'`. The `<img>` route looks simpler but fails in a way that
 * cannot be diagnosed: `onerror` carries no reason, and a cross-origin image that the
 * page already displayed normally is very likely sitting in the HTTP cache as a
 * response fetched *without* an `Origin` header — which the browser then refuses to
 * reuse for a CORS request, even though the server does send `Access-Control-Allow-
 * Origin: *`. Going through `fetch` avoids that reuse rule and surfaces a real status
 * code when something is actually wrong.
 */

export interface DownscaleOptions {
  /** Longest edge of the result, in pixels. */
  maxEdge?: number;
  /** JPEG quality, 0-1. */
  quality?: number;
}

async function loadBitmap(url: string): Promise<ImageBitmap> {
  let blob: Blob;
  try {
    const res = await fetch(url, { mode: 'cors', cache: 'no-cache' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    blob = await res.blob();
  } catch (e: any) {
    throw new Error(t('参考图加载失败（{v1}）: {v2}', { v1: url, v2: e.message }));
  }

  if (!blob.type.startsWith('image/') && blob.size === 0) {
    throw new Error(t('参考图内容为空或不是图片（{v1}）', { v1: url }));
  }

  try {
    return await createImageBitmap(blob);
  } catch (e: any) {
    throw new Error(t('参考图解码失败（{v1}）: {v2}', { v1: blob.type || t('未知类型'), v2: e.message }));
  }
}

export async function downscaleImageToDataUrl(
  url: string,
  { maxEdge = 768, quality = 0.82 }: DownscaleOptions = {}
): Promise<string> {
  const bitmap = await loadBitmap(url);

  try {
    const { width: w, height: h } = bitmap;
    if (!w || !h) {
      throw new Error(t('参考图尺寸为 0'));
    }

    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error(t('无法创建 canvas 上下文'));
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    bitmap.close();
  }
}
