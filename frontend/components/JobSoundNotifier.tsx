'use client';

import { useEffect, useRef } from 'react';
import { useStore } from '@/lib/store';
import { useJobPollerStore } from '@/lib/jobPollerStore';

/**
 * Sound for this project's renders, when enabled in studio settings (off by
 * default): a spoken line with the expected duration when a job starts, and a
 * short chime when it ends -- rising for done, falling for error or cancel.
 * The duration is the backend's learned estimate (sched_remaining at start).
 */
export default function JobSoundNotifier() {
  const enabled = useStore((s) => s.settings.soundNotifyJobs);
  const projectId = useStore((s) => s.currentProjectId);
  const active = useJobPollerStore((s) => s.queue.active as any);
  const jobs = useJobPollerStore((s) => s.jobs);
  // Every job spoken for, so a chain resuming after a cut-in is not announced again.
  const announced = useRef<Set<string>>(new Set());
  const running = useRef<string | null>(null);

  const activeId: string | undefined = active?.id;
  const mine = Boolean(active && (!projectId || !active.project_id || active.project_id === projectId));
  const remaining: number | undefined = active?.sched_remaining;

  // Start: wait for the first poll that carries an estimate, then speak once.
  useEffect(() => {
    if (!enabled || !activeId || !mine || announced.current.has(activeId)) return;
    if (remaining === undefined) return;
    announced.current.add(activeId);
    // A job that was already running when the page loaded is not "starting".
    const started = Date.parse(active?.started_at ?? '');
    if (Number.isFinite(started) && Date.now() - started > 60_000) return;
    speak(`开始生成，预计${spokenDuration(remaining)}`);
  }, [enabled, activeId, mine, remaining]);

  // End: the job we were watching is no longer the active one.
  useEffect(() => {
    const prev = running.current;
    running.current = mine ? activeId ?? null : null;
    if (!enabled || !prev || prev === activeId) return;
    const status = jobs[prev]?.status;
    // A chain that stepped aside for a cut-in job is still running.
    if (status === 'running' || status === 'queued') return;
    chime(status === 'done');
  }, [enabled, activeId, mine, jobs]);

  return null;
}

function spokenDuration(sec: number): string {
  if (sec < 60) return '不到一分钟';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}分钟`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}小时${m % 60}分钟` : `${h}小时`;
}

function speak(text: string) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    const zh = synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith('zh'));
    if (zh) u.voice = zh;
    synth.speak(u);
  } catch { /* no speech engine: stay silent */ }
}

let audioCtx: AudioContext | null = null;

/** Two soft tones: up for success, down for failure. */
function chime(ok: boolean) {
  try {
    audioCtx = audioCtx ?? new AudioContext();
    const ctx = audioCtx;
    void ctx.resume();
    const notes = ok ? [660, 990] : [520, 330];
    notes.forEach((freq, i) => {
      const t0 = ctx.currentTime + i * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    });
  } catch { /* audio blocked: stay silent */ }
}
