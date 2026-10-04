'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';

import { api, type ChainUpscaleState } from '@/lib/api';
import { type Chain, findChains } from '@/lib/chains';
import { useStore as useAppStore } from '@/lib/store';
import { useT } from '@/lib/i18n';
import { useCanvasNav } from '@/lib/canvasNav';

/**
 * Every motion-context chain on this canvas, head first, opened from the scene
 * bar's 链头 button. Picking a head flies to it; each chain also says how many
 * of its segments already have HD and flies to the first one that does not,
 * since HD has to be made in chain order.
 */
export default function ChainIndex() {
  const t = useT();
  const { setCenter, getViewport, setNodes, getNode } = useReactFlow();
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const projectId = useAppStore((s) => s.currentProjectId);
  const sceneId = useAppStore((s) => s.currentSceneId);
  const [run, setRun] = useState<ChainUpscaleState | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const readRun = useCallback(async () => {
    if (!projectId) return;
    try {
      setRun(await api.chainUpscaleStatus(projectId, sceneId || undefined));
    } catch {
      /* the status is a convenience; the nodes themselves show the result */
    }
  }, [projectId, sceneId]);

  // While the panel is open, follow the run (one per project) every few seconds.
  useEffect(() => {
    if (!open) return;
    void readRun();
    const timer = window.setInterval(() => void readRun(), 4000);
    return () => window.clearInterval(timer);
  }, [open, readRun]);

  const startRun = async (chain: Chain) => {
    if (!projectId) return;
    setRunError(null);
    try {
      setRun(await api.startChainUpscale(projectId, {
        node_id: chain.head.id,
        shot_ids: chain.segments.map((s) => s.id),
        scene: sceneId || undefined,
      }));
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    }
  };

  const stopRun = async () => {
    if (!projectId) return;
    try {
      setRun(await api.cancelChainUpscale(projectId, sceneId || undefined));
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    const toggle = () => setOpen((on) => !on);
    window.addEventListener('toggleChainIndex', toggle);
    return () => window.removeEventListener('toggleChainIndex', toggle);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const chains = useMemo<Chain[]>(() => (open ? findChains(nodes, edges) : []), [open, nodes, edges]);

  const jump = (id: string) => {
    const node = getNode(id);
    if (!node) return;
    const w = node.measured?.width ?? node.width ?? 0;
    const h = node.measured?.height ?? node.height ?? 0;
    // Nodes inside a group have positions relative to the parent.
    let x = node.position.x;
    let y = node.position.y;
    let parent = node.parentId ? getNode(node.parentId) : undefined;
    while (parent) {
      x += parent.position.x;
      y += parent.position.y;
      parent = parent.parentId ? getNode(parent.parentId) : undefined;
    }
    useCanvasNav.getState().remember(getViewport());
    setCenter(x + w / 2, y + h / 2, { zoom: Math.max(getViewport().zoom, 0.6), duration: 300 });
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
  };

  if (!open) return null;

  return (
    <div className="absolute left-4 top-[108px] z-50 flex max-h-[70vh] w-[340px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-white/15 bg-black/85 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-xs text-white/70">
        <span>{t('本场景的链（{v1} 条）', { v1: chains.length })}</span>
        <button onClick={() => setOpen(false)} className="text-white/40 hover:text-white">×</button>
      </div>
      <div className="overflow-y-auto">
        {runError && <div className="border-b border-white/[0.06] px-3 py-2 text-[11px] text-rose-300">{runError}</div>}
        {chains.length === 0 && (
          <div className="px-3 py-3 text-xs text-white/40">{t('这个画布上没有接续（motion context）连起来的链')}</div>
        )}
        {chains.map((chain) => {
          const done = chain.segments.filter((s) => s.hd).length;
          const total = chain.segments.length;
          const isOpen = expanded === chain.head.id;
          return (
            <div key={chain.head.id} className="border-b border-white/[0.06] px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setExpanded(isOpen ? null : chain.head.id)}
                  className="w-3 flex-none text-white/40 hover:text-white"
                  title={t('展开各段')}
                >
                  {isOpen ? '▾' : '▸'}
                </button>
                <button
                  onClick={() => jump(chain.head.id)}
                  className="flex-1 truncate text-left text-white hover:text-emerald-300"
                  title={t('跳到链头')}
                >
                  {chain.head.label}
                </button>
                <span
                  className={`flex-none font-mono tabular-nums ${done === total ? 'text-emerald-300' : 'text-white/50'}`}
                  title={t('已出高清的段数 / 总段数')}
                >
                  {t('高清 {v1}/{v2}', { v1: done, v2: total })}
                </span>
              </div>
              {(() => {
                const mine = run?.chain?.[0] === chain.head.id || (run?.chain ?? []).includes(chain.head.id);
                const running = run?.status === 'running';
                if (running && mine) {
                  const at = chain.segments.findIndex((s) => s.id === run?.current);
                  return (
                    <div className="ml-5 mt-1 flex items-center gap-2 text-[11px] text-sky-200">
                      <span className="truncate">
                        {t('高清中：第 {v1}/{v2} 段', { v1: Math.max(at, 0) + 1, v2: chain.segments.length })}
                      </span>
                      <button onClick={stopRun} className="flex-none rounded border border-white/20 px-1.5 text-white/70 hover:text-white">
                        {t('停止')}
                      </button>
                    </div>
                  );
                }
                return (
                  <div className="ml-5 mt-1 flex flex-col gap-0.5">
                    {done < total && (
                      <button
                        onClick={() => void startRun(chain)}
                        disabled={running}
                        className="w-fit rounded border border-emerald-400/40 px-2 py-0.5 text-[11px] text-emerald-200 hover:bg-emerald-400/10 disabled:cursor-not-allowed disabled:opacity-40"
                        title={running ? t('另一条链正在出高清，一个项目同时只跑一条') : t('按链的顺序逐段出高清，上一段出完才开始下一段')}
                      >
                        {t('全部高清（{v1} 段待出）', { v1: total - done })}
                      </button>
                    )}
                    {mine && run?.status === 'error' && run.error && (
                      <div className="text-[11px] text-rose-300">{t('停在：{v1}', { v1: run.error })}</div>
                    )}
                    {mine && run?.status === 'cancelled' && (
                      <div className="text-[11px] text-white/40">{t('已停止')}</div>
                    )}
                  </div>
                );
              })()}
              {chain.from && (
                <button
                  onClick={() => jump(chain.from!.id)}
                  className="ml-5 mt-1 block max-w-full truncate text-left text-[11px] text-white/40 hover:text-white/80"
                  title={t('链头接的是场景外带进来的片段')}
                >
                  {t('接自：{v1}', { v1: chain.from.label })}
                </button>
              )}
              {chain.nextHd && (
                <button
                  onClick={() => jump(chain.nextHd!.id)}
                  className="ml-5 mt-1 block truncate text-left text-amber-200/80 hover:text-amber-100"
                >
                  {t('下一段待出高清：{v1}', { v1: chain.nextHd.label })}
                </button>
              )}
              {chain.branched && (
                <div className="ml-5 mt-0.5 text-[10px] text-white/35">{t('有分叉：某段被接了不止一次')}</div>
              )}
              {isOpen && (
                <div className="ml-5 mt-1 flex flex-col">
                  {chain.segments.map((s, i) => (
                    <button
                      key={s.id}
                      onClick={() => jump(s.id)}
                      className="flex items-center gap-2 rounded px-1 py-0.5 text-left text-white/70 hover:bg-white/10 hover:text-white"
                    >
                      <span className="w-4 flex-none text-right font-mono text-white/30">{i + 1}</span>
                      <span className={`h-1.5 w-1.5 flex-none rounded-full ${s.hd ? 'bg-emerald-400' : 'bg-white/20'}`} />
                      <span className="truncate">{s.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
