'use client';

import React from 'react';

import { useCutRoom } from '@/lib/editor/store';
import {
  type Clip,
  type TransitionType,
  NEUTRAL_FILTERS,
  VOLUME_CEILING_DB,
  VOLUME_FLOOR_DB,
  clipLabel,
  clipLength,
  dbToGain,
  formatDb,
  formatTimecode,
  gainToDb,
} from '@/lib/editor/types';
import { showAlert } from '@/components/ui/Dialog';
import { t } from '@/lib/i18n';
import { languageName, sourceTitle } from '@/lib/editor/subtitleLang';

import VersionSwitcher from './VersionSwitcher';

const TRANSITIONS: Array<{ value: TransitionType | 'none'; label: string }> = [
  { value: 'none', label: '硬切' },
  { value: 'dissolve', label: '交叉溶解' },
  { value: 'fade', label: '淡入黑' },
  { value: 'dip', label: '闪白' },
];

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];

/** Everything about the selected clip that is not its position on the timeline. */
export default function Inspector({ onLocate }: { onLocate: (nodeId: string) => void }) {
  const timeline = useCutRoom((s) => s.timeline);
  const selection = useCutRoom((s) => s.selection);
  const sequences = useCutRoom((s) => s.sequences);
  const exportStatus = useCutRoom((s) => s.exportStatus);
  const exportTarget = useCutRoom((s) => s.exportTarget);
  const exportProgress = useCutRoom((s) => s.exportProgress);
  const clip = timeline.clips.find((c) => c.id === selection[0]) ?? null;
  const asset = clip ? timeline.assets[clip.assetId] : null;
  // Why the seam dissolve was refused, for the clip it was tried on; gone when another is selected.
  const [seamNote, setSeamNote] = React.useState<string | null>(null);
  React.useEffect(() => setSeamNote(null), [clip?.id]);

  if (!clip) {
    return (
      <div className="w-[248px] flex-none overflow-y-auto border-l border-white/10 p-3">
        <Header>{t('片段属性')}</Header>
        <p className="text-[11px] leading-relaxed text-zinc-600">
          
          {t('选中一个片段来调整转场、调色、变速和音量。')}
        </p>
      </div>
    );
  }

  const store = useCutRoom.getState();
  const exporting = exportStatus === 'queued' || exportStatus === 'running';
  const filters = clip.filters ?? NEUTRAL_FILTERS;
  const isText = Boolean(clip.text);
  // A reference plays the other film as it is cut there; its look is edited in
  // that film's own tab, so only placement and trim are this clip's.
  const isRef = Boolean(clip.seqRef);
  const refName = isRef ? sequences.find((q) => q.id === clip.seqRef)?.name : undefined;

  return (
    <div className="flex w-[248px] flex-none flex-col gap-3 overflow-y-auto border-l border-white/10 p-3">
      <Header>{clipLabel(clip, asset, refName)}</Header>

      {/* Naming is the first thing in the panel because it is what you reach for
          while the shot is fresh in your head. Blank means "no name": the clip
          falls back to its source's title rather than becoming nameless. */}
      <input
        value={clip.name ?? ''}
        placeholder={isText ? t('字幕') : asset?.title ?? t('片段')}
        onChange={(e) => store.updateClip(clip.id, { name: e.target.value })}
        onBlur={(e) => {
          // Normalise on the way out: a name of nothing but spaces is no name.
          store.updateClip(clip.id, { name: e.target.value.trim() || undefined });
          window.dispatchEvent(new Event('inputBlurred'));
        }}
        // One snapshot per rename, taken BEFORE the first keystroke. Committing
        // on the way out would snapshot the new name, and undo would then have
        // nothing to go back to; committing per keystroke would make undo walk
        // the name back letter by letter.
        onFocus={() => {
          store.commit();
          window.dispatchEvent(new Event('inputFocused'));
        }}
        className="rounded border border-white/10 bg-black/40 px-2 py-1 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-400/60"
      />

      <div className="flex flex-col gap-1 text-[11px]">
        <Row label={t('轨道')} value={timeline.tracks.find((t) => t.id === clip.trackId)?.name ?? clip.trackId} />
        <Row label={t('起点')} value={formatTimecode(clip.start, timeline.fps)} />
        <Row label={t('长度')} value={t('{v1} 帧', { v1: clipLength(clip) })} />
        {asset && (
          <Row
            label={t('源')}
            value={asset.fps ? `${asset.width}×${asset.height} · ${asset.fps.toFixed(2)}fps` : t('静帧')}
          />
        )}
      </div>

      {/* Bypass sits above everything else it disables — the rest of this panel
          still edits the clip, it just will not be seen until this is off. */}
      <button
        // The panel edits the clip it shows, so this button acts on that clip
        // alone — the transport button and B are the multi-clip route.
        onClick={() => store.commitUpdate(clip.id, { bypassed: !clip.bypassed })}
        className={`rounded-lg border px-2 py-1.5 text-[11px] transition-colors ${
          clip.bypassed
            ? 'border-amber-400/50 bg-amber-400/15 text-amber-200 hover:bg-amber-400/25'
            : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]'
        }`}
        title={t('旁通后片段留在原位，但不参与预览和导出 (B)')}
      >
        {clip.bypassed ? t('已旁通 · 点击恢复 (B)') : t('旁通此片段 (B)')}
      </button>

      {/* ── Transition ─────────────────────────────────────────────── */}
      {isRef && (
        <div className="flex flex-col gap-1.5 rounded border border-amber-300/20 bg-amber-300/[0.06] p-2 text-[11px] leading-relaxed text-amber-100/80">
          {t('这是对另一部影片的引用，内容随那部影片的剪辑实时变化。调色、变速、淡入淡出请回原影片里改。')}
          <button
            onClick={() => void store.activate(clip.seqRef as string).catch(() => undefined)}
            className="self-start rounded border border-amber-300/30 px-2 py-0.5 text-amber-100 hover:bg-amber-300/10"
          >
            {t('打开「{v1}」编辑', { v1: refName ?? clip.seqRef ?? '' })}
          </button>
        </div>
      )}

      {!isText && !isRef && asset?.nodeId && asset.kind === 'video' && (
        <Section title={t('切换版本')}>
          <VersionSwitcher asset={asset} clipId={clip.id} />
        </Section>
      )}

      {!isText && !isRef && (
        <Section title={t('入场转场')}>
          {asset?.chainHead && asset.chainHead.frames > 0 && (
            <div className="flex flex-col gap-1">
              <button
                onClick={() => setSeamNote(store.seamDissolve(clip.id))}
                className="rounded border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-100 transition-colors hover:bg-emerald-400/20"
                title={t('接续生成的片段：露出开头的重叠帧，对齐到上一段末尾，并在这段重叠上做交叉溶解。后面的片段不动。这是「自动」规则：重叠段只播上一段的声音，这个片段开头重叠部分的声音不用。你已手动处理的帧不动。')}
              >
                {t('接缝溶解（一键）')}
              </button>
              {seamNote && <p className="text-[10px] leading-relaxed text-amber-300/80">{t(seamNote)}</p>}
            </div>
          )}
          {clip.seamMute && (
            <div className="flex flex-col gap-1 rounded border border-emerald-400/20 bg-emerald-400/[0.05] p-1.5 text-[10px] leading-relaxed text-emerald-100/80">
              {t('自动接缝：这个片段开头第 {v1}–{v2} 帧的声音不用，这段只播上一段的声音。你手动处理的帧不受影响。', { v1: clip.seamMute.from + 1, v2: clip.seamMute.to })}
              <button
                onClick={() => store.commitUpdate(clip.id, {
                  seamMute: undefined,
                  transitionIn: clip.transitionIn ? { type: clip.transitionIn.type, frames: clip.transitionIn.frames } : undefined,
                })}
                className="self-start rounded border border-emerald-400/30 px-1.5 py-0.5 text-emerald-100 hover:bg-emerald-400/10"
                title={t('去掉自动处理：画面不变，这几帧的声音恢复播放，之后按你手动设的处理。')}
              >
                {t('去掉自动处理（恢复这段声音）')}
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {TRANSITIONS.map((option) => {
              const active =
                option.value === 'none'
                  ? !clip.transitionIn
                  : clip.transitionIn?.type === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() =>
                    store.setTransition(
                      clip.id,
                      option.value === 'none'
                        ? null
                        : { type: option.value, frames: clip.transitionIn?.frames || 12 }
                    )
                  }
                  className={chip(active)}
                >
                  {t(option.label)}
                </button>
              );
            })}
          </div>
          {clip.transitionIn && (
            <Slider
              label={t('时长')}
              suffix=" 帧"
              min={2}
              max={48}
              step={1}
              value={clip.transitionIn.frames}
              onChange={(frames) =>
                store.setTransition(clip.id, { type: clip.transitionIn!.type, frames })
              }
            />
          )}
          {clip.transitionIn?.type === 'dissolve' && (
            <p className="text-[10px] leading-relaxed text-zinc-600">
              
              {t('溶解需要重叠：片段已向前移动到与上一段重叠')} {clip.transitionIn.frames}  {t('帧。')}
            </p>
          )}
        </Section>
      )}

      {/* ── Fades ──────────────────────────────────────────────────── */}
      {!isRef && (
      <Section title={t('淡入淡出')}>
        <Slider label={t('淡入')} suffix=" 帧" min={0} max={72} step={1} value={clip.fadeIn}
          onChange={(fadeIn) => store.commitUpdate(clip.id, { fadeIn })} />
        <Slider label={t('淡出')} suffix=" 帧" min={0} max={72} step={1} value={clip.fadeOut}
          onChange={(fadeOut) => store.commitUpdate(clip.id, { fadeOut })} />
      </Section>
      )}

      {/* A reference is one gain stage over the whole stretch of the other film it
          shows: every shot in it is scaled by this on top of its own volume, and the
          bars on the timeline are drawn at the level that comes out. */}
      {isRef && (
        <Section title={t('引用整体音量')}>
          <Slider
            label={t('音量')}
            suffix=" dB"
            min={VOLUME_FLOOR_DB}
            max={VOLUME_CEILING_DB}
            step={0.5}
            value={gainToDb(clip.volume)}
            format={formatDb}
            onChange={(db) => store.updateClip(clip.id, { volume: dbToGain(db) })}
          />
          <label className="flex items-center justify-between text-[11px] text-zinc-400">
            {t('静音')}
            <input
              type="checkbox"
              checked={clip.muted}
              onChange={(e) => store.commitUpdate(clip.id, { muted: e.target.checked })}
            />
          </label>
        </Section>
      )}

      {/* ── Speed and audio ────────────────────────────────────────── */}
      {!isText && !isRef && (
        <Section title={t('变速与声音')}>
          <div className="flex flex-wrap gap-1">
            {SPEEDS.map((speed) => (
              <button
                key={speed}
                onClick={() => store.commitUpdate(clip.id, { speed })}
                className={chip(Math.abs((clip.speed || 1) - speed) < 0.001)}
              >
                {speed}x
              </button>
            ))}
            {/* Any rate, to two decimals: the presets cannot fit a clip to an exact
                length (a 5.3 s take into a 4.8 s gap is 1.10x). */}
            <SpeedInput value={clip.speed || 1} onCommit={(speed) => store.commitUpdate(clip.id, { speed })} />
          </div>
          {/* Decibels on the slider, linear gain in the model: 0 dB is the
              clip as recorded, and the bottom of the travel is silence. */}
          <Slider
            label={t('音量')}
            suffix=" dB"
            min={VOLUME_FLOOR_DB}
            max={VOLUME_CEILING_DB}
            step={0.5}
            value={gainToDb(clip.volume)}
            format={formatDb}
            onChange={(db) => store.updateClip(clip.id, { volume: dbToGain(db) })}
          />
          <button
            onClick={() => {
              useCutRoom.setState({ selection: [clip.id] });
              const why = store.detachAudio();
              if (why) void showAlert(why);
            }}
            disabled={clip.muted || !asset?.hasAudio}
            className="self-start rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08] disabled:opacity-40"
            title={
              asset?.hasAudio
                ? t('把这一镜的声音拆到独立音频轨，画面转为静音')
                : t('这个素材没有音轨')
            }
          >
            
            {t('分离音频')}
          </button>
          <label className="flex items-center justify-between text-[11px] text-zinc-400">
            
            {t('静音')}
            <input
              type="checkbox"
              checked={clip.muted}
              onChange={(e) => store.commitUpdate(clip.id, { muted: e.target.checked })}
            />
          </label>
        </Section>
      )}

      {/* Crop, fit, rotate and flip are not here on purpose: they are geometry,
          and geometry is chosen by looking at the picture. They live on the
          monitor's own toolbar, over the frame they reshape. */}

      {/* ── Colour ─────────────────────────────────────────────────── */}
      {!isText && !isRef && (
        <Section title={t('调色')}>
          <Slider label={t('亮度')} min={-0.5} max={0.5} step={0.01} value={filters.brightness}
            onChange={(brightness) => store.setFilters(clip.id, { brightness })} />
          <Slider label={t('对比度')} min={0.3} max={2} step={0.01} value={filters.contrast}
            onChange={(contrast) => store.setFilters(clip.id, { contrast })} />
          <Slider label={t('饱和度')} min={0} max={2.5} step={0.01} value={filters.saturation}
            onChange={(saturation) => store.setFilters(clip.id, { saturation })} />
          <Slider label={t('色温')} suffix="K" min={2500} max={12000} step={100} value={filters.temperature}
            onChange={(temperature) => store.setFilters(clip.id, { temperature })} />
          <button
            onClick={() => store.commitUpdate(clip.id, { filters: undefined })}
            className="self-start text-[10px] text-zinc-500 hover:text-zinc-300"
          >
            
            {t('重置调色')}
          </button>
        </Section>
      )}

      {/* ── Text ───────────────────────────────────────────────────── */}
      {isText && clip.text && (
        <Section title={t('文字')}>
          {(() => {
            const source = sourceTitle(timeline, clip);
            return source && (
              <p className="whitespace-pre-wrap rounded border border-white/5 bg-white/[0.03] p-2 text-[11px] text-zinc-400">
                <span className="mr-1 text-zinc-600">{languageName(source.lang)}</span>
                {source.words}
              </p>
            );
          })()}
          <textarea
            value={clip.text.content}
            onChange={(e) => store.setText(clip.id, { content: e.target.value })}
            onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
            onBlur={() => window.dispatchEvent(new Event('inputBlurred'))}
            rows={3}
            className="w-full resize-none rounded border border-white/10 bg-black/40 p-2 text-[12px] text-zinc-100 outline-none focus:border-emerald-400/60"
          />
          <button
            onClick={() => window.dispatchEvent(new Event('openSubtitleStyle'))}
            className="self-start text-[10px] text-zinc-500 underline decoration-dotted hover:text-zinc-300"
          >
            {t('字号、颜色、位置在顶栏「字幕样式」里改，对本影片所有字幕生效')}
          </button>
        </Section>
      )}

      {asset && (
        <button
          onClick={() => onLocate(asset.nodeId)}
          className="rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08]"
        >
          
          {t('在画布中定位')}
        </button>
      )}

      {/* One shot, rendered as it is cut here and hung back on the canvas as a
          node — so a trim, a crop or a colour move can go on to feed the next
          generation without the whole film being exported first. Sharing the
          one export slot is why this is disabled while any render runs. */}
      <button
        onClick={() => void store.startClipExport(clip.id, clipLabel(clip, asset))}
        disabled={exporting}
        className="rounded border border-sky-400/40 bg-sky-400/10 px-2 py-1 text-[11px] text-sky-200 hover:bg-sky-400/20 disabled:opacity-40"
        title={t('只渲染这一个片段（含裁切、变速、调色、音量），完成后作为素材节点放到画布中央')}
      >
        {exporting && exportTarget === 'canvas'
          ? t('导出中 {v1}%', { v1: Math.round(exportProgress * 100) })
          : t('导出此片段到画布')}
      </button>
    </div>
  );
}

export const chip = (active: boolean) =>
  `rounded px-2 py-0.5 text-[11px] ${
    active ? 'bg-emerald-400/20 text-emerald-200' : 'bg-white/[0.05] text-zinc-400 hover:text-zinc-200'
  }`;

function Header({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 truncate text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-white/[0.07] pt-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-600">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-zinc-500">{label}</span>
      <span className="truncate font-mono text-zinc-300 tabular-nums">{value}</span>
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix = '',
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  /** Overrides the readout, for a scale whose number is not its value. */
  format?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-[11px] text-zinc-400">
      <span className="flex justify-between">
        {label}
        <span className="font-mono text-zinc-300 tabular-nums">
          {format ? format(value) : step < 1 ? value.toFixed(2) : Math.round(value)}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        // A drag fires continuously; the snapshot is taken once, when the
        // pointer goes down, so one gesture is one undo step.
        onPointerDown={() => useCutRoom.getState().commit()}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-white/15 accent-emerald-400"
      />
    </label>
  );
}

export type { Clip };


function SpeedInput({ value, onCommit }: { value: number; onCommit: (speed: number) => void }) {
  const [text, setText] = React.useState(String(+value.toFixed(3)));
  React.useEffect(() => { setText(String(+value.toFixed(3))); }, [value]);
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) { setText(String(+value.toFixed(3))); return; }
    const clamped = Math.min(8, Math.max(0.1, Math.round(n * 1000) / 1000));
    setText(String(clamped));
    if (Math.abs(clamped - value) > 0.0005) onCommit(clamped);
  };
  return (
    <label className="flex items-center gap-1 text-[11px] text-zinc-400">
      <input
        type="number"
        min={0.1}
        max={8}
        step={0.01}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="w-16 rounded-md bg-white/[0.06] border border-white/10 px-1.5 py-0.5 text-zinc-100 font-mono text-[11px] outline-none focus:border-white/30"
        title="0.1–8x"
      />
      x
    </label>
  );
}
