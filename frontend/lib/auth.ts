'use client';

/**
 * The signed-in account, cached in localStorage so the next visit skips the
 * login screen.
 *
 * The cache is the whole point of the feature, so it is read synchronously on
 * the first render and trusted: the gate lets you straight into the canvas and
 * asks the backend afterwards whether the token is still good. A token that has
 * expired or was logged out elsewhere comes back `user: null` and the session
 * is cleared then -- a second of canvas is a better cost than a login flash on
 * every reload.
 *
 * `api.ts` reads the same session for `X-User-Id`, so an account's projects
 * follow it between browsers instead of being tied to one localStorage UUID.
 */

import { BACKEND_URL } from './config';
import { t } from './i18n';

export interface Account {
  id: string;
  username: string;
  created?: number | null;
  /** Admins also see the asset library's unattributable files -- see accounts.py. */
  is_admin?: boolean;
}

export interface Session {
  token: string;
  user: Account;
}

const STORAGE_KEY = 'ai_cinema_session';
const CHANGE_EVENT = 'ai-cinema-auth-change';

let cached: Session | null | undefined;

function read(): Session | null {
  if (typeof window === 'undefined') return null;
  if (cached !== undefined) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    cached = parsed?.token && parsed?.user?.id ? (parsed as Session) : null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Browser-side canvas state that belongs to one account. Stored under a key
 * with the account id in it, so a second account signing in on this browser
 * never reads the first one's nodes, viewport or last-opened project.
 */
const ACCOUNT_SCOPED_KEYS = ['cinima-nodes', 'cinima-edges', 'cinima-viewport', 'ai_cinema_last_project_id'];

export function userScopedKey(base: string): string {
  return `${base}:${read()?.user.id ?? 'anon'}`;
}

/**
 * The studio keeps the open project in the zustand store and in module
 * globals (api.ts), none of which know about accounts. When the account
 * changes -- log out, log in as someone else, a token cleared by revalidate,
 * or any of these in another tab -- reloading is the one reset that reaches
 * all of them, so nobody inherits the previous account's canvas.
 */
function reloadIfAccountChanged(before: string | null, after: string | null) {
  if (before === after) return;
  try {
    // Unscoped copies from before accounts could hold anyone's canvas.
    for (const key of ACCOUNT_SCOPED_KEYS) localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  window.location.reload();
}

function write(session: Session | null) {
  const before = read()?.user.id ?? null;
  cached = session;
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode / storage full: the session still works for this tab.
  }
  // Same tab: React subscribers. Other tabs get the native `storage` event.
  window.dispatchEvent(new Event(CHANGE_EVENT));
  reloadIfAccountChanged(before, session?.user.id ?? null);
}

export function getSession(): Session | null {
  return read();
}

export function getAuthToken(): string | null {
  return read()?.token ?? null;
}

export function subscribeAuth(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      const before = cached?.user.id ?? null;
      cached = undefined;
      cb();
      reloadIfAccountChanged(before, read()?.user.id ?? null);
    }
  };
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener('storage', onStorage);
  };
}

async function post(path: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.detail === 'string' ? data.detail : t('请求失败，请稍后再试'));
  }
  return data;
}

export async function login(username: string, password: string): Promise<Session> {
  const data = await post('/auth/login', { username, password });
  const session: Session = { token: data.token, user: data.user };
  write(session);
  return session;
}

export async function register(username: string, password: string): Promise<Session> {
  const data = await post('/auth/register', { username, password });
  const session: Session = { token: data.token, user: data.user };
  write(session);
  return session;
}

/**
 * The backend said the token is no longer good (401). Drop the session so the
 * login screen comes back, instead of carrying on as nobody.
 */
export function expireSession(): void {
  if (read()) write(null);
}

export async function logout(): Promise<void> {
  const token = getAuthToken();
  write(null);
  // The local session is already gone; the server call is best-effort so a
  // backend that is down cannot trap someone in an account.
  if (token) {
    try {
      await post('/auth/logout', undefined, token);
    } catch {
      /* ignore */
    }
  }
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await post('/auth/password', { old_password: oldPassword, new_password: newPassword },
    getAuthToken());
}

/**
 * Ask the backend whether the cached token is still valid, and refresh the
 * stored username. Returns false when the session was cleared as a result.
 * A network error leaves the session alone -- an offline backend is not proof
 * that a token is bad.
 */
export async function revalidate(): Promise<boolean> {
  const token = getAuthToken();
  if (!token) return false;
  try {
    const res = await fetch(`${BACKEND_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return true;
    const data = await res.json();
    if (!data.user) {
      write(null);
      return false;
    }
    write({ token, user: data.user });
    return true;
  } catch {
    return true;
  }
}
