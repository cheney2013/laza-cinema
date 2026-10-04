'use client';

import { useEffect, useState } from 'react';
import { loadMachineProfile } from '@/lib/api';

const NONE: ReadonlySet<string> = new Set();

/** Node types the backend's machine profile says this box cannot run (16 GB cards). */
export function useDisabledNodeTypes(): ReadonlySet<string> {
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(NONE);
  useEffect(() => {
    let live = true;
    loadMachineProfile().then((p) => {
      if (live && p?.disabled_node_types?.length) setDisabled(new Set(p.disabled_node_types));
    });
    return () => { live = false; };
  }, []);
  return disabled;
}

/** True when this machine's profile refuses the H3 latent enhance (it loads a 21 GB base). */
export function useLatentUpscaleDisabled(): boolean {
  const [disabled, setDisabled] = useState(false);
  useEffect(() => {
    let live = true;
    loadMachineProfile().then((p) => {
      if (live) setDisabled(Boolean(p?.disabled_upscale_methods?.includes('h3_latent')));
    });
    return () => { live = false; };
  }, []);
  return disabled;
}
