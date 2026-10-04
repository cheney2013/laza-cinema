'use client';

import React, { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface InlineTokenEditorHandle {
  insertText: (text: string) => boolean;
}

export interface InlineTokenPart<T> {
  text: string;
  token?: T;
}

interface InlineTokenEditorProps<T> {
  value: string;
  onChange: (value: string) => void;
  parse: (value: string) => InlineTokenPart<T>[];
  renderToken: (token: T, raw: string) => React.ReactNode;
  editorHandleRef?: React.MutableRefObject<InlineTokenEditorHandle | null>;
  onFocus?: () => void;
  onBlur?: () => void;
  onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
  onPaste?: React.ClipboardEventHandler<HTMLDivElement>;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
}

function serialize(root: HTMLElement): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (!(node instanceof HTMLElement)) return '';
    if (node.dataset.inlineToken !== undefined) return node.dataset.inlineToken;
    if (node.tagName === 'BR') return '\n';
    const body = Array.from(node.childNodes).map(walk).join('');
    return node.tagName === 'DIV' || node.tagName === 'P' ? `${body}\n` : body;
  };
  return Array.from(root.childNodes).map(walk).join('').replace(/\n$/, '');
}

function serializedOffset(root: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(container, offset);
  const scratch = document.createElement('div');
  scratch.append(range.cloneContents());
  return serialize(scratch).length;
}

function restoreCaret(root: HTMLElement, target: number) {
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
    const raw = node.dataset.inlineToken;
    if (raw !== undefined) { consumed += raw.length; return; }
    Array.from(node.childNodes).forEach(visit);
  };
  visit(root);
  const range = document.createRange();
  const resolved = point as { node: Node; offset: number } | null;
  if (resolved) range.setStart(resolved.node, resolved.offset);
  else { range.selectNodeContents(root); range.collapse(false); }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function adjacentToken(root: HTMLElement, container: Node, offset: number, direction: 'backward' | 'forward') {
  let cursor = container;
  if (cursor.nodeType === Node.TEXT_NODE) {
    const length = cursor.textContent?.length || 0;
    if ((direction === 'backward' && offset > 0) || (direction === 'forward' && offset < length)) return null;
  } else if (cursor instanceof HTMLElement) {
    const child = cursor.childNodes[direction === 'backward' ? offset - 1 : offset];
    if (child) cursor = child;
  }
  while (cursor !== root) {
    if (cursor instanceof HTMLElement && cursor.dataset.inlineToken !== undefined) return cursor;
    const sibling = direction === 'backward' ? cursor.previousSibling : cursor.nextSibling;
    if (sibling) {
      cursor = sibling;
      while (cursor instanceof HTMLElement && cursor.dataset.inlineToken === undefined && cursor.childNodes.length) {
        cursor = direction === 'backward' ? cursor.lastChild! : cursor.firstChild!;
      }
      return cursor instanceof HTMLElement && cursor.dataset.inlineToken !== undefined ? cursor : null;
    }
    if (!cursor.parentNode) return null;
    cursor = cursor.parentNode;
  }
  return null;
}

export default function InlineTokenEditor<T>({
  value, onChange, parse, renderToken, editorHandleRef, onFocus, onBlur,
  onMouseDown, onPaste, placeholder, className = '', style,
}: InlineTokenEditorProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(false);
  const renderedValueRef = useRef(value);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const [, rerender] = useState(0);
  /**
   * Bumped every time an outside change is adopted, and used as the editable
   * div's key so React builds a fresh one.
   *
   * Re-rendering the children is not enough here. Ordinary typing is left
   * unmanaged on purpose (caret and IME), so the browser has been writing text
   * nodes into this div that React never created — and React only ever removes
   * or updates its own. Update the children over that and the browser's nodes
   * stay on screen: the card goes on showing the text you typed while `value`
   * has since been replaced from the 独立大窗, an MCP write or ✦转译. Remounting
   * throws the whole element away, strays included. It costs nothing visible
   * because it only happens while the caret is somewhere else.
   */
  const domGenerationRef = useRef(0);
  if (!focusedRef.current && renderedValueRef.current !== value) {
    renderedValueRef.current = value;
    domGenerationRef.current += 1;
  }

  const saveSelection = useCallback(() => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    selectionRef.current = {
      start: serializedOffset(root, range.startContainer, range.startOffset),
      end: serializedOffset(root, range.endContainer, range.endOffset),
    };
  }, []);

  const commit = useCallback((next: string, caret: number) => {
    renderedValueRef.current = next;
    pendingCaretRef.current = caret;
    selectionRef.current = { start: caret, end: caret };
    onChange(next);
    rerender((n) => n + 1);
  }, [onChange]);

  const insertText = useCallback((text: string) => {
    const root = rootRef.current;
    if (!root || !text) return false;
    const current = serialize(root);
    const saved = selectionRef.current;
    const start = Math.min(saved?.start ?? current.length, current.length);
    const end = Math.min(saved?.end ?? start, current.length);
    commit(current.slice(0, start) + text + current.slice(end), start + text.length);
    requestAnimationFrame(() => root.focus());
    return true;
  }, [commit]);

  useEffect(() => {
    if (!editorHandleRef) return;
    editorHandleRef.current = { insertText };
    return () => { editorHandleRef.current = null; };
  }, [editorHandleRef, insertText]);

  useLayoutEffect(() => {
    if (pendingCaretRef.current === null || !rootRef.current) return;
    restoreCaret(rootRef.current, pendingCaretRef.current);
    pendingCaretRef.current = null;
  });

  return <div
    key={domGenerationRef.current}
    ref={rootRef}
    contentEditable
    suppressContentEditableWarning
    role="textbox"
    aria-multiline="true"
    data-placeholder={placeholder}
    className={className}
    style={style}
    onMouseDown={onMouseDown}
    onMouseUp={saveSelection}
    onKeyUp={saveSelection}
    onWheel={(event) => {
      if (event.currentTarget.scrollHeight > event.currentTarget.clientHeight) {
        event.stopPropagation();
      }
    }}
    onCopy={(event) => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      const root = event.currentTarget;
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
      const scratch = document.createElement('div');
      scratch.append(range.cloneContents());
      event.preventDefault();
      event.clipboardData.setData('text/plain', serialize(scratch));
    }}
    onFocus={() => { focusedRef.current = true; onFocus?.(); }}
    onInput={(event) => {
      const root = event.currentTarget;
      const next = serialize(root);
      onChange(next);

      // Ordinary typing stays unmanaged to preserve native caret/IME behavior.
      // Re-render only when a complete raw token has just appeared/disappeared.
      const parsedTokens = parse(next).filter((part) => part.token !== undefined).map((part) => part.text);
      const renderedTokens = Array.from(root.querySelectorAll<HTMLElement>('[data-inline-token]'))
        .map((element) => element.dataset.inlineToken || '');
      const tokenShapeChanged = parsedTokens.length !== renderedTokens.length
        || parsedTokens.some((token, index) => token !== renderedTokens[index]);
      if (tokenShapeChanged) {
        const selection = window.getSelection();
        let caret = next.length;
        if (selection?.rangeCount && root.contains(selection.anchorNode)) {
          const range = selection.getRangeAt(0);
          caret = serializedOffset(root, range.endContainer, range.endOffset);
        }
        renderedValueRef.current = next;
        pendingCaretRef.current = caret;
        selectionRef.current = { start: caret, end: caret };
        rerender((n) => n + 1);
      } else {
        requestAnimationFrame(saveSelection);
      }
    }}
    onBeforeInput={(event) => {
      const inputType = (event.nativeEvent as InputEvent).inputType;
      const direction = inputType === 'deleteContentBackward' ? 'backward' : inputType === 'deleteContentForward' ? 'forward' : null;
      if (!direction) return;
      const selection = window.getSelection();
      if (!selection?.isCollapsed || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      const root = event.currentTarget;
      if (!adjacentToken(root, range.startContainer, range.startOffset, direction)) return;
      event.preventDefault();
      const current = serialize(root);
      const caret = serializedOffset(root, range.startContainer, range.startOffset);
      const at = direction === 'backward' ? caret - 1 : caret;
      commit(current.slice(0, at) + current.slice(at + 1), Math.max(0, at));
    }}
    onPaste={onPaste ?? ((event) => {
      // execCommand('insertText') writes straight into the DOM. React owns these
      // children, so a multi-line paste — where the browser splits text nodes and
      // adds its own <div>/<br> — makes the next reconcile throw "removeChild:
      // The node to be removed is not a child of this node". Go through commit()
      // like every other edit here, and let React stay the only writer.
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;
      const root = event.currentTarget;
      const current = serialize(root);
      const selection = window.getSelection();
      let start = current.length;
      let end = current.length;
      if (selection && selection.rangeCount > 0 && root.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        const a = serializedOffset(root, range.startContainer, range.startOffset);
        const b = serializedOffset(root, range.endContainer, range.endOffset);
        start = Math.min(a, b);
        end = Math.max(a, b);
      } else {
        const saved = selectionRef.current;
        start = Math.min(saved?.start ?? current.length, current.length);
        end = Math.min(saved?.end ?? start, current.length);
      }
      commit(current.slice(0, start) + text + current.slice(end), start + text.length);
    })}
    onBlur={() => {
      saveSelection();
      setTimeout(() => {
        if (document.activeElement === rootRef.current) return;
        focusedRef.current = false;
        // Writes that landed while the caret was here were refused during
        // render, to keep typing and IME composition intact. Ask for one more
        // render now that the caret is gone, and the branch at the top of this
        // component adopts them.
        rerender((n) => n + 1);
        onBlur?.();
      }, 0);
    }}
  >
    {parse(renderedValueRef.current).map((part, index) => part.token !== undefined ? (
      <span key={`${index}:${part.text}`} contentEditable={false} data-inline-token={part.text} className="inline-block">
        {renderToken(part.token, part.text)}
      </span>
    ) : <Fragment key={`${index}:${part.text}`}>{part.text}</Fragment>)}
  </div>;
}
