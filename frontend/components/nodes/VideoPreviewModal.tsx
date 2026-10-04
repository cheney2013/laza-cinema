'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { NATIVE_VIDEO_CHROME_OFF } from './mediaChrome';
import { t } from '@/lib/i18n';
import { useStore } from '@/lib/store';
import { downloadFile } from '@/lib/utils';
import { describeProgress } from '@/lib/download';
import { showAlert } from '@/components/ui/Dialog';

interface Props {
  beforeUrl: string | null;  // source video (blob or URL)
  afterUrl: string | null;   // upscaled/generated video (blob or URL)
  onClose: () => void;
  onCaptureFrame?: (videoElement: HTMLVideoElement) => void; // snapshot callback
  /** Source frame rate, for frame stepping. Defaults to this project's 24. */
  fps?: number;
  /** Fallback file name for the download button. */
  downloadName?: string;
  /** The node's alias: names the downloaded file when set. */
  alias?: string | null;
  /**
   * Seconds at the head of both files that are not the shot (an enhanced
   * chained shot keeps its overlap for the cut room). Playback, looping, the
   * timeline, the clock and frame numbers all start after it.
   */
  headSeconds?: number;
}

export default function VideoPreviewModal({ beforeUrl, afterUrl, onClose, onCaptureFrame, fps, downloadName, alias, headSeconds = 0 }: Props) {
  const head = headSeconds > 0 ? headSeconds : 0;
  // Bytes received while the download button is working; null when idle. A cut of several
  // minutes is hundreds of MB, so the button says how far it has got.
  const [download, setDownload] = useState<{ done: number; total: number } | null>(null);
  const startDownload = async () => {
    if (!afterUrl || download) return;
    setDownload({ done: 0, total: 0 });
    try {
      await downloadFile(afterUrl, downloadName || 'video.mp4', alias, (done, total) => setDownload({ done, total }));
    } catch (error) {
      void showAlert(t('下载失败：{v1}', { v1: (error as Error).message }));
    } finally {
      setDownload(null);
    }
  };
  // One viewer for both "enlarge" and "compare": the split view appears only
  // when there is a second, different video to set against the result.
  const hasCompare = !!beforeUrl && beforeUrl !== afterUrl;
  const [split, setSplit] = useState(50);           // divider position (%)
  const [isPlaying, setIsPlaying] = useState(false);
  // On by default. It used to start from !!beforeUrl, but the upscale node loads
  // the source as a blob after the modal mounts, so beforeUrl was still null at
  // that moment and compare opened switched off. renderCompare still needs a
  // beforeUrl, so a node with no source shows the plain player.
  const [isCompareActive, setIsCompareActive] = useState(true);
  // Sound follows the canvas-wide rule under the group key "preview-modal":
  // one owner audible, and playback inherits the last mute state
  // (useSingleAudioCoordinator).
  const modalMuted = useStore((s) => s.activeAudioNodeId !== 'preview-modal');
  const setActiveAudioNodeId = useStore((s) => s.setActiveAudioNodeId);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const beforeRef = useRef<HTMLVideoElement>(null);
  const afterRef = useRef<HTMLVideoElement>(null);
  const syncingRef = useRef(false);
  const wasPlayingRef = useRef(false);
  // The picture box inside the viewport, plus the viewport width it was measured
  // against — the divider works in container space, the clips in picture space.
  const [videoRect, setVideoRect] = useState<
    { left: number; top: number; width: number; height: number; containerWidth: number } | null
  >(null);
  const videoFps = fps && fps > 0 ? fps : 24;
  const shotDuration = Math.max(0, duration - head);
  const shotTime = Math.max(0, currentTime - head);
  const totalFrames = shotDuration > 0 ? Math.max(1, Math.ceil(shotDuration * videoFps)) : 0;
  // 0-based, like ffmpeg's n, guide-frame indexes and edit windows: "frame 134"
  // here is the frame an agent extracts as n=134. A 1-based count put every
  // frame Yige named one frame after the one pulled (C20a, 2026-09-25).
  const currentFrame = totalFrames > 0
    ? Math.min(totalFrames - 1, Math.max(0, Math.floor(shotTime * videoFps + 1e-3)))
    : 0;
  const [flashOpacity, setFlashOpacity] = useState(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const toastFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastFadeTimerRef.current) clearTimeout(toastFadeTimerRef.current);
      if (toastClearTimerRef.current) clearTimeout(toastClearTimerRef.current);
    };
  }, []);

  // `timeupdate` is deliberately throttled by browsers and can skip several
  // frames between UI updates. Drive the visible frame counter from decoded
  // video frames so it changes on every frame actually presented.
  useEffect(() => {
    const video = afterRef.current;
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    let callbackId = 0;
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      setCurrentTime(metadata.mediaTime);
      callbackId = video.requestVideoFrameCallback(onFrame);
    };
    callbackId = video.requestVideoFrameCallback(onFrame);
    return () => video.cancelVideoFrameCallback(callbackId);
  }, [afterUrl]);

  // ── Auto-play on mount & metadata loading ───────────────────────────────────
  const calculateVideoRect = useCallback(() => {
    const container = containerRef.current;
    const video = afterRef.current;
    if (!container || !video || !video.videoWidth) return;

    const containerRect = container.getBoundingClientRect();
    const containerRatio = containerRect.width / containerRect.height;
    const videoRatio = video.videoWidth / video.videoHeight;

    let actualWidth: number, actualHeight: number;
    if (videoRatio > containerRatio) {
      actualWidth = containerRect.width;                 // width constrained
      actualHeight = actualWidth / videoRatio;
    } else {
      actualHeight = containerRect.height;               // height constrained
      actualWidth = actualHeight * videoRatio;
    }
    const actualLeft = (containerRect.width - actualWidth) / 2;
    const actualTop = (containerRect.height - actualHeight) / 2;

    setVideoRect({
      left: actualLeft, top: actualTop, width: actualWidth, height: actualHeight,
      containerWidth: containerRect.width,
    });
  }, []);

  useEffect(() => {
    const a = afterRef.current;
    const b = beforeRef.current;
    if (!a) return;

    const onLoaded = () => {
      if (afterRef.current) {
        setDuration(afterRef.current.duration);
        if (head > 0 && afterRef.current.currentTime < head) {
          afterRef.current.currentTime = head;
          if (beforeRef.current) beforeRef.current.currentTime = head;
        }
      }
      calculateVideoRect();
    };

    a.addEventListener('loadedmetadata', onLoaded);
    if (a.readyState >= 1) {
      onLoaded();
    }

    if (b) {
      b.addEventListener('loadedmetadata', calculateVideoRect);
      if (b.readyState >= 1) {
        calculateVideoRect();
      }
    }

    // Auto-play on mount
    a.play()
      .then(() => {
        setIsPlaying(true);
        if (b && hasCompare && isCompareActive) {
          b.play().catch(() => {});
        }
      })
      .catch(() => {});

    window.addEventListener('resize', calculateVideoRect);
    return () => {
      a.removeEventListener('loadedmetadata', onLoaded);
      if (b) {
        b.removeEventListener('loadedmetadata', calculateVideoRect);
      }
      window.removeEventListener('resize', calculateVideoRect);
    };
  }, [hasCompare, calculateVideoRect, isCompareActive]);

  // ── Sync play states & time when comparison is toggled or state changes ───────
  useEffect(() => {
    const b = beforeRef.current;
    const a = afterRef.current;
    if (!b || !a) return;

    if (isCompareActive) {
      b.currentTime = a.currentTime;
      if (isPlaying && b.paused) {
        b.play().catch(() => {});
      } else if (!isPlaying && !b.paused) {
        b.pause();
      }
    } else {
      b.pause();
    }
  }, [isCompareActive, isPlaying]);

  // ── Sync: after video drives timing ─────────────────────────────────────
  const handleAfterTimeUpdate = useCallback(() => {
    const a = afterRef.current;
    if (!a) return;
    
    // The native loop comes back to 0, which is overlap when there is a head.
    if (head > 0 && a.currentTime < head - 0.01) {
      a.currentTime = head;
      const b0 = beforeRef.current;
      if (b0) b0.currentTime = head;
    }
    // Always update current progress state
    setCurrentTime(a.currentTime);

    if (isCompareActive && !syncingRef.current) {
      const b = beforeRef.current;
      if (b && Math.abs(b.currentTime - a.currentTime) > 0.15) {
        syncingRef.current = true;
        b.currentTime = a.currentTime;
        syncingRef.current = false;
      }
    }
  }, [isCompareActive, head]);

  // ── Play / Pause toggle ───────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const b = beforeRef.current, a = afterRef.current;
    if (!a) return;
    if (a.paused) {
      a.play().catch(() => {});
      if (b && isCompareActive) {
        b.play().catch(() => {});
      }
      setIsPlaying(true);
    } else {
      a.pause();
      if (b) {
        b.pause();
        b.currentTime = a.currentTime;
      }
      setIsPlaying(false);
    }
  }, [isCompareActive]);

  const stepFrame = useCallback((dir: number) => {
    const b = beforeRef.current, a = afterRef.current;
    if (!a) return;
    const step = 1 / videoFps;
    a.pause();
    if (b) b.pause();
    setIsPlaying(false);

    // Seek to the middle of the target frame: adding 1/fps to a boundary time
    // drifts in floating point and lands on the previous frame.
    const maxTime = Math.max(0, (a.duration || Infinity) - 0.01);
    const frameNow = Math.floor(a.currentTime * videoFps + 1e-3);
    const targetTime = Math.max(head, Math.min(maxTime, (frameNow + dir + 0.5) * step));
    
    a.currentTime = targetTime;
    if (b && isCompareActive) {
      b.currentTime = targetTime;
    }
    setCurrentTime(targetTime);
  }, [videoFps, isCompareActive, head]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // Skip if typing in form input
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      const key = e.key.toLowerCase();
      if (key === 'escape') onClose();
      if (key === ' ') { e.preventDefault(); togglePlay(); }
      if (key === 'd') { e.preventDefault(); stepFrame(-1); }
      if (key === 'f') { e.preventDefault(); stepFrame(1); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, togglePlay, stepFrame]);

  // ── Drag divider helpers ──────────────────────────────────────────────────
  const applyDrag = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    
    let pct = (x / rect.width) * 100;
    
    // Constrain to video rect if available
    if (videoRect) {
      const minPct = (videoRect.left / rect.width) * 100;
      const maxPct = ((videoRect.left + videoRect.width) / rect.width) * 100;
      pct = Math.max(minPct, Math.min(maxPct, pct));
    } else {
      pct = Math.max(0, Math.min(100, pct));
    }
    
    setSplit(pct);
  }, [videoRect]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const onMove = (ev: MouseEvent) => { if (isDragging.current) applyDrag(ev.clientX); };
    const onUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [applyDrag]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const onMove = (ev: TouchEvent) => { ev.preventDefault(); applyDrag(ev.touches[0].clientX); };
    const onEnd = () => {
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
  }, [applyDrag]);

  // ── Progress Timeline scrubbing helpers ────────────────────────────────────
  const handleProgressScrub = useCallback((clientX: number, trackEl: HTMLDivElement) => {
    if (!duration) return;
    const rect = trackEl.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetTime = head + pct * Math.max(0, duration - head);
    
    const a = afterRef.current;
    const b = beforeRef.current;
    if (a) {
      a.currentTime = targetTime;
    }
    if (b && isCompareActive) {
      b.currentTime = targetTime;
    }
    setCurrentTime(targetTime);
  }, [duration, isCompareActive, head]);

  const handleProgressMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const track = e.currentTarget;
    
    // Check and save play state before pausing
    const isCurrentlyPlaying = isPlaying;
    wasPlayingRef.current = isCurrentlyPlaying;
    
    // Pause videos during scrubbing
    const a = afterRef.current;
    const b = beforeRef.current;
    if (a) a.pause();
    if (b) b.pause();
    setIsPlaying(false);

    handleProgressScrub(e.clientX, track);
    
    const onMouseMove = (ev: MouseEvent) => {
      handleProgressScrub(ev.clientX, track);
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      
      // Restore playback if it was playing
      if (wasPlayingRef.current) {
        const activeA = afterRef.current;
        const activeB = beforeRef.current;
        if (activeA) {
          activeA.play().catch(() => {});
        }
        if (activeB && isCompareActive) {
          activeB.play().catch(() => {});
        }
        setIsPlaying(true);
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [handleProgressScrub, isPlaying, isCompareActive]);

  const handleProgressTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const track = e.currentTarget;
    
    // Check and save play state before pausing
    const isCurrentlyPlaying = isPlaying;
    wasPlayingRef.current = isCurrentlyPlaying;
    
    // Pause videos during scrubbing
    const a = afterRef.current;
    const b = beforeRef.current;
    if (a) a.pause();
    if (b) b.pause();
    setIsPlaying(false);

    handleProgressScrub(e.touches[0].clientX, track);
    
    const onMove = (ev: TouchEvent) => {
      handleProgressScrub(ev.touches[0].clientX, track);
    };
    const onEnd = () => {
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      
      // Restore playback if it was playing
      if (wasPlayingRef.current) {
        const activeA = afterRef.current;
        const activeB = beforeRef.current;
        if (activeA) {
          activeA.play().catch(() => {});
        }
        if (activeB && isCompareActive) {
          activeB.play().catch(() => {});
        }
        setIsPlaying(true);
      }
    };
    window.addEventListener('touchmove', onMove);
    window.addEventListener('touchend', onEnd);
  }, [handleProgressScrub, isPlaying, isCompareActive]);

  const handleCaptureClick = useCallback(() => {
    if (onCaptureFrame && afterRef.current) {
      setFlashOpacity(0.85);
      setTimeout(() => setFlashOpacity(0), 150);

      onCaptureFrame(afterRef.current);

      if (toastFadeTimerRef.current) clearTimeout(toastFadeTimerRef.current);
      if (toastClearTimerRef.current) clearTimeout(toastClearTimerRef.current);

      setToastMessage(t('已成功保存截图并生成图片节点'));
      setToastVisible(true);
      
      toastFadeTimerRef.current = setTimeout(() => {
        setToastVisible(false);
      }, 2000);
      
      toastClearTimerRef.current = setTimeout(() => {
        setToastMessage(null);
      }, 2300);
    }
  }, [onCaptureFrame]);

  const fmt = (s: number) => {
    if (isNaN(s)) return '0:00';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const renderCompare = isCompareActive && hasCompare;

  // `split` is a percentage of the container so the divider can be dragged in
  // screen space; the clips need the same seam expressed inside the picture box.
  const splitInPicture =
    videoRect && videoRect.containerWidth > 0 && videoRect.width > 0
      ? Math.max(
          0,
          Math.min(
            100,
            (((split / 100) * videoRect.containerWidth - videoRect.left) / videoRect.width) * 100
          )
        )
      : split;

  const content = (
    <div
      // the before and after clips play in lock-step: one video to the
      // canvas's one-playback rule (useSingleAudioCoordinator)
      data-media-group="preview-modal"
      style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        background: 'rgba(0,0,0,0.93)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        fontFamily: 'inherit',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* ── Video comparison container ─────────────────────────────── */}
      <div
        ref={containerRef}
        style={{
          position: 'relative',
          width: 'min(90vw, 140vh)',
          height: 'min(80vh, 56.25vw)',  /* 16:9 clamp */
          background: '#000',
          borderRadius: 14,
          overflow: 'hidden',
          userSelect: 'none',
          boxShadow: '0 32px 80px rgba(0,0,0,0.7)',
        }}
      >
        {/* Flash effect overlay */}
        <div style={{
          position: 'absolute', inset: 0,
          background: '#fff',
          zIndex: 99,
          opacity: flashOpacity,
          pointerEvents: 'none',
          transition: 'opacity 0.15s ease-out',
        }} />

        {/* Toast Notification */}
        {toastMessage && (
          <div style={{
            position: 'absolute',
            top: 24, left: '50%',
            transform: `translateX(-50%) translateY(${toastVisible ? 0 : -10}px)`,
            background: 'rgba(20, 20, 20, 0.88)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255, 255, 255, 0.18)',
            borderRadius: 24,
            padding: '8px 18px',
            color: '#fff',
            fontSize: 13,
            fontWeight: 500,
            zIndex: 100,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            opacity: toastVisible ? 1 : 0,
            transition: 'opacity 0.25s ease, transform 0.25s ease',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span>{toastMessage}</span>
          </div>
        )}

        {/*
          Both clips are laid into one box, sized from the result's own aspect
          ratio, instead of each fitting itself into the viewport.

          The upscaler does not preserve the source ratio — it snaps to a
          multiple of 128, so 1376×768 comes back 2816×1536. Letterboxing each
          video independently then places the two pictures at different scales
          and offsets, and the wipe seam no longer matches: that is the
          misalignment. `cover` on the source trims the ~2% difference instead of
          rescaling the picture, so what meets at the divider is the same frame.
        */}
        <div
          style={{
            position: 'absolute',
            left: videoRect ? videoRect.left : 0,
            top: videoRect ? videoRect.top : 0,
            width: videoRect ? videoRect.width : '100%',
            height: videoRect ? videoRect.height : '100%',
          }}
        >
          {hasCompare && (
            <video
              {...NATIVE_VIDEO_CHROME_OFF}
              ref={beforeRef}
              src={beforeUrl!}
              crossOrigin="anonymous"
              loop muted playsInline
              style={{
                position: 'absolute', inset: 0,
                width: '100%', height: '100%',
                objectFit: 'cover',
                display: renderCompare ? 'block' : 'none',
                clipPath: `polygon(0 0, ${splitInPicture}% 0, ${splitInPicture}% 100%, 0 100%)`,
              }}
            />
          )}

          <video
            {...NATIVE_VIDEO_CHROME_OFF}
            ref={afterRef}
            src={afterUrl || undefined}
            crossOrigin="anonymous"
            loop playsInline
            // the result carries the sound; the source side stays muted
            muted={modalMuted}
            onTimeUpdate={handleAfterTimeUpdate}
            style={{
              position: 'absolute', inset: 0,
              width: '100%', height: '100%',
              objectFit: 'contain',
              clipPath: renderCompare
                ? `polygon(${splitInPicture}% 0, 100% 0, 100% 100%, ${splitInPicture}% 100%)`
                : 'none',
            }}
          />
        </div>

        {/* Current decoded frame: always visible over the picture, including
            while the transport controls are not being hovered. */}
        <div style={{
          position: 'absolute',
          top: renderCompare ? 52 : 16,
          right: 18,
          zIndex: 20,
          padding: '7px 12px',
          borderRadius: 8,
          background: 'rgba(0,0,0,0.72)',
          border: '1px solid rgba(255,255,255,0.22)',
          boxShadow: '0 4px 18px rgba(0,0,0,0.45)',
          backdropFilter: 'blur(8px)',
          color: '#fff',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 14,
          fontWeight: 650,
          fontVariantNumeric: 'tabular-nums',
          pointerEvents: 'none',
        }}>
          第 {currentFrame} 帧
        </div>

        {/* ── Divider (Only shown in compare mode) ───────────────────────────────── */}
        {renderCompare && (
          <div
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
            className="vc-divider"
            style={{
              position: 'absolute', top: 0, bottom: 0,
              left: `${split}%`, transform: 'translateX(-50%)',
              width: 48,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'ew-resize', zIndex: 10,
            }}
          >
            {/* Line */}
            <div style={{
              position: 'absolute', inset: '0 auto',
              left: '50%', transform: 'translateX(-50%)',
              width: 2,
              background: 'rgba(255,255,255,0.88)',
              pointerEvents: 'none',
            }} />
            {/* Knob */}
            <div style={{
              width: 44, height: 44, borderRadius: '50%',
              background: '#fff',
              boxShadow: '0 2px 16px rgba(0,0,0,0.55)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              position: 'relative', zIndex: 1, flexShrink: 0,
            }}>
              <svg width="20" height="14" viewBox="0 0 20 14" fill="none">
                <path d="M6 7H14M6 7L3 4M6 7L3 10M14 7L17 4M14 7L17 10"
                  stroke="#1a1a1a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
        )}

        {/* ── Corner labels (Only in compare mode) ────────────────────────── */}
        {renderCompare && (
          <>
            <div style={{
              position: 'absolute', top: 14, left: 14,
              padding: '4px 12px', borderRadius: 20,
              background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
              color: 'rgba(255,255,255,0.9)', fontSize: 11, fontWeight: 600,
              letterSpacing: '0.03em', pointerEvents: 'none',
              opacity: split > 10 ? 1 : 0, transition: 'opacity 0.2s',
            }}>{t('原始')}</div>

            <div style={{
              position: 'absolute', top: 14, right: 14,
              padding: '4px 12px', borderRadius: 20,
              background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
              color: 'rgba(255,255,255,0.9)', fontSize: 11, fontWeight: 600,
              letterSpacing: '0.03em', pointerEvents: 'none',
              opacity: split < 90 ? 1 : 0, transition: 'opacity 0.2s',
            }}>{t('处理后')}</div>
          </>
        )}

        {/* Click viewport to play/pause (not on slider divider) */}
        <div
          style={{ position: 'absolute', inset: 0, zIndex: 5, cursor: 'default' }}
          onClick={(e) => {
            // Avoid interception if clicking knob or close to divider
            const rect = e.currentTarget.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const splitX = (split / 100) * rect.width;
            if (renderCompare && Math.abs(clickX - splitX) < 24) {
              return;
            }
            togglePlay();
          }}
        />
      </div>

      {/* ── Bottom controls ─────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        width: 'min(90vw, 140vh)',
        marginTop: 16,
        padding: '0 4px',
      }}>
        {/* Progress Bar Row */}
        <div 
          onMouseDown={handleProgressMouseDown}
          onTouchStart={handleProgressTouchStart}
          style={{ 
            width: '100%', 
            height: 20, 
            display: 'flex', 
            alignItems: 'center', 
            cursor: 'pointer', 
            position: 'relative' 
          }}
        >
          {/* Track background */}
          <div style={{ width: '100%', height: 6, background: 'rgba(255,255,255,0.15)', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
            {/* Progress filled */}
            <div style={{ height: '100%', width: `${shotDuration ? (shotTime / shotDuration) * 100 : 0}%`, background: '#fff', borderRadius: 3, transition: 'width 0.1s' }} />
          </div>
          {/* Knob indicator */}
          <div style={{
            position: 'absolute',
            left: `${shotDuration ? (shotTime / shotDuration) * 100 : 0}%`,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: '#fff',
            transform: 'translateX(-50%)',
            boxShadow: '0 0 6px rgba(0,0,0,0.5)',
            pointerEvents: 'none',
          }} />
        </div>

        {/* Control Buttons Row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {/* Left Controls: Play/Pause, Frame stepping, Time display */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={togglePlay}
              style={{
                width: 36, height: 36, borderRadius: '50%',
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.15)',
                color: '#fff', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background 0.2s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.2)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
            >
              {isPlaying ? (
                <svg width="12" height="12" viewBox="0 0 14 14" fill="white">
                  <rect x="2" y="1" width="4" height="12" rx="1" />
                  <rect x="8" y="1" width="4" height="12" rx="1" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 14 14" fill="white">
                  <path d="M3 1.5L12.5 7L3 12.5V1.5Z" />
                </svg>
              )}
            </button>

            {/* Frame step backward */}
            <button
              onClick={() => stepFrame(-1)}
              title={t('上一帧 (D)')}
              style={{
                width: 32, height: 32, borderRadius: '50%',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: '#ccc', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background 0.2s, color 0.2s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 20L9 12L19 4V20Z" fill="currentColor"/>
                <line x1="5" y1="5" x2="5" y2="19" stroke="currentColor" strokeWidth="2.5" />
              </svg>
            </button>

            {/* Frame step forward */}
            <button
              onClick={() => stepFrame(1)}
              title={t('下一帧 (F)')}
              style={{
                width: 32, height: 32, borderRadius: '50%',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: '#ccc', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background 0.2s, color 0.2s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 4L15 12L5 20V4Z" fill="currentColor"/>
                <line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2.5" />
              </svg>
            </button>

            {/* Time display */}
            <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, fontFamily: 'monospace' }}>
              {fmt(shotTime)} / {fmt(shotDuration)}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12, fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>
              F {currentFrame} / {totalFrames - 1}
            </span>
          </div>

          {/* Right Controls: Compare Toggle, Shortcuts hint */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {/* Screenshot button (only if onCaptureFrame is provided) */}
            {onCaptureFrame && (
              <button
                onClick={handleCaptureClick}
                title={t('截取当前帧为新图像节点')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 14px', borderRadius: 18,
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 500,
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.18)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                <span>{t('拍照')}</span>
              </button>
            )}

            {/* Sound toggle */}
            <button
              onClick={() => setActiveAudioNodeId(modalMuted ? 'preview-modal' : null)}
              title={modalMuted ? t('取消静音') : t('静音')}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 14px', borderRadius: 18,
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.15)',
                color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 500,
              }}
            >
              <span>{modalMuted ? '🔇' : '🔊'}</span>
            </button>

            {afterUrl && (
              <button
                onClick={() => void startDownload()}
                disabled={download !== null}
                title={download ? t('正在下载，完成前请不要关闭页面') : t('下载视频')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 14px', borderRadius: 18,
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  color: '#fff', cursor: download ? 'progress' : 'pointer', fontSize: 12, fontWeight: 500,
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.18)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
                <span>{download ? t('下载中 {v1}', { v1: describeProgress(download.done, download.total) }) : t('下载')}</span>
              </button>
            )}

            {/* Compare toggle: only when there is something to compare */}
            {hasCompare && (
              <button
                onClick={() => setIsCompareActive(!isCompareActive)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 14px', borderRadius: 18,
                  background: isCompareActive ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.05)',
                  border: isCompareActive ? '1px solid rgba(255,255,255,0.3)' : '1px solid rgba(255,255,255,0.1)',
                  color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 500,
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => {
                  if (!isCompareActive) e.currentTarget.style.background = 'rgba(255,255,255,0.12)';
                }}
                onMouseLeave={(e) => {
                  if (!isCompareActive) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                }}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <rect x="1" y="2" width="4.5" height="9" rx="1" stroke="currentColor" strokeWidth="1.2" />
                  <rect x="7.5" y="2" width="4.5" height="9" rx="1" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M5.5 6.5H7.5M5.5 6.5L4.5 5.5M5.5 6.5L4.5 7.5M7.5 6.5L8.5 5.5M7.5 6.5L8.5 7.5"
                    stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{t('对比模式:')} {isCompareActive ? t('开') : t('关')}</span>
              </button>
            )}

            {/* Hint */}
            <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11 }}>
              
              {t('D/F 逐帧 · 空格 播/停 · ESC 关闭')}
            </span>
          </div>
        </div>
      </div>

      {/* ── Close button ──────────────────────────────────────────────── */}
      <button
        onClick={onClose}
        style={{
          position: 'absolute', top: 16, right: 16,
          width: 36, height: 36, borderRadius: '50%',
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.13)',
          color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 0.2s, color 0.2s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; e.currentTarget.style.color = '#fff'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
      >✕</button>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(content, document.body) : null;
}
