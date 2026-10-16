'use client';

import { memo, useEffect, useState } from 'react';
import { NodeProps, useReactFlow } from '@xyflow/react';

import IconHandle from './IconHandle';
import NodeShell from './NodeShell';
import AudioPlayer from './AudioPlayer';
import { cardBody, defaultShadow, header, label, selectedShadow } from './PromptNode';
import { useAutoHeightNode } from '@/hooks/useAutoHeightNode';
import { api, type RefModEntry } from '@/lib/api';
import { BACKEND_URL } from '@/lib/config';
import { t } from '@/lib/i18n';
import { RefModNode as RefModNodeType } from '@/lib/types';
import { areNodePropsEqual } from '@/lib/utils';
import Select from '@/components/ui/Select';

const field = 'nodrag bg-white/5 border border-white/10 rounded px-1 py-0.5 font-mono text-[9px] text-zinc-300 w-full';

/**
 * A saved RefMod (Fantastic H3 pack) as a canvas resource: pick its look and voice, see the picture and the
 * recordings it was made from, and wire it to a video node's RefMod port like any other reference.
 */
function RefModNode({ id, data, selected }: NodeProps<RefModNodeType>) {
  const { updateNodeData } = useReactFlow();
  const [entries, setEntries] = useState<RefModEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [big, setBig] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.listRefMods().then((r) => { if (live) setEntries(r.refmods); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const looks = (entries || []).filter((e) => e.kind === 'image');
  const voices = (entries || []).filter((e) => e.kind === 'audio');
  const visual = data.visual as string | undefined;
  const audio = data.audio as string | undefined;
  const look = looks.find((e) => e.name === visual);
  const voice = voices.find((e) => e.name === audio);
  const preview = look?.preview_url ? `${BACKEND_URL}${look.preview_url}` : null;

  const sizing = useAutoHeightNode({
    id,
    ratioSources: [],
    hasMedia: false,
    mediaHidden: false,
    userWidth: data.userWidth,
    defaultW: 280,
  });

  const sources = [...(look?.sources || []), ...(voice?.sources || [])];
  const emotion = typeof voice?.params?.emotion === 'string' ? voice.params.emotion : '';

  return (
    <NodeShell nodeId={id} spec={sizing.spec} selected={selected} onResizeEnd={sizing.onResizeEnd} autoHeight>
      <div className="node-shell-headwrap" style={{ position: 'relative', flex: '0 0 auto' }}>
        <div style={header} data-chrome-row="header" className="node-shell-header flex items-center justify-between">
          <div className="flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.05] px-2 py-0.5 text-zinc-300">
            <span style={label} className="text-zinc-200" data-chrome="label">RefMod</span>
          </div>
        </div>
      </div>

      <div
        style={{ ...cardBody, flex: '0 0 auto', boxShadow: selected ? selectedShadow : defaultShadow }}
        className="nodrag nowheel space-y-2 p-2.5 text-[10px]"
      >
        {failed && <div className="text-[9px] text-red-400">{t('RefMod 列表加载失败')}</div>}
        {preview && (
          <img
            src={preview}
            alt={visual}
            title={t('点开看大图')}
            onClick={() => setBig(preview)}
            className="max-h-40 w-full cursor-zoom-in rounded object-cover"
          />
        )}
        <label className="block space-y-0.5">
          <span className="text-zinc-400">{t('外观')}</span>
          <Select
            className={field}
            value={visual || ''}
            onChange={(e) => updateNodeData(id, { visual: e.target.value || undefined })}
          >
            <option value="">{t('（无外观）')}</option>
            {visual && !look && <option value={visual}>{visual}</option>}
            {looks.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
          </Select>
        </label>
        <label className="block space-y-0.5">
          <span className="text-zinc-400">{t('声音')}</span>
          <Select
            className={field}
            value={audio || ''}
            onChange={(e) => updateNodeData(id, { audio: e.target.value || undefined })}
          >
            <option value="">{t('（无声音）')}</option>
            {audio && !voice && <option value={audio}>{audio}</option>}
            {voices.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}{typeof e.params?.emotion === 'string' && e.params.emotion ? ` · ${e.params.emotion}` : ''}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-zinc-400">{t('权重')}</span>
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            className={`${field} w-14`}
            value={(data.w as number) ?? 1}
            onChange={(e) => updateNodeData(id, { w: parseFloat(e.target.value) || 0 })}
          />
        </label>
        {emotion && <div className="text-[9px] text-amber-300/80">{t('情绪')}：{emotion}</div>}
        {sources.length > 0 && (
          <div className="space-y-1.5 border-t border-white/10 pt-1.5">
            <div className="text-zinc-400">{t('做成它的资料')}</div>
            {sources.map((src) => (
              <div key={src.url} className="space-y-0.5">
                {src.role === 'image' && (
                  <img
                    src={`${BACKEND_URL}${src.url}`}
                    alt=""
                    onClick={() => setBig(`${BACKEND_URL}${src.url}`)}
                    className="max-h-24 cursor-zoom-in rounded"
                  />
                )}
                {src.role === 'audio' && <AudioPlayer src={`${BACKEND_URL}${src.url}`} className="w-full" />}
                {src.note && <div className="text-[9px] text-zinc-500">{src.note}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {big && (
        <div
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 cursor-zoom-out"
          onClick={() => setBig(null)}
        >
          <img src={big} alt="" className="max-h-[90vh] max-w-[90vw] rounded shadow-2xl" />
        </div>
      )}

      <IconHandle type="source" id="out-refmod" portType="refmod" nodeId={id} title={t('RefMod（接到视频节点的 RefMod 口）')} />
    </NodeShell>
  );
}

export default memo(RefModNode, areNodePropsEqual);
