'use client';

import React from 'react';

import { api, type NodeVersion } from '@/lib/api';
import { useCutRoom } from '@/lib/editor/store';
import type { EditorAsset } from '@/lib/editor/types';
import { t } from '@/lib/i18n';

const tagOf = (url: string | null | undefined) => /_([0-9a-f]{8})(?:_\d+_?)?\.\w+$/.exec(url ?? '')?.[1] ?? '';

/** Which version of the node an asset is showing now, whatever file it opened. */
function usedIndex(asset: EditorAsset, versions: NodeVersion[]): number {
  const files = [asset.url, asset.roughUrl, asset.chainHead?.trimmedUrl, asset.roughChainHead?.trimmedUrl];
  return versions.findIndex((v) => files.some((f) => f && (f === v.url || f === v.untrimmedUrl || f === v.hd?.url)));
}

function when(createdAt: NodeVersion['createdAt']): string {
  const ms = Number(createdAt);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Switch THIS clip between the versions of the canvas node it came from, keeping the
 * cut where it is; other clips cut from the same shot stay on their own version. A version with a 高清 render made from it is shown at that
 * quality while "用高清" is on.
 */
export default function VersionSwitcher({ asset, clipId }: { asset: EditorAsset; clipId: string }) {
  const projectId = useCutRoom((s) => s.projectId);
  const nodeId = asset.nodeId;
  const [versions, setVersions] = React.useState<NodeVersion[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [useHd, setUseHd] = React.useState(true);
  const [busy, setBusy] = React.useState<number | null>(null);

  React.useEffect(() => {
    setVersions(null);
    setError(null);
    if (!projectId || !nodeId) return;
    let cancelled = false;
    api.nodeVersions(projectId, nodeId)
      .then((res) => { if (!cancelled) setVersions(res.versions); })
      .catch(() => { if (!cancelled) setError(t('读不到这个节点的版本（节点可能已删除）')); });
    return () => { cancelled = true; };
  }, [projectId, nodeId]);

  if (!nodeId || asset.kind !== 'video') return null;
  const used = versions ? usedIndex(asset, versions) : -1;

  const pick = async (index: number) => {
    if (!versions || busy !== null) return;
    setBusy(index);
    const ok = await useCutRoom.getState().switchClipVersion(clipId, versions[index], useHd);
    setBusy(null);
    if (!ok) setError(t('这个版本的文件读不了'));
    else setError(null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
        <input type="checkbox" checked={useHd} onChange={(e) => setUseHd(e.target.checked)} />
        {t('有高清版时用高清')}
      </label>
      {versions === null && !error && <p className="text-[11px] text-zinc-600">{t('读取中…')}</p>}
      {error && <p className="text-[11px] text-amber-300/80">{error}</p>}
      <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
        {versions?.map((v, i) => (
          <button
            key={v.url}
            disabled={busy !== null}
            onClick={() => void pick(i)}
            className={`flex items-center gap-1.5 rounded border px-2 py-1 text-left text-[11px] transition-colors ${
              i === used
                ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-100'
                : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.08]'
            }`}
            title={v.url}
          >
            <span className="font-mono text-zinc-400">{tagOf(v.url)}</span>
            <span className="flex-1 truncate text-zinc-500">{when(v.createdAt)}</span>
            {v.adopted && <span className="text-emerald-300">{t('验收')}</span>}
            {v.current && <span className="text-sky-300">{t('画布当前')}</span>}
            {v.hd && <span className="text-fuchsia-300">{t('高清')}</span>}
            {busy === i && <span className="text-zinc-500">…</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
