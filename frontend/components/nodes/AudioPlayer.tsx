'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';

/**
 * Player for a node whose output is sound alone: play/pause, seek, time.
 *
 * Deliberately no mute or volume. The native <audio controls> carries both, and
 * on a node that is nothing but a sound they only offer a way to play it silently.
 */
export default function AudioPlayer({
  src,
  paused,
  onDuration,
  autoPlay,
  className,
  toggleRef,
  onPlayingChange,
  knownDuration,
}: {
  src: string;
  /** Stops playback while true, e.g. when a preview modal takes over. */
  paused?: boolean;
  onDuration?: (seconds: number) => void;
  autoPlay?: boolean;
  className?: string;
  /** Filled with this player's play/pause, for a second control (the outline-mode button). */
  toggleRef?: MutableRefObject<(() => void) | null>;
  onPlayingChange?: (playing: boolean) => void;
  /** Length already on record. With it the clip is not fetched until played
   *  (preload none): a canvas of 34 voice strips downloaded every wav on open. */
  knownDuration?: number;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(knownDuration && knownDuration > 0 ? knownDuration : 0);

  useEffect(() => {
    if (paused) ref.current?.pause();
  }, [paused]);

  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  if (toggleRef) toggleRef.current = toggle;
  useEffect(() => { onPlayingChange?.(playing); }, [playing, onPlayingChange]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  return (
    <div className={`nodrag flex w-full items-center gap-2 ${className ?? ''}`} onClick={(e) => e.stopPropagation()}>
      <audio
        ref={ref}
        src={src}
        preload={knownDuration && knownDuration > 0 ? 'none' : 'metadata'}
        autoPlay={autoPlay}
        onPlay={(e) => {
          // useSingleAudioCoordinator mutes every other element whenever one
          // un-mutes, and this player has no button to undo that, so it would
          // play silently from then on. Starting it is the request for sound;
          // un-muting here makes the coordinator mute the rest instead.
          e.currentTarget.muted = false;
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) {
            setDuration(d);
            onDuration?.(d);
          }
        }}
      />
      <button
        type="button"
        onClick={toggle}
        title={playing ? 'Pause' : 'Play'}
        className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
      >
        {playing ? (
          <svg width="12" height="12" viewBox="0 0 11 11" fill="currentColor">
            <rect x="2" y="1.5" width="2.8" height="8" rx="1" />
            <rect x="6.2" y="1.5" width="2.8" height="8" rx="1" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 11 11" fill="currentColor"><path d="M2.5 1.5l7 4-7 4V1.5z" /></svg>
        )}
      </button>
      <div
        className="relative flex h-6 flex-1 cursor-pointer items-center"
        onClick={(e) => {
          const a = ref.current;
          if (!a || !duration) return;
          const rect = e.currentTarget.getBoundingClientRect();
          a.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration;
          setTime(a.currentTime);
        }}
      >
        <div className="h-1 w-full overflow-hidden rounded bg-white/15">
          <div className="h-full rounded bg-white/85" style={{ width: `${duration ? (time / duration) * 100 : 0}%` }} />
        </div>
      </div>
      <span className="flex-none font-mono text-[10px] text-white/50">
        {fmt(time)} / {fmt(duration)}
      </span>
    </div>
  );
}
