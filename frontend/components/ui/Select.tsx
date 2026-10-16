'use client';

import React, {
  Children, Fragment, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * The project's one dropdown. A drop-in for the native select: same `value` / `onChange(e)` (read
 * `e.target.value`) / `disabled` / `className` / `style` / `title`, and `<option>` children.
 * The closed control keeps whatever `className` / `style` the call site gives it; the open list
 * is drawn here, so every dropdown in the studio looks the same instead of taking the OS's
 * white native list.
 */

type Opt = { value: string; disabled: boolean; node: React.ReactNode };

function collect(children: React.ReactNode, out: Opt[] = []): Opt[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as React.ReactElement<any>;
    if (el.type === Fragment) { collect(el.props.children, out); return; }
    if (el.type === 'option') {
      const text = el.props.children;
      out.push({
        value: String(el.props.value ?? (typeof text === 'string' ? text : '')),
        disabled: !!el.props.disabled,
        node: text,
      });
    }
  });
  return out;
}

export type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'size'>;

export default function Select({
  value, onChange, disabled, className, style, title, children, id, name, onClick, onMouseDown,
  autoFocus, 'aria-label': ariaLabel,
}: SelectProps) {
  const opts = useMemo(() => collect(children), [children]);
  const current = String(value ?? '');
  const selectedIdx = Math.max(0, opts.findIndex((o) => o.value === current));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selectedIdx);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; up: boolean; max: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const below = window.innerHeight - b.bottom - 8;
    const above = b.top - 8;
    const up = below < 180 && above > below;
    setRect({ left: b.left, top: up ? b.top : b.bottom, width: b.width, up, max: Math.max(120, Math.min(320, up ? above : below)) });
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const reposition = (e: Event) => {
      if (listRef.current?.contains(e.target as Node)) return;
      place();
    };
    document.addEventListener('mousedown', close, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', close, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const choose = (i: number) => {
    const o = opts[i];
    if (!o || o.disabled) return;
    setOpen(false);
    btnRef.current?.focus();
    if (o.value !== current) {
      const target = { value: o.value, name } as unknown as HTMLSelectElement;
      onChange?.({ target, currentTarget: target } as unknown as React.ChangeEvent<HTMLSelectElement>);
    }
  };

  const step = (dir: 1 | -1) => {
    let i = active;
    for (let n = 0; n < opts.length; n++) {
      i = (i + dir + opts.length) % opts.length;
      if (!opts[i].disabled) { setActive(i); return; }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        setActive(selectedIdx);
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); setOpen(false); }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        id={id}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        autoFocus={autoFocus}
        disabled={disabled}
        className={`nodrag ${className ?? ''}`}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : undefined, fontFamily: 'inherit',
          ...style,
        }}
        onMouseDown={onMouseDown as React.MouseEventHandler<HTMLButtonElement> | undefined}
        onClick={(e) => {
          (onClick as React.MouseEventHandler<HTMLButtonElement> | undefined)?.(e);
          if (e.defaultPrevented || disabled) return;
          setActive(selectedIdx);
          setOpen((v) => !v);
        }}
        onKeyDown={onKeyDown}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {opts[selectedIdx]?.node ?? ''}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
          strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7, transform: open ? 'rotate(180deg)' : undefined }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && rect && typeof document !== 'undefined' && createPortal(
        <div
          ref={listRef}
          role="listbox"
          className="nodrag nowheel"
          style={{
            position: 'fixed', left: rect.left, minWidth: rect.width, zIndex: 100000,
            ...(rect.up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.top + 4 }),
            maxHeight: rect.max, overflowY: 'auto', padding: 4, borderRadius: 10,
            background: '#16161d', border: '1px solid rgba(255,255,255,0.12)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.55)', fontSize: 12, color: '#e4e4e7',
          }}
        >
          {opts.map((o, i) => {
            const isSel = i === selectedIdx;
            return (
              <div
                key={`${o.value}-${i}`}
                role="option"
                aria-selected={isSel}
                data-active={i === active}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 7,
                  cursor: o.disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                  opacity: o.disabled ? 0.4 : 1,
                  background: i === active && !o.disabled ? 'rgba(255,255,255,0.09)' : 'transparent',
                  color: isSel ? '#fff' : '#d4d4d8',
                }}
              >
                <span style={{ width: 10, flexShrink: 0, color: '#06b6d4' }}>{isSel ? '✓' : ''}</span>
                <span>{o.node}</span>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
