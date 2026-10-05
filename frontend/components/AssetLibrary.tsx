'use client';

import { dropDeletedFromTimelines } from '@/lib/editor/afterDelete';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';

import { api, type Asset } from '@/lib/api';
import { describeRestored, restoredNodeData } from '@/lib/assetProvenance';
import { type AssetUsage, type UsageSequence, buildUsageIndex, liveCount } from '@/lib/assetUsage';
import { resolveAssetUrl } from '@/lib/config';
import { probeVideo, useVideoProbe } from '@/lib/videoProbe';
import { showConfirm } from '@/components/ui/Dialog';
import VideoPreviewModal from '@/components/nodes/VideoPreviewModal';
import { useFrameGrab } from '@/lib/frameGrab';
import { useCutRoom } from '@/lib/editor/store';
import type { Timeline } from '@/lib/editor/types';
import { useStore } from '@/lib/store';
import { useBackdropDismiss } from '@/lib/useBackdropDismiss';

import type { Node as FlowNode } from '@xyflow/react';
import { t } from '@/lib/i18n';
import AudioPlayer from './nodes/AudioPlayer';
const EMPTY_NODES: FlowNode[] = [];

/**
 * The asset library: every file this project has generated, and who still uses it.
 *
 * Nothing is deleted automatically any more. That makes the reference badge the
 * most important thing on each card — it is the only warning before a clip goes,
 * and a clip takes its latent with it, which is where the disk space actually is.
 */

type Filter = 'all' | 'video' | 'image' | 'audio' | 'unused';

/** How many cards the grid adds at a time. */
const CARD_BATCH = 60;

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'video', label: '视频' },
  { id: 'image', label: '图片' },
  { id: 'audio', label: '音频' },
  { id: 'unused', label: '未使用' },
];

function formatSize(bytes: number): string {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(2)} GB`;
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * How long a clip runs. Read off the same probe the card already does for its
 * poster and resolution — nothing records a duration server side.
 *
 * Under a minute it is the number of seconds, because that is the unit shots are
 * cut in; past that it becomes m:ss, where counting seconds stops being useful.
 */
function formatDuration(seconds: number): string {
  if (!(seconds > 0)) return '';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function formatDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Resolution is read off the rendered element — nothing records it server side,
 *  and the card already loads the media anyway. */
function useNaturalSize() {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const onImage = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.currentTarget;
    if (el.naturalWidth) setSize({ w: el.naturalWidth, h: el.naturalHeight });
  }, []);
  const onVideo = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const el = e.currentTarget;
    if (el.videoWidth) setSize({ w: el.videoWidth, h: el.videoHeight });
  }, []);
  return { size, onImage, onVideo };
}

/**
 * Natural size (and duration, for a clip) of an asset already on the backend.
 *
 * Every other path that builds a media node — 抽帧, 重构, 补帧 — hands over the
 * dimensions it already has. This one starts from a URL, so it asks the browser
 * first: a node born without a size renders into a 16:9 guess and only settles
 * once the element reports back, and until then the box does not match the
 * picture it is holding. Anything unreadable resolves empty and the node falls
 * back to the guess, exactly as before.
 */
async function probeAsset(
  url: string,
  kind: Asset['kind']
): Promise<{ width?: number; height?: number; duration?: number }> {
  if (kind === 'audio') {
    // Duration only, through the shared probe (no lingering player).
    const p = await probeVideo(resolveAssetUrl(url), 'audio');
    return { duration: p.seconds || undefined };
  }
  if (kind !== 'video' && kind !== 'image') return {};
  return new Promise((resolve) => {
    const src = resolveAssetUrl(url);
    const timer = setTimeout(() => resolve({}), 4000);
    const done = (result: { width?: number; height?: number; duration?: number }) => {
      clearTimeout(timer);
      resolve(result);
    };
    if (kind === 'image') {
      const image = new Image();
      image.onload = () => done({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => done({});
      image.src = src;
      return;
    }
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () =>
      done({
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        duration: Number.isFinite(video.duration) ? video.duration : undefined,
      });
    video.onerror = () => done({});
    video.src = src;
  });
}

/**
 * The generation context a clip carries in its own metadata, restored onto the
 * node that carries it back to the canvas. See `lib/assetProvenance`: the goal
 * is parity with the node that made it, so an upscale of a re-placed clip lands
 * where an upscale from the original node would have.
 */
async function recoverProvenance(
  asset: Asset,
  probed: { width?: number; height?: number; duration?: number }
): Promise<{ data: Record<string, unknown>; note: string }> {
  if (asset.kind !== 'video') {
    return { data: { width: probed.width, height: probed.height, duration: probed.duration }, note: '' };
  }
  try {
    const found = await api.assetProvenance(asset.name);
    return { data: restoredNodeData(found, probed), note: describeRestored(found) };
  } catch {
    // Provenance is a bonus, never a reason to fail putting an asset on the
    // canvas. An older backend has no such endpoint at all.
    return { data: { width: probed.width, height: probed.height, duration: probed.duration }, note: '' };
  }
}

function AssetLibrary({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const grabFrame = useFrameGrab();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [totals, setTotals] = useState({
    total: 0,
    unusedCount: 0,
    unusedBytes: 0,
    orphanLatents: 0,
    orphanLatentBytes: 0,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Deletion is behind a switch. Browsing is the common case, and a grid where
  // every click arms a delete is a grid you stop trusting.
  const [managing, setManaging] = useState(false);
  // Off by default: the library is a project's own shelf. Turned on for a
  // cleanup pass, when the question is what is on the disk rather than what
  // belongs here.
  const [allProjects, setAllProjects] = useState(false);
  /** The asset opened full size. Browsing is what the library is for; a click
   *  should show you the shot, not just its thumbnail. */
  const [preview, setPreview] = useState<Asset | null>(null);
  /** Outcome of the last cleanup, reported in place. */
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const projectId = useStore((s) => s.currentProjectId);
  const projectName = useStore((s) => s.currentProjectName);
  const dismiss = useBackdropDismiss(onClose);
  const { screenToFlowPosition, setCenter } = useReactFlow();
  // While closed the dialog renders nothing, so it must not re-render (and
  // rebuild the usage index) on every node change either.
  const nodes = useStore((s) => (isOpen ? s.nodes : EMPTY_NODES));
  /**
   * The cut's own timeline. `undefined` means we have not been able to look —
   * the difference matters: an asset used only in the cut would otherwise read
   * as used nowhere, which is exactly the reading that gets a live file deleted.
   */
  const [cutTimeline, setCutTimeline] = useState<UsageSequence[] | undefined>(undefined);
  // Successive drops fan out instead of landing on top of each other.
  const dropCountRef = useRef(0);
  // Where the grid was scrolled to. The dialog renders nothing while closed, so
  // the scroll container is destroyed and its position has to be carried by
  // hand -- otherwise going out to the cut room and back lands you at the top of
  // a wall of two hundred thumbnails.
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  // A library can hold thousands of files. Putting every card in the page at once made a phone
  // lay out and paint a 130,000-node tree on each scroll step, so only the first batch is in the
  // page and the next one is added as the end comes within reach (never removed: the scroll
  // position the dialog restores stays valid).
  const [shown, setShown] = useState(CARD_BATCH);
  const moreRef = useRef<HTMLDivElement>(null);

  // Every film in the project counts. For the ones the cut room holds open, its
  // in-memory copy wins: it has the edits autosave has not written yet.
  useEffect(() => {
    if (!isOpen || !projectId) return;
    let cancelled = false;
    api
      .listSequences(projectId, true)
      .then(({ sequences }) => {
        if (cancelled) return;
        const cut = useCutRoom.getState();
        const held = cut.projectId === projectId;
        setCutTimeline(
          sequences.flatMap((q) => {
            const live = !held
              ? null
              : q.id === cut.activeSeqId
                ? cut.timeline
                : cut.sessions[q.id]?.timeline ?? null;
            const timeline = live ?? (q.timeline as Timeline | null);
            return timeline ? [{ seqId: q.id, name: q.name, timeline }] : [];
          })
        );
      })
      .catch(() => {
        if (!cancelled) setCutTimeline(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectId]);

  const usageIndex = useMemo(
    () => buildUsageIndex(nodes, cutTimeline ?? null),
    [nodes, cutTimeline]
  );

  /** Close the library and put the referencing node or clip in front of the user. */
  const locate = useCallback(
    (usage: AssetUsage) => {
      if (usage.kind === 'clip') {
        window.dispatchEvent(new CustomEvent('openCutRoomAtClip', { detail: { clipId: usage.id, seqId: usage.seqId } }));
        onClose();
        return;
      }
      const node = useStore.getState().nodes.find((n) => n.id === usage.id);
      if (!node) return;
      const width = node.measured?.width ?? node.width ?? 300;
      const height = node.measured?.height ?? node.height ?? 300;
      // Selecting it is the highlight: a centred viewport alone still leaves the
      // eye hunting on a dense canvas, and selection already draws a glow.
      useStore
        .getState()
        .setNodes(useStore.getState().nodes.map((n) => ({ ...n, selected: n.id === usage.id })));
      setCenter(node.position.x + width / 2, node.position.y + height / 2, {
        zoom: 1.1,
        duration: 400,
      });
      onClose();
    },
    [onClose, setCenter]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listAssets(projectId, allProjects);
      setAssets(data.assets);
      setTotals({
        total: data.total_bytes,
        unusedCount: data.unused_count,
        unusedBytes: data.unused_bytes,
        orphanLatents: data.orphan_latent_count,
        orphanLatentBytes: data.orphan_latent_bytes,
      });
      setSelected((current) => {
        const alive = new Set(data.assets.map((a) => a.name));
        return new Set([...current].filter((name) => alive.has(name)));
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, allProjects]);

  // Management mode is per-visit, not remembered. The dialog is never unmounted
  // — it only renders nothing while closed — so without this it reopens armed
  // for deletion, with the card actions hidden and nothing saying why.
  useEffect(() => {
    if (!isOpen) return;
    setManaging(false);
    setSelected(new Set());
    setPreview(null);
    setNotice(null);
    void refresh();
  }, [isOpen, refresh]);

  // After the grid has been re-created and filled, put it back where it was.
  useEffect(() => {
    if (!isOpen || !gridRef.current) return;
    gridRef.current.scrollTop = scrollTopRef.current;
  }, [isOpen, assets]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (preview) setPreview(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, preview]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return assets.filter((asset) => {
      if (filter === 'unused' && asset.referenced) return false;
      if (filter !== 'all' && filter !== 'unused' && asset.kind !== filter) return false;
      if (needle && !asset.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [assets, filter, query]);

  // A different list starts from its first batch again.
  useEffect(() => {
    setShown(CARD_BATCH);
  }, [filter, query, allProjects]);

  // When the end of what is in the page comes within about two screens, add the next batch. The
  // observer is rebuilt after each batch, so a short list on a tall screen keeps filling until it
  // is out of reach.
  useEffect(() => {
    if (!isOpen || shown >= visible.length) return;
    const el = moreRef.current;
    const root = gridRef.current;
    if (!el || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((n) => n + CARD_BATCH);
      },
      { root, rootMargin: '1500px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [isOpen, shown, visible.length]);

  const selectedAssets = useMemo(
    () => assets.filter((a) => selected.has(a.name)),
    [assets, selected]
  );
  const selectedBytes = selectedAssets.reduce((sum, a) => sum + a.size + a.companion_size, 0);
  const selectedReferenced = selectedAssets.filter((a) => a.referenced).length;

  // Every click toggles one card, the way a checkbox grid does. Cleanup is a
  // multi-select job by nature; a click that silently dropped the rest of the
  // selection would cost more than it saves.
  const toggle = (name: string) => {
    if (!managing) return;
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  };

  // The confirmation before a delete is worth stopping for; the receipt after one
  // is not. The result lands in the header, where the numbers it reports already
  // are, and a success line clears itself.
  const report = (tone: 'ok' | 'error', text: string) => {
    setNotice({ tone, text });
    if (tone === 'ok') window.setTimeout(() => setNotice(null), 6000);
  };

  const runDelete = async (body: { names?: string[]; unused?: boolean }, confirmText: string) => {
    if (!(await showConfirm(confirmText, { title: t('清理素材'), confirmText: t('删除'), danger: true }))) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.deleteAssets(body);
      await dropDeletedFromTimelines(result.deleted);
      await refresh();
      setSelected(new Set());
      report(
        'ok',
        t('已删除 {n} 个文件，释放 {size}', { n: result.deleted.length, size: formatSize(result.freed_bytes) }) +
          (result.skipped.length ? t(' · {n} 个未能删除（可能正被占用）', { n: result.skipped.length }) : '')
      );
    } catch (e) {
      report('error', t('清理失败：{error}', { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  /** Put an asset on the canvas as an upload node, the way 抽帧 does. */
  const sendToCanvas = async (asset: Asset) => {
    const centre = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    const offset = (dropCountRef.current++ % 6) * 48;
    const probed = await probeAsset(asset.url, asset.kind);
    const provenance = await recoverProvenance(asset, probed);
    const { width, height } = { width: probed.width, height: probed.height };
    window.dispatchEvent(new Event('takeSnapshot'));
    // React Flow v12 measures a node that declares no size, and the node's own
    // box is what the media is drawn into — so the size goes on the node, not
    // only in `data`, the same as every other node this app builds.
    const boxWidth = 240;
    // Sound has no picture to size the box from; the upload node draws a fixed
    // player strip for it, so give it that height rather than no size at all.
    const boxHeight =
      asset.kind === 'audio'
        ? 120
        : width && height ? 32 + Math.min(Math.round((boxWidth * height) / width), 480) : undefined;
    useStore.getState().setNodes([
      ...useStore.getState().nodes,
      {
        id: `image-${Date.now()}`,
        type: 'image',
        position: { x: centre.x + offset, y: centre.y + offset },
        // The canvas stores backend-relative paths; resolveAssetUrl adds the host.
        data: { url: asset.url, mediaType: asset.kind, ...provenance.data },
        ...(boxHeight ? { width: boxWidth, height: boxHeight } : {}),
      },
    ]);
    report('ok', t('已放到画布：{name}{note}', { name: asset.name, note: provenance.note }));
  };

  /** Hand one clip to the cut room on a timeline of its own. */
  const editAlone = (asset: Asset) => {
    window.dispatchEvent(new CustomEvent('openCutRoomWithAsset', { detail: asset }));
    onClose();
  };

  const deleteSelected = () => {
    const latents = selectedAssets.filter((a) => a.companions.length > 0).length;
    void runDelete(
      { names: [...selected] },
      t('删除选中的 {n} 个素材（{size}）？', { n: selected.size, size: formatSize(selectedBytes) }) +
        (latents ? t('\n其中 {n} 个视频会连同潜空间文件一起删除。', { n: latents }) : '') +
        (selectedReferenced ? t('\n注意：{n} 个仍被项目引用，删除后画布上会变成缺失素材。', { n: selectedReferenced }) : '')
    );
  };

  const cleanUnused = () => {
    void runDelete(
      { unused: true },
      t('删除全部 {n} 个未被任何项目引用的素材，释放约 {size}？\n', { n: totals.unusedCount, size: formatSize(totals.unusedBytes) }) +
        t('对应的潜空间文件会一并删除。')
    );
  };

  /**
   * Every render a node ever made stays in its takes[] and counts as "in use",
   * so it never shows up as unused. This removes the superseded ones that nothing
   * else holds -- the take entries first, then the files -- across every project
   * that lists them.
   */
  const cleanHistory = async () => {
    if (!projectId) return;
    setBusy(true);
    setNotice(null);
    try {
      const plan = await api.planTakeHistory(projectId);
      if (plan.files.length === 0) {
        report('ok', t('没有可清理的历史版本') +
          (plan.kept_in_use ? t(' · {n} 个旧版本仍被其他节点或时间线使用，已保留', { n: plan.kept_in_use }) : ''));
        return;
      }
      const others = plan.other_project_names;
      const ok = await showConfirm(
        t('删除 {nodes} 个节点的 {takes} 个历史版本（{files} 个文件，含潜空间约 {size}）？\n', {
          nodes: plan.nodes.filter((n) => n.project_id === projectId).length,
          takes: plan.take_count,
          files: plan.files.length + plan.companions.length,
          size: formatSize(plan.bytes),
        }) +
          t('每个节点当前显示的版本不动；被其他节点、剪辑时间线引用的旧版本也保留。') +
          (plan.kept_in_use ? t('\n{n} 个旧版本仍在使用，已跳过。', { n: plan.kept_in_use }) : '') +
          (others.length ? t('\n这些文件也出现在「{names}」的节点历史里，会一并从那边移除。', { names: others.join('」「') }) : ''),
        { title: t('清理节点历史版本'), confirmText: t('删除'), danger: true }
      );
      if (!ok) return;
      const result = await api.cleanTakeHistory(projectId);
      await refresh();
      report('ok', t('已删除 {takes} 个历史版本、{n} 个文件，释放 {size}', {
        takes: result.take_count, n: result.deleted.length, size: formatSize(result.freed_bytes),
      }));
    } catch (e) {
      report('error', t('清理失败：{error}', { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md sm:p-6"
      {...dismiss}
    >
      <div
        className="flex h-[100dvh] w-full max-w-6xl flex-col overflow-hidden border-white/10 shadow-2xl sm:h-[86vh] sm:rounded-2xl sm:border"
        style={{ background: 'rgba(14, 14, 20, 0.97)' }}
      >
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-white/10 px-3 py-2 sm:px-4 sm:py-2.5">
          <span className="text-sm font-bold tracking-wide text-white">{t('🗂 素材库')}</span>
          <span className="text-xs text-zinc-400">{projectName}</span>
          <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
            {t('{count} 个素材 · {total} · 未使用 {unused} 个（{unusedSize}）', {
              count: assets.length,
              total: formatSize(totals.total),
              unused: totals.unusedCount,
              unusedSize: formatSize(totals.unusedBytes),
            })}
            {totals.orphanLatents > 0 &&
              t(' · 含 {n} 个孤儿潜空间（{size}）', {
              n: totals.orphanLatents,
              size: formatSize(totals.orphanLatentBytes),
            })}
          </span>
          {notice && (
            <span
              role="status"
              className={`flex items-center gap-2 rounded-lg px-2 py-1 text-[11px] ${
                notice.tone === 'ok'
                  ? 'bg-emerald-500/15 text-emerald-200'
                  : 'bg-rose-500/15 text-rose-200'
              }`}
            >
              {notice.text}
              <button onClick={() => setNotice(null)} className="opacity-60 hover:opacity-100" title={t('关闭提示')}>
                ×
              </button>
            </span>
          )}

          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <button
              onClick={() => void refresh()}
              disabled={loading || busy}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.08] disabled:opacity-40"
            >
              {loading ? t('扫描中…') : t('刷新')}
            </button>
            {managing && (
              <>
                <button
                  onClick={deleteSelected}
                  disabled={busy || selected.size === 0}
                  className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-200 hover:bg-rose-500/20 disabled:opacity-40"
                >
                  
                  {t('删除选中')} {selected.size > 0 ? `(${selected.size} · ${formatSize(selectedBytes)})` : ''}
                </button>
                <button
                  onClick={cleanUnused}
                  disabled={busy || totals.unusedCount === 0}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200 hover:bg-amber-500/20 disabled:opacity-40"
                >
                  
                  {t('一键清理未使用')}
                </button>
                <button
                  onClick={() => void cleanHistory()}
                  disabled={busy || !projectId}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200 hover:bg-amber-500/20 disabled:opacity-40"
                  title={t('删除本项目节点里已被新版本取代、且没有别处使用的历史版本文件')}
                >
                  {t('清理节点历史版本')}
                </button>
              </>
            )}
            <button
              onClick={() => {
                setManaging((on) => !on);
                setSelected(new Set());
                setPreview(null);
              }}
              disabled={busy}
              className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40 ${
                managing
                  ? 'border-rose-400/60 bg-rose-500/20 text-rose-100'
                  : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]'
              }`}
              title={managing ? t('退出管理模式') : t('进入管理模式，选中并清理素材')}
            >
              {managing ? t('退出管理') : t('管理')}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.08]"
            >
              
              {t('关闭')}
            </button>
          </div>
        </div>

        {/* ── Filters ─────────────────────────────────────────────────── */}
        <div className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-white/10 px-3 py-2 sm:px-4">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              onClick={() => setFilter(option.id)}
              className={`rounded-lg px-2 py-1 text-[11px] transition-colors ${
                filter === option.id
                  ? 'bg-white/15 text-white'
                  : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
              }`}
            >
              {t(option.label)}
            </button>
          ))}
          <button
            onClick={() => setAllProjects((v) => !v)}
            title={t('显示其它项目生成的素材')}
            className={`ml-1 rounded-lg px-2 py-1 text-[11px] transition-colors ${
              allProjects
                ? 'bg-white/15 text-white'
                : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
            }`}
          >
            
            {t('跨项目')}
          </button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
            onBlur={() => window.dispatchEvent(new Event('inputBlurred'))}
            placeholder={t('按文件名搜索')}
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-base text-zinc-200 outline-none focus:border-white/25 sm:ml-2 sm:w-48 sm:flex-none sm:text-[11px]"
          />
          <span className="ml-auto hidden font-mono text-[10px] text-zinc-600 sm:inline">
            {visible.length}  {t('项 ·')}{' '}
            {managing ? t('点击卡片选中或取消') : t('点击放大查看，点“管理”开始清理')} ·{' '}
            {allProjects ? t('正在显示所有项目的素材') : t('本项目的素材，加上来历不明的旧文件')}
          </span>
          {managing && visible.length > 0 && (
            <button
              onClick={() =>
                setSelected((current) =>
                  visible.every((a) => current.has(a.name))
                    ? new Set()
                    : new Set(visible.map((a) => a.name))
                )
              }
              className="text-[11px] text-zinc-400 hover:text-white"
            >
              {visible.every((a) => selected.has(a.name)) ? t('取消全选') : t('全选当前')}
            </button>
          )}
        </div>

        {/* ── Grid ────────────────────────────────────────────────────── */}
        <div
          ref={gridRef}
          onScroll={(e) => {
            scrollTopRef.current = e.currentTarget.scrollTop;
          }}
          className="min-h-0 flex-1 overflow-y-auto p-3"
        >
          {error && <p className="p-4 text-xs text-rose-300">{t('读取素材失败：')}{error}</p>}
          {!error && visible.length === 0 && (
            <p className="p-6 text-center text-xs text-zinc-600">
              {loading ? t('正在扫描输出目录…') : t('这里没有符合条件的素材。')}
            </p>
          )}
          {/* A grid, so the list reads the way it is sorted: left to right, then
              down. CSS columns filled each column top-to-bottom instead, which
              put the newest asset next to the oldest. Cards still keep their own
              aspect ratio — `items-start` stops a row from stretching a 16:9
              card to the height of a 9:16 one. */}
          <div className="grid grid-cols-2 items-start gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visible.slice(0, shown).map((asset) => (
              <AssetCard
                key={asset.name}
                asset={asset}
                managing={managing}
                selected={selected.has(asset.name)}
                onToggle={() => toggle(asset.name)}
                onOpen={() => setPreview(asset)}
                onSendToCanvas={() => void sendToCanvas(asset)}
                onEdit={() => editAlone(asset)}
                usages={usageIndex.get(asset.name) ?? []}
                otherProjects={asset.projects.filter((p) => p.id !== projectId).map((p) => p.name)}
                originProject={
                  asset.origin_project && asset.origin_project !== projectId
                    ? asset.origin_project_name ?? asset.origin_project
                    : null
                }
                cutKnown={cutTimeline !== undefined}
                onLocate={locate}
              />
            ))}
          </div>
          {shown < visible.length && (
            <div ref={moreRef} className="py-4 text-center text-[11px] text-zinc-600">
              {t('已显示 {v1} / {v2} 项，往下滑会继续加载', { v1: shown, v2: visible.length })}
            </div>
          )}
        </div>
      </div>

      {preview && preview.kind === 'video' ? (
        // The studio's own viewer, the one every canvas node opens: D/F frame
        // stepping, speed, loop and 抽帧 all come with it.
        <VideoPreviewModal
          beforeUrl={null}
          afterUrl={resolveAssetUrl(preview.url)}
          downloadName={preview.name}
          onClose={() => setPreview(null)}
          onCaptureFrame={(video) =>
            void grabFrame(video).then((nodeId) => {
              if (nodeId) setPreview(null);
            })
          }
        />
      ) : (
        preview && <AssetPreview asset={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

/** Full-size look at one asset. Video plays, stills just get room to breathe. */
function AssetPreview({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const dismiss = useBackdropDismiss(onClose);
  const url = resolveAssetUrl(asset.url);
  const { size, onImage } = useNaturalSize();
  // Read off the player that is open anyway, so the sheet says the same thing
  // the card does.
  const [seconds, setSeconds] = useState(0);
  const viewerDuration = formatDuration(seconds);

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/90 p-6"
      {...dismiss}
    >
      {asset.kind === 'video' ? (
        // Videos open in VideoPreviewModal instead; see the caller.
        null
      ) : asset.kind === 'audio' ? (
        // One player, mounted only while the sheet is open — the same rule that
        // keeps the grid under Chrome's media-player cap.
        <div className="flex w-[min(92vw,640px)] flex-col items-center gap-4 rounded-lg bg-zinc-900/80 p-8 shadow-2xl">
          <span className="text-sky-300/80">
            <KindIcon kind="audio" size={56} />
          </span>
          <AudioPlayer src={url} autoPlay onDuration={setSeconds} />
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={asset.name}
          className="max-h-[82vh] max-w-full rounded-lg shadow-2xl"
          onLoad={onImage}
        />
      )}
      <div className="pointer-events-none flex items-center gap-3 font-mono text-[11px] text-zinc-400">
        <span>{asset.name}</span>
        {size && <span>{size.w}×{size.h}</span>}
        {viewerDuration && <span>{viewerDuration}</span>}
        <span className={asset.referenced ? 'text-emerald-300' : 'text-amber-300'}>
          {asset.referenced ? t('已引用') : t('未使用')}
        </span>
        <span className="text-zinc-600">{t('Esc 关闭')}</span>
      </div>
    </div>
  );
}

/**
 * Type marks are drawn, not typed.
 *
 * 🎞 and 🖼 are near-identical at badge size — same rounded rectangle, same
 * muted fill, and the renderer picks whatever the platform ships. These are
 * drawn instead, and told apart by silhouette alone: a play triangle against a
 * picture frame, at one weight and one colour.
 */
const KIND_META: Record<Asset['kind'], { label: string; path: React.ReactNode }> = {
  video: {
    label: '视频',
    path: (
      <>
        <rect x="2" y="4" width="20" height="16" rx="2.5" />
        <path d="M10 9.2v5.6l4.6-2.8z" fill="currentColor" stroke="none" />
      </>
    ),
  },
  image: {
    label: '图片',
    path: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <circle cx="8.5" cy="9.5" r="1.6" fill="currentColor" stroke="none" />
        <path d="M4 17.5l4.8-5 3.4 3.4 2.9-2.4 4.9 4" />
      </>
    ),
  },
  audio: {
    label: '音频',
    path: <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />,
  },
  latent: {
    label: '潜空间',
    path: (
      <>
        <path d="M12 3l9 5-9 5-9-5 9-5z" />
        <path d="M3 12l9 5 9-5M3 16l9 5 9-5" />
      </>
    ),
  },
  model: {
    label: '模型',
    path: (
      <>
        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
        <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
      </>
    ),
  },
};

/** A crosshair: the badge's promise is "I can take you there". */
function LocateIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="6" />
      <path d="M12 1v3M12 20v3M1 12h3M20 12h3" />
    </svg>
  );
}

/** A canvas node. */
function BoardIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </svg>
  );
}

/** A clip in the cut. */
function FilmIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M8 4v16M16 4v16" />
    </svg>
  );
}

function KindIcon({ kind, size = 15 }: { kind: Asset['kind']; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-white"
      aria-hidden="true"
    >
      {KIND_META[kind].path}
    </svg>
  );
}

function AssetCard({
  asset,
  managing,
  selected,
  onToggle,
  onOpen,
  onSendToCanvas,
  onEdit,
  usages,
  otherProjects,
  originProject,
  cutKnown,
  onLocate,
}: {
  asset: Asset;
  managing: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onSendToCanvas: () => void;
  onEdit: () => void;
  /** Nodes and clips in this project that point at the file. */
  usages: AssetUsage[];
  /** Other projects using it. Shown, never navigated to — jumping there costs a
   *  project switch and a canvas reload, and the delete warning already says it. */
  otherProjects: string[];
  /** Name of the project that made it, when that was not this one. */
  originProject: string | null;
  /** Whether the cut's timeline could be read at all. */
  cutKnown: boolean;
  onLocate: (usage: AssetUsage) => void;
}) {
  const url = resolveAssetUrl(asset.url);
  // Audio opens too (2026-09-06): a voice-reference bin is useless if the only
  // way to hear a clip is to drag it onto the timeline first.
  const viewable = asset.kind === 'video' || asset.kind === 'image' || asset.kind === 'audio';
  const kind = KIND_META[asset.kind];
  const { size: imageSize, onImage } = useNaturalSize();
  const probe = useVideoProbe(
    asset.kind === 'video' || asset.kind === 'audio' ? url : null,
    asset.kind === 'audio' ? 'audio' : 'video'
  );
  const size = asset.kind === 'video' ? (probe && probe.w ? { w: probe.w, h: probe.h } : null) : imageSize;
  // Only media that runs has one; a still shows its dimensions alone.
  const duration = probe ? formatDuration(probe.seconds) : '';
  // Hover is tracked here rather than left to `group-hover:`: these cards sit in
  // a CSS `columns` flow, where the hover-only overlays stayed fully transparent
  // while still taking clicks. A state flag repaints them for certain.
  const [hovered, setHovered] = useState(false);
  const [listing, setListing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);
  // Nothing in memory points at it. When the backend says it IS referenced, that
  // is a state of its own — saying "未被引用" would be a lie that costs a live
  // file — and either way there is nowhere to navigate to.
  const locatable = !managing && usages.length > 0;
  const live = liveCount(usages);

  // Picking things to delete takes the whole card over; a sheet left open across
  // that switch would be sitting on top of the checkbox.
  useEffect(() => {
    if (managing) setListing(false);
  }, [managing]);

  // Click anywhere else — another card, the toolbar, the backdrop — and the
  // sheet goes away. Without this it stays open behind the next thing you do.
  useEffect(() => {
    if (!listing) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // The badge is the toggle, so a press on it is never "outside": closing
      // here and reopening on the click would make it impossible to shut.
      if (panelRef.current?.contains(target) || badgeRef.current?.contains(target)) return;
      setListing(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [listing]);

  return (
    // A div, not a button: the card carries its own actions, and a button inside
    // a button is invalid markup that browsers resolve by dropping one of them.
    <div
      role="button"
      tabIndex={0}
      onClick={() => (managing ? onToggle() : viewable && onOpen())}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          managing ? onToggle() : viewable && onOpen();
        }
      }}
      // Off-screen cards are not laid out or painted; 'auto 220px' is the size held for one until it has been seen.
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 220px' }}
      className={`group relative flex w-full flex-col overflow-hidden rounded-xl border text-left transition-colors ${
        selected
          ? 'border-rose-400/70 bg-rose-500/10'
          : managing || viewable
          ? 'cursor-pointer border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.06]'
          : 'cursor-default border-white/10 bg-white/[0.03]'
      }`}
    >
      <div className="relative w-full bg-black/60">
        {/* Natural aspect ratio — the column layout is what makes that possible. */}
        {asset.kind === 'video' && (
          // A frame, not a <video>: the grid can hold a hundred clips and Chrome
          // caps media players per page (2026-09-06). Sizes come off the probe.
          probe?.poster ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={probe.poster} alt="" className="block h-auto w-full" loading="lazy" decoding="async" />
          ) : (
            <div className="aspect-video w-full" />
          )
        )}
        {asset.kind === 'image' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="block h-auto w-full" loading="lazy" decoding="async" onLoad={onImage} />
        )}
        {asset.kind === 'audio' && (
          <div className="flex h-24 w-full flex-col items-center justify-center gap-1 text-sky-300/80">
            <KindIcon kind="audio" size={30} />
            <span className="font-mono text-[10px] tabular-nums text-zinc-500">
              {probe ? `${probe.seconds.toFixed(1)}s` : t('读取中…')}
            </span>
          </div>
        )}
        {!viewable && (
          <div className="flex h-24 w-full items-center justify-center opacity-60">
            <KindIcon kind={asset.kind} size={30} />
          </div>
        )}

        {!managing && viewable && (
          <span
            className={`pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 text-2xl text-white transition-opacity ${
              hovered ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {asset.kind === 'image' ? '⤢' : '▶'}
          </span>
        )}

        {/* Type first, then state: what a thing is, then whether it is in use.
            Both chips are solid — a tinted badge over a bright frame is
            unreadable exactly when it matters.

            The state badge is also the way in: "已引用" and "带我去看" are the
            same question, so it carries the count and opens the list itself
            rather than putting a third chip in a corner that already has two. */}
        <div className="absolute left-1.5 top-1.5 flex items-center gap-1">
          <span
            className="flex items-center rounded-md bg-black/85 p-1 shadow-lg"
            title={t(kind.label)}
          >
            <KindIcon kind={asset.kind} />
          </span>
          {locatable ? (
            <button
              ref={badgeRef}
              onClick={(e) => {
                e.stopPropagation();
                setListing((open) => !open);
              }}
              className={`flex items-center gap-1 rounded-md px-2 py-[3px] text-[11px] font-bold shadow-lg transition-colors ${
                listing
                  ? 'bg-white text-zinc-900'
                  : live > 0
                  ? 'bg-emerald-400 text-emerald-950 hover:bg-emerald-300'
                  : // Only remembered, never currently output: it must not wear
                    // the same green as a shot that is on the canvas right now.
                    'bg-zinc-300 text-zinc-800 hover:bg-white'
              }`}
              title={
                (live > 0
                  ? t('这个项目里有 {n} 处在用它 · 点开定位', { n: live })
                  : t('没有任何节点或片段在输出它，但 {n} 个节点记得生成过它 · 点开查看', { n: usages.length })) +
                (otherProjects.length > 0 ? t('\n另有项目在用：{projects}', { projects: otherProjects.join('、') }) : '')
              }
            >
              <LocateIcon />
              {live > 0 ? t('已引用 {n}', { n: live }) : t('旧版本 {n}', { n: usages.length })}
            </button>
          ) : (
            <span
              className={`rounded-md px-2 py-[3px] text-[11px] font-bold shadow-lg ${
                !asset.referenced
                  ? 'bg-amber-400 text-amber-950'
                  : // Referenced, but nothing in this project points at it. Not
                    // the same green as a located reference and deliberately not
                    // the same amber as 未使用 either — it is neither "here" nor
                    // "safe to delete", and colouring it as either misleads.
                    'bg-emerald-400/25 text-emerald-100 ring-1 ring-inset ring-emerald-300/50'
              }`}
              title={
                !asset.referenced
                  ? (originProject
                      ? t('没有任何项目引用它，可以安全删除 · 由「{project}」生成', { project: originProject })
                      : t('没有任何项目引用它，可以安全删除'))
                  : (cutKnown
                      ? t('保存过的文档里提到过它，但这个项目的画布和时间线上都找不到 —— 可能来自别的项目，或藏在某个未识别的字段里。')
                      : t('读不到这个项目的时间线，剪辑台里的引用无法确认。删除前请先打开剪辑台看一眼。')) +
                    (otherProjects.length > 0 ? t('\n另有项目在用：{projects}', { projects: otherProjects.join('、') }) : '')
              }
            >
              {asset.referenced ? t('位置不明') : t('未使用')}
            </span>
          )}
        </div>

        {asset.companions.length > 0 && (
          <span
            className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-300"
            title={t('删除时一并清理：{files}', { files: asset.companions.join('、') })}
          >
            
            {t('含潜空间')} {formatSize(asset.companion_size)}
          </span>
        )}

        {managing && selected && (
          <span className="absolute inset-0 flex items-center justify-center bg-rose-500/15 text-lg text-rose-100">
            ✓
          </span>
        )}

        {/* Actions stay out of the way until the card is hovered, and never while
            picking things to delete. */}
        {!managing && viewable && (
          <div
            className={`absolute inset-x-1.5 bottom-1.5 flex gap-1 transition-opacity ${
              hovered ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSendToCanvas();
              }}
              className="flex-1 rounded-md bg-black/80 px-2 py-1 text-[10px] text-zinc-100 hover:bg-black"
              title={t('在画布中心放置一个引用这个素材的节点')}
            >
              
              {t('放到画布')}
            </button>
            {(asset.kind === 'video' || asset.kind === 'audio' || asset.kind === 'image') && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
                className="flex-1 rounded-md bg-black/80 px-2 py-1 text-[10px] text-zinc-100 hover:bg-black"
                title={t('在剪辑台里单独剪这一段')}
              >
                
                {t('剪辑')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Where it is used. A sheet over the card, not an expander below it: the
          cards sit in a grid whose rows size to their tallest card, so growing
          one card shoves every neighbour around — the worst possible feedback
          for a click that means "show me where this is". */}
      {listing && (
        <div
          ref={panelRef}
          role="group"
          aria-label={t('在用的位置')}
          className="absolute inset-0 z-20 flex flex-col rounded-xl bg-zinc-950/95 backdrop-blur-sm"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setListing(false);
            }
          }}
        >
          <div className="flex items-center justify-between border-b border-white/10 px-2 py-1">
            <span className="text-[10px] font-medium tracking-wide text-zinc-400">{t('在用的位置')}</span>
            <button
              onClick={() => setListing(false)}
              className="rounded px-1 text-[11px] leading-none text-zinc-500 hover:text-white"
              title={t('关闭')}
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-0.5">
            {usages.map((usage, index) => (
              <React.Fragment key={`${usage.kind}-${usage.id}`}>
                {/* The moment the list stops being about the file as it is now.
                    Without this line a stale take reads as a current reference,
                    and the shot it takes you to is not the one you clicked. */}
                {!usage.live && (index === 0 || usages[index - 1].live) && (
                  <span className="mt-0.5 block border-t border-white/10 px-2 pb-0.5 pt-1 text-[9px] text-zinc-500">
                    
                    {t('以下节点生成过它，但现在输出的已不是这一版')}
                  </span>
                )}
                <button
                  autoFocus={index === 0}
                  onClick={() => onLocate(usage)}
                  className={`group/row flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-white/10 focus:bg-white/10 focus:outline-none ${
                    usage.live ? '' : 'opacity-60'
                  }`}
                  title={
                    usage.kind === 'clip'
                      ? t('在剪辑台里选中这个片段')
                      : usage.live
                      ? t('在画布上定位这个节点')
                      : t('在画布上定位这个节点 —— 它的当前输出已经是另一个文件了')
                  }
                >
                  <span className="shrink-0 text-zinc-500">
                    {usage.kind === 'clip' ? <FilmIcon /> : <BoardIcon />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] leading-tight text-zinc-100">
                      {usage.label}
                    </span>
                    {usage.detail && (
                      <span className="block truncate font-mono text-[9px] leading-tight text-zinc-500">
                        {usage.detail}
                      </span>
                    )}
                  </span>
                  {/* Only on the row the pointer is on: a column of arrows reads as
                      decoration, one arrow reads as "this one goes". */}
                  <span className="shrink-0 text-[11px] text-emerald-300 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus/row:opacity-100">
                    →
                  </span>
                </button>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-0.5 px-2 py-1.5">
        <span className="truncate font-mono text-[10px] text-zinc-300" title={asset.name}>
          {asset.name}
        </span>
        <span className="flex items-center justify-between font-mono text-[10px] text-zinc-600 tabular-nums">
          <span>
            {duration}
            {size && <span className={duration ? 'ml-1.5 text-zinc-500' : 'text-zinc-500'}>{size.w}×{size.h}</span>}
          </span>
          <span>{formatDate(asset.modified)}</span>
        </span>
      </div>
    </div>
  );
}

// Re-rendered on every canvas change before 2026-09-05; props are stable now.
export default React.memo(AssetLibrary);
