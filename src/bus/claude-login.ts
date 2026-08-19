/**
 * Health check for the native Claude Code CLI login credential
 * (~/.claude/.credentials.json).
 *
 * This is distinct from the accounts.json-based multi-account rotation
 * system in oauth.ts. A deployment with no accounts.json and no per-agent
 * CLAUDE_CODE_OAUTH_TOKEN (this org, as of 2026-08) authenticates every
 * agent PTY session through the OS user's shared native Claude Code login
 * instead — all agents share HOME, so they share one credentials file.
 * That shared file is what actually died in the 2026-08-12 fleet-wide
 * outage (see MEMORY.md).
 *
 * The credential has two expiries with very different risk profiles:
 * - access token (~8h): the CLI refreshes this itself on active use.
 *   Being past its expiry while idle is normal, not an incident.
 * - refresh token (~24d, rotates forward on each refresh): if this lapses,
 *   nothing programmatic can renew it — a human has to run /login. This is
 *   the credential expiry that actually causes an outage, and it gives
 *   weeks of lead time if watched.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export type ClaudeLoginStatus =
  | 'ok'
  | 'access_stale'
  | 'refresh_expiring'
  | 'refresh_expired'
  | 'not_found'
  | 'unreadable';

export interface ClaudeLoginHealth {
  status: ClaudeLoginStatus;
  access_expires_at?: string;
  access_minutes_remaining?: number;
  refresh_expires_at?: string;
  refresh_days_remaining?: number;
  subscription_type?: string;
}

// Refresh token expiring within this many days is the actionable warning —
// a human needs to run /login before it lapses.
export const REFRESH_WARN_DAYS = 5;
// Access token more than this many minutes past its own expiry with no
// refresh suggests the CLI's self-refresh is stuck, not just idle.
export const ACCESS_STALE_MINUTES = 120;

export function defaultCredentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

export function checkClaudeLoginHealth(path: string = defaultCredentialsPath()): ClaudeLoginHealth {
  if (!existsSync(path)) {
    return { status: 'not_found' };
  }

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { status: 'unreadable' };
  }

  const oauth = (data as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth;
  const expiresAt = oauth?.expiresAt;
  const refreshExpiresAt = oauth?.refreshTokenExpiresAt;
  if (typeof expiresAt !== 'number' || typeof refreshExpiresAt !== 'number') {
    return { status: 'unreadable' };
  }

  const now = Date.now();
  const accessMinutesRemaining = Math.round((expiresAt - now) / 60_000);
  const refreshDaysRemaining = Math.round((refreshExpiresAt - now) / (24 * 60 * 60 * 1000));

  const result: ClaudeLoginHealth = {
    status: 'ok',
    access_expires_at: new Date(expiresAt).toISOString(),
    access_minutes_remaining: accessMinutesRemaining,
    refresh_expires_at: new Date(refreshExpiresAt).toISOString(),
    refresh_days_remaining: refreshDaysRemaining,
  };
  if (typeof oauth?.subscriptionType === 'string') {
    result.subscription_type = oauth.subscriptionType;
  }

  if (refreshDaysRemaining <= 0) {
    result.status = 'refresh_expired';
  } else if (refreshDaysRemaining <= REFRESH_WARN_DAYS) {
    result.status = 'refresh_expiring';
  } else if (accessMinutesRemaining <= -ACCESS_STALE_MINUTES) {
    result.status = 'access_stale';
  }

  return result;
}
