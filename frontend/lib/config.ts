// Use the hostname through which the user opened the frontend. This keeps one
// build working via localhost, LAN IP, Tailscale IP, or a DNS name without
// baking a particular machine address into the browser bundle. The configured
// URL remains the source of protocol and port.
import { assetVersion, withVersion } from './assetVersions';

function browserHostUrl(configuredUrl: string, fallbackPort: number, httpsPort?: string): string {
  if (typeof window === 'undefined') return configuredUrl.replace(/\/$/, '');
  // Opened over HTTPS (tailscale serve): an http:// backend would be blocked as
  // mixed content, so use the HTTPS port the same serve config maps to it.
  if (window.location.protocol === 'https:' && httpsPort) {
    return `https://${window.location.hostname}:${httpsPort}`;
  }
  try {
    const url = new URL(configuredUrl);
    url.hostname = window.location.hostname;
    return url.origin;
  } catch {
    return `${window.location.protocol}//${window.location.hostname}:${fallbackPort}`;
  }
}

const CONFIGURED_BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8003';
// `tailscale serve --https=8443 http://127.0.0.1:8003` (see start.ps1)
export const BACKEND_URL = browserHostUrl(CONFIGURED_BACKEND_URL, 8003,
  process.env.NEXT_PUBLIC_API_HTTPS_PORT || '8443');

const CONFIGURED_COMFYUI_URL = process.env.NEXT_PUBLIC_COMFYUI_URL || 'http://localhost:8188';
export const COMFYUI_URL = browserHostUrl(CONFIGURED_COMFYUI_URL, 8188);

/**
 * 把后端资源路径补成绝对地址。
 *
 * store 里存的是 `/uploads/xxx.png` 这种**后端**相对路径，直接塞给 <img>/<video>
 * 会打到前端自己的端口上，拿回 404 —— 于是缩略图全是碎图标。
 * blob: / data: / http(s): 已经是完整地址，原样放行。
 */
export function resolveAssetUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (/^(https?:|blob:|data:)/i.test(url)) return url;
  // 这个文件如果在本次会话里被就地覆盖过，带上版本号 —— 地址不变的 <video>
  // 永远不会再去问服务器一次，后端的 no-cache 也就没有机会生效。
  return withVersion(`${BACKEND_URL}${url}`, assetVersion(url));
}

/**
 * A served video's first frame, cut by the backend, as an image URL.
 *
 * Pages show this until a clip is actually played. Mounting a <video> to grab
 * the frame itself downloads the file, for every clip, the moment a page opens.
 * Null for blob:/data: sources and foreign URLs, which the backend cannot read.
 */
export function posterUrl(src: string | null | undefined): string | null {
  if (!src || /^(blob:|data:)/i.test(src)) return null;
  if (/^https?:/i.test(src) && !src.startsWith(BACKEND_URL)) return null;
  return `${BACKEND_URL}/media/poster?src=${encodeURIComponent(src)}`;
}
