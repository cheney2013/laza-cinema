'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, type Node } from '@xyflow/react';

import { showAlert, showConfirm, showPrompt } from '@/components/ui/Dialog';
import { api, type BibleEntry, type BibleFile, type BibleKind, type SceneInfo } from '@/lib/api';
import { posterUrl, resolveAssetUrl } from '@/lib/config';
import { t } from '@/lib/i18n';
import { useStore } from '@/lib/store';

const KIND_LABEL: Record<BibleKind, string> = {
  cast: '人物定妆',
  environment: '环境',
  prop: '道具',
  voice: '语音',
  other: '其他',
};
const KINDS = Object.keys(KIND_LABEL) as BibleKind[];

/** A node from some scene that shows a file and is not yet in the bible. */
interface Candidate {
  key: string;
  sceneId: string;
  sceneName: string;
  node: Node;
}

function mediaOf(file: BibleFile): string {
  if (file.mediaType) return file.mediaType;
  const url = file.url || '';
  if (/\.(wav|mp3|m4a|flac|ogg)(\?|$)/i.test(url)) return 'audio';
  if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(url)) return 'video';
  return 'image';
}

/** "定妆板 · 主角 v5（备注）" -> "主角 v5"; the backend guesses the kind from the prefix. */
function guessName(label: string): string {
  let text = label.trim();
  if (text.includes('·')) text = text.split('·').slice(1).join('·');
  return text.split(/[（(]/)[0].trim().slice(0, 60) || label.trim().slice(0, 60);
}

function fileOf(data: Record<string, unknown>): BibleFile {
  const out: BibleFile = {};
  if (typeof data.url === 'string') out.url = data.url;
  if (typeof data.mediaType === 'string') out.mediaType = data.mediaType;
  for (const k of ['width', 'height', 'duration'] as const) {
    const v = Number(data[k]);
    if (Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

function Thumb({ file }: { file: BibleFile }) {
  const media = mediaOf(file);
  if (!file.url) return null;
  if (media === 'audio') {
    return <div className="flex h-full w-full items-center justify-center text-2xl text-zinc-500">♪</div>;
  }
  const src = media === 'video' ? posterUrl(resolveAssetUrl(file.url)) : resolveAssetUrl(file.url);
  return <img src={src ?? undefined} alt="" loading="lazy" className="h-full w-full object-contain" />;
}

async function uploadReplacement(file: File): Promise<BibleFile> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (file.type.startsWith('audio/') || ext === 'm4a') {
    const r = await api.uploadVideoFile(file);
    return { url: r.url, mediaType: 'audio', duration: r.duration || undefined };
  }
  if (file.type.startsWith('video/')) {
    const r = await api.uploadVideoFile(file);
    return { url: r.url, mediaType: 'video', width: r.width, height: r.height, duration: r.duration || undefined };
  }
  const size = await new Promise<{ width: number; height: number }>((resolve) => {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => resolve({ width: 0, height: 0 });
  });
  const { url } = await api.uploadStyleReference(file);
  return { url, mediaType: 'image', width: size.width || undefined, height: size.height || undefined };
}

/**
 * The film's production bible: cast sheets, environment plates, voices and props
 * every scene draws on. Scene nodes link to an entry; giving the entry a new
 * version of its file updates those nodes in every scene.
 */
export default function ProductionBible({
  projectId,
  scenes,
  currentSceneId,
  onClose,
}: {
  projectId: string;
  scenes: SceneInfo[];
  currentSceneId: string;
  onClose: () => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const [tab, setTab] = useState<'entries' | 'collect'>('entries');
  const [entries, setEntries] = useState<BibleEntry[] | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);

  const sceneName = useCallback((id: string) => scenes.find((s) => s.id === id)?.name ?? id, [scenes]);

  const fail = (title: string, e: unknown) =>
    void showAlert(t('{title}失败：{error}', { title, error: (e as Error).message }), { title: t('资料库'), danger: true });

  const loadEntries = useCallback(async () => {
    try {
      setEntries((await api.getBible(projectId)).entries);
    } catch (e) {
      fail(t('读取资料库'), e);
    }
  }, [projectId]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  // Collect: every node in every scene that shows a file and is not linked yet.
  useEffect(() => {
    if (tab !== 'collect' || candidates) return;
    (async () => {
      try {
        const canvases = await Promise.all(scenes.map((s) => api.loadCanvas(projectId, 'default', s.id)));
        const found: Candidate[] = [];
        canvases.forEach((canvas, i) => {
          for (const node of canvas.nodes as Node[]) {
            const d = node.data as Record<string, unknown>;
            if (node.type !== 'image' || !d?.url || d.bibleId) continue;
            found.push({ key: `${scenes[i].id}/${node.id}`, sceneId: scenes[i].id, sceneName: scenes[i].name, node });
          }
        });
        setCandidates(found);
      } catch (e) {
        fail(t('读取场景'), e);
      }
    })();
  }, [tab, candidates, scenes, projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const entryGroups = useMemo(() => {
    const visible = (entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q) || e.notes.toLowerCase().includes(q));
    return KINDS.map((k) => [k, visible.filter((e) => e.kind === k)] as const).filter(([, list]) => list.length);
  }, [entries, q]);

  const visibleCandidates = useMemo(
    () => (candidates ?? []).filter((c) => !q || String((c.node.data as Record<string, unknown>).label || c.node.id).toLowerCase().includes(q)),
    [candidates, q],
  );

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const switchTab = (next: 'entries' | 'collect') => {
    setTab(next);
    setSelected(new Set());
  };

  // ── Actions ────────────────────────────────────────────────────────────────

  const place = () => {
    const chosen = (entries ?? []).filter((e) => selected.has(e.id) && e.url);
    if (!chosen.length) return;
    const centre = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const columns = Math.ceil(Math.sqrt(chosen.length));
    const stamp = Date.now().toString(36);
    window.dispatchEvent(new Event('takeSnapshot'));
    const added: Node[] = chosen.map((e, i) => {
      const media = mediaOf(e);
      const width = 240;
      const height =
        media === 'audio' ? 120 : e.width && e.height ? 32 + Math.min(Math.round((width * e.height) / e.width), 480) : undefined;
      return {
        id: `bible-${e.id.slice(4)}-${stamp}${i}`,
        type: 'image',
        position: { x: centre.x + (i % columns) * 280, y: centre.y + Math.floor(i / columns) * 320 },
        data: {
          url: e.url, mediaType: media, width: e.width, height: e.height, duration: e.duration,
          label: `${t(KIND_LABEL[e.kind])} · ${e.name}`, bibleId: e.id,
        },
        ...(height ? { width, height } : {}),
      } as Node;
    });
    useStore.getState().setNodes([...useStore.getState().nodes, ...added]);
    onClose();
  };

  const collect = async () => {
    const chosen = (candidates ?? []).filter((c) => selected.has(c.key));
    if (!chosen.length) return;
    setBusy(true);
    try {
      // Nodes showing the same file become one entry.
      const byUrl = new Map<string, Candidate[]>();
      for (const c of chosen) {
        const url = String((c.node.data as Record<string, unknown>).url);
        byUrl.set(url, [...(byUrl.get(url) ?? []), c]);
      }
      for (const group of byUrl.values()) {
        const data = group[0].node.data as Record<string, unknown>;
        await api.addBibleEntry(projectId, {
          ...fileOf(data),
          name: guessName(String(data.label || group[0].node.id)),
          link: group.map((c) => ({ scene: c.sceneId, node_id: c.node.id })),
        });
      }
      setCandidates(null);
      await loadEntries();
      switchTab('entries');
    } catch (e) {
      fail(t('收录'), e);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (entry: BibleEntry) => {
    const name = await showPrompt(t('条目名称'), { title: t('重命名'), defaultValue: entry.name, confirmText: t('保存') });
    if (!name?.trim() || name.trim() === entry.name) return;
    try {
      setEntries((await api.updateBibleEntry(projectId, entry.id, { name: name.trim() })).entries);
    } catch (e) {
      fail(t('重命名'), e);
    }
  };

  const setKind = async (entry: BibleEntry, kind: BibleKind) => {
    try {
      setEntries((await api.updateBibleEntry(projectId, entry.id, { kind })).entries);
    } catch (e) {
      fail(t('修改分类'), e);
    }
  };

  const replaceWith = async (entry: BibleEntry, file: BibleFile) => {
    const where = entry.usage.scenes.map(sceneName).join('、');
    const ok = await showConfirm(
      entry.usage.nodes
        ? t('「{name}」换成新文件，{n} 个节点会一起更新（{scenes}）。旧文件保留在历史版本里。', {
            name: entry.name, n: entry.usage.nodes, scenes: where,
          })
        : t('「{name}」换成新文件？旧文件保留在历史版本里。', { name: entry.name }),
      { title: t('更新版本'), confirmText: t('更新') },
    );
    if (!ok) return;
    setBusy(true);
    try {
      setEntries((await api.updateBibleEntry(projectId, entry.id, file)).entries);
    } catch (e) {
      fail(t('更新版本'), e);
    } finally {
      setBusy(false);
    }
  };

  const onReplaceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const entry = entries?.find((x) => x.id === replaceTarget.current);
    if (!file || !entry) return;
    setBusy(true);
    try {
      const uploaded = await uploadReplacement(file);
      setBusy(false);
      await replaceWith(entry, uploaded);
    } catch (err) {
      fail(t('上传'), err);
    } finally {
      setBusy(false);
    }
  };

  /** A new version taken from the node selected on the canvas (e.g. a fresh render). */
  const replaceFromSelection = async (entry: BibleEntry) => {
    const node = useStore.getState().nodes.find((n) => n.selected);
    const d = (node?.data ?? {}) as Record<string, unknown>;
    const url = (typeof d.url === 'string' && d.url) || (typeof d.generatedUrl === 'string' && d.generatedUrl) || '';
    if (!node || !url) {
      void showAlert(t('先在画布上选中一个带文件的节点，再点这里。'), { title: t('更新版本') });
      return;
    }
    await replaceWith(entry, { ...fileOf(d), url });
  };

  const remove = async (entry: BibleEntry) => {
    const ok = await showConfirm(
      t('把「{name}」移出资料库？{n} 个关联节点会保留文件，变回普通节点；不删除任何文件。', {
        name: entry.name, n: entry.usage.nodes,
      }),
      { title: t('移出资料库'), confirmText: t('移出'), danger: true },
    );
    if (!ok) return;
    try {
      setEntries((await api.deleteBibleEntry(projectId, entry.id)).entries);
    } catch (e) {
      fail(t('移出'), e);
    }
  };

  // ── View ───────────────────────────────────────────────────────────────────

  const card = (key: string, file: BibleFile, title: string, sub: React.ReactNode, extra?: React.ReactNode) => (
    <div
      key={key}
      className={`overflow-hidden rounded-xl border transition-colors ${
        selected.has(key) ? 'border-sky-400/70 bg-sky-400/[0.08]' : 'border-white/[0.08] bg-white/[0.02] hover:border-white/20'
      }`}
    >
      <button onClick={() => toggle(key)} className="block w-full text-left">
        <div className="aspect-video bg-black/40">
          <Thumb file={file} />
        </div>
        <div className="px-2 pt-1.5">
          <p className="line-clamp-2 text-[11px] leading-snug text-zinc-200" title={title}>{title}</p>
          <p className="mt-0.5 text-[10px] text-zinc-500">{sub}</p>
        </div>
      </button>
      {extra}
    </div>
  );

  const entryActions = (entry: BibleEntry) => (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-2 pt-1 text-[10px] text-zinc-500">
      <select
        value={entry.kind}
        onChange={(e) => void setKind(entry, e.target.value as BibleKind)}
        className="rounded bg-white/[0.05] px-1 py-0.5 text-zinc-300 outline-none"
      >
        {KINDS.map((k) => (
          <option key={k} value={k}>{t(KIND_LABEL[k])}</option>
        ))}
      </select>
      <button className="hover:text-zinc-200" onClick={() => void rename(entry)}>{t('改名')}</button>
      <button
        className="hover:text-zinc-200"
        onClick={() => {
          replaceTarget.current = entry.id;
          replaceInput.current?.click();
        }}
      >
        {t('上传新版')}
      </button>
      <button className="hover:text-zinc-200" onClick={() => void replaceFromSelection(entry)} title={t('用画布上选中节点的文件作为新版本')}>
        {t('用选中节点')}
      </button>
      {entry.history.length > 0 && (
        <button className="hover:text-zinc-200" onClick={() => setHistoryOf(historyOf === entry.id ? null : entry.id)}>
          {t('历史 {n}', { n: entry.history.length })}
        </button>
      )}
      <button className="hover:text-red-300" onClick={() => void remove(entry)}>{t('移出')}</button>
      {historyOf === entry.id && (
        <div className="mt-1 grid w-full grid-cols-3 gap-1">
          {entry.history.map((h, i) => (
            <button
              key={`${h.url}-${i}`}
              onClick={() => void replaceWith(entry, h)}
              className="overflow-hidden rounded border border-white/10 hover:border-sky-400/60"
              title={t('恢复这个版本（{date}前的）', { date: new Date(h.replaced_at * 1000).toLocaleString() })}
            >
              <div className="aspect-video bg-black/40"><Thumb file={h} /></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-md sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <input ref={replaceInput} type="file" accept="image/*,video/*,audio/*,.m4a" className="hidden" onChange={onReplaceFile} />
      <div
        className="flex h-[86vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
        style={{ background: 'rgba(14, 14, 20, 0.97)' }}
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-white/10 px-5 py-3">
          <div className="mr-auto">
            <p className="text-sm font-semibold text-zinc-100">{t('资料库')}</p>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              {tab === 'entries'
                ? t('全片共用的定妆、环境、语音和道具。更新一个条目的版本，所有场景里关联的节点一起换。')
                : t('从各场景挑出要全片共用的素材；原节点会关联到新条目。每镜专用的姿势参考、灰模锚不用收录。')}
            </p>
          </div>
          <div className="flex rounded-lg border border-white/10 p-0.5">
            {(['entries', 'collect'] as const).map((k) => (
              <button
                key={k}
                onClick={() => switchTab(k)}
                className={`rounded-md px-2.5 py-1 text-[11px] ${tab === k ? 'bg-white/[0.12] text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                {k === 'entries' ? t('条目 {n}', { n: entries?.length ?? 0 }) : t('从场景收录')}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
            onBlur={() => window.dispatchEvent(new Event('inputBlurred'))}
            placeholder={t('搜索…')}
            className="h-8 w-44 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-xs text-zinc-200 outline-none focus:border-white/25"
          />
          <button onClick={onClose} className="rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-200">
            {t('关闭 (Esc)')}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'entries' && (
            <>
              {!entries && <p className="text-xs text-zinc-500">{t('正在读取…')}</p>}
              {entries && entries.length === 0 && (
                <p className="text-xs text-zinc-500">{t('资料库还是空的。到「从场景收录」里挑出全片共用的素材。')}</p>
              )}
              {entryGroups.map(([kind, list]) => (
                <section key={kind} className="mb-5">
                  <p className="mb-2 text-xs font-medium text-zinc-300">
                    {t(KIND_LABEL[kind])} <span className="text-zinc-600">· {list.length}</span>
                  </p>
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
                    {list.map((e) =>
                      card(
                        e.id,
                        e,
                        e.name,
                        e.usage.nodes
                          ? t('{n} 个节点 · {scenes}', { n: e.usage.nodes, scenes: e.usage.scenes.map(sceneName).join('、') })
                          : t('未被使用'),
                        entryActions(e),
                      ),
                    )}
                  </div>
                </section>
              ))}
            </>
          )}
          {tab === 'collect' && (
            <>
              {!candidates && <p className="text-xs text-zinc-500">{t('正在读取各场景…')}</p>}
              {candidates && visibleCandidates.length === 0 && (
                <p className="text-xs text-zinc-500">{t('没有可收录的素材节点。')}</p>
              )}
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
                {visibleCandidates.map((c) => {
                  const d = c.node.data as Record<string, unknown>;
                  return card(c.key, fileOf(d), String(d.label || c.node.id), c.sceneName);
                })}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-white/10 px-5 py-3">
          <p className="text-[11px] text-zinc-500">
            {t('已选 {n} 个', { n: selected.size })}
            {tab === 'entries' && ' · ' + t('当前场景：{name}', { name: sceneName(currentSceneId) })}
          </p>
          {tab === 'entries' ? (
            <button
              onClick={place}
              disabled={selected.size === 0 || busy}
              className="rounded-lg bg-sky-500/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
            >
              {t('放入当前场景')}
            </button>
          ) : (
            <button
              onClick={() => void collect()}
              disabled={selected.size === 0 || busy}
              className="rounded-lg bg-sky-500/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
            >
              {busy ? t('收录中…') : t('收录到资料库')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
