import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkClaudeLoginHealth,
  REFRESH_WARN_DAYS,
  ACCESS_STALE_MINUTES,
} from '../../../src/bus/claude-login.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function writeCredentials(path: string, overrides: Record<string, unknown> = {}) {
  const payload = {
    claudeAiOauth: {
      accessToken: 'redacted-access',
      refreshToken: 'redacted-refresh',
      expiresAt: Date.now() + 4 * 60 * 60 * 1000, // 4h out
      refreshTokenExpiresAt: Date.now() + 24 * DAY_MS,
      rateLimitTier: 'default_claude_max_5x',
      subscriptionType: 'max',
      scopes: ['user:inference'],
      ...overrides,
    },
  };
  writeFileSync(path, JSON.stringify(payload), 'utf-8');
}

describe('checkClaudeLoginHealth', () => {
  let testDir: string;
  let credPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-claude-login-test-'));
    mkdirSync(join(testDir, '.claude'), { recursive: true });
    credPath = join(testDir, '.claude', '.credentials.json');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns not_found when the credentials file does not exist', () => {
    const result = checkClaudeLoginHealth(join(testDir, '.claude', 'missing.json'));
    expect(result.status).toBe('not_found');
  });

  it('returns unreadable on invalid JSON', () => {
    writeFileSync(credPath, '{not json', 'utf-8');
    const result = checkClaudeLoginHealth(credPath);
    expect(result.status).toBe('unreadable');
  });

  it('returns unreadable when claudeAiOauth or expiry fields are missing', () => {
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { subscriptionType: 'max' } }), 'utf-8');
    const result = checkClaudeLoginHealth(credPath);
    expect(result.status).toBe('unreadable');
  });

  it('returns ok when both tokens have healthy time remaining', () => {
    writeCredentials(credPath);
    const result = checkClaudeLoginHealth(credPath);
    expect(result.status).toBe('ok');
    expect(result.access_minutes_remaining).toBeGreaterThan(0);
    expect(result.refresh_days_remaining).toBeGreaterThan(REFRESH_WARN_DAYS);
    expect(result.subscription_type).toBe('max');
  });

  it('returns ok when access token is expired but refresh is nowhere near due (self-heals)', () => {
    writeCredentials(credPath, { expiresAt: Date.now() - 10 * 60 * 1000 }); // 10 min past expiry
    const result = checkClaudeLoginHealth(credPath);
    expect(result.status).toBe('ok');
  });

  it('flags access_stale when the access token has been dead well past the grace window', () => {
    writeCredentials(credPath, { expiresAt: Date.now() - (ACCESS_STALE_MINUTES + 30) * 60 * 1000 });
    const result = checkClaudeLoginHealth(credPath);
    expect(result.status).toBe('access_stale');
  });

  it('flags refresh_expiring when the refresh token is within the warn window', () => {
    writeCredentials(credPath, { refreshTokenExpiresAt: Date.now() + (REFRESH_WARN_DAYS - 1) * DAY_MS });
    const result = checkClaudeLoginHealth(credPath);
    expect(result.status).toBe('refresh_expiring');
  });

  it('flags refresh_expired when the refresh token has already lapsed', () => {
    writeCredentials(credPath, { refreshTokenExpiresAt: Date.now() - DAY_MS });
    const result = checkClaudeLoginHealth(credPath);
    expect(result.status).toBe('refresh_expired');
  });

  it('prioritizes refresh_expired over access_stale when both conditions are true', () => {
    writeCredentials(credPath, {
      expiresAt: Date.now() - (ACCESS_STALE_MINUTES + 30) * 60 * 1000,
      refreshTokenExpiresAt: Date.now() - DAY_MS,
    });
    const result = checkClaudeLoginHealth(credPath);
    expect(result.status).toBe('refresh_expired');
  });

  it('never includes accessToken or refreshToken values in the result', () => {
    writeCredentials(credPath);
    const result = checkClaudeLoginHealth(credPath);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('redacted-access');
    expect(serialized).not.toContain('redacted-refresh');
  });
});
