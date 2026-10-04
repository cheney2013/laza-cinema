'use client';
import { copyText } from '@/lib/copyText';
import { useSyncedText } from '@/hooks/useSyncedText';

import { Position, NodeProps, useReactFlow } from '@xyflow/react';
import NodeShell from './NodeShell';
import { useNodeSizing } from '@/hooks/useNodeSizing';
import { PromptNode as PromptNodeType } from '@/lib/types';
import IconHandle from './IconHandle';
import { useState, useEffect, memo, useCallback, useRef } from 'react';
import { areNodePropsEqual } from '@/lib/utils';
import { t } from '@/lib/i18n';

function PromptNode({ id, data, selected }: NodeProps<PromptNodeType>) {
  const { updateNodeData, setNodes } = useReactFlow();
  const [localText, setLocalText] = useSyncedText((data.text as string) || '');
  const [isEditing, setIsEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);

  // 提示词节点没有媒体区，整块都是文本内容 —— hasMedia:false，高度归内容管，
  // 尺寸方程只负责守住"标题栏那排按钮排得下"这个下限。
  const sizing = useNodeSizing({
    id,
    type: 'prompt',
    rows: ['header'],
    paddingX: 28,
    hasMedia: false,
    userWidth: data.userWidth,
  });

  // 双击落点对应的字符下标，进入编辑态后光标就停在这里（null = 落到末尾）
  const pendingCaretRef = useRef<number | null>(null);
  // 只读区双击时的滚动位置 —— 两者字体/行高/宽度一致，直接搬给 textarea 就能保持视觉不跳
  const pendingScrollRef = useRef<number>(0);

  // 把一次鼠标点击换算成只读文本里的字符下标。
  // 只读区把 localText 整个渲染成单个文本节点（white-space: pre-wrap），
  // 所以 caret range 的偏移量可以直接当作 textarea 里的下标用。
  const caretIndexFromPoint = useCallback((container: HTMLElement, x: number, y: number): number | null => {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null;
    let offset = 0;
    if (typeof doc.caretPositionFromPoint === 'function') {
      const pos = doc.caretPositionFromPoint(x, y);
      if (!pos) return null;
      node = pos.offsetNode;
      offset = pos.offset;
    } else if (typeof doc.caretRangeFromPoint === 'function') {
      const range = doc.caretRangeFromPoint(x, y);
      if (!range) return null;
      node = range.startContainer;
      offset = range.startOffset;
    } else {
      return null;
    }
    if (!node || !container.contains(node)) return null;
    // 用一个从容器开头到落点的 Range，长度即为下标（容器里只有文本，不含额外元素）
    const measure = document.createRange();
    measure.selectNodeContents(container);
    try {
      measure.setEnd(node, offset);
    } catch {
      return null;
    }
    return measure.toString().length;
  }, []);

  // 双击进入编辑后强制聚焦 —— autoFocus 在节点重渲染时不一定生效
  useEffect(() => {
    if (!isEditing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const caret = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const pos = caret === null ? el.value.length : Math.min(caret, el.value.length);
    el.setSelectionRange(pos, pos);
    if (caret !== null) el.scrollTop = pendingScrollRef.current;
  }, [isEditing]);

  // Auto-adapt node height to content
  const fitNodeHeight = useCallback((textToFit: string, extraPadding: number = 0) => {
    if (!textToFit && extraPadding === 0) return;
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== id) return n;
        const currentW = (n.measured?.width || n.width || 320) as number;
        // Estimate characters per line (approx 32-40 chars per line at 13px font)
        const charsPerLine = Math.max(22, Math.floor((currentW - 36) / 7.2));
        const lines = (textToFit || '').split('\n').reduce((acc, line) => {
          return acc + Math.max(1, Math.ceil(line.length / charsPerLine));
        }, 0);
        // Header (36px) + Actions bar (38px) + text padding (24px) + content + extra padding (panels)
        const calculatedH = Math.min(Math.max(180, 100 + lines * 22 + extraPadding), 600);
        if (n.height === calculatedH) return n;
        return { ...n, height: calculatedH };
      })
    );
  }, [id, setNodes]);

  // Sync local state with node data when it changes externally
  useEffect(() => {
    setLocalText(data.text);
  }, [data.text]);

  const handleBlur = () => {
    if (localText !== data.text) {
      updateNodeData(id, { text: localText });
      fitNodeHeight(localText);
      window.dispatchEvent(new Event('takeSnapshot'));
    }
  };

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!localText) return;
    void copyText(localText).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <NodeShell
      nodeId={id}
      spec={sizing.spec}
      selected={selected}
      onResizeEnd={sizing.onResizeEnd}
      shellRef={sizing.shellRef}
    >
      {/* ── Node Header ──────────────────────────────────────────────── */}
      <div style={header} data-chrome-row="header" className="node-shell-header">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-zinc-300">
          <span className="font-mono text-[10px] font-semibold text-zinc-400">T</span>
          <span style={label} className="text-zinc-200" data-chrome="label">{t('提示词')}</span>
        </div>

        <div className="flex items-center gap-1">
          <span className="text-[10px] font-mono text-zinc-500 ml-1">
            {localText ? t('{n} 字符', { n: localText.length }) : t('空')}
          </span>
        </div>
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div style={{ ...cardBody, width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

          {/* ── Original Prompt content area ──────────────────────────── */}
          <div
            style={{ padding: '12px 14px 8px', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
            onDoubleClick={(e) => {
              if (!isEditing) {
                const view = e.currentTarget.querySelector<HTMLElement>('[data-prompt-view]');
                pendingCaretRef.current = view && localText
                  ? caretIndexFromPoint(view, e.clientX, e.clientY)
                  : null;
                pendingScrollRef.current = view ? view.scrollTop : 0;
              }
              setIsEditing(true);
            }}
          >
            {isEditing ? (
              <textarea
                ref={textareaRef}
                className="nodrag nowheel"
                style={{
                  width: '100%',
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  overflowY: 'auto',
                  color: '#ededed',
                  fontSize: 13,
                  lineHeight: 1.6,
                  fontFamily: 'inherit',
                }}
                placeholder={t('描述你想创建的影视场景、光影与构图…')}
                value={localText}
                onChange={(e) => setLocalText(e.target.value)}
                onWheel={(e) => {
                  e.stopPropagation();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onFocus={() => {
                  window.dispatchEvent(new Event('inputFocused'));
                }}
                onBlur={() => {
                  setIsEditing(false);
                  window.dispatchEvent(new Event('inputBlurred'));
                  handleBlur();
                }}
              />
            ) : (
              <div
                className="nowheel"
                data-prompt-view
                style={{
                  width: '100%',
                  flex: 1,
                  color: localText ? '#ededed' : '#71717a',
                  fontSize: 13,
                  lineHeight: 1.6,
                  fontFamily: 'inherit',
                  whiteSpace: 'pre-wrap',
                  overflowY: 'auto',
                  wordBreak: 'break-word',
                  cursor: 'text',
                }}
              >
                {localText || t('双击输入场景、角色或镜头提示词…')}
              </div>
            )}
          </div>

          {/* ── Copy ────────────────────────────────────────────────────
              Rewriting and translating live on the node that uses the prompt
              (the H3 node's 转译), which knows the references it is written for. */}
          <div className="px-3 pb-2 pt-1 flex items-center justify-end gap-2">
            <button
              onClick={handleCopy}
              title={t('复制提示词')}
              className="p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition-colors cursor-pointer flex-shrink-0"
            >
              {copied ? (
                <span className="text-[10px] text-zinc-200 font-mono">{t('已复制')}</span>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </div>

        </div>
        <IconHandle type="target" portType="prompt" nodeId={id} />
        <IconHandle type="source" portType="prompt" nodeId={id} />
      </div>
    </NodeShell>
  );
}

export default memo(PromptNode, areNodePropsEqual);

// ── Shared design tokens ────────────────────────────────────────────────────

export const cardBody: React.CSSProperties = {
  background: 'rgba(14, 14, 20, 0.90)',
  backdropFilter: 'blur(28px)',
  WebkitBackdropFilter: 'blur(28px)',
  borderRadius: 18,
  position: 'relative',
  color: '#ededed',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  boxShadow: '0 16px 44px rgba(0, 0, 0, 0.75), inset 0 1px 0 rgba(255, 255, 255, 0.14)',
};

export const selectedShadow = '0 0 0 1.5px rgba(255, 255, 255, 0.95), 0 0 24px rgba(255, 255, 255, 0.18), 0 16px 48px rgba(0, 0, 0, 0.85)';
export const defaultShadow = '0 16px 44px rgba(0, 0, 0, 0.75), inset 0 1px 0 rgba(255, 255, 255, 0.14)';

export const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
  marginBottom: 8,
  paddingLeft: 4,
  paddingRight: 4,
  whiteSpace: 'nowrap',
};

export const label: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.02em',
};
