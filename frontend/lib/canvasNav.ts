import { create } from 'zustand';

/** A canvas viewport as React Flow keeps it. */
export interface NavViewport {
  x: number;
  y: number;
  zoom: number;
}

const MAX_TRAIL = 20;
/** Places closer than this (screen px) count as the same place. */
const SAME_PLACE_PX = 40;

/**
 * Where the user was before jumping somewhere else on the canvas, so "back" can
 * put them there again. A jump that starts where the last one started adds nothing:
 * hopping to and from the same neighbour must not build a staircase of identical steps.
 */
export function pushTrail(trail: NavViewport[], viewport: NavViewport): NavViewport[] {
  const last = trail[trail.length - 1];
  if (last && Math.hypot(last.x - viewport.x, last.y - viewport.y) < SAME_PLACE_PX && Math.abs(last.zoom - viewport.zoom) < 0.05) {
    return trail;
  }
  return [...trail, viewport].slice(-MAX_TRAIL);
}

interface CanvasNavState {
  trail: NavViewport[];
  /** Call with the viewport as it is BEFORE moving away. */
  remember: (viewport: NavViewport) => void;
  /** The most recent place, removed from the trail; null when there is none. */
  back: () => NavViewport | null;
  clear: () => void;
}

export const useCanvasNav = create<CanvasNavState>((set, get) => ({
  trail: [],
  remember: (viewport) => set((s) => ({ trail: pushTrail(s.trail, viewport) })),
  back: () => {
    const trail = get().trail;
    if (trail.length === 0) return null;
    set({ trail: trail.slice(0, -1) });
    return trail[trail.length - 1];
  },
  clear: () => set({ trail: [] }),
}));
