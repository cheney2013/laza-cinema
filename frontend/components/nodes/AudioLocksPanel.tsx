'use client';

import { useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useStore } from '@/lib/store';

/** One lock as the canvas stores it (data.audioLocks): a recording put on a second of the delivered clip. */
export interface LockRow {
  node?: string;
  url?: string;
  at: number;
  strength?: number;
  text?: string;
  from?: number;
  to?: number;
}

interface Props {
  nodeId: string;
  locks: LockRow[];
  generatedUrl?: string | null;
  latentFilename?: string | null;
  seed?: number;
  busy: boolean;
  onChange: (locks: LockRow[]) => void;
}

const SELF = '__self__';

const cell = 'bg-white/[0.06] border border-white/10 rounded px-1.5 py-0.5 text-[11px] text-zinc-100 outline-none focus:border-white/40';

/**
 * The node's audio locks, editable, and the button that redoes only the sound with them.
 *
 * A lock puts a recording (a canvas audio node, or this node's own take as the carrier of its
 * ambience) on a second of the delivered clip and keeps it as recorded; everything else is
 * generated around it. 只重做声音 keeps the picture of the take on display and re-noises its audio
 * against the locks (backend/audio_redo.py), saving the result as a new version. The lines that are
 * locked are cut out of the prompt for that run on their own.
 */
export default function AudioLocksPanel({ nodeId, locks, generatedUrl, latentFilename, seed, busy, onChange }: Props) {
  const projectId = useStore((s) => s.currentProjectId);
  const sceneId = useStore((s) => s.currentSceneId);
  const nodes = useStore((s) => s.nodes);
  const [mode, setMode] = useState<'polish' | 'reroll'>('reroll');
  const [redoSeed, setRedoSeed] = useState<string>('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  const audioNodes = useMemo(
    () => nodes
      .filter((n) => n.id !== nodeId && ((n.data as any)?.mediaType === 'audio' || n.type === 'audioGen'))
      .map((n) => {
        const d = n.data as any;
        return { id: n.id, label: String(d?.alias || d?.label || n.id).slice(0, 48) };
      }),
    [nodes, nodeId]
  );

  const rows = locks;
  const set = (i: number, patch: Partial<LockRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const source = (r: LockRow) => (r.node ? r.node : r.url && r.url === generatedUrl ? SELF : r.url ? '__url__' : '');
  const pick = (i: number, value: string) => {
    if (value === SELF) set(i, { node: undefined, url: generatedUrl ?? undefined });
    else set(i, { node: value, url: undefined });
  };

  const canRedo = Boolean(generatedUrl && latentFilename && rows.length && projectId) && !busy && !sending;

  const redo = async () => {
    if (!projectId) return;
    setSending(true);
    setMessage(null);
    try {
      const out = await api.redoAudio(projectId, nodeId, {
        mode,
        seed: redoSeed.trim() === '' ? undefined : Number(redoSeed),
        scene: sceneId || undefined,
      });
      const cut = Array.isArray((out as any).prompt_stripped) ? (out as any).prompt_stripped.length : 0;
      setMessage({
        ok: true,
        text: t('已提交，排队重做声音{v1}', { v1: cut ? t('（被锁台词已从提示词里切掉 {v1} 处）', { v1: cut }) : '' }),
      });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2 space-y-2">
      <div className="flex items-center justify-between text-[10px] text-zinc-400 font-medium">
        <span>{t('音频锁定')}</span>
        <button
          type="button"
          className="px-1.5 py-0.5 rounded border border-white/15 text-zinc-300 hover:bg-white/10"
          onClick={() => onChange([...rows, { node: audioNodes[0]?.id, at: 0, strength: 1, text: '' }])}
        >
          + {t('添加')}
        </button>
      </div>

      {rows.length === 0 && (
        <div className="text-[10px] text-zinc-500">
          {t('把录音放在成片的指定秒数并保持原样，其余声音由模型围绕它生成。')}
        </div>
      )}

      {rows.map((r, i) => (
        <div key={i} className="space-y-1 rounded border border-white/10 p-1.5">
          <div className="flex gap-1 items-center">
            <select
              className={`${cell} flex-1 min-w-0`}
              value={source(r)}
              onChange={(e) => pick(i, e.target.value)}
              title={t('录音来源：画布上的音频节点，或本节点当前这一版（作垫底的环境声）')}
            >
              {source(r) === '__url__' && <option value="__url__">{t('自定义地址')}</option>}
              {generatedUrl && <option value={SELF}>{t('本节点当前这一版（垫底）')}</option>}
              {audioNodes.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <button
              type="button"
              className="px-1.5 text-zinc-400 hover:text-red-300"
              title={t('删除这条')}
              onClick={() => onChange(rows.filter((_, k) => k !== i))}
            >×</button>
          </div>
          <div className="flex flex-wrap gap-1 items-center text-[10px] text-zinc-400">
            <label className="flex items-center gap-1">{t('放在')}
              <input type="number" step={0.01} min={0} className={`${cell} w-16`} value={r.at}
                onChange={(e) => set(i, { at: Number(e.target.value) })} />s
            </label>
            <label className="flex items-center gap-1">{t('强度')}
              <input type="number" step={0.05} min={0} max={1} className={`${cell} w-14`} value={r.strength ?? 1}
                onChange={(e) => set(i, { strength: Number(e.target.value) })} />
            </label>
            <label className="flex items-center gap-1" title={t('只锁录音的这一段（秒）；留空是整段')}>{t('锁')}
              <input type="number" step={0.1} min={0} className={`${cell} w-14`} value={r.from ?? ''} placeholder="0"
                onChange={(e) => set(i, { from: e.target.value === '' ? undefined : Number(e.target.value) })} />–
              <input type="number" step={0.1} min={0} className={`${cell} w-14`} value={r.to ?? ''} placeholder={t('末')}
                onChange={(e) => set(i, { to: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </label>
          </div>
          <input
            className={`${cell} w-full`}
            value={r.text ?? ''}
            placeholder={t('这句台词的原文（用来从提示词里切掉重复的台词）')}
            onChange={(e) => set(i, { text: e.target.value })}
          />
        </div>
      ))}

      <div className="pt-1 border-t border-white/10 space-y-1">
        <div className="flex gap-1 items-center text-[10px] text-zinc-400">
          <select className={cell} value={mode} onChange={(e) => setMode(e.target.value as 'polish' | 'reroll')}
            title={t('润色：同样的声音清理一遍；重新生成：保持画面，围着锁定重新生成整条声音')}>
            <option value="reroll">{t('重新生成')}</option>
            <option value="polish">{t('润色')}</option>
          </select>
          <label className="flex items-center gap-1">{t('种子')}
            <input className={`${cell} w-20`} value={redoSeed} placeholder={seed !== undefined ? String(seed) : t('随机')}
              onChange={(e) => setRedoSeed(e.target.value.replace(/[^0-9-]/g, ''))} />
          </label>
          <button
            type="button"
            disabled={!canRedo}
            onClick={redo}
            className={`ml-auto px-2 py-0.5 rounded border text-[11px] ${canRedo ? 'border-emerald-400/50 text-emerald-200 hover:bg-emerald-400/10' : 'border-white/10 text-zinc-500 cursor-not-allowed'}`}
            title={
              !generatedUrl ? t('还没有渲染出片')
                : !latentFilename ? t('这一版没有保存潜变量，不能只重做声音')
                  : !rows.length ? t('先添加至少一条锁定')
                    : t('保持这一版的画面，只重做声音，结果作为新的一版')
            }
          >
            {sending ? t('提交中…') : t('只重做声音')}
          </button>
        </div>
        {message && (
          <div className={`text-[10px] ${message.ok ? 'text-emerald-300' : 'text-red-300'} break-words`}>{message.text}</div>
        )}
      </div>
    </div>
  );
}
