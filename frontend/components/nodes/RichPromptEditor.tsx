'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { BACKEND_URL } from '@/lib/config';
import InlineTokenEditor, { type InlineTokenEditorHandle } from '@/components/InlineTokenEditor';
import { useBackdropDismiss } from '@/lib/useBackdropDismiss';
import { t } from '@/lib/i18n';

const API_BASE = BACKEND_URL;

export type TokenType =
  | 'image'
  | 'audio'
  | 'video'
  | 'subject'
  | 'dialogue'
  | 'voiceover'
  | 'scenetrans'
  | 'cutoff'
  | 'shot'
  | 'speaker'
  | 'camera'
  | 'section';

export interface ParsedToken {
  type: 'text' | 'token';
  value: string;
  kind?: TokenType;
  index?: number;
  alias?: string;
  lang?: string;
  content?: string;
  speakerId?: string;
  shotNumber?: number;
  timestamp?: string;
  cameraMotion?: string;
  sectionName?: string;
}

interface TokenMatch {
  start: number;
  end: number;
  raw: string;
  kind: TokenType;
  index?: number;
  alias?: string;
  lang?: string;
  content?: string;
  speakerId?: string;
  shotNumber?: number;
  timestamp?: string;
  cameraMotion?: string;
  sectionName?: string;
}

// ── Token Parsing Logic ──────────────────────────────────────────────────────
export function parseRichPromptTokens(text: string): ParsedToken[] {
  if (!text) return [];
  const matches: TokenMatch[] = [];

  // 1. Reference Assets: <图1>, <图1:林夕>, <Picture 1: Alice>, <Audio 1: BGM>, <Video 1: 运镜>, <Subject 1: 主角>
  const refRe = /<(图|Picture|Pic|Image|Audio|Video|Subject)\s*(\d+)(?:\s*[:：]\s*([^>]+))?>/gi;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(text)) !== null) {
    const tag = m[1].toLowerCase();
    let kind: TokenType = 'image';
    if (tag.startsWith('aud')) kind = 'audio';
    else if (tag.startsWith('vid')) kind = 'video';
    else if (tag.startsWith('sub')) kind = 'subject';

    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      kind,
      index: parseInt(m[2], 10),
      alias: m[3]?.trim(),
    });
  }

  // 2. Dialogue & Voiceover: <d>[Lang] content</d> or with voiceover markers
  const dRe = /<d>(?:\[([^\]]+)\]\s*)?([\s\S]*?)<\/d>/gi;
  while ((m = dRe.exec(text)) !== null) {
    const prefix = text.slice(Math.max(0, m.index - 80), m.index).toLowerCase();
    const isVoiceover = prefix.includes('voiceover') || prefix.includes('画外音') || prefix.includes('off-screen') || prefix.includes('旁白');

    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      kind: isVoiceover ? 'voiceover' : 'dialogue',
      lang: m[1]?.trim() || 'Chinese',
      content: m[2]?.trim() || '',
    });
  }

  // 3. Scene Transition: <scenetrans> / <跨场景> / <转场>
  const transRe = /<(?:scenetrans|跨场景|转场)>/gi;
  while ((m = transRe.exec(text)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      kind: 'scenetrans',
    });
  }

  // 4. Audio Cutoff: <cutoff> / <截断>
  const cutoffRe = /<(?:cutoff|截断)>/gi;
  while ((m = cutoffRe.exec(text)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      kind: 'cutoff',
    });
  }

  // 5. Shots: [Shot 1], [Shot 2] At 00:03.500, [Shot 3 @ 00:06.000]
  const shotRe = /\[Shot\s*(\d+)(?:\s*(?:At|at|@)\s*([0-9:.]+))?(?:[^\n\]]*)\]/gi;
  while ((m = shotRe.exec(text)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      kind: 'shot',
      shotNumber: parseInt(m[1], 10),
      timestamp: m[2]?.trim(),
    });
  }

  // 6. Speaker IDs: (S1), (S2), (S1,S2)
  const speakerRe = /\((S\d+(?:\s*,\s*S\d+)*)\)/g;
  while ((m = speakerRe.exec(text)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      kind: 'speaker',
      speakerId: m[1].replace(/\s+/g, ''),
    });
  }

  // 7. Camera Motion tags: [Camera: Push In with small amplitude] / [运镜: ...] / <camera: ...> / Standard H3 camera sentences
  const camRe = /(?:\[(?:Camera|camera|运镜)\s*[:：]\s*([^\]]+)\]|<(?:camera|运镜)\s*[:：]\s*([^>]+)>|(?:^|[.!?\n]\s*)(The camera (?:pushes in|pulls out|pans (?:left|right|up|down)|tracks|orbits|performs a (?:smooth )?cinematic arc shot|holds a steady static shot|shakes slightly)[^.!?\n]*)|(?:^|[.!?\n]\s*)(A first-person point-of-view \(POV\) shot[^.!?\n]*))/gi;
  while ((m = camRe.exec(text)) !== null) {
    const rawMatch = m[0].trim();
    const motionText = (m[1] || m[2] || m[3] || m[4] || rawMatch).trim();
    const matchStart = m.index + (m[0].indexOf(rawMatch));
    matches.push({
      start: matchStart,
      end: matchStart + rawMatch.length,
      raw: rawMatch,
      kind: 'camera',
      cameraMotion: motionText,
    });
  }

  // 8. H3 Section Headers
  const sectionRe = /(?:^|\n)(integrated_multimodal_description|overall_soundscape|non_diegetic_music|subject_definitions|summary|retention_analysis|detailed_description):/gi;
  while ((m = sectionRe.exec(text)) !== null) {
    const rawMatch = m[0].trim();
    const secName = m[1].toLowerCase();
    const matchStart = m.index + (m[0].length - rawMatch.length);
    matches.push({
      start: matchStart,
      end: matchStart + rawMatch.length,
      raw: rawMatch,
      kind: 'section',
      sectionName: secName,
    });
  }

  // Sort matches by start position and eliminate any overlaps
  matches.sort((a, b) => a.start - b.start);

  const nonOverlapping: TokenMatch[] = [];
  let lastEnd = 0;
  for (const match of matches) {
    if (match.start >= lastEnd) {
      nonOverlapping.push(match);
      lastEnd = match.end;
    }
  }

  // Build the parsed tokens array with in-between plain text
  const parts: ParsedToken[] = [];
  let cursor = 0;
  for (const tm of nonOverlapping) {
    if (tm.start > cursor) {
      parts.push({ type: 'text', value: text.slice(cursor, tm.start) });
    }
    parts.push({
      type: 'token',
      value: tm.raw,
      kind: tm.kind,
      index: tm.index,
      alias: tm.alias,
      lang: tm.lang,
      content: tm.content,
      speakerId: tm.speakerId,
      shotNumber: tm.shotNumber,
      timestamp: tm.timestamp,
      cameraMotion: tm.cameraMotion,
      sectionName: tm.sectionName,
    });
    cursor = tm.end;
  }

  if (cursor < text.length) {
    parts.push({ type: 'text', value: text.slice(cursor) });
  }

  return parts;
}

// ── Token Badge Component ────────────────────────────────────────────────────
interface TokenChipProps {
  kind: TokenType;
  index?: number;
  alias?: string;
  aliases?: string[];
  imageUrls?: string[];
  audioUrls?: string[];
  videoUrls?: string[];
  lang?: string;
  content?: string;
  speakerId?: string;
  shotNumber?: number;
  timestamp?: string;
  cameraMotion?: string;
  sectionName?: string;
  rawValue?: string;
  subjectPictures?: number[];
}

// Subject N -> the Picture indices its definition line binds
// ("<Subject 1> (S1): ... from <Picture 2>"). The definition is the first line
// that starts with the Subject tag; failing that, the first line naming it with
// a picture.
export function subjectPictureMap(text: string): Record<number, number[]> {
  const map: Record<number, number[]> = {};
  const fallback: Record<number, number[]> = {};
  for (const line of (text || '').split(/\r?\n/)) {
    const subs = [...line.matchAll(/<Subject\s*(\d+)[^>]*>/gi)];
    if (!subs.length) continue;
    const pics = [...line.matchAll(/<(?:图|Picture|Pic|Image)\s*(\d+)[^>]*>/gi)].map((m) => parseInt(m[1], 10));
    if (!pics.length) continue;
    const uniq = [...new Set(pics)];
    const lead = /^[\s\-*•]*<Subject\s*(\d+)/i.exec(line);
    if (lead) {
      const n = parseInt(lead[1], 10);
      if (!map[n]) map[n] = uniq;
    }
    for (const m of subs) {
      const n = parseInt(m[1], 10);
      if (!fallback[n]) fallback[n] = uniq;
    }
  }
  return { ...fallback, ...map };
}

export function InlineTokenChip({
  kind,
  index = 1,
  alias,
  aliases = [],
  imageUrls = [],
  audioUrls = [],
  videoUrls = [],
  lang = 'Chinese',
  content = '',
  speakerId,
  shotNumber,
  timestamp,
  cameraMotion,
  sectionName,
  rawValue,
  subjectPictures = [],
}: TokenChipProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const isPrimary = index === 1;
  const effectiveAlias = alias || (index ? aliases[index - 1] : '') || '';

  // 1. Image reference chip
  if (kind === 'image') {
    const rawUrl = imageUrls[index - 1];
    const url = rawUrl ? (rawUrl.startsWith('blob:') || rawUrl.startsWith('http') ? rawUrl : `${API_BASE}${rawUrl}`) : null;

    return (
      <span
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className={`inline-flex items-center gap-1.5 mx-0.5 my-0.5 px-2 py-0.5 rounded-lg text-[11px] font-mono select-none transition-all duration-150 align-middle shadow-xs border relative group max-w-full ${
          isPrimary
            ? 'bg-amber-500/15 text-amber-200 border-amber-500/40 ring-1 ring-amber-400/30 shadow-[0_0_8px_rgba(245,158,11,0.2)]'
            : 'bg-white/[0.06] text-zinc-200 border-white/15 hover:border-white/35'
        }`}
        style={{ verticalAlign: 'middle', lineHeight: 1.3 }}
      >
        {url ? (
          <img
            src={url}
            alt=""
            className={`w-4 h-4 rounded-md object-cover flex-shrink-0 ${isPrimary ? 'ring-1 ring-amber-400/60' : 'ring-1 ring-white/20'}`}
          />
        ) : (
          <span className="w-4 h-4 rounded-md bg-white/10 flex items-center justify-center text-[9px] flex-shrink-0">🖼</span>
        )}
        <span className="font-semibold tracking-tight flex items-center gap-1 min-w-0">
          <span className="flex-shrink-0">{isPrimary ? '图1 ★' : `图${index}`}</span>
          {effectiveAlias && (
            <>
              <span className="text-white/30 font-normal flex-shrink-0">·</span>
              <span className="text-amber-300 font-sans font-medium max-w-[80px] truncate">{effectiveAlias}</span>
            </>
          )}
        </span>

        {showTooltip && (url || effectiveAlias) && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 p-1.5 bg-[#0a0a0e]/95 border border-white/20 rounded-xl shadow-2xl z-50 pointer-events-none animate-in fade-in zoom-in-95 duration-100 flex flex-col items-center gap-1 min-w-[80px]">
            {url && <img src={url} alt="" className="w-16 h-16 object-cover rounded-lg" />}
            <div className="flex flex-col items-center">
              <span className="text-[9px] font-mono text-zinc-300 font-bold">{t('参考图')} {index}</span>
              {effectiveAlias && <span className="text-[9px] font-sans text-amber-300 font-medium">{effectiveAlias}</span>}
            </div>
          </div>
        )}
      </span>
    );
  }

  // 2. Audio reference chip
  if (kind === 'audio') {
    return (
      <span
        className="inline-flex items-center gap-1.5 mx-0.5 my-0.5 px-2 py-0.5 rounded-lg text-[11px] font-mono select-none transition-all duration-150 align-middle shadow-xs border bg-white/[0.06] text-zinc-200 border-white/15 hover:border-white/25 max-w-full"
        style={{ verticalAlign: 'middle', lineHeight: 1.3 }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 flex-shrink-0">
          <path d="M12 2v20M17 5v14M7 9v6M22 10v4M2 10v4" />
        </svg>
        <span className="font-semibold flex items-center gap-1 min-w-0">
          <span className="flex-shrink-0">Audio {index}</span>
          {effectiveAlias && (
            <>
              <span className="text-white/30 font-normal flex-shrink-0">·</span>
              <span className="text-zinc-300 font-sans font-medium max-w-[80px] truncate">{effectiveAlias}</span>
            </>
          )}
        </span>
      </span>
    );
  }

  // 3. Video reference chip
  if (kind === 'video') {
    return (
      <span
        className="inline-flex items-center gap-1.5 mx-0.5 my-0.5 px-2 py-0.5 rounded-lg text-[11px] font-mono select-none transition-all duration-150 align-middle shadow-xs border bg-white/[0.06] text-zinc-200 border-white/15 hover:border-white/25 max-w-full"
        style={{ verticalAlign: 'middle', lineHeight: 1.3 }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 flex-shrink-0">
          <rect x="2" y="4" width="14" height="16" rx="2" />
          <path d="M16 8l6-3v14l-6-3V8z" />
        </svg>
        <span className="font-semibold flex items-center gap-1 min-w-0">
          <span className="flex-shrink-0">Video {index}</span>
          {effectiveAlias && (
            <>
              <span className="text-white/30 font-normal flex-shrink-0">·</span>
              <span className="text-zinc-300 font-sans font-medium max-w-[80px] truncate">{effectiveAlias}</span>
            </>
          )}
        </span>
      </span>
    );
  }

  // 4. Subject definition chip -- hover shows the pictures its definition binds
  if (kind === 'subject') {
    const pics = subjectPictures
      .map((n) => ({ n, raw: imageUrls[n - 1] }))
      .filter((p) => p.raw)
      .map((p) => ({ n: p.n, url: p.raw.startsWith('blob:') || p.raw.startsWith('http') ? p.raw : `${API_BASE}${p.raw}` }));
    return (
      <span
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className="inline-flex items-center gap-1.5 mx-0.5 my-0.5 px-2 py-0.5 rounded-lg text-[11px] font-mono select-none transition-all duration-150 align-middle shadow-xs border bg-white/[0.06] text-zinc-200 border-white/15 hover:border-white/25 max-w-full relative"
        style={{ verticalAlign: 'middle', lineHeight: 1.3 }}
      >
        {pics[0] ? (
          <img src={pics[0].url} alt="" className="w-4 h-4 rounded-md object-cover flex-shrink-0 ring-1 ring-white/20" />
        ) : (
          <span className="text-zinc-400 flex-shrink-0">👤</span>
        )}
        <span className="font-semibold flex-shrink-0">Subject {index}</span>
        {effectiveAlias && <span className="text-zinc-300 font-sans font-medium max-w-[80px] truncate">· {effectiveAlias}</span>}

        {showTooltip && pics.length > 0 && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 p-1.5 bg-[#0a0a0e]/95 border border-white/20 rounded-xl shadow-2xl z-50 pointer-events-none animate-in fade-in zoom-in-95 duration-100 flex gap-1.5">
            {pics.map((p) => (
              <div key={p.n} className="flex flex-col items-center gap-0.5">
                <img src={p.url} alt="" className="w-24 h-24 object-cover rounded-lg" />
                <span className="text-[9px] font-mono text-zinc-300 font-bold">Picture {p.n}</span>
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }

  // 5. Dialogue tag: <d>[Lang] 对话内容</d>
  if (kind === 'dialogue') {
    return (
      <span
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className="inline-flex items-center gap-1.5 mx-0.5 my-0.5 px-2 py-0.5 rounded-lg text-[11px] select-none transition-all duration-150 align-middle shadow-xs border bg-white/[0.08] text-white border-white/20 relative group max-w-full"
        style={{ verticalAlign: 'middle', lineHeight: 1.3 }}
      >
        <span className="text-zinc-400 text-xs flex-shrink-0">💬</span>
        <span className="text-[9px] font-mono font-bold bg-white/15 text-zinc-200 px-1 py-0.2 rounded border border-white/20 uppercase flex-shrink-0">
          {lang}
        </span>
        <span className="font-sans font-medium text-white/95 max-w-[130px] truncate">
          "{content}"
        </span>

        {showTooltip && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 bg-[#0a0a0e]/95 border border-white/20 rounded-xl shadow-2xl z-50 pointer-events-none animate-in fade-in zoom-in-95 duration-100 flex flex-col gap-0.5 min-w-[140px] max-w-[280px]">
            <span className="text-[9px] font-mono text-zinc-300 font-bold flex items-center gap-1">
              <span>{t('💬 角色对白 (Diegetic Speech)')}</span>
            </span>
            <span className="text-xs text-white leading-relaxed font-sans break-words">{content}</span>
          </div>
        )}
      </span>
    );
  }

  // 6. Voiceover tag: says in an off-screen voiceover: <d>[Lang] 旁白</d>
  if (kind === 'voiceover') {
    return (
      <span
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className="inline-flex items-center gap-1.5 mx-0.5 my-0.5 px-2 py-0.5 rounded-lg text-[11px] select-none transition-all duration-150 align-middle shadow-xs border bg-white/[0.08] text-white border-white/20 relative group max-w-full"
        style={{ verticalAlign: 'middle', lineHeight: 1.3 }}
      >
        <span className="text-zinc-400 text-xs flex-shrink-0">🎙️</span>
        <span className="text-[9px] font-mono font-bold bg-white/15 text-zinc-200 px-1 py-0.2 rounded border border-white/20 flex-shrink-0">
          
          {t('画外音')}
        </span>
        <span className="font-sans font-medium text-white/95 max-w-[120px] truncate">
          "{content}"
        </span>
        <span className="text-[8px] text-zinc-400 bg-black/40 px-1 rounded flex-shrink-0">{t('(闭嘴)')}</span>

        {showTooltip && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 bg-[#0a0a0e]/95 border border-white/20 rounded-xl shadow-2xl z-50 pointer-events-none animate-in fade-in zoom-in-95 duration-100 flex flex-col gap-0.5 min-w-[150px] max-w-[280px]">
            <span className="text-[9px] font-mono text-zinc-300 font-bold flex items-center gap-1">
              <span>{t('🎙️ 旁白/画外音 (Off-Screen Voiceover)')}</span>
            </span>
            <span className="text-xs text-white leading-relaxed font-sans break-words">{content}</span>
            <span className="text-[8px] text-zinc-400 mt-0.5">{t('画面中角色嘴唇严格保持闭合状态')}</span>
          </div>
        )}
      </span>
    );
  }

  // 7. Scene transition tag: <scenetrans>
  if (kind === 'scenetrans') {
    return (
      <span
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className="inline-flex items-center gap-1 mx-0.5 my-0.5 px-2 py-0.5 rounded-lg text-[10px] font-mono select-none transition-all duration-150 align-middle shadow-xs border bg-white/[0.06] text-zinc-200 border-white/15 hover:border-white/25 relative group max-w-full"
        style={{ verticalAlign: 'middle', lineHeight: 1.3 }}
      >
        <span className="text-zinc-300 font-bold flex-shrink-0">⚡</span>
        <span className="font-bold tracking-tight truncate">{t('&lt;scenetrans&gt; 跨场景转场')}</span>

        {showTooltip && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 p-2 bg-[#0a0a0e]/95 border border-white/20 rounded-xl shadow-2xl z-50 pointer-events-none animate-in fade-in zoom-in-95 duration-100 flex flex-col gap-1 min-w-[180px] max-w-[280px]">
            <span className="text-[10px] font-mono text-zinc-200 font-bold flex items-center gap-1">
              <span>{t('⚡ 跨镜头声音延续 (&lt;scenetrans&gt;)')}</span>
            </span>
            <p className="text-[9px] text-zinc-300 leading-relaxed font-sans">
              
              {t('用于分镜头切镜时，确保同一句台词、歌词或关键环境音跨越转场点无缝连续播放。')}
            </p>
          </div>
        )}
      </span>
    );
  }

  // 8. Audio cutoff tag: <cutoff>
  if (kind === 'cutoff') {
    return (
      <span
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className="inline-flex items-center gap-1 mx-0.5 my-0.5 px-2 py-0.5 rounded-lg text-[10px] font-mono select-none transition-all duration-150 align-middle shadow-xs border bg-white/[0.06] text-zinc-200 border-white/15 hover:border-white/25 relative group max-w-full"
        style={{ verticalAlign: 'middle', lineHeight: 1.3 }}
      >
        <span className="text-zinc-300 flex-shrink-0">✂️</span>
        <span className="font-bold tracking-tight truncate">{t('&lt;cutoff&gt; 音频截断')}</span>

        {showTooltip && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 p-2 bg-[#0a0a0e]/95 border border-white/20 rounded-xl shadow-2xl z-50 pointer-events-none animate-in fade-in zoom-in-95 duration-100 flex flex-col gap-1 min-w-[180px] max-w-[280px]">
            <span className="text-[10px] font-mono text-zinc-200 font-bold flex items-center gap-1">
              <span>{t('✂️ 结尾音频截断 (&lt;cutoff&gt;)')}</span>
            </span>
            <p className="text-[9px] text-zinc-300 leading-relaxed font-sans">
              
              {t('标记视频在达到设定的时长终点时，语音对白自然截断点。')}
            </p>
          </div>
        )}
      </span>
    );
  }

  // 9. Shot marker: [Shot N] @ timestamp
  if (kind === 'shot') {
    return (
      <span
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className="inline-flex items-center gap-1.5 mx-0.5 my-0.5 px-2 py-0.5 rounded-lg text-[10px] font-mono select-none transition-all duration-150 align-middle shadow-xs border bg-white/[0.08] text-white border-white/20 relative group max-w-full"
        style={{ verticalAlign: 'middle', lineHeight: 1.3 }}
      >
        <span className="text-zinc-300 flex-shrink-0">🎬</span>
        <span className="font-bold flex-shrink-0">Shot {shotNumber}</span>
        {timestamp && <span className="text-zinc-300/80 truncate max-w-[80px]">@ {timestamp}</span>}

        {showTooltip && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 p-2 bg-[#0a0a0e]/95 border border-white/20 rounded-xl shadow-2xl z-50 pointer-events-none animate-in fade-in zoom-in-95 duration-100 flex flex-col gap-1 min-w-[160px] max-w-[280px]">
            <span className="text-[10px] font-mono text-zinc-200 font-bold">{t('🎬 分镜切镜标记')}</span>
            <span className="text-[9px] text-zinc-300 font-sans">
              
              {t('第 {n} 个电影镜头', { n: shotNumber ?? 1 })}
              {timestamp ? t('（切镜时间点：{time}）', { time: timestamp }) : t('（起始镜头）')}
            </span>
          </div>
        )}
      </span>
    );
  }

  // 10. Speaker ID: (S1), (S2)
  if (kind === 'speaker') {
    return (
      <span
        className="inline-flex items-center gap-0.5 mx-0.5 my-0.5 px-1.5 py-0.2 rounded-full text-[9px] font-mono font-bold select-none align-middle border bg-white/[0.08] text-zinc-200 border-white/20 flex-shrink-0"
        style={{ verticalAlign: 'middle' }}
        title={t('说话人编号: {id}', { id: speakerId ?? '' })}
      >
        <span>👤</span>
        <span>{speakerId}</span>
      </span>
    );
  }

  // 11. Camera motion tag: [Camera: Push In]
  if (kind === 'camera') {
    return (
      <span
        className="inline-flex items-center gap-1 mx-0.5 my-0.5 px-2 py-0.5 rounded-lg text-[10px] font-sans font-medium select-none align-middle border bg-white/[0.06] text-zinc-200 border-white/15 hover:border-white/25 max-w-full"
        style={{ verticalAlign: 'middle' }}
        title={t('电影镜头运镜调度: {motion}', { motion: cameraMotion ?? '' })}
      >
        <span className="text-zinc-400 flex-shrink-0">🎥</span>
        <span className="max-w-[150px] truncate">{cameraMotion}</span>
      </span>
    );
  }

  // 12. H3 Section headers
  if (kind === 'section') {
    const sectionLabels: Record<string, string> = {
      integrated_multimodal_description: '📑 多模态视听时序描述',
      overall_soundscape: '🔊 全局环境与动作音效',
      non_diegetic_music: '🎵 画外背景配乐 (BGM)',
      subject_definitions: '👥 资产主体与角色定义',
      summary: '📋 任务概要与引用矩阵',
      retention_analysis: '📊 特征继承与迁移分析',
      detailed_description: '🎬 电影级分镜详述',
    };

    return (
      <div className="my-1.5 pt-1.5 border-t border-white/10 flex items-center gap-1.5 max-w-full">
        <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-white/10 text-white border border-white/15 truncate max-w-full">
          {t(sectionLabels[sectionName || ''] || '') || rawValue || 'H3 Section'}
        </span>
      </div>
    );
  }

  return <span className="mx-0.5 break-words">{rawValue}</span>;
}

// ── Rich Rendered Flow Component ────────────────────────────────────────────
export function RenderedPromptFlow({
  text,
  imageUrls = [],
  aliases = [],
  audioUrls = [],
  videoUrls = [],
  placeholder = t('输入场景描述…'),
  className = '',
}: {
  text: string;
  imageUrls?: string[];
  aliases?: string[];
  audioUrls?: string[];
  videoUrls?: string[];
  placeholder?: string;
  className?: string;
}) {
  if (!text || !text.trim()) {
    return <span className="text-zinc-500 italic select-none text-xs">{placeholder}</span>;
  }

  const parts = parseRichPromptTokens(text);
  const subjectPics = subjectPictureMap(text);
  return (
    <span className={`text-zinc-100 text-xs leading-relaxed break-words whitespace-pre-wrap font-normal block w-full max-w-full min-w-0 overflow-hidden ${className}`}>
      {parts.map((p, i) =>
        p.type === 'token' && p.kind ? (
          <InlineTokenChip
            key={i}
            kind={p.kind}
            index={p.index}
            alias={p.alias}
            aliases={aliases}
            imageUrls={imageUrls}
            audioUrls={audioUrls}
            videoUrls={videoUrls}
            lang={p.lang}
            content={p.content}
            speakerId={p.speakerId}
            shotNumber={p.shotNumber}
            timestamp={p.timestamp}
            cameraMotion={p.cameraMotion}
            sectionName={p.sectionName}
            rawValue={p.value}
            subjectPictures={p.kind === 'subject' && p.index ? subjectPics[p.index] : undefined}
          />
        ) : (
          <span key={i} className="break-words">{p.value}</span>
        )
      )}
    </span>
  );
}

function serializeRichEditor(root: HTMLElement): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (!(node instanceof HTMLElement)) return '';
    const raw = node.dataset.richToken;
    if (raw !== undefined) return raw;
    if (node.tagName === 'BR') return '\n';
    const body = Array.from(node.childNodes).map(walk).join('');
    return node.tagName === 'DIV' || node.tagName === 'P' ? `${body}\n` : body;
  };
  return Array.from(root.childNodes).map(walk).join('').replace(/\n$/, '');
}

function findAdjacentRichToken(
  root: HTMLElement,
  container: Node,
  offset: number,
  direction: 'backward' | 'forward',
): HTMLElement | null {
  let cursor: Node = container;

  if (cursor.nodeType === Node.TEXT_NODE) {
    const length = cursor.textContent?.length || 0;
    if ((direction === 'backward' && offset > 0) || (direction === 'forward' && offset < length)) return null;
  } else if (cursor instanceof HTMLElement) {
    const childIndex = direction === 'backward' ? offset - 1 : offset;
    const child = cursor.childNodes[childIndex];
    if (child) cursor = child;
  }

  while (cursor !== root) {
    if (cursor instanceof HTMLElement && cursor.dataset.richToken !== undefined) return cursor;
    const sibling = direction === 'backward' ? cursor.previousSibling : cursor.nextSibling;
    if (sibling) {
      cursor = sibling;
      while (cursor instanceof HTMLElement && cursor.dataset.richToken === undefined && cursor.childNodes.length > 0) {
        cursor = direction === 'backward' ? cursor.lastChild! : cursor.firstChild!;
      }
      return cursor instanceof HTMLElement && cursor.dataset.richToken !== undefined ? cursor : null;
    }
    if (!cursor.parentNode) return null;
    cursor = cursor.parentNode;
  }

  return null;
}

function richEditorOffset(root: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(container, offset);
  const scratch = document.createElement('div');
  scratch.append(range.cloneContents());
  return serializeRichEditor(scratch).length;
}

function restoreRichEditorCaret(root: HTMLElement, target: number) {
  const selection = window.getSelection();
  if (!selection) return;
  let consumed = 0;
  let point: { node: Node; offset: number } | null = null;
  const visit = (node: Node) => {
    if (point) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length || 0;
      if (target <= consumed + length) point = { node, offset: Math.max(0, target - consumed) };
      else consumed += length;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const raw = node.dataset.richToken;
    if (raw !== undefined) { consumed += raw.length; return; }
    Array.from(node.childNodes).forEach(visit);
  };
  visit(root);
  const range = document.createRange();
  const resolvedPoint = point as { node: Node; offset: number } | null;
  if (resolvedPoint) range.setStart(resolvedPoint.node, resolvedPoint.offset);
  else { range.selectNodeContents(root); range.collapse(false); }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function deleteIntoRichToken(root: HTMLElement, direction: 'backward' | 'forward'): { value: string; caret: number } | null {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;

  const token = findAdjacentRichToken(root, range.startContainer, range.startOffset, direction);
  const raw = token?.dataset.richToken;
  if (!token || raw === undefined) return null;
  const value = serializeRichEditor(root);
  const caret = richEditorOffset(root, range.startContainer, range.startOffset);
  const deleteAt = direction === 'backward' ? caret - 1 : caret;
  return { value: value.slice(0, deleteAt) + value.slice(deleteAt + 1), caret: Math.max(0, deleteAt) };
}

/** Labels stay rendered while the prose around them remains directly editable. */
function LegacyEditablePromptFlow({
  value, onChange, onBlur, placeholder, imageUrls, aliases, audioUrls, videoUrls, editorHandleRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder: string;
  imageUrls: string[];
  aliases: string[];
  audioUrls: string[];
  videoUrls: string[];
  editorHandleRef?: React.MutableRefObject<RichPromptEditorHandle | null>;
}) {
  const focusedRef = useRef(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const renderedValueRef = useRef(value);
  const pendingCaretRef = useRef<number | null>(null);
  const savedSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const [, rerenderEditor] = useState(0);
  if (!focusedRef.current) renderedValueRef.current = value;
  const parts = parseRichPromptTokens(renderedValueRef.current);

  const saveSelection = useCallback(() => {
    const root = editorRef.current;
    const selection = window.getSelection();
    if (!root || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    savedSelectionRef.current = {
      start: richEditorOffset(root, range.startContainer, range.startOffset),
      end: richEditorOffset(root, range.endContainer, range.endOffset),
    };
  }, []);

  const insertText = useCallback((text: string) => {
    const root = editorRef.current;
    if (!root || !text) return false;
    const current = serializeRichEditor(root);
    const saved = savedSelectionRef.current;
    const start = Math.min(saved?.start ?? current.length, current.length);
    const end = Math.min(saved?.end ?? start, current.length);
    const next = current.slice(0, start) + text + current.slice(end);
    renderedValueRef.current = next;
    pendingCaretRef.current = start + text.length;
    savedSelectionRef.current = { start: pendingCaretRef.current, end: pendingCaretRef.current };
    onChange(next);
    rerenderEditor((n) => n + 1);
    requestAnimationFrame(() => root.focus());
    return true;
  }, [onChange]);

  useEffect(() => {
    if (!editorHandleRef) return;
    editorHandleRef.current = { insertText };
    return () => { editorHandleRef.current = null; };
  }, [editorHandleRef, insertText]);

  useEffect(() => {
    const handleInsert = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<{ text: string; handled: boolean }>;
      const root = editorRef.current;
      if (!root || !focusedRef.current || !event.detail?.text) return;
      event.detail.handled = insertText(event.detail.text);
    };
    window.addEventListener('richPromptInsert', handleInsert);
    return () => window.removeEventListener('richPromptInsert', handleInsert);
  }, [insertText]);

  useEffect(() => {
    const root = editorRef.current;
    if (pendingCaretRef.current === null || !root) return;
    restoreRichEditorCaret(root, pendingCaretRef.current);
    pendingCaretRef.current = null;
  });

  return (
    <div
      ref={editorRef}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      data-rich-editor="true"
      data-placeholder={placeholder}
      className="nodrag nopan h-full w-full max-w-full min-w-0 overflow-y-auto p-2 text-xs leading-relaxed text-zinc-100 whitespace-pre-wrap break-words outline-none cursor-text empty:before:content-[attr(data-placeholder)] empty:before:text-zinc-500 empty:before:italic"
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={saveSelection}
      onKeyUp={saveSelection}
      onWheel={(event) => {
        if (event.currentTarget.scrollHeight > event.currentTarget.clientHeight) {
          event.stopPropagation();
        }
      }}
      onFocus={() => {
        focusedRef.current = true;
        window.dispatchEvent(new Event('inputFocused'));
      }}
      onBeforeInput={(event) => {
        const inputType = (event.nativeEvent as InputEvent).inputType;
        const direction = inputType === 'deleteContentBackward'
          ? 'backward'
          : inputType === 'deleteContentForward'
            ? 'forward'
            : null;
        if (!direction) return;
        const edit = deleteIntoRichToken(event.currentTarget, direction);
        if (!edit) return;
        event.preventDefault();
        renderedValueRef.current = edit.value;
        pendingCaretRef.current = edit.caret;
        onChange(edit.value);
        rerenderEditor((n) => n + 1);
      }}
      onInput={(event) => {
        onChange(serializeRichEditor(event.currentTarget));
        requestAnimationFrame(saveSelection);
      }}
      onPaste={(event) => {
        // execCommand('insertText') writes into the DOM behind React's back. A
        // one-line paste survives it; a multi-line one makes the browser split
        // text nodes and add its own <div>/<br>, and the next reconcile then
        // fails with "removeChild: The node to be removed is not a child of
        // this node". Route the paste through the same state path the reference
        // chips already use, so React stays the only writer.
        event.preventDefault();
        const text = event.clipboardData.getData('text/plain');
        if (!text) return;
        const root = event.currentTarget;
        const selection = window.getSelection();
        const current = serializeRichEditor(root);
        let start = current.length;
        let end = current.length;
        if (selection && selection.rangeCount > 0 && root.contains(selection.anchorNode)) {
          const range = selection.getRangeAt(0);
          const a = richEditorOffset(root, range.startContainer, range.startOffset);
          const b = richEditorOffset(root, range.endContainer, range.endOffset);
          start = Math.min(a, b);
          end = Math.max(a, b);
        } else {
          const saved = savedSelectionRef.current;
          start = Math.min(saved?.start ?? current.length, current.length);
          end = Math.min(saved?.end ?? start, current.length);
        }
        const next = current.slice(0, start) + text + current.slice(end);
        renderedValueRef.current = next;
        pendingCaretRef.current = start + text.length;
        savedSelectionRef.current = { start: pendingCaretRef.current, end: pendingCaretRef.current };
        onChange(next);
        rerenderEditor((n) => n + 1);
      }}
      onBlur={() => {
        saveSelection();
        // Keep the saved selection alive through a thumbnail/button click. The
        // click may synchronously insert a reference back into this editor.
        setTimeout(() => {
          if (document.activeElement === editorRef.current) return;
          focusedRef.current = false;
          // Same as InlineTokenEditor: adopting the value is not enough on its
          // own, the surface has to be re-rendered or it keeps the old text.
          if (renderedValueRef.current !== value) {
            renderedValueRef.current = value;
            rerenderEditor((n) => n + 1);
          }
          window.dispatchEvent(new Event('inputBlurred'));
          onBlur?.();
        }, 0);
      }}
    >
      {parts.map((part, index) => part.type === 'token' && part.kind ? (
        <span key={`${index}:${part.value}`} contentEditable={false} data-rich-token={part.value} className="inline-block">
          <InlineTokenChip
            kind={part.kind} index={part.index} alias={part.alias} aliases={aliases}
            imageUrls={imageUrls} audioUrls={audioUrls} videoUrls={videoUrls}
            lang={part.lang} content={part.content} speakerId={part.speakerId}
            shotNumber={part.shotNumber} timestamp={part.timestamp}
            cameraMotion={part.cameraMotion} sectionName={part.sectionName} rawValue={part.value}
          />
        </span>
      ) : (
        <React.Fragment key={`${index}:${part.value}`}>{part.value}</React.Fragment>
      ))}
    </div>
  );
}

/** Shared token editor; this adapter only supplies H3 parsing and chip visuals. */
function EditablePromptFlow({
  value, onChange, onBlur, placeholder, imageUrls, aliases, audioUrls, videoUrls, editorHandleRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder: string;
  imageUrls: string[];
  aliases: string[];
  audioUrls: string[];
  videoUrls: string[];
  editorHandleRef?: React.MutableRefObject<RichPromptEditorHandle | null>;
}) {
  return <InlineTokenEditor
    value={value}
    onChange={onChange}
    placeholder={placeholder}
    editorHandleRef={editorHandleRef}
    parse={(text) => parseRichPromptTokens(text).map((part) => ({ text: part.value, token: part.type === 'token' ? part : undefined }))}
    renderToken={(part) => <InlineTokenChip
      kind={part.kind!} index={part.index} alias={part.alias} aliases={aliases}
      imageUrls={imageUrls} audioUrls={audioUrls} videoUrls={videoUrls}
      lang={part.lang} content={part.content} speakerId={part.speakerId}
      shotNumber={part.shotNumber} timestamp={part.timestamp}
      cameraMotion={part.cameraMotion} sectionName={part.sectionName} rawValue={part.value}
    />}
    onMouseDown={(event) => event.stopPropagation()}
    onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
    onBlur={() => {
      window.dispatchEvent(new Event('inputBlurred'));
      onBlur?.();
    }}
    className="nodrag nopan h-full w-full max-w-full min-w-0 overflow-y-auto p-2 text-xs leading-relaxed text-zinc-100 whitespace-pre-wrap break-words outline-none cursor-text empty:before:content-[attr(data-placeholder)] empty:before:text-zinc-500 empty:before:italic"
  />;
}

/** Inserts into the currently focused rendered rich-prompt surface. */
export function insertIntoActiveRichPrompt(text: string): boolean {
  const detail = { text, handled: false };
  window.dispatchEvent(new CustomEvent('richPromptInsert', { detail }));
  return detail.handled;
}

// ── Camera Motion Options ──────────────────────────────────────────────────
const CAMERA_PRESETS = [
  { label: 'Push In 慢推', icon: '🔍', value: 'The camera pushes in with small amplitude at slow speed toward 拍摄主体', placeholder: '拍摄主体' },
  { label: 'Pull Out 拉远', icon: '🔭', value: 'The camera pulls out at slow speed, revealing 全景环境', placeholder: '全景环境' },
  { label: 'Pan Right 右摇', icon: '👉', value: 'The camera pans right across the scene, framing 目标主体', placeholder: '目标主体' },
  { label: 'Pan Left 左摇', icon: '👈', value: 'The camera pans left smoothly toward 目标主体', placeholder: '目标主体' },
  { label: 'Tracking 跟拍', icon: '🚶', value: 'The camera tracks smoothly beside the moving subject as 人物动作', placeholder: '人物动作' },
  { label: 'Arc Shot 环绕', icon: '🔄', value: 'The camera performs a smooth cinematic arc shot around 核心主体', placeholder: '核心主体' },
  { label: 'POV 第一视角', icon: '👁️', value: 'A first-person point-of-view (POV) shot framing 主视角景象', placeholder: '主视角景象' },
  { label: 'Static 固定机位', icon: '⚓', value: 'The camera holds a steady static shot as 画面事件', placeholder: '画面事件' },
  { label: 'Shake 呼吸微晃', icon: '🎬', value: 'The camera shakes slightly with handheld realism as 现场环境', placeholder: '现场环境' },
];

// ── Independent Focused Prompt Studio Modal (Portal) ───────────────────────────
interface ExpandedPromptModalProps {
  title?: string;
  value: string;
  onChange: (val: string) => void;
  onClose: () => void;
  placeholder?: string;
  imageUrls?: string[];
  aliases?: string[];
  audioUrls?: string[];
  videoUrls?: string[];
  tokenPrefix?: '图' | 'Picture';
  showH3Toolbar?: boolean;
}

export function ExpandedPromptModal({
  title = t('电影级提示词独立工作台'),
  value,
  onChange,
  onClose,
  placeholder = t('输入电影镜头运镜、光影、人物动作与对白（支持对话、画外音、跨场景转场与分镜）…'),
  imageUrls = [],
  aliases = [],
  audioUrls = [],
  videoUrls = [],
  tokenPrefix = '图',
  showH3Toolbar = true,
}: ExpandedPromptModalProps) {
  const [activeTab, setActiveTab] = useState<'editor' | 'preview' | 'split'>('editor');
  const [showCameraMenu, setShowCameraMenu] = useState(false);
  const modalTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto focus & set selection range on mount
  useEffect(() => {
    requestAnimationFrame(() => {
      if (modalTextareaRef.current) {
        modalTextareaRef.current.focus();
        const len = modalTextareaRef.current.value.length;
        modalTextareaRef.current.setSelectionRange(len, len);
      }
    });
  }, []);

  // Keyboard shortcut listener for Esc and Ctrl+Enter
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Insert snippet with placeholder selection inside modal
  const insertModalSnippet = useCallback((snippet: string, selectPlaceholder?: string) => {
    const ta = modalTextareaRef.current;
    if (ta) {
      const start = ta.selectionStart ?? value.length;
      const end = ta.selectionEnd ?? value.length;
      const next = value.slice(0, start) + snippet + value.slice(end);
      onChange(next);
      setTimeout(() => {
        if (ta) {
          ta.focus();
          if (selectPlaceholder && snippet.includes(selectPlaceholder)) {
            const pStart = snippet.indexOf(selectPlaceholder);
            const pEnd = pStart + selectPlaceholder.length;
            ta.setSelectionRange(start + pStart, start + pEnd);
          } else {
            ta.setSelectionRange(start + snippet.length, start + snippet.length);
          }
        }
      }, 20);
    } else {
      const prefix = value && !value.endsWith(' ') ? ' ' : '';
      onChange((value || '') + prefix + snippet);
    }
  }, [value, onChange]);

  const handleInsertModalRef = useCallback((idx: number, customAlias?: string) => {
    const effectiveAlias = customAlias !== undefined ? customAlias : (aliases?.[idx - 1] || '');
    const token = effectiveAlias
      ? (tokenPrefix === 'Picture' ? `<Picture ${idx}: ${effectiveAlias}>` : `<图${idx}:${effectiveAlias}>`)
      : (tokenPrefix === 'Picture' ? `<Picture ${idx}>` : `<图${idx}>`);
    insertModalSnippet(token);
  }, [tokenPrefix, aliases, insertModalSnippet]);

  const dismiss = useBackdropDismiss(onClose);

  return (
    // Text here is meant to be read and quoted, so selection is on by default
    // and the chrome (header, toolbars) opts out. The other way round — the
    // shell `select-none` with each pane opting back in — left `user-select:
    // none` between the panes, and a shift+click extension is anchored in one
    // element and extended in another: the browser refuses it wherever the two
    // are not both selectable.
    <div
      className="nodrag nopan fixed inset-0 z-[99999] bg-black/75 backdrop-blur-md flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-150 select-text"
      {...dismiss}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="w-full max-w-3xl bg-[#0e0e14]/95 border border-white/20 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh] animate-in zoom-in-95 duration-150 relative text-white font-sans"
        onClick={(e) => e.stopPropagation()}
        // Never preventDefault a press in here: that is the gesture the browser
        // builds a text selection out of, shift+click extension included.
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between bg-white/[0.02] select-none">
          <div className="flex items-center gap-2.5">
            <span className="p-1.5 rounded-lg bg-gradient-to-br from-purple-500/20 to-indigo-500/20 text-purple-300 border border-purple-500/30 text-sm font-bold shadow-xs">
              ✦
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white tracking-tight">{title}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/10 text-zinc-300 border border-white/10">
                  {showH3Toolbar ? t('MiniMax H3 电影视听规范') : t('FLUX 图像提示词')}
                </span>
              </div>
              <span className="text-[10px] text-zinc-400">{t('独立大窗沉浸模式 · 不受节点高度限制')}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* View Mode Toggle */}
            <div className="flex items-center p-0.5 rounded-lg bg-white/5 border border-white/10 text-[11px] font-medium text-zinc-400">
              <button
                type="button"
                onClick={() => setActiveTab('editor')}
                className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                  activeTab === 'editor' ? 'bg-white/20 text-white shadow-xs' : 'hover:text-zinc-200'
                }`}
              >
                
                {t('✎ 编辑源码')}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('preview')}
                className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                  activeTab === 'preview' ? 'bg-white/20 text-white shadow-xs' : 'hover:text-zinc-200'
                }`}
              >
                
                {t('👁 图文流预览')}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('split')}
                className={`px-2 py-1 rounded-md transition-colors cursor-pointer ${
                  activeTab === 'split' ? 'bg-white/20 text-white shadow-xs' : 'hover:text-zinc-200'
                }`}
              >
                
                {t('◫ 分屏对照')}
              </button>
            </div>

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              title={t('保存并收起 (Esc)')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-4 flex-1 min-h-0 overflow-y-auto flex flex-col gap-3">
          {activeTab === 'editor' && (
            <textarea
              ref={modalTextareaRef}
              className="nodrag nopan w-full flex-1 min-h-[260px] bg-white/[0.02] border border-white/10 focus:border-purple-500/50 rounded-xl p-3.5 text-sm text-white placeholder-zinc-500 outline-none resize-none leading-relaxed font-sans shadow-inner select-text"
              placeholder={placeholder}
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
          )}

          {activeTab === 'preview' && (
            <div className="w-full flex-1 min-h-[260px] bg-white/[0.02] border border-white/10 rounded-xl p-3.5 overflow-y-auto leading-relaxed select-text">
              <RenderedPromptFlow
                text={value}
                imageUrls={imageUrls}
                aliases={aliases}
                audioUrls={audioUrls}
                videoUrls={videoUrls}
                placeholder={placeholder}
                className="text-sm leading-relaxed"
              />
            </div>
          )}

          {activeTab === 'split' && (
            <div className="grid grid-cols-2 gap-3 flex-1 min-h-[260px]">
              <textarea
                ref={modalTextareaRef}
                className="nodrag nopan w-full h-full bg-white/[0.02] border border-white/10 focus:border-purple-500/50 rounded-xl p-3 text-xs text-white placeholder-zinc-500 outline-none resize-none leading-relaxed font-sans shadow-inner select-text"
                placeholder={placeholder}
                value={value}
                onChange={(e) => onChange(e.target.value)}
              />
              <div className="w-full h-full bg-white/[0.02] border border-white/10 rounded-xl p-3 overflow-y-auto leading-relaxed select-text">
                <RenderedPromptFlow
                  text={value}
                  imageUrls={imageUrls}
                  aliases={aliases}
                  audioUrls={audioUrls}
                  videoUrls={videoUrls}
                  placeholder={placeholder}
                  className="text-xs leading-relaxed"
                />
              </div>
            </div>
          )}

          {/* Quick H3 Toolbar inside Modal */}
          {showH3Toolbar && (
            <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/10 flex flex-col gap-2 select-none">
              {/* Row 1: Cinematic Action Tags */}
              <div className="flex items-center gap-1.5 flex-wrap text-xs font-mono no-scrollbar" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
                <span className="text-[10px] text-zinc-400 font-sans font-bold flex-shrink-0 mr-1">{t('✦ 影视视听标签:')}</span>

                <button
                  type="button"
                  onClick={() => insertModalSnippet(' (S1) says: <d>[Chinese] 对白内容</d>', '对白内容')}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-950/70 hover:bg-sky-900 border border-sky-500/50 text-sky-200 text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] shadow-xs"
                  title={t('插入角色现场对白，并自动高亮选中「对白内容」')}
                >
                  <span>{t('💬 对话 &lt;d&gt;')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => insertModalSnippet(' (S1) says in an off-screen voiceover: <d>[Chinese] 旁白内容</d> while his lips remain completely closed.', '旁白内容')}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-fuchsia-950/70 hover:bg-fuchsia-900 border border-fuchsia-500/50 text-fuchsia-200 text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] shadow-xs"
                  title={t('插入画外音旁白（角色嘴唇闭合），并自动高亮选中「旁白内容」')}
                >
                  <span>{t('🎙️ 画外音/旁白')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => insertModalSnippet('<scenetrans>')}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-950/70 hover:bg-amber-900 border border-amber-500/50 text-amber-200 text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] shadow-xs"
                  title={t('插入跨场景声音延续转场标签')}
                >
                  <span>{t('⚡ 跨场景转场')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => insertModalSnippet('<cutoff>')}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-950/70 hover:bg-rose-900 border border-rose-500/50 text-rose-200 text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] shadow-xs"
                  title={t('插入末尾音频截断标签')}
                >
                  <span>{t('✂️ 结尾截断')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => insertModalSnippet(' [Shot 2] At 00:03.500, the camera cuts to ')}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-950/70 hover:bg-emerald-900 border border-emerald-500/50 text-emerald-200 text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] shadow-xs"
                  title={t('插入分镜头切镜与时间戳')}
                >
                  <span>{t('🎬 分镜切镜')}</span>
                </button>

                {/* Camera presets toggle */}
                <button
                  type="button"
                  onClick={() => setShowCameraMenu((v) => !v)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer ${
                    showCameraMenu
                      ? 'bg-violet-900 border-violet-400 text-white shadow-xs'
                      : 'bg-violet-950/70 hover:bg-violet-900 border-violet-500/50 text-violet-200'
                  }`}
                  title={t('展开选择 9 种标准电影运镜调度指令')}
                >
                  <span>{t('🎥 电影运镜调度')} {showCameraMenu ? '▲' : '▾'}</span>
                </button>
              </div>

              {/* Expandable Camera Motion Palette in Modal */}
              {showCameraMenu && (
                <div className="p-2.5 rounded-xl bg-violet-950/30 border border-violet-500/30 flex flex-col gap-2 animate-in fade-in duration-100 select-none">
                  <div className="flex items-center justify-between text-xs text-violet-300 font-semibold px-0.5">
                    <span className="flex items-center gap-1.5">
                      <span>{t('🎥 MiniMax H3 标准电影运镜调度库')}</span>
                      <span className="text-[10px] text-zinc-400 font-normal">{t('（点击即可插入并自动高亮修改主体）')}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowCameraMenu(false)}
                      className="text-[11px] text-zinc-400 hover:text-white cursor-pointer px-1.5 py-0.5 rounded hover:bg-white/10"
                    >
                      
                      {t('✕ 收起')}
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {CAMERA_PRESETS.map((cam) => (
                      <button
                        key={cam.label}
                        type="button"
                        onClick={() => {
                          insertModalSnippet(cam.value, cam.placeholder);
                          setShowCameraMenu(false);
                        }}
                        className="text-left p-2 rounded-xl bg-white/[0.03] hover:bg-violet-900/60 border border-white/10 hover:border-violet-400/50 text-zinc-200 hover:text-white transition-all cursor-pointer flex flex-col gap-1 shadow-xs group"
                        title={cam.value}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-violet-200 group-hover:text-white flex items-center gap-1">
                            <span>{cam.icon}</span>
                            <span>{t(cam.label)}</span>
                          </span>
                          <span className="text-[10px] text-violet-400 font-mono">{t('+插入')}</span>
                        </div>
                        <span className="text-[10px] text-zinc-400 font-mono truncate">
                          {cam.value}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Row 2: Reference Assets */}
              {imageUrls.length > 0 && (
                <div className="flex items-center justify-between pt-2 border-t border-white/5 text-xs text-zinc-400">
                  <span className="text-[10px] font-mono text-zinc-500 flex-shrink-0">{t('已挂载参考资产:')}</span>
                  <div className="flex items-center gap-1.5 flex-wrap no-scrollbar" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
                    {imageUrls.map((url, idx) => {
                      const alias = aliases?.[idx];
                      return (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => handleInsertModalRef(idx + 1, alias)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/5 hover:bg-white/15 border border-white/10 text-zinc-200 hover:text-white text-xs font-mono cursor-pointer transition-colors whitespace-nowrap"
                          title={t('插入 {token}', { token: alias ? `<图${idx + 1}:${alias}>` : `<图${idx + 1}>` })}
                        >
                          <span>+{tokenPrefix === 'Picture' ? `P${idx + 1}` : `图${idx + 1}`}</span>
                          {alias && <span className="text-amber-300 font-sans font-medium">{alias}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/10 flex items-center justify-between bg-white/[0.02] text-xs">
          <div className="flex items-center gap-3 text-zinc-400 font-mono text-[11px]">
            <span>{t('字数:')} {value.length}</span>
            <span>{t('行数:')} {value ? value.split('\n').length : 0}</span>
            <span className="text-zinc-600">|</span>
            <span className="text-zinc-500 font-sans">{t('[Esc] 退出 · [Ctrl+Enter] 快速保存')}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/15 text-zinc-200 hover:text-white transition-colors cursor-pointer font-medium"
            >
              
              {t('收起')}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold transition-all shadow-lg shadow-purple-900/30 cursor-pointer flex items-center gap-1.5 active:scale-[0.98]"
            >
              <span>{t('✓ 完成并保存')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main RichPromptEditor Component ──────────────────────────────────────────
export interface RichPromptEditorProps {
  value: string;
  onChange: (val: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  title?: string;
  imageUrls?: string[];
  aliases?: string[];
  audioUrls?: string[];
  videoUrls?: string[];
  disabled?: boolean;
  minHeight?: number | string;
  maxHeight?: number | string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  editorHandleRef?: React.MutableRefObject<RichPromptEditorHandle | null>;
  className?: string;
  tokenPrefix?: '图' | 'Picture';
  showH3Toolbar?: boolean;
  autoExpandModal?: boolean;
}

export type RichPromptEditorHandle = InlineTokenEditorHandle;

export default function RichPromptEditor({
  value,
  onChange,
  onBlur,
  placeholder = '输入电影镜头运镜、光影、人物动作与对白（支持对话、画外音、跨场景转场与分镜）…',
  title = t('电影视听提示词工作台'),
  imageUrls = [],
  aliases = [],
  audioUrls = [],
  videoUrls = [],
  disabled = false,
  minHeight = 64,
  maxHeight = 140,
  textareaRef,
  editorHandleRef,
  className = '',
  tokenPrefix = '图',
  showH3Toolbar = true,
  autoExpandModal = true,
}: RichPromptEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showCameraMenu, setShowCameraMenu] = useState(false);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isInteractingToolbarRef = useRef(false);
  const internalRef = useRef<HTMLTextAreaElement | null>(null);
  const activeRef = textareaRef || internalRef;

  useEffect(() => {
    setMounted(true);
  }, []);

  // Switch to editing (auto opens modal if autoExpandModal is true)
  const handleStartEdit = useCallback((forceInline = false) => {
    if (disabled) return;
    if (autoExpandModal && !forceInline) {
      setIsModalOpen(true);
      return;
    }
    setIsEditing(true);
    requestAnimationFrame(() => {
      if (activeRef.current) {
        activeRef.current.focus();
        window.dispatchEvent(new Event('inputFocused'));
      }
    });
  }, [disabled, autoExpandModal, activeRef]);

  // Finish editing on blur with focus retention check
  const handleTextareaBlur = useCallback(() => {
    if (isInteractingToolbarRef.current) {
      isInteractingToolbarRef.current = false;
      return;
    }
    setTimeout(() => {
      if (isInteractingToolbarRef.current) {
        isInteractingToolbarRef.current = false;
        return;
      }
      if (containerRef.current && containerRef.current.contains(document.activeElement)) {
        return;
      }
      setIsEditing(false);
      setShowCameraMenu(false);
      window.dispatchEvent(new Event('inputBlurred'));
      if (onBlur) onBlur();
    }, 150);
  }, [onBlur]);

  // Generic snippet insertion with automatic placeholder text selection and guaranteed focus retention
  const insertSnippet = useCallback((snippet: string, selectPlaceholder?: string) => {
    setIsEditing(true);
    isInteractingToolbarRef.current = true;
    const ta = activeRef.current;
    if (ta) {
      const start = ta.selectionStart ?? value.length;
      const end = ta.selectionEnd ?? value.length;
      const next = value.slice(0, start) + snippet + value.slice(end);
      onChange(next);
      setTimeout(() => {
        if (ta) {
          ta.focus();
          if (selectPlaceholder && snippet.includes(selectPlaceholder)) {
            const pStart = snippet.indexOf(selectPlaceholder);
            const pEnd = pStart + selectPlaceholder.length;
            ta.setSelectionRange(start + pStart, start + pEnd);
          } else {
            ta.setSelectionRange(start + snippet.length, start + snippet.length);
          }
          window.dispatchEvent(new Event('inputFocused'));
          isInteractingToolbarRef.current = false;
        }
      }, 20);
    } else {
      const prefix = value && !value.endsWith(' ') ? ' ' : '';
      const next = (value || '') + prefix + snippet;
      onChange(next);
      handleStartEdit();
      setTimeout(() => {
        const ta = activeRef.current;
        if (ta) {
          ta.focus();
          const baseStart = (value || '').length + prefix.length;
          if (selectPlaceholder && snippet.includes(selectPlaceholder)) {
            const pStart = snippet.indexOf(selectPlaceholder);
            const pEnd = pStart + selectPlaceholder.length;
            ta.setSelectionRange(baseStart + pStart, baseStart + pEnd);
          } else {
            ta.setSelectionRange(next.length, next.length);
          }
          window.dispatchEvent(new Event('inputFocused'));
        }
        isInteractingToolbarRef.current = false;
      }, 60);
    }
  }, [value, activeRef, onChange, handleStartEdit]);

  // Insert reference token chip (<图1:林夕>, <Picture 1: Alice>)
  const handleInsertRefToken = useCallback((idx: number, customAlias?: string) => {
    const effectiveAlias = customAlias !== undefined ? customAlias : (aliases?.[idx - 1] || '');
    const token = effectiveAlias
      ? (tokenPrefix === 'Picture' ? `<Picture ${idx}: ${effectiveAlias}>` : `<图${idx}:${effectiveAlias}>`)
      : (tokenPrefix === 'Picture' ? `<Picture ${idx}>` : `<图${idx}>`);
    insertSnippet(token);
  }, [tokenPrefix, aliases, insertSnippet]);

  return (
    <>
      <div
        ref={containerRef}
        className={`nodrag nopan relative group/editor rounded-xl border transition-all duration-200 w-full max-w-full min-w-0 overflow-hidden flex flex-col ${
          isEditing
            ? 'bg-black/75 border-white/40 ring-1 ring-white/20 shadow-[0_0_12px_rgba(255,255,255,0.1)]'
            : 'bg-white/[0.03] hover:bg-white/[0.05] border-white/10 hover:border-white/20'
        } ${className}`}
        style={{ height: minHeight || 68 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* ── Mode Pill Badges in Top Right ─────────────────────── */}
        <div className="nodrag nopan absolute top-1.5 right-2 z-20 flex items-center gap-1 opacity-0 group-hover/editor:opacity-100 transition-opacity select-none">
          {/* Independent Modal Expand Button */}
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setIsModalOpen(true);
            }}
            className="nodrag nopan flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-mono bg-purple-600/40 hover:bg-purple-600/70 text-purple-200 border border-purple-500/40 cursor-pointer shadow-xs transition-colors"
            title={t('进入独立大窗工作台模式 (不受卡片高度限制)')}
          >
            <span>{t('⤢ 独立大窗')}</span>
          </button>

          {isEditing ? (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setIsEditing(false);
                setShowCameraMenu(false);
                if (onBlur) onBlur();
              }}
              className="nodrag nopan flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-mono bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-200 border border-emerald-500/40 cursor-pointer shadow-xs"
              title={t('点击完成并切换为图文渲染视图')}
            >
              <span>{t('👁 渲染视图')}</span>
            </button>
          ) : (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                handleStartEdit(true);
              }}
              className="nodrag nopan flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-mono bg-white/10 hover:bg-white/20 text-zinc-300 border border-white/20 cursor-pointer shadow-xs"
              title={t('在卡片内展开小框行内编辑')}
            >
              <span>{t('✎ 行内小框')}</span>
            </button>
          )}
        </div>

        {/* ── Editing Mode: Native Textarea with full typing/IME support ── */}
        {isEditing ? (
          <div className="nodrag nopan p-2 flex flex-col justify-between h-full w-full max-w-full min-w-0 overflow-hidden">
            <textarea
              ref={activeRef as React.RefObject<HTMLTextAreaElement>}
              className="nodrag nopan w-full max-w-full min-w-0 bg-transparent text-xs text-white placeholder-zinc-500 outline-none resize-none leading-relaxed font-sans flex-1 min-h-0"
              placeholder={placeholder}
              value={value}
              autoFocus
              onChange={(e) => onChange(e.target.value)}
              onFocus={() => window.dispatchEvent(new Event('inputFocused'))}
              onBlur={handleTextareaBlur}
            />

            {/* ── H3 Tag Inserter Toolbar ──────────────────────────── */}
            {showH3Toolbar && (
              <div
                className="nodrag nopan mt-2 pt-1.5 border-t border-white/10 flex flex-col gap-1.5 select-none"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  isInteractingToolbarRef.current = true;
                }}
              >
                {/* Row 1: Core H3 Cinematic Audio/Visual Tags */}
                <div className="nodrag nopan flex items-center gap-1 overflow-x-auto no-scrollbar pb-0.5 text-[9px] font-mono" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
                  <span className="text-[8px] text-zinc-500 flex-shrink-0 select-none mr-0.5">{t('H3标签:')}</span>

                  {/* Dialogue */}
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      isInteractingToolbarRef.current = true;
                      insertSnippet(' (S1) says: <d>[Chinese] 对白内容</d>', '对白内容');
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    className="nodrag nopan flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-950/60 hover:bg-sky-900/80 border border-sky-500/40 text-sky-200 cursor-pointer transition-colors flex-shrink-0"
                    title={t('插入角色台词（自动选中「对白内容」以便直接键入替换）')}
                  >
                    <span>{t('💬 对话')}</span>
                  </button>

                  {/* Voiceover */}
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      isInteractingToolbarRef.current = true;
                      insertSnippet(' (S1) says in an off-screen voiceover: <d>[Chinese] 旁白内容</d> while his lips remain completely closed.', '旁白内容');
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    className="nodrag nopan flex items-center gap-1 px-1.5 py-0.5 rounded bg-fuchsia-950/60 hover:bg-fuchsia-900/80 border border-fuchsia-500/40 text-fuchsia-200 cursor-pointer transition-colors flex-shrink-0"
                    title={t('插入画外音/旁白（自动选中「旁白内容」以便直接键入替换）')}
                  >
                    <span>{t('🎙️ 画外音')}</span>
                  </button>

                  {/* Scene Transition */}
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      isInteractingToolbarRef.current = true;
                      insertSnippet('<scenetrans>');
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    className="nodrag nopan flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-950/60 hover:bg-amber-900/80 border border-amber-500/40 text-amber-200 cursor-pointer transition-colors flex-shrink-0"
                    title={t('插入跨场景声音接戏标签：<scenetrans> (保持切镜声音连续)')}
                  >
                    <span>{t('⚡ 跨场景')}</span>
                  </button>

                  {/* Audio Cutoff */}
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      isInteractingToolbarRef.current = true;
                      insertSnippet('<cutoff>');
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    className="nodrag nopan flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-950/60 hover:bg-rose-900/80 border border-rose-500/40 text-rose-200 cursor-pointer transition-colors flex-shrink-0"
                    title={t('插入末尾声音截断标签：<cutoff>')}
                  >
                    <span>{t('✂️ 截断')}</span>
                  </button>

                  {/* Shot cut */}
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      isInteractingToolbarRef.current = true;
                      insertSnippet(' [Shot 2] At 00:03.500, the camera cuts to ');
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    className="nodrag nopan flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-950/60 hover:bg-emerald-900/80 border border-emerald-500/40 text-emerald-200 cursor-pointer transition-colors flex-shrink-0"
                    title={t('插入分镜头切镜点与时间戳')}
                  >
                    <span>{t('🎬 分镜')}</span>
                  </button>

                  {/* Camera presets toggle */}
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      isInteractingToolbarRef.current = true;
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setShowCameraMenu((v) => !v);
                    }}
                    className={`nodrag nopan flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors flex-shrink-0 cursor-pointer ${
                      showCameraMenu
                        ? 'bg-violet-900/80 border-violet-400 text-white'
                        : 'bg-violet-950/60 hover:bg-violet-900/80 border-violet-500/40 text-violet-200'
                    }`}
                    title={t('选择标准电影运镜指令')}
                  >
                    <span>{t('🎥 运镜')} {showCameraMenu ? '▲' : '▾'}</span>
                  </button>
                </div>

                {/* Expandable Camera Motion Drawer in-node */}
                {showCameraMenu && (
                  <div
                    className="nodrag nopan p-1.5 rounded-lg bg-violet-950/70 border border-violet-500/40 flex flex-col gap-1 select-none animate-in fade-in duration-100"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      isInteractingToolbarRef.current = true;
                    }}
                  >
                    <div className="flex items-center justify-between text-[9px] text-violet-300 font-bold px-0.5">
                      <span>{t('🎥 电影运镜调度指令:')}</span>
                      <button
                        type="button"
                        onClick={() => setShowCameraMenu(false)}
                        className="text-zinc-400 hover:text-white cursor-pointer px-1"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      {CAMERA_PRESETS.map((cam) => (
                        <button
                          key={cam.label}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            isInteractingToolbarRef.current = true;
                            insertSnippet(cam.value, cam.placeholder);
                            setShowCameraMenu(false);
                          }}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                          className="nodrag nopan text-left px-1.5 py-1 rounded bg-black/40 hover:bg-violet-900/80 border border-violet-500/20 hover:border-violet-400/60 text-zinc-200 hover:text-white text-[9px] font-sans transition-colors cursor-pointer flex items-center justify-between"
                          title={cam.value}
                        >
                          <span className="truncate">{t(cam.label)}</span>
                          <span className="text-[8px] text-violet-400 font-mono">+</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Row 2: Reference Assets Quick Insert */}
                {imageUrls.length > 0 && (
                  <div className="nodrag nopan flex items-center justify-between text-[10px] text-zinc-400 pt-1 border-t border-white/5">
                    <span className="text-[8px] font-mono text-zinc-500">{t('参考图引用:')}</span>
                    <div className="flex items-center gap-1 overflow-x-auto no-scrollbar" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
                      {imageUrls.map((url, idx) => {
                        const alias = aliases?.[idx];
                        return (
                          <button
                            key={idx}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              isInteractingToolbarRef.current = true;
                              handleInsertRefToken(idx + 1, alias);
                            }}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            className="nodrag nopan flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/15 border border-white/10 text-zinc-300 hover:text-white text-[9px] font-mono cursor-pointer transition-colors whitespace-nowrap"
                            title={t('插入 {token}', { token: alias ? `<图${idx + 1}:${alias}>` : `<图${idx + 1}>` })}
                          >
                            <span>+{tokenPrefix === 'Picture' ? `P${idx + 1}` : `图${idx + 1}`}</span>
                            {alias && <span className="text-amber-300 font-sans font-medium max-w-[50px] truncate">{alias}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          /* ── Rendered labels and editable prose share one surface ─────── */
          <EditablePromptFlow
            value={value}
            onChange={onChange}
            onBlur={onBlur}
            imageUrls={imageUrls}
            aliases={aliases}
            audioUrls={audioUrls}
            videoUrls={videoUrls}
            editorHandleRef={editorHandleRef}
            placeholder={placeholder}
          />
        )}
      </div>

      {/* ── Independent Modal Overlay (Portal) ────────────────────────── */}
      {isModalOpen && mounted && typeof document !== 'undefined' && createPortal(
        <ExpandedPromptModal
          title={title}
          value={value}
          onChange={onChange}
          onClose={() => setIsModalOpen(false)}
          placeholder={placeholder}
          imageUrls={imageUrls}
          aliases={aliases}
          audioUrls={audioUrls}
          videoUrls={videoUrls}
          tokenPrefix={tokenPrefix}
          showH3Toolbar={showH3Toolbar}
        />,
        document.body
      )}
    </>
  );
}
