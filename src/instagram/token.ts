import crypto from 'crypto';
import { env } from '../config/environment.js';
import { getSetting, setSetting } from '../db/settings.js';

/**
 * @BostonBlerds' Instagram access token. Long-lived tokens last 60 days, and Instagram lets
 * a valid one (at least 24 hours old) be exchanged for a fresh 60-day token. The bot does that
 * weekly and keeps the current token in the database. If someone pastes a new token into .env
 * by hand, the bot notices (by comparing a fingerprint) and switches to it.
 */
type TokenState = {
  token: string;
  /** Fingerprint of the .env token this state came from or last checked against. */
  envFingerprint: string;
  refreshedAt: string;
  expiresAt: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
};

const KEY = 'ig_token';
const RENEW_EVERY_MS = 7 * 24 * 3_600_000;
const fingerprint = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

let cached: TokenState | null = null;

async function state(): Promise<TokenState | null> {
  if (!env.IG_ACCESS_TOKEN) return null;
  if (cached) return cached;
  const saved = await getSetting<TokenState>(KEY);
  const envPrint = fingerprint(env.IG_ACCESS_TOKEN);
  if (saved && saved.envFingerprint === envPrint) {
    cached = saved;
  } else {
    // First run, or a new token was pasted into .env: start from the .env token.
    cached = {
      token: env.IG_ACCESS_TOKEN,
      envFingerprint: envPrint,
      refreshedAt: new Date().toISOString(),
      expiresAt: null,
      lastError: null,
      lastAttemptAt: null,
    };
    await setSetting(KEY, cached);
  }
  return cached;
}

export async function getAccessToken(): Promise<string | null> {
  return (await state())?.token ?? null;
}

/** For the dashboard: when the token expires and whether renewal is working (no token value). */
export async function tokenStatus() {
  const s = await state();
  if (!s) return { configured: false as const };
  return { configured: true as const, refreshedAt: s.refreshedAt, expiresAt: s.expiresAt, lastAttemptAt: s.lastAttemptAt, lastError: s.lastError };
}

/** Renews the token if it's been a week. Safe to call often. Never throws. */
export async function renewTokenIfDue(force = false) {
  const s = await state();
  if (!s) return;
  if (!force && Date.now() - new Date(s.refreshedAt).getTime() < RENEW_EVERY_MS && s.expiresAt) return;

  const now = new Date().toISOString();
  try {
    const url = new URL('https://graph.instagram.com/refresh_access_token');
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', s.token);
    const res = await fetch(url);
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: { message: string } };
    if (!res.ok || !body.access_token) throw new Error(body.error?.message ?? `HTTP ${res.status}`);

    cached = {
      ...s,
      token: body.access_token,
      refreshedAt: now,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null,
      lastError: null,
      lastAttemptAt: now,
    };
    await setSetting(KEY, cached);
    console.log(`Instagram token renewed; expires ${cached.expiresAt}`);
  } catch (err) {
    cached = { ...s, lastError: (err as Error).message, lastAttemptAt: now };
    await setSetting(KEY, cached);
    console.error('Instagram token renewal failed:', (err as Error).message);
  }
}
