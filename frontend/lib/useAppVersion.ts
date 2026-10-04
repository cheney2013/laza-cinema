'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export type AppVersion = { name: string; version: string; commit: string };

let pending: Promise<AppVersion | null> | null = null;

/** The backend's name / version / commit, fetched once per page load; null while loading or with an older backend. */
export function useAppVersion(): AppVersion | null {
  const [info, setInfo] = useState<AppVersion | null>(null);
  useEffect(() => {
    let live = true;
    if (!pending) pending = api.getVersion().catch(() => { pending = null; return null; });
    pending.then((v) => { if (live) setInfo(v); });
    return () => { live = false; };
  }, []);
  return info;
}

/** "v1.2.0" and a tooltip with the commit, for the places that show the version. */
export function versionLabel(info: AppVersion | null): { text: string; title: string } | null {
  if (!info) return null;
  return { text: `v${info.version}`, title: `${info.name} v${info.version}${info.commit ? ` · ${info.commit}` : ''}` };
}
