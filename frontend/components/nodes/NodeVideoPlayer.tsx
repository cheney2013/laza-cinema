'use client';

import { memo, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useStore } from '@/lib/store';
import { posterUrl } from '@/lib/config';
import { NATIVE_VIDEO_CHROME_OFF, capturePoster, cachedPoster, useTypingInside } from './mediaChrome';
import { t } from '@/lib/i18n';

/**
 * The one in-node video player, taken from the H3 node so every node that shows a
 * clip plays it the same way: poster frame while idle, <video> only when played,
 * hovered or selected, and a hover overlay with an info line on top, then
 * play / sound / drag-to-seek / time, then the node's own actions.
 *
 * The node keeps its own card, header and error banners around it; `videoRef`
 * lets it drive the element (screenshot, pause when a modal opens, autoplay on
 * completion) the way it did before.
 */

interface Props {
  nodeId: string;
  src: string | null;
  videoRef?: RefObject<HTMLVideoElement | null>;
  selected?: boolean;
  /** Top-left line of the hover overlay. */
  info?: ReactNode;
  /** Top-right of the hover overlay. */
  infoRight?: ReactNode;
  /** Row under the transport: the node's own buttons. */
  actions?: ReactNode;
  /** Suppress autoplay (e.g. while the node is generating). */
  holdPlayback?: boolean;
  /** External request to pause (a preview modal opened). */
  paused?: boolean;
  /** Bump to start playback from the top (autoplay on completion). Works while the
   *  poster is up: the <video> is mounted and started once it has data. */
  playToken?: number;
  onMediaSize?: (width: number, height: number) => void;
  onDuration?: (duration: number) => void;
  /** Mount the <video> now, not on hover: the node still needs its duration/size. */
  eager?: boolean;
  /** Extra layers inside the frame (generating line, settings drawer). */
  children?: ReactNode;
  /**
   * Seconds at the head of the file that are not this clip: an enhanced chained
   * shot keeps its overlap with the previous shot for the cut room, but the node
   * itself plays, loops, seeks and times only what follows it.
   */
  headSeconds?: number;
}

export const fmtTime = (s: number) => {
  const v = Number.isFinite(s) && s > 0 ? s : 0;
  return `${Math.floor(v / 60)}:${Math.floor(v % 60).toString().padStart(2, '0')}`;
};

const MAX_PARKED = 3;
/** Clips paused away from their start that still hold a mounted <video>, oldest first. */
const parkedPlayers = new Map<string, () => void>();

function NodeVideoPlayer({
  nodeId, src, videoRef: externalRef, selected, info, infoRight, actions,
  holdPlayback, paused, playToken, eager, onMediaSize, onDuration, children, headSeconds = 0,
}: Props) {
  const head = headSeconds > 0 ? headSeconds : 0;
  const ownRef = useRef<HTMLVideoElement | null>(null);
  const videoRef = (externalRef ?? ownRef) as RefObject<HTMLVideoElement | null>;
  const activeAudioNodeId = useStore((s) => s.activeAudioNodeId);
  const setActiveAudioNodeId = useStore((s) => s.setActiveAudioNodeId);
  const isAudioActive = activeAudioNodeId === nodeId;
  const [isHovered, setIsHovered] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [poster, setPoster] = useState<string | null>(null);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDur, setVideoDur] = useState(0);
  const playOnMountRef = useRef(false);
  const overlayFocus = useTypingInside();

  useEffect(() => {
    // The backend's poster is frame 0, which is overlap when there is a head.
    setPoster(head > 0 ? null : posterUrl(src) ?? cachedPoster(src));
    setVideoTime(0);
    setVideoDur(0);
  }, [src, head]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !isAudioActive;
  }, [isAudioActive, videoRef]);

  useEffect(() => {
    if (paused) videoRef.current?.pause();
  }, [paused, videoRef]);

  useEffect(() => {
    if (!playToken) return;
    const v = videoRef.current;
    playOnMountRef.current = true;
    setIsPlaying(true);
    if (v && v.readyState >= 2 && v.currentSrc === v.src) {
      playOnMountRef.current = false;
      v.currentTime = head;
      v.play().catch(() => {});
    }
  }, [playToken, videoRef, head]);

  // A clip paused away from its start stays mounted: swapping it for the poster
  // (frame 0) on mouse-leave threw away the frame the user had scrubbed to, and the
  // remounted <video> started over from 0.
  const parked = videoTime > head + 0.05;
  // ...but only a few of them: each mounted <video> keeps a decoder and its frame
  // textures in GPU memory, and every clip played and paused mid-way stayed mounted.
  // The oldest beyond MAX_PARKED go back to their poster.
  const idleParked = parked && !isPlaying && !isHovered && !selected && !eager && Boolean(poster);
  useEffect(() => {
    if (!idleParked) {
      parkedPlayers.delete(nodeId);
      return;
    }
    parkedPlayers.delete(nodeId);
    parkedPlayers.set(nodeId, () => setVideoTime(0));
    while (parkedPlayers.size > MAX_PARKED) {
      const oldest = parkedPlayers.keys().next().value as string;
      const release = parkedPlayers.get(oldest);
      parkedPlayers.delete(oldest);
      release?.();
    }
    return () => { parkedPlayers.delete(nodeId); };
  }, [idleParked, nodeId]);
  const showVideo = Boolean(src) && (Boolean(eager) || parked || !(poster && !isPlaying && !isHovered && !selected));

  const toggle = () => {
    const v = videoRef.current;
    if (!v) {
      // Poster is up: mount the video and start it once it has data.
      playOnMountRef.current = true;
      setIsPlaying(true);
      return;
    }
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  return (
    <div
      className="relative w-full h-full overflow-hidden"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {showVideo ? (
        <video
          ref={videoRef as RefObject<HTMLVideoElement>}
          src={src ?? undefined}
          // The idle <img> is swapped for this on hover; without the same poster the
          // card is black until the first frame decodes -- a flash on every hover.
          poster={poster ?? undefined}
          {...NATIVE_VIDEO_CHROME_OFF}
          crossOrigin="anonymous"
          // With a head to skip, the loop is done by hand (onEnded), or every pass
          // would start with the overlap.
          loop={!(head > 0)}
          playsInline
          autoPlay={!holdPlayback && isPlaying}
          muted={!isAudioActive}
          // contain, not cover: cover crops the frame, which contradicts keeping the media ratio.
          className="node-shell-media w-full h-full object-contain bg-black"
          onLoadedData={() => {
            const v = videoRef.current;
            if (!v || !src) return;
            if (head > 0 && v.currentTime < head) v.currentTime = head;
            if (playOnMountRef.current) {
              playOnMountRef.current = false;
              v.play().catch(() => {});
            }
            if (poster) return;
            // Only for a source the backend cannot cut a poster from. loadeddata fires
            // before the first frame is painted; a seek decodes it even in a hidden tab.
            const grab = () => {
              const url = videoRef.current ? capturePoster(videoRef.current, src) : null;
              if (url) setPoster(url);
            };
            v.addEventListener('seeked', grab, { once: true });
            if (v.paused) v.currentTime = Math.min(head + 0.04, Math.max(0, (v.duration || 1) - 0.01));
          }}
          onEnded={() => {
            const v = videoRef.current;
            if (!v || !(head > 0)) return;
            v.currentTime = head;
            v.play().catch(() => {});
          }}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={() => {
            const v = videoRef.current;
            if (!v) return;
            if (head > 0 && v.currentTime < head - 0.01) v.currentTime = head;
            setVideoTime(v.currentTime);
          }}
          onLoadedMetadata={() => {
            const v = videoRef.current;
            if (!v) return;
            setVideoDur(v.duration || 0);
            if (v.duration) onDuration?.(v.duration);
            if (v.videoWidth && v.videoHeight) onMediaSize?.(v.videoWidth, v.videoHeight);
          }}
          onClick={toggle}
        />
      ) : src && poster ? (
        <img
          src={poster}
          alt=""
          draggable={false}
          className="node-shell-media w-full h-full object-contain bg-black"
          onLoad={(event) => {
            const img = event.currentTarget;
            if (img.naturalWidth && img.naturalHeight) onMediaSize?.(img.naturalWidth, img.naturalHeight);
          }}
          onError={() => setPoster(null)}
          onClick={toggle}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-black/60 text-xs text-zinc-500">
          {t('加载视频…')}
        </div>
      )}

      {/* Hover overlay */}
      <div
        className={`absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/40 flex flex-col justify-between p-2.5 transition-opacity duration-200 ${isHovered || overlayFocus.typing ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onFocus={overlayFocus.onFocus}
        onBlur={overlayFocus.onBlur}
        onClick={(e) => {
          // The overlay covers the frame, so "click the picture to pause" has to be
          // handled here too; anything that is not a control counts as the picture.
          if ((e.target as HTMLElement).closest('button, a, input, select, textarea, label, [role="button"], .nodrag')) return;
          toggle();
        }}
      >
        <div className="flex items-center justify-between gap-1.5 text-[10px] text-white/70">
          {info ? (
            <span className="font-mono bg-black/50 px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 truncate">{info}</span>
          ) : <span />}
          {infoRight}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <button onClick={toggle} className="p-1 rounded text-white hover:text-white/80 cursor-pointer">
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button
              onClick={() => setActiveAudioNodeId(isAudioActive ? null : nodeId)}
              className={`p-1 rounded cursor-pointer transition-colors ${isAudioActive ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
              title={isAudioActive ? t('静音（点击关闭声音）') : t('开启声音（当前静音）')}
            >
              {isAudioActive ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              )}
            </button>
            <div
              className="nodrag flex-1 h-4 flex items-center cursor-pointer group/seek"
              onPointerDown={(e) => {
                // nodrag keeps the overlay's click handler out; stop here too so a drag
                // is not taken as a canvas box-select.
                e.stopPropagation();
                const v = videoRef.current;
                if (!v || !(videoDur > 0)) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const seek = (clientX: number) => {
                  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
                  const at = head + ratio * Math.max(0, videoDur - head);
                  v.currentTime = at;
                  setVideoTime(at);
                };
                seek(e.clientX);
                e.currentTarget.setPointerCapture(e.pointerId);
                const onMove = (ev: PointerEvent) => seek(ev.clientX);
                const onUp = () => {
                  window.removeEventListener('pointermove', onMove);
                  window.removeEventListener('pointerup', onUp);
                };
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
              }}
            >
              <div className="w-full h-1 bg-white/20 rounded-full overflow-hidden group-hover/seek:h-1.5 transition-[height]">
                <div
                  className="h-full bg-white/85 rounded-full"
                  style={{ width: `${videoDur > head ? (Math.max(0, videoTime - head) / (videoDur - head)) * 100 : 0}%` }}
                />
              </div>
            </div>
            <span className="text-[9px] font-mono text-zinc-300">
              {fmtTime(Math.max(0, videoTime - head))} / {fmtTime(Math.max(0, videoDur - head))}
            </span>
          </div>

          {actions && (
            <div className="flex items-center justify-between gap-1.5 pt-1">{actions}</div>
          )}
        </div>
      </div>

      {children}
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

export default memo(NodeVideoPlayer);
