'use client';

import { useEffect, useState } from 'react';

import { posterUrl } from './config';

/**
 * Size, length and one poster frame of a served clip, without keeping a <video>.
 *
 * 2026-09-06: Chrome refuses to create more than ~75 media players per page
 * ("Blocked attempt to create a WebMediaPlayer as there are too many"). The cut
 * room's bin, the asset library's grid and the provenance panels each mounted a
 * <video preload="metadata"> per clip just to print "1376×768 · 8.7s", and with a
 * 12-segment project open the player for the exported film itself was the one
 * refused. A metadata read does not need a player that lives as long as the row.
 *
 * So every thumbnail-only site asks here instead. One throwaway element at a
 * time reads the metadata, grabs a frame, drops its src (which releases the
 * player), and the result is cached by URL for the life of the page. The rows
 * then render an <img> — which counts against nothing.
 */
export interface VideoProbe {
  w: number;
  h: number;
  seconds: number;
  /** JPEG data URL of a frame near the start, or null if the frame could not be read. */
  poster: string | null;
}

const CACHE = new Map<string, VideoProbe>();
const PENDING = new Map<string, Promise<VideoProbe>>();
let queue: Promise<unknown> = Promise.resolve();

/** Failure result: the caller shows a blank tile, exactly as a broken <video> did. */
const EMPTY: VideoProbe = { w: 0, h: 0, seconds: 0, poster: null };

function probeOnce(url: string, kind: 'video' | 'audio', timeoutMs = 15000): Promise<VideoProbe> {
  return new Promise((resolve) => {
    const el = document.createElement(kind);
    el.muted = true;
    // The backend cuts the poster, so only the header has to be read here. Cutting
    // it in the page needs a decoded frame, and preload="auto" to get one pulls
    // the whole file for every tile on the page.
    const serverPoster = kind === 'video' ? posterUrl(url) : null;
    el.preload = kind === 'video' && !serverPoster ? 'auto' : 'metadata';
    if (kind === 'video') (el as HTMLVideoElement).crossOrigin = 'anonymous';

    const finish = (result: VideoProbe) => {
      clearTimeout(timer);
      el.onloadedmetadata = null;
      el.onloadeddata = null;
      el.onseeked = null;
      el.onerror = null;
      // Dropping the source is what frees the WebMediaPlayer; GC alone is too slow.
      el.removeAttribute('src');
      el.load();
      resolve(result);
    };
    const timer = setTimeout(() => finish(EMPTY), timeoutMs);
    el.onerror = () => finish(EMPTY);

    if (serverPoster) {
      const v = el as HTMLVideoElement;
      el.onloadedmetadata = () =>
        finish({
          w: v.videoWidth,
          h: v.videoHeight,
          seconds: Number.isFinite(v.duration) ? v.duration : 0,
          poster: serverPoster,
        });
    } else if (kind === 'audio') {
      el.onloadedmetadata = () =>
        finish({ w: 0, h: 0, seconds: Number.isFinite(el.duration) ? el.duration : 0, poster: null });
    } else {
      const v = el as HTMLVideoElement;
      const capture = () => {
        const meta = { w: v.videoWidth, h: v.videoHeight, seconds: Number.isFinite(v.duration) ? v.duration : 0 };
        let poster: string | null = null;
        try {
          if (v.videoWidth && v.readyState >= 2) {
            const scale = Math.min(1, 320 / v.videoWidth);
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(v.videoWidth * scale));
            c.height = Math.max(1, Math.round(v.videoHeight * scale));
            const ctx = c.getContext('2d');
            if (ctx) {
              ctx.drawImage(v, 0, 0, c.width, c.height);
              poster = c.toDataURL('image/jpeg', 0.7);
            }
          }
        } catch {
          poster = null; // tainted canvas: the numbers still count
        }
        finish({ ...meta, poster });
      };
      v.onloadeddata = () => {
        // Frame 0 is often a fade-in; a beat later reads as the clip.
        const t = Number.isFinite(v.duration) && v.duration > 1 ? 0.5 : 0;
        if (t === 0) { capture(); return; }
        v.onseeked = capture;
        v.currentTime = t;
      };
    }
    el.src = url;
  });
}

export function probeVideo(url: string, kind: 'video' | 'audio' = 'video'): Promise<VideoProbe> {
  const hit = CACHE.get(url);
  if (hit) return Promise.resolve(hit);
  const pending = PENDING.get(url);
  if (pending) return pending;
  // Serialised: N parallel probes would be N players again.
  const p = queue.then(() => probeOnce(url, kind)).then((r) => {
    CACHE.set(url, r);
    PENDING.delete(url);
    return r;
  });
  queue = p.catch(() => undefined);
  PENDING.set(url, p);
  return p;
}

export function cachedProbe(url: string | null | undefined): VideoProbe | null {
  return url ? CACHE.get(url) ?? null : null;
}

/** React view of probeVideo: null until read, then stable for the page. */
export function useVideoProbe(url: string | null | undefined, kind: 'video' | 'audio' = 'video'): VideoProbe | null {
  const [probe, setProbe] = useState<VideoProbe | null>(() => cachedProbe(url));
  useEffect(() => {
    if (!url) { setProbe(null); return; }
    const hit = CACHE.get(url);
    if (hit) { setProbe(hit); return; }
    let live = true;
    setProbe(null);
    probeVideo(url, kind).then((r) => { if (live) setProbe(r); });
    return () => { live = false; };
  }, [url, kind]);
  return probe;
}
