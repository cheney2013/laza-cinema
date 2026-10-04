'use client';

import { memo, useEffect, useMemo, useState } from 'react';
import type { Edge } from '@xyflow/react';
import { useStore } from '@/lib/store';
import { t } from '@/lib/i18n';
import { copyText } from '@/lib/copyText';
import { BACKEND_URL as API_BASE } from '@/lib/config';
import { pushTake, type H3Take } from '@/lib/h3/takes';
import {
  currentTakeIndex, dirtyKeys, inputIssues, snapshotInputs, switchPatch, takeForDisplayed, takeLatent,
  type InputIssue,
} from '@/lib/h3/takeSwitch';
import type { ConnectedInput } from '@/hooks/useConnectedInputs';

/**
 * ‹ 3/13 › over a generated clip: step through the node's versions. The node's
 * parameters follow the version shown; editing them afterwards makes the next
 * run a new version. Warns when the inputs that version was made with are gone
 * or differ from the current wiring.
 */
function TakeNavigator({
  nodeId, data, connected, onSwitch,
}: {
  nodeId: string;
  data: Record<string, unknown>;
  connected: ConnectedInput[];
  onSwitch: (patch: Record<string, unknown>) => void;
}) {
  const takes = useMemo(
    () => ((data.takes as H3Take[] | undefined) || []).filter((tk) => tk.url),
    [data.takes],
  );
  // Newest first in storage; shown oldest = 1.
  const idx = currentTakeIndex(takes, data.generatedUrl);
  const take = idx >= 0 ? takes[idx] : undefined;
  const nodeIdsKey = useStore((s) => s.nodes.map((n) => n.id).join('|'));
  const nodeIds = useMemo(() => new Set(nodeIdsKey.split('|')), [nodeIdsKey]);
  const [fileGone, setFileGone] = useState(false);
  // Warnings the director has closed, keyed by the version and the exact messages:
  // a new version or a new problem shows again.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [dismissedDirty, setDismissedDirty] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const issues = useMemo(
    () => inputIssues(take, snapshotInputs(connected), nodeIds),
    [take, connected, nodeIds],
  );
  const dirty = dirtyKeys(take, data);

  // The clip file itself can be deleted by the library's clean-up.
  useEffect(() => {
    setFileGone(false);
    const url = take?.url;
    if (!url) return;
    let alive = true;
    fetch(url.startsWith('http') ? url : `${API_BASE}${url}`, { method: 'HEAD' })
      .then((r) => { if (alive && r.status === 404) setFileGone(true); })
      .catch(() => {});
    return () => { alive = false; };
  }, [take?.url]);

  // A clip on display that no take records still counts as a version.
  const total = takes.length + (idx < 0 && data.generatedUrl ? 1 : 0);
  if (total < 2 && !dirty.length && !issues.some((i) => i.kind !== 'unrecorded' && i.kind !== 'no-latent')) {
    return null;
  }

  const go = (to: number) => {
    const next = takes[to];
    if (!next || to === idx) return;
    if (dirty.length && !window.confirm(t('当前有未生成的修改（{keys}），切换版本会丢弃这些修改。继续？', { keys: dirty.join(', ') }))) {
      return;
    }
    const patch = switchPatch(next, data);
    // The clip on display has no take yet: record it first, or switching away
    // orphans it (2026-09-19, s2-c5: a fresh render vanished this way).
    const orphan = idx < 0 ? takeForDisplayed(data, `view-${Date.now().toString(36)}`) : null;
    if (orphan) patch.takes = pushTake(data.takes as H3Take[] | undefined, orphan);
    onSwitch(patch);
  };

  // Put the wiring back the way this version had it (sources that still exist).
  const restoreWiring = () => {
    if (!take?.inputs) return;
    const { edges, setEdges } = useStore.getState();
    const keep = edges.filter((e) => e.target !== nodeId);
    const restored: Edge[] = take.inputs
      .filter((inp) => nodeIds.has(inp.source))
      .map((inp, i) => {
        const old = edges.find((e) => e.target === nodeId && e.source === inp.source && e.targetHandle === inp.targetHandle);
        return old ?? {
          id: `e-take-${nodeId}-${i}-${Date.now().toString(36)}`,
          source: inp.source,
          target: nodeId,
          sourceHandle: inp.targetHandle === 'in-ref-audio' ? 'out-audio'
            : inp.targetHandle === 'in-motion-context' || inp.targetHandle === 'in-ref-video' ? 'out-video' : 'out-image',
          targetHandle: inp.targetHandle,
        };
      });
    setEdges([...keep, ...restored]);
    window.dispatchEvent(new Event('takeSnapshot'));
  };

  const shown = idx >= 0 ? takes.length - idx : total;
  const file = (take?.url || (data.generatedUrl as string) || '').split('/').pop()?.replace(/_00001_\.mp4$/, '') || '';
  // The version's unique id: the hash in its file name (H3_Chunk_f8ec514b -> f8ec514b),
  // what the agent and the director name a version by (2026-09-19).
  const versionId = file.match(/([0-9a-f]{8})(?:\.mp4)?$/)?.[1] || file;
  const warnings: string[] = [];
  if (fileGone) warnings.push(t('该版本视频文件已删除'));
  const text = (i: InputIssue) => {
    switch (i.kind) {
      case 'missing-node': return t('输入丢失：{h} 的来源节点已删除', { h: i.handle });
      case 'removed': return t('输入未连接：{h}（来源节点还在）', { h: i.handle });
      case 'changed': return t('输入已变：{h} 的来源内容和该版本不同', { h: i.handle });
      case 'added': return t('多了该版本没有的输入：{h}', { h: i.handle });
      case 'unrecorded': return t('该版本未记录输入，无法核对');
      case 'no-latent': return t('该版本没有接续潜空间，下游无法从它接续');
    }
  };
  warnings.push(...issues.filter((i) => i.kind !== 'unrecorded').map(text));
  const dirtyKey = `${take?.id ?? data.generatedUrl ?? ''}|${dirty.join('|')}`;
  const warningKey = `${take?.id ?? data.generatedUrl ?? ''}|${warnings.join('|')}`;
  const unrecorded = issues.some((i) => i.kind === 'unrecorded');
  const latent = take ? takeLatent(take) : null;
  const canRestore = Boolean(take?.inputs) && issues.some((i) => i.kind === 'removed' || i.kind === 'added');

  return (
    <div
      className="nodrag absolute right-2.5 top-2.5 z-20 flex max-w-[60%] flex-col items-end gap-1"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[10px] text-zinc-200">
        <button
          className="px-1 disabled:opacity-30 hover:text-white cursor-pointer"
          disabled={idx < 0 ? takes.length === 0 : idx >= takes.length - 1}
          onClick={() => go(idx < 0 ? 0 : idx + 1)}
          title={t('上一个版本')}
        >‹</button>
        <span title={latent?.inferred ? `${file}
${t('潜空间按文件名推断')}: ${latent.name}` : file}>{shown}/{total}</span>
        <button
          className="px-1 disabled:opacity-30 hover:text-white cursor-pointer"
          disabled={idx <= 0}
          onClick={() => go(idx - 1)}
          title={t('下一个版本')}
        >›</button>
        {versionId && (
          <button
            className="nodrag ml-0.5 border-l border-white/15 pl-1.5 text-zinc-400 hover:text-white cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              void copyText(versionId).then((ok) => {
                if (!ok) return;
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
            title={t('复制版本 ID')}
          >{copied ? t('已复制') : versionId}</button>
        )}
      </div>
      {dirty.length > 0 && dismissedDirty !== dirtyKey && (
        <div className="relative rounded-md bg-amber-500/80 py-0.5 pl-1.5 pr-5 text-[10px] text-black" title={dirty.join(', ')}>
          {t('已修改参数，重新生成将成为新版本')}
          <button
            className="absolute right-1 top-0 cursor-pointer text-black/60 hover:text-black"
            onClick={() => setDismissedDirty(dirtyKey)}
            title={t('关闭提示')}
          >✕</button>
        </div>
      )}
      {unrecorded && (
        <div className="rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-zinc-400">{t('该版本未记录输入，无法核对')}</div>
      )}
      {warnings.length > 0 && dismissedKey !== warningKey && (
        <div className="relative rounded-md bg-rose-600/85 py-1 pl-1.5 pr-5 text-[10px] leading-snug text-white">
          <button
            className="absolute right-1 top-0.5 cursor-pointer text-white/70 hover:text-white"
            onClick={() => setDismissedKey(warningKey)}
            title={t('关闭提示')}
          >✕</button>
          {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
          {canRestore && (
            <button className="mt-1 underline cursor-pointer" onClick={restoreWiring}>
              {t('恢复该版本的连线')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(TakeNavigator);
