'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { showAlert, showConfirm, showPrompt } from '@/components/ui/Dialog';
import { api, type SceneInfo, type SequenceInfo } from '@/lib/api';
import { posterUrl, resolveAssetUrl } from '@/lib/config';
import { t } from '@/lib/i18n';
import { useStore } from '@/lib/store';

import ProductionBible from './ProductionBible';

const STATUS: Record<SceneInfo['status'], { label: string; dot: string }> = {
  todo: { label: '未开始', dot: 'bg-zinc-500' },
  in_progress: { label: '制作中', dot: 'bg-amber-400' },
  accepted: { label: '已验收', dot: 'bg-emerald-400' },
};

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** A card's picture: a clip's backend-cut first frame, or the still itself. */
function sceneCover(url: string | null): string | null {
  if (!url) return null;
  return /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url) ? posterUrl(resolveAssetUrl(url)) : resolveAssetUrl(url);
}

/** The film's scenes, re-read whenever the project or the scene list changes. */
function useScenes(projectId: string | null) {
  const version = useStore((s) => s.scenesVersion);
  const [scenes, setScenes] = useState<SceneInfo[]>([]);
  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      setScenes((await api.listScenes(projectId)).scenes);
    } catch {
      // The backend being away is reported elsewhere; the tabs keep what they had.
    }
  }, [projectId]);
  useEffect(() => {
    void reload();
  }, [reload, version]);
  // Scenes are also added from outside the studio (the canvas MCP), which never
  // bumps scenesVersion: re-read on focus and on a slow poll while visible.
  useEffect(() => {
    const onFocus = () => void reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 15000);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [reload]);
  return { scenes, reload };
}

/**
 * Scene tabs under the header: a film is one project with a canvas per scene,
 * so a two-hour film never has to live on one canvas. The first tab opens the
 * film overview.
 */
export default function SceneBar() {
  const projectId = useStore((s) => s.currentProjectId);
  const currentSceneId = useStore((s) => s.currentSceneId);
  const { scenes, reload } = useScenes(projectId);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [refsOpen, setRefsOpen] = useState(false);

  const open = (sceneId: string) => useStore.getState().setCurrentScene(sceneId);

  const addScene = async () => {
    if (!projectId) return;
    const name = await showPrompt(t('新场景的名称'), {
      title: t('新建场景'),
      defaultValue: t('场景 {n}', { n: scenes.length + 1 }),
      confirmText: t('创建'),
    });
    if (!name?.trim()) return;
    try {
      const scene = await api.createScene(projectId, name.trim());
      useStore.getState().bumpScenes();
      open(scene.id);
    } catch (e) {
      void showAlert(t('创建场景失败：{error}', { error: (e as Error).message }), { title: t('新建场景'), danger: true });
    }
  };

  const rename = async (scene: SceneInfo) => {
    if (!projectId) return;
    const name = await showPrompt(t('场景名称'), { title: t('重命名场景'), defaultValue: scene.name, confirmText: t('保存') });
    if (!name?.trim() || name.trim() === scene.name) return;
    await api.updateScene(projectId, scene.id, { name: name.trim() });
    useStore.getState().bumpScenes();
  };

  if (!projectId) return null;

  return (
    <>
      {/* On a phone the header is two rows, so the scene bar sits below both */}
      <div className="fixed left-2 right-2 top-[106px] z-30 flex pointer-events-none sm:top-[62px] sm:left-4 sm:right-4">
        <div
          className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-white/[0.08] px-1.5 py-1 backdrop-blur-md"
          style={{ background: 'rgba(14, 14, 20, 0.82)' }}
        >
          <button
            onClick={() => {
              void reload();
              setOverviewOpen(true);
            }}
            className="flex h-7 flex-none items-center gap-1.5 rounded-lg px-2.5 text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white"
            title={t('电影总览：所有场景的进度、时长和顺序')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            {t('总览')}
          </button>
          <button
            onClick={() => window.dispatchEvent(new Event('toggleChainIndex'))}
            className="flex h-7 flex-none items-center gap-1.5 rounded-lg px-2.5 text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white"
            title={t('本场景所有接续链：跳到链头，看每条链出了几段高清')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <circle cx="5" cy="12" r="2.5" />
              <path d="M8 12h4M16 12h4" />
              <circle cx="14" cy="12" r="1.5" />
            </svg>
            {t('链头')}
          </button>
          <div className="mx-0.5 h-4 w-px flex-none bg-white/10" />
          {scenes.map((scene) => {
            const active = scene.id === currentSceneId;
            return (
              <button
                key={scene.id}
                onClick={() => open(scene.id)}
                onDoubleClick={() => void rename(scene)}
                className={`flex h-7 flex-none items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors ${
                  active
                    ? 'bg-white/[0.12] text-white'
                    : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
                }`}
                title={t('{name} · {status} · {n} 个节点（双击重命名）', {
                  name: scene.name, status: t(STATUS[scene.status].label), n: scene.node_count,
                })}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${STATUS[scene.status].dot}`} />
                <span className="max-w-[160px] truncate">{scene.name}</span>
              </button>
            );
          })}
          <button
            onClick={() => void addScene()}
            className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.08] hover:text-white"
            title={t('新建场景')}
          >
            +
          </button>
          <div className="mx-0.5 h-4 w-px flex-none bg-white/10" />
          <button
            onClick={() => {
              void reload();
              setRefsOpen(true);
            }}
            className="flex h-7 flex-none items-center gap-1.5 rounded-lg px-2.5 text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white"
            title={t('资料库：全片共用的定妆、环境、语音和道具')}
          >
            {t('资料库')}
          </button>
        </div>
      </div>

      {refsOpen && (
        <ProductionBible
          projectId={projectId}
          scenes={scenes}
          currentSceneId={currentSceneId}
          onClose={() => setRefsOpen(false)}
        />
      )}

      {overviewOpen && (
        <FilmOverview
          projectId={projectId}
          scenes={scenes}
          currentSceneId={currentSceneId}
          onClose={() => setOverviewOpen(false)}
          onOpen={(id) => {
            open(id);
            setOverviewOpen(false);
          }}
          onAdd={() => void addScene()}
          onRename={(scene) => void rename(scene)}
        />
      )}
    </>
  );
}

function FilmOverview({
  projectId, scenes, currentSceneId, onClose, onOpen, onAdd, onRename,
}: {
  projectId: string;
  scenes: SceneInfo[];
  currentSceneId: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onAdd: () => void;
  onRename: (scene: SceneInfo) => void;
}) {
  const projectName = useStore((s) => s.currentProjectName);
  const [sequences, setSequences] = useState<SequenceInfo[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);

  useEffect(() => {
    api.listSequences(projectId).then((r) => setSequences(r.sequences)).catch(() => setSequences([]));
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const totals = useMemo(() => ({
    accepted: scenes.filter((s) => s.status === 'accepted').length,
    seconds: scenes.reduce((sum, s) => sum + (s.duration_s ?? 0), 0),
    nodes: scenes.reduce((sum, s) => sum + s.node_count, 0),
  }), [scenes]);

  const patch = async (scene: SceneInfo, change: Parameters<typeof api.updateScene>[2]) => {
    try {
      await api.updateScene(projectId, scene.id, change);
      useStore.getState().bumpScenes();
    } catch (e) {
      void showAlert(t('保存失败：{error}', { error: (e as Error).message }), { title: t('电影总览'), danger: true });
    }
  };

  const drop = async (targetId: string) => {
    if (!dragging || dragging === targetId) return;
    const ids = scenes.map((s) => s.id).filter((id) => id !== dragging);
    ids.splice(ids.indexOf(targetId), 0, dragging);
    setDragging(null);
    await api.reorderScenes(projectId, ids);
    useStore.getState().bumpScenes();
  };

  const remove = async (scene: SceneInfo) => {
    const ok = await showConfirm(
      t('从电影里移除场景「{name}」？\n画布会移到项目的回收区，节点引用的素材不会被当作未使用而删掉；需要时可以手工找回。', { name: scene.name }),
      { title: t('移除场景'), confirmText: t('移除'), danger: true },
    );
    if (!ok) return;
    if (scene.id === currentSceneId) useStore.getState().setCurrentScene('main');
    await api.deleteScene(projectId, scene.id);
    useStore.getState().bumpScenes();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-md sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex h-[86vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
        style={{ background: 'rgba(14, 14, 20, 0.97)' }}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <div>
            <p className="text-sm font-semibold text-zinc-100">{projectName} · {t('电影总览')}</p>
            <p className="mt-0.5 font-mono text-[11px] text-zinc-500">
              {t('{n} 场 · 已验收 {a} · 成片 {d} · {nodes} 个节点', {
                n: scenes.length, a: totals.accepted, d: formatDuration(totals.seconds), nodes: totals.nodes,
              })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onAdd}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.08]"
            >
              {t('+ 新建场景')}
            </button>
            <button onClick={onClose} className="rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-200">
              {t('关闭 (Esc)')}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <p className="mb-3 text-[11px] text-zinc-600">{t('拖动卡片调整场景顺序；成片时长取自关联的剪辑序列。')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {scenes.map((scene, index) => {
              const cover = sceneCover(scene.thumbnail_url);
              return (
                <div
                  key={scene.id}
                  draggable
                  onDragStart={() => setDragging(scene.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => void drop(scene.id)}
                  className={`group flex flex-col overflow-hidden rounded-xl border bg-white/[0.02] ${
                    scene.id === currentSceneId ? 'border-emerald-400/50' : 'border-white/10'
                  } ${dragging === scene.id ? 'opacity-40' : ''}`}
                >
                  <button
                    onClick={() => onOpen(scene.id)}
                    className="relative aspect-video w-full bg-black/50"
                    title={t('打开这个场景')}
                  >
                    {cover ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={cover} alt="" className="h-full w-full object-cover" draggable={false} />
                    ) : (
                      <span className="text-xs text-zinc-600">{t('还没有镜头')}</span>
                    )}
                    <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                  </button>
                  <div className="flex flex-col gap-2 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <button
                        onDoubleClick={() => onRename(scene)}
                        onClick={() => onOpen(scene.id)}
                        className="truncate text-left text-sm text-zinc-100"
                        title={t('单击打开，双击重命名')}
                      >
                        {scene.name}
                      </button>
                      <span className="flex-none font-mono text-[11px] text-zinc-500">{formatDuration(scene.duration_s)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={scene.status}
                        onChange={(e) => void patch(scene, { status: e.target.value as SceneInfo['status'] })}
                        className="rounded border border-white/10 bg-black/40 px-1.5 py-1 text-[11px] text-zinc-300"
                      >
                        {(Object.keys(STATUS) as SceneInfo['status'][]).map((key) => (
                          <option key={key} value={key}>{t(STATUS[key].label)}</option>
                        ))}
                      </select>
                      <select
                        value={scene.sequence_id ?? ''}
                        onChange={(e) => void patch(scene, { sequence_id: e.target.value })}
                        className="min-w-0 flex-1 truncate rounded border border-white/10 bg-black/40 px-1.5 py-1 text-[11px] text-zinc-300"
                        title={t('这场的成片对应剪辑台里的哪条序列')}
                      >
                        <option value="">{t('未关联成片')}</option>
                        {sequences.map((seq) => (
                          <option key={seq.id} value={seq.id}>{seq.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-zinc-500">
                      <span>{t('{n} 个节点', { n: scene.node_count })}</span>
                      {scene.id !== 'main' && (
                        <button onClick={() => void remove(scene)} className="text-zinc-600 hover:text-rose-300">
                          {t('移除')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
