'use client';

import { useRef, useState } from 'react';
import { t } from '@/lib/i18n';

/**
 * 3D orbit view for the CrossView node: the subject at the centre, the source camera
 * (grey) on the floor ring, the new camera (violet) orbiting it. Drag sideways for
 * azimuth, up/down for elevation; right-drag turns the view, double-click resets it.
 * Not Shift-drag: Shift is the canvas's selection key, so Shift-dragging here also
 * started a box selection / node drag on the canvas underneath.
 * Plain SVG with a hand-rolled projection -- no 3D library for one small gizmo.
 *
 * World: y up, source camera on +z. az>0 = to the right as the source camera sees
 * the subject, which is the backend's convention.
 */

type V3 = [number, number, number];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const norm3 = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const AZ_MIN = -90, AZ_MAX = 90, EL_MIN = -35, EL_MAX = 45;
const D2R = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const snap = (v: number) => Math.round(v / 5) * 5;
const R = 1.35;
const HOME = { yaw: -30, pitch: 24 };

function camPos(az: number, el: number, r = R): V3 {
  return [r * Math.sin(az * D2R) * Math.cos(el * D2R), r * Math.sin(el * D2R), r * Math.cos(az * D2R) * Math.cos(el * D2R)];
}

interface Props {
  az: number;
  el: number;
  onChange: (az: number, el: number) => void;
  disabled?: boolean;
}

export default function ReangleOrbit3D({ az, el, onChange, disabled }: Props) {
  const drag = useRef<{ x: number; y: number; az: number; el: number; turn: boolean } | null>(null);
  const [view, setView] = useState(HOME);

  // Rotate by view yaw/pitch, weak perspective. Returns [x, y, depth toward viewer].
  const P = (p: V3): [number, number, number] => {
    const cy = Math.cos(view.yaw * D2R), sy = Math.sin(view.yaw * D2R);
    const x1 = p[0] * cy - p[2] * sy, z1 = p[0] * sy + p[2] * cy;
    const cp = Math.cos(view.pitch * D2R), sp = Math.sin(view.pitch * D2R);
    const y2 = p[1] * cp - z1 * sp, z2 = p[1] * sp + z1 * cp;
    const k = 1 / (1 - z2 * 0.08);
    return [80 + x1 * 34 * k, 62 - y2 * 34 * k, z2];
  };
  const pts = (list: V3[]) => list.map((q) => { const s = P(q); return `${s[0]},${s[1]}`; }).join(' ');
  const ring = (a0: number, a1: number) => {
    const out: V3[] = [];
    for (let a = a0; a <= a1; a += 5) out.push(camPos(a, 0));
    return out;
  };

  const frustum = (pos: V3, color: string, fill: string) => {
    const f = norm3(mul3(pos, -1));
    const r = norm3(cross3(f, [0, 1, 0]));
    const u = cross3(r, f);
    const base = add3(pos, mul3(f, 0.34));
    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([i, j]) =>
      P(add3(add3(base, mul3(r, 0.2 * i)), mul3(u, 0.12 * j))));
    const o = P(pos);
    return (
      <g>
        {corners.map((q, i) => <line key={i} x1={o[0]} y1={o[1]} x2={q[0]} y2={q[1]} stroke={color} strokeWidth="0.8" />)}
        <polygon points={corners.map((q) => `${q[0]},${q[1]}`).join(' ')} fill={fill} stroke={color} strokeWidth="0.9" />
        <circle cx={o[0]} cy={o[1]} r="2.6" fill={color} />
      </g>
    );
  };

  const cam = camPos(az, el);
  const foot = P(camPos(az, 0));
  const origin = P([0, 0, 0]);
  const meridian: V3[] = [];
  const stepE = el >= 0 ? 3 : -3;
  for (let e = 0; Math.abs(e) < Math.abs(el); e += stepE) meridian.push(camPos(az, e));
  meridian.push(cam);
  // Draw the new camera behind the subject when it is farther from the viewer.
  const camBehind = P(cam)[2] < 0;

  const feet = P([0, -0.5, 0]), top = P([0, 0.55, 0]), head = P([0, 0.72, 0]), facing = P([0, -0.5, 0.5]);
  const subject = (
    <g>
      <line x1={feet[0]} y1={feet[1]} x2={facing[0]} y2={facing[1]} stroke="rgba(255,255,255,0.35)" strokeWidth="1" markerEnd="url(#rv3Arrow)" />
      <line x1={feet[0]} y1={feet[1]} x2={top[0]} y2={top[1]} stroke="rgba(255,255,255,0.55)" strokeWidth="5" strokeLinecap="round" />
      <circle cx={head[0]} cy={head[1]} r="4" fill="rgba(255,255,255,0.65)" />
    </g>
  );
  const newCam = frustum(cam, '#a78bfa', 'rgba(167,139,250,0.25)');

  const onDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, az, el, turn: e.button === 2 };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.turn) {
      setView((v) => ({ yaw: v.yaw - e.movementX * 0.6, pitch: clamp(v.pitch + e.movementY * 0.4, 0, 80) }));
      return;
    }
    onChange(clamp(snap(d.az + (e.clientX - d.x) * 0.9), AZ_MIN, AZ_MAX),
             clamp(snap(d.el - (e.clientY - d.y) * 0.6), EL_MIN, EL_MAX));
  };
  const onUp = () => { drag.current = null; };

  return (
    <svg viewBox="0 0 160 120"
         className={`nodrag nopan w-[168px] h-[126px] shrink-0 touch-none select-none rounded-md bg-white/[0.02] border border-white/5 ${disabled ? 'opacity-40' : 'cursor-grab active:cursor-grabbing'}`}
         onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
         onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
         onDoubleClick={() => setView(HOME)}>
      <defs>
        <marker id="rv3Arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto">
          <path d="M0 0 L6 3 L0 6z" fill="rgba(255,255,255,0.45)" />
        </marker>
      </defs>
      <polyline points={pts(ring(-180, 180))} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
      <polyline points={pts(ring(-90, 90))} fill="none" stroke="rgba(251,191,36,0.3)" strokeWidth="3" strokeLinecap="round" />
      <polyline points={pts(ring(-45, 45))} fill="none" stroke="rgba(45,212,191,0.5)" strokeWidth="3" strokeLinecap="round" />
      {camBehind && newCam}
      {frustum(camPos(0, 0), 'rgba(255,255,255,0.4)', 'rgba(255,255,255,0.06)')}
      <line x1={foot[0]} y1={foot[1]} x2={origin[0]} y2={origin[1]} stroke="rgba(167,139,250,0.35)" strokeWidth="0.8" strokeDasharray="2 2" />
      {subject}
      <polyline points={pts(meridian)} fill="none" stroke="rgba(167,139,250,0.7)" strokeWidth="1" strokeDasharray="2 2" />
      {!camBehind && newCam}
      <text x="4" y="115" fontSize="6.5" fill="rgba(255,255,255,0.35)">{t('拖动改机位 · 右键拖转视角 · 双击复位')}</text>
    </svg>
  );
}
