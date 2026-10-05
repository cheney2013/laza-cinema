import { create } from 'zustand';

import { api } from '../api';
import {
  type QualityChoice, type QualityLevel, TOP_LEVEL, effectiveLevel, isQualityChoice, previewUrlFor, proxyKey, stepDown,
} from './previewLevels';
import type { EditorAsset } from './types';

const STORAGE_KEY = 'cutroom.previewQuality';

function savedChoice(): QualityChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const value = raw === 'auto' ? raw : Number(raw);
    return isQualityChoice(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

interface PreviewQualityState {
  /** What the monitor menu says. A per-viewer preference, not part of the film. */
  choice: QualityChoice;
  /** Height in screen pixels of the monitor's picture, for auto. */
  displayHeight: number;
  /** Auto never goes above this: lowered when the machine drops frames, back to the top when the menu is touched. */
  autoCap: QualityLevel;
  /** Built low-level proxies by proxyKey. */
  built: Record<string, string>;
  setChoice: (choice: QualityChoice) => void;
  setDisplayHeight: (px: number) => void;
  /** The machine is dropping frames: hold auto one level lower. Returns the new cap. */
  stepAutoDown: () => QualityLevel;
}

export const usePreviewQuality = create<PreviewQualityState>((set, get) => ({
  choice: 'auto',
  displayHeight: 1080,
  autoCap: TOP_LEVEL,
  built: {},
  setChoice: (choice) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(choice));
    } catch {
      /* a preference only */
    }
    set({ choice, autoCap: TOP_LEVEL });
  },
  setDisplayHeight: (px) => {
    const rounded = Math.round(px / 20) * 20;
    if (rounded !== get().displayHeight && rounded > 0) set({ displayHeight: rounded });
  },
  stepAutoDown: () => {
    // One below what is playing now, not below the old cap: with a small monitor the cap is above the
    // level in use, and lowering it there would change nothing while using up the steps.
    const { choice, displayHeight, autoCap } = get();
    const next = stepDown(effectiveLevel(choice, displayHeight, autoCap));
    set({ autoCap: next });
    return next;
  },
}));

/** Read the saved choice once the page is in a browser (not at import: this module is also loaded on the server). */
export function restoreChoice(): void {
  usePreviewQuality.setState({ choice: savedChoice() });
}

export const currentLevel = (): QualityLevel => {
  const s = usePreviewQuality.getState();
  return effectiveLevel(s.choice, s.displayHeight, s.autoCap);
};

/** The file the monitor plays for this asset at the level in force now. */
export function previewUrl(asset: EditorAsset): string {
  return asset.kind === 'video' ? previewUrlFor(asset, currentLevel(), usePreviewQuality.getState().built) : asset.url;
}

const inFlight = new Set<string>();
const failed = new Set<string>();

/** Build (or fetch) the proxies this level needs for these videos; each shows up in `built` as it lands. */
export async function ensureProxies(assets: EditorAsset[], level: QualityLevel): Promise<void> {
  const wanted = assets.filter(
    (a) => a.kind === 'video' && !a.offline && a.height > level && level < TOP_LEVEL
  );
  await Promise.all(
    wanted.map(async (asset) => {
      const key = proxyKey(asset.url, level);
      if (usePreviewQuality.getState().built[key] || inFlight.has(key) || failed.has(key)) return;
      inFlight.add(key);
      try {
        const { proxy_url } = await api.buildProxyLevel(asset.url, level);
        usePreviewQuality.setState((s) => ({ built: { ...s.built, [key]: proxy_url } }));
      } catch {
        failed.add(key); // the standard proxy keeps playing; not retried this session
      } finally {
        inFlight.delete(key);
      }
    })
  );
}
