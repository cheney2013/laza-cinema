'use client';

import { create } from 'zustand';

/**
 * Which files have been overwritten in place during this session.
 *
 * 覆盖原素材 rewrites a file under its own name, so every url in the project
 * still points at the right place — and every element already showing it keeps
 * showing the old bytes. The backend is not at fault: it sends
 * `Cache-Control: no-cache` and re-derives proxies per mtime. A <video> whose
 * `src` string has not changed simply never asks again.
 *
 * So a version is stamped on the path, and `resolveAssetUrl` turns it into a
 * `?v=` the browser has to treat as a different resource.
 *
 * Keyed by the backend-relative path exactly as the API returns it.
 */
interface AssetVersions {
  versions: Record<string, number>;
  bump: (path: string) => void;
}

export const useAssetVersions = create<AssetVersions>((set) => ({
  versions: {},
  bump: (path) => set((s) => ({ versions: { ...s.versions, [path]: Date.now() } })),
}));

/** Mark a file as rewritten. Everything built through `resolveAssetUrl` after
 * this asks the server again. */
export function bumpAssetVersion(path: string): void {
  if (path) useAssetVersions.getState().bump(path);
}

/** The token for a path, or 0 when it has not been overwritten here. */
export function assetVersion(path: string): number {
  return useAssetVersions.getState().versions[path] ?? 0;
}

/** Append the version as a query parameter, respecting any query already there. */
export function withVersion(url: string, version: number): string {
  if (!version) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${version}`;
}

/**
 * The same thing for a component holding an absolute src: subscribes, so the
 * player re-renders and re-requests when the file behind it is overwritten.
 *
 * Node data stores absolute urls, so the path is taken back off the src to look
 * it up — the map is keyed the way the API speaks, `/uploads/….mp4`.
 */
export function useVersionedSrc(src: string): string {
  const versions = useAssetVersions((s) => s.versions);
  if (!src) return src;
  let path = src;
  try {
    if (/^https?:/i.test(src)) path = new URL(src).pathname;
  } catch {
    // Not a url we can take apart; fall through and look up the whole string.
  }
  const version = versions[path] ?? versions[decodeURIComponent(path)] ?? 0;
  return withVersion(src, version);
}
