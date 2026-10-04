'use client';

import type React from 'react';

import ReangleOrbit3D from './ReangleOrbit3D';
import { ReangleKeyframe } from '@/lib/types';
import { t } from '@/lib/i18n';

/**
 * Visual camera controls for the CrossView node.
 *
 * Orbit pad: the 3D orbit view (ReangleOrbit3D) plus the readout, risk note and
 * preset angles.
 *
 * Camera plan: the keyframe list shown as shots instead of JSON. Two keyframes on
 * adjacent frames are a hard cut, so a shot marked "cut" is stored as the previous
 * camera held on f-1 plus the new camera on f -- the same data.keyframes the backend
 * already takes, nothing new in the schema.
 */


/** from: for a moving shot (cut false), the keyframe where the move starts; the previous camera holds until then. */
export interface CameraShot { f: number; az: number; el: number; cut: boolean; from?: number }

/** Collapse hold+cut pairs back into shots. */
export function keyframesToShots(kfs: ReangleKeyframe[]): CameraShot[] {
  const sorted = [...kfs].sort((a, b) => a.f - b.f);
  const shots: CameraShot[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const k = sorted[i];
    const next = sorted[i + 1];
    // k is only the held tail of the previous shot when the next frame cuts away.
    const prev = shots[shots.length - 1];
    if (next && next.f === k.f + 1 && prev && prev.az === k.az && prev.el === k.el) {
      shots.push({ f: next.f, az: next.az, el: next.el, cut: true });
      i++;
      continue;
    }
    // A hold at the previous camera followed by a move: the move starts at k.
    if (next && next.f > k.f + 1 && prev && prev.az === k.az && prev.el === k.el
        && (next.az !== k.az || next.el !== k.el)) {
      shots.push({ f: next.f, az: next.az, el: next.el, cut: false, from: k.f });
      i++;
      continue;
    }
    shots.push({ f: k.f, az: k.az, el: k.el, cut: false });
  }
  // The clip's opening needs a camera. A list whose first shot starts later
  // (e.g. only "frame 31: -30") means the source camera until then, so that
  // becomes shot 1 at 0/0 -- rather than dragging the later shot back to frame 1.
  if (shots.length && shots[0].f > 1) {
    shots[0] = { ...shots[0], cut: true };
    shots.unshift({ f: 1, az: 0, el: 0, cut: false });
  }
  if (shots.length) shots[0] = { ...shots[0], f: 1, cut: false };
  return shots;
}

export function shotsToKeyframes(shots: CameraShot[]): ReangleKeyframe[] {
  const sorted = [...shots].sort((a, b) => a.f - b.f);
  // Shot 1 always starts at frame 1: deleting the shot before it must not leave
  // the clip's opening without a camera (and an uneditable start frame on screen).
  if (sorted.length) sorted[0] = { ...sorted[0], f: 1, cut: false };
  const out: ReangleKeyframe[] = [];
  sorted.forEach((s, i) => {
    const prev = sorted[i - 1];
    if (s.cut && prev && s.f - 1 > prev.f) out.push({ f: s.f - 1, az: prev.az, el: prev.el, dist: 1 });
    if (!s.cut && prev && s.from && s.from > prev.f && s.from < s.f) out.push({ f: s.from, az: prev.az, el: prev.el, dist: 1 });
    out.push({ f: s.f, az: s.az, el: s.el, dist: 1 });
  });
  return out;
}

interface PadProps {
  az: number;
  el: number;
  onChange: (az: number, el: number) => void;
  disabled?: boolean;
}

export function CameraOrbitPad({ az, el, onChange, disabled }: PadProps) {
  const risk = Math.abs(az) > 45 ? (Math.abs(az) > 75 ? 'high' : 'mid') : 'ok';

  return (
    <div className={`flex items-stretch gap-2 nodrag nopan ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <ReangleOrbit3D az={az} el={el} onChange={onChange} disabled={disabled} />

      <div className="flex flex-col justify-between min-w-0 flex-1 py-0.5">
        <div className="font-mono text-[11px] text-zinc-200">
          {t('水平')} {az > 0 ? '+' : ''}{az}°<br />{t('俯仰')} {el > 0 ? '+' : ''}{el}°
        </div>
        <div className={`text-[9px] leading-snug ${risk === 'ok' ? 'text-teal-300/80' : risk === 'mid' ? 'text-amber-300/80' : 'text-red-300/80'}`}>
          {risk === 'ok' ? t('±45° 内，最稳') : risk === 'mid' ? t('超过 45°，新露出的区域靠模型补') : t('接近 90°，大部分是模型编的')}
        </div>
        <div className="flex flex-wrap gap-1">
          {[-45, -30, 30, 45].map((a) => (
            <button key={a} onClick={() => onChange(a, el)}
                    className={`px-1 rounded text-[9px] font-mono border ${a === az ? 'border-violet-400/60 text-violet-200 bg-violet-500/15' : 'border-white/10 text-zinc-400 bg-white/5 hover:text-zinc-200'}`}>
              {a > 0 ? '+' : ''}{a}
            </button>
          ))}
          <button onClick={() => onChange(az, 0)}
                  className="px-1 rounded text-[9px] border border-white/10 text-zinc-400 bg-white/5 hover:text-zinc-200">{t('平视')}</button>
        </div>
      </div>
    </div>
  );
}

interface PlanProps {
  shots: CameraShot[];
  selected: number;
  onSelect: (i: number) => void;
  onChange: (shots: CameraShot[]) => void;
  az: number;
  el: number;
  /** Source frame of keyframe f=1 (the node's start frame): rows show source frame numbers, as the player does. */
  startFrame?: number;
  /** Rendered under each row: that shot's own frame and its render button. */
  renderBelow?: (shot: CameraShot, i: number) => React.ReactNode;
}

/** Camera plan as a shot list; the selected shot is what the orbit pad edits. */
export function CameraPlan({ shots, selected, onSelect, onChange, az, el, startFrame = 0, renderBelow }: PlanProps) {
  // Keyframe f counts from 1 at the start frame; people read source frames (0-based, like the player).
  const toSrc = (f: number) => startFrame + f - 1;
  const fromSrc = (src: number) => Math.max(1, src - startFrame + 1);
  const set = (i: number, patch: Partial<CameraShot>) =>
    onChange(shots.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const add = () => {
    const last = shots[shots.length - 1];
    const base = shots.length ? [] : [{ f: 1, az, el, cut: false }];
    const f = last ? last.f + 40 : 41;
    onChange([...shots, ...base, { f, az: -az || 30, el, cut: true }]);
    onSelect(shots.length + base.length);
  };

  return (
    <div className="nodrag nopan flex flex-col gap-0.5">
      {shots.map((s, i) => (
        <div key={i}>
        <div onClick={() => onSelect(i)}
             className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[9px] cursor-pointer border ${i === selected ? 'border-violet-400/50 bg-violet-500/10' : 'border-transparent hover:bg-white/5'}`}>
          <span className="text-zinc-500 w-8">{t('机位')}{i + 1}</span>
          <span className="text-zinc-500">{t('第')}</span>
          <input type="number" min={startFrame} value={toSrc(i === 0 ? 1 : s.f)} disabled={i === 0}
                 title={i === 0 ? t('第一个机位从片头开始；要从后面某一帧才换机位，就在那一帧「加一个机位」') : undefined}
                 onChange={(e) => set(i, { f: fromSrc(parseInt(e.target.value) || 0) })}
                 className="w-10 bg-white/5 border border-white/10 rounded px-1 font-mono text-zinc-300 disabled:opacity-50" />
          <span className="text-zinc-500">{t('帧')}</span>
          {/* Typed here or dragged on the orbit pad above (which edits the selected shot). */}
          <span className="flex items-center gap-0.5 flex-1 font-mono text-zinc-300">
            <input type="number" step={5} min={-90} max={90} value={s.az}
                   title={t('水平角：正数向右绕，负数向左绕')}
                   onClick={(e) => e.stopPropagation()}
                   onChange={(e) => set(i, { az: Math.max(-90, Math.min(90, parseFloat(e.target.value) || 0)) })}
                   className="w-11 bg-white/5 border border-white/10 rounded px-1 text-zinc-300" />°
            <span className="text-zinc-600 mx-0.5">/</span>
            <input type="number" step={5} min={-45} max={60} value={s.el}
                   title={t('俯仰角：正数从上往下看，负数从下往上看')}
                   onClick={(e) => e.stopPropagation()}
                   onChange={(e) => set(i, { el: Math.max(-45, Math.min(60, parseFloat(e.target.value) || 0)) })}
                   className="w-11 bg-white/5 border border-white/10 rounded px-1 text-zinc-300" />°
          </span>
          {i > 0 && (
            <button onClick={(e) => { e.stopPropagation(); set(i, { cut: !s.cut }); }}
                    title={t('点一下切换。到这帧才切：上一个机位一直保持到前一帧；慢慢移过来：镜头从上一个机位开始就逐渐转向这里')}
                    className={`px-1 rounded border ${s.cut ? 'border-amber-400/50 text-amber-200' : 'border-white/10 text-zinc-500'}`}>
              {s.cut ? t('到这帧才切') : t('从上一机位慢慢移过来')}
            </button>
          )}
          {i > 0 && !s.cut && (
            <label className="flex items-center gap-0.5 text-zinc-500" onClick={(e) => e.stopPropagation()}
                   title={t('镜头从哪一帧开始移；之前保持上一个机位。留空＝从上一个机位那帧就开始移')}>
              {t('从第')}
              <input type="number" min={startFrame} placeholder={String(toSrc(shots[i - 1].f))}
                     value={s.from ? toSrc(s.from) : ''}
                     onChange={(e) => set(i, { from: e.target.value === '' ? undefined : fromSrc(parseInt(e.target.value) || 0) })}
                     className="w-10 bg-white/5 border border-white/10 rounded px-1 font-mono text-zinc-300" />
              {t('帧开始移')}
            </label>
          )}
          <button onClick={(e) => { e.stopPropagation(); onChange(shots.filter((_, j) => j !== i)); onSelect(Math.max(0, i - 1)); }}
                  className="text-zinc-600 hover:text-red-300 px-0.5">×</button>
        </div>
        {renderBelow?.(s, i)}
        </div>
      ))}
      <button onClick={add}
              className="self-start px-1.5 py-0.5 rounded text-[9px] border border-dashed border-white/15 text-zinc-400 hover:text-zinc-200">
        + {shots.length ? t('加一个机位') : t('分成多机位')}
      </button>
    </div>
  );
}
