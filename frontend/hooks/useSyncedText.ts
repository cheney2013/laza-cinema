'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Local editor state for a text field that other writers also change.
 *
 * Every prompt editor kept a `useState(data.prompt)` seeded once at mount. The
 * studio does pull the canvas from the backend every 3 s, so an MCP write
 * (prompt_file, replace_in_node_text) reached `data.prompt` — but never the
 * editor, which went on showing the text from when the card mounted. Worse, its
 * blur handler wrote that stale text back over the node (2026-09-06: a node
 * carried a prompt that had been replaced twice while the card still read
 * "television murmurs"). The canvas is the record; the editor must follow it.
 *
 * Rule: when the store value changes to something other than what this editor
 * last saw, adopt it. The user's own keystrokes round-trip through the store
 * and come back equal, so typing is untouched.
 */
export function useSyncedText(external: string): [string, (value: string) => void] {
  const [local, setLocal] = useState(external);
  const lastExternal = useRef(external);
  useEffect(() => {
    if (external !== lastExternal.current) {
      lastExternal.current = external;
      setLocal(external);
    }
  }, [external]);
  return [local, setLocal];
}
