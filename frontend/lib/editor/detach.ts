import { t } from '../i18n';
import type { Clip, EditorAsset, Track } from './types';

/**
 * Which of the selected clips 分离音频 can take the sound from, and why it passed over the rest.
 *
 * It used to return without a word when nothing qualified, so a click that did nothing looked like a
 * broken button (the picture clip of 场4 C23b, already detached and muted, with its sound on an audio
 * lane: selecting either one and clicking did nothing).
 */
export type DetachSkip = 'title' | 'audioLane' | 'offline' | 'noAudio' | 'muted';

export interface DetachPlan {
  /** Clips the sound can be taken from. */
  sources: Clip[];
  /** What to tell the user: why nothing happened, or what was passed over. Null when all went through. */
  message: string | null;
}

function skipReason(
  clip: Clip,
  tracks: Track[],
  assets: Record<string, EditorAsset | undefined>,
): DetachSkip | null {
  if (clip.text) return 'title';
  const track = tracks.find((tr) => tr.id === clip.trackId);
  if (!track || track.kind !== 'video') return 'audioLane';
  const asset = assets[clip.assetId];
  if (asset?.offline) return 'offline';
  if (!asset?.hasAudio) return 'noAudio';
  if (clip.muted) return 'muted';
  return null;
}

const WHY: Record<DetachSkip, () => string> = {
  title: () => t('标题没有声音'),
  audioLane: () => t('音频轨上的片段本身就是单独的声音，不需要再分离'),
  offline: () => t('素材读取失败（离线），先让它重新读取'),
  noAudio: () => t('这个素材没有音轨'),
  muted: () => t('这一镜已经静音（分离过，或被手动静音），它的声音在音频轨上；想再分一份，先取消静音'),
};

export function planDetach(
  clips: Clip[],
  tracks: Track[],
  assets: Record<string, EditorAsset | undefined>,
  selection: string[],
): DetachPlan {
  const picked = clips.filter((c) => selection.includes(c.id));
  if (picked.length === 0) return { sources: [], message: t('先选中要分离声音的镜头') };

  const sources: Clip[] = [];
  const skipped = new Map<DetachSkip, number>();
  for (const clip of picked) {
    const why = skipReason(clip, tracks, assets);
    if (why) skipped.set(why, (skipped.get(why) || 0) + 1);
    else sources.push(clip);
  }
  if (skipped.size === 0) return { sources, message: null };

  // The reason that covers most of what was passed over; with ties, the first in the order above.
  const [why] = [...skipped.entries()].sort((a, b) => b[1] - a[1])[0];
  const total = [...skipped.values()].reduce((n, v) => n + v, 0);
  if (sources.length === 0) return { sources, message: WHY[why]() };
  return {
    sources,
    message: t('已分离 {v1} 段；另外 {v2} 段没有处理：{v3}', { v1: sources.length, v2: total, v3: WHY[why]() }),
  };
}
