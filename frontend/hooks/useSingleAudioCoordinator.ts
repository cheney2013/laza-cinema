'use client';
import { useEffect } from 'react';
import { useStore } from '@/lib/store';

/**
 * useSingleAudioCoordinator
 *
 * A global guard for media on the canvas, mounted once by InfiniteCanvas.
 * Three rules:
 *
 * 1. One thing plays at a time (2026-09-15). When a media element starts,
 *    every other playing element is paused -- except those in the same group:
 *    the tracks of one node (compare A/B) and the two
 *    sides of a preview modal play in lock-step and count as one video. A group
 *    is the nearest `[data-media-group]`, else the React Flow node, else the
 *    element itself.
 * 2. The next video inherits the last one's mute state. The owner of the sound
 *    is the `[data-media-group]` value if there is one (the preview modal uses
 *    "preview-modal"), else the node id; node videos, the chain preview and the
 *    modal all take
 *    `muted` from the store's `activeAudioNodeId`, and every sound button writes
 *    that value, so the remembered state is read off its changes (a node
 *    becoming active = unmuted, the active node going to null = muted) rather
 *    than off `volumechange`, which every video fires once on mount. When a
 *    canvas node starts playing, the remembered state is written back to the
 *    store for it; the coordinator's own writes are not recorded.
 * 3. At most one element produces sound: when one is un-muted, every other
 *    element is muted (the original safety net, for playback outside React).
 *
 * `[data-media-ambient]` elements (decorative loops such as a node's
 * generating-state background) are ignored by all three rules.
 */

const MUTE_KEY = 'ai_cinema_last_play_muted';

function readLastMuted(): boolean {
  try {
    const v = localStorage.getItem(MUTE_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

function writeLastMuted(muted: boolean) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {}
}

function groupOf(el: Element): Element {
  return el.closest('[data-media-group]') || el.closest('.react-flow__node') || el;
}

function isMedia(t: EventTarget | null): t is HTMLMediaElement {
  return t instanceof HTMLMediaElement && !t.closest('[data-media-ambient]');
}

export function useSingleAudioCoordinator() {
  useEffect(() => {
    let applying = false;

    const unsubscribe = useStore.subscribe((state, prev) => {
      if (applying || state.activeAudioNodeId === prev.activeAudioNodeId) return;
      if (state.activeAudioNodeId) writeLastMuted(false);
      else if (prev.activeAudioNodeId) writeLastMuted(true);
    });

    function handlePlay(e: Event) {
      const target = e.target;
      if (!isMedia(target)) return;
      const group = groupOf(target);

      for (const el of Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio'))) {
        if (el === target || el.paused || el.closest('[data-media-ambient]')) continue;
        if (groupOf(el) === group) continue;
        el.pause();
      }

      // who owns the sound: a marked group (the preview modal), else the node
      const nodeId =
        target.closest('[data-media-group]')?.getAttribute('data-media-group') ||
        target.closest('.react-flow__node')?.getAttribute('data-id');
      if (!nodeId) return;
      const { activeAudioNodeId, setActiveAudioNodeId } = useStore.getState();
      const next = readLastMuted() ? (activeAudioNodeId === nodeId ? null : activeAudioNodeId) : nodeId;
      if (next === activeAudioNodeId) return;
      applying = true;
      try {
        setActiveAudioNodeId(next);
      } finally {
        applying = false;
      }
    }

    function handleVolumeChange(e: Event) {
      const target = e.target;
      if (!isMedia(target) || target.muted) return;
      for (const el of Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio'))) {
        if (el !== target && !el.muted) el.muted = true;
      }
    }

    // Media events do not bubble; capture phase on the document still sees them.
    document.addEventListener('play', handlePlay, true);
    document.addEventListener('volumechange', handleVolumeChange, true);
    return () => {
      unsubscribe();
      document.removeEventListener('play', handlePlay, true);
      document.removeEventListener('volumechange', handleVolumeChange, true);
    };
  }, []);
}
