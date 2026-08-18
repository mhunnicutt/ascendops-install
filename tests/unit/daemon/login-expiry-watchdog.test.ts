import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  scanNewLoginExpiryReading,
  pollLoginExpiryReadings,
  selectLoginExpiryAgentsToAlert,
  selectLoginExpiredAgentsToAlert,
  readLoginExpiryState,
  writeLoginExpiryState,
  loginExpiryStatePath,
  LOGIN_EXPIRY_ALERT_COOLDOWN_MS,
  LOGIN_EXPIRY_READING_TTL_MS,
  LOGIN_EXPIRED_ALERT_COOLDOWN_MS,
  LoginExpiryState,
} from '../../../src/daemon/index';

// Regression guard for the 2026-08-12 incident: a shared Claude account auth
// expiry silently hung every agent session at once. Each agent's session had
// already printed a "login expires in N days" countdown banner (3 -> 2 -> 1)
// in the days before, completely unread — that's the proactive signal this
// watchdog reads out of each agent's stdout.log on the daemon's own
// interval, independent of any agent session.
//
// It also reads a second, reactive signal: "Login expired · Please run
// /login", the line Claude Code prints when a cron/message injects into an
// already-dead session. Confirmed 2026-08-18 against the real incident-
// window logs that this line appears reliably (378/68/42/32 occurrences
// across the four affected agents, all inside the incident window, zero on
// the unaffected agent) — a prior version of this watchdog (2026-08-16)
// assumed no such post-death signal existed and shipped countdown-only.

function mkCtxRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortextos-loginwatch-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function writeLog(ctxRoot: string, agent: string, content: string): string {
  const dir = join(ctxRoot, 'logs', agent);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'stdout.log');
  writeFileSync(p, content, 'utf-8');
  return p;
}

const bannerLine = (days: number) =>
  `\x1b[38;5;220m⚠\x1b[4GYour login expires in ${days} day${days === 1 ? '' : 's'}\x1b[38;5;246m · run /login to renew`;

// Matches the real Claude Code CLI response line verbatim (confirmed against
// live production stdout.log during the 2026-08-12 incident window).
const expiredLine = () => `\x1b[38;5;231m●\x1b[39m Login expired · Please run /login`;

describe('scanNewLoginExpiryReading', () => {
  let ctxRoot: string;
  beforeEach(() => { ctxRoot = mkCtxRoot(); });
  afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); });

  it('returns null when the log has no banner', () => {
    const p = writeLog(ctxRoot, 'anna', 'just some normal session output\n');
    const r = scanNewLoginExpiryReading(p, 0);
    expect(r.daysRemaining).toBeNull();
    expect(r.newOffset).toBeGreaterThan(0);
  });

  it('finds a banner and strips ANSI codes', () => {
    const p = writeLog(ctxRoot, 'anna', bannerLine(3) + '\n');
    const r = scanNewLoginExpiryReading(p, 0);
    expect(r.daysRemaining).toBe(3);
  });

  it('returns the LAST match when multiple banners appear in the new slice', () => {
    const content = bannerLine(3) + '\n' + 'other output\n' + bannerLine(1) + '\n';
    const p = writeLog(ctxRoot, 'anna', content);
    const r = scanNewLoginExpiryReading(p, 0);
    expect(r.daysRemaining).toBe(1);
  });

  it('only scans bytes after fromOffset, ignoring an old banner already consumed', () => {
    const p = writeLog(ctxRoot, 'anna', bannerLine(3) + '\n');
    const firstOffset = scanNewLoginExpiryReading(p, 0).newOffset;
    appendFileSync(p, 'no banner in this new chunk\n');
    const r = scanNewLoginExpiryReading(p, firstOffset);
    expect(r.daysRemaining).toBeNull();
    expect(r.newOffset).toBeGreaterThan(firstOffset);
  });

  it('detects a fresh banner appended after the prior offset', () => {
    const p = writeLog(ctxRoot, 'anna', 'boot output\n');
    const firstOffset = scanNewLoginExpiryReading(p, 0).newOffset;
    appendFileSync(p, bannerLine(1) + '\n');
    const r = scanNewLoginExpiryReading(p, firstOffset);
    expect(r.daysRemaining).toBe(1);
  });

  it('rescans from 0 when the file has shrunk below fromOffset (rotation)', () => {
    const p = writeLog(ctxRoot, 'anna', 'a'.repeat(500));
    const rotated = writeLog(ctxRoot, 'anna', bannerLine(2) + '\n');
    const r = scanNewLoginExpiryReading(rotated, 500);
    expect(r.daysRemaining).toBe(2);
  });

  it('returns newOffset unchanged with null reading when file is missing', () => {
    const r = scanNewLoginExpiryReading(join(ctxRoot, 'logs', 'ghost', 'stdout.log'), 42);
    expect(r).toEqual({ newOffset: 42, daysRemaining: null, loginExpiredDetected: false });
  });

  it('detects the reactive "Login expired" line', () => {
    const p = writeLog(ctxRoot, 'anna', expiredLine() + '\n');
    const r = scanNewLoginExpiryReading(p, 0);
    expect(r.loginExpiredDetected).toBe(true);
  });

  it('does not flag loginExpiredDetected when the line is absent', () => {
    const p = writeLog(ctxRoot, 'anna', 'just some normal session output\n');
    const r = scanNewLoginExpiryReading(p, 0);
    expect(r.loginExpiredDetected).toBe(false);
  });

  it('only detects the expired line within the new bytes, not an old one already consumed', () => {
    const p = writeLog(ctxRoot, 'anna', expiredLine() + '\n');
    const firstOffset = scanNewLoginExpiryReading(p, 0).newOffset;
    appendFileSync(p, 'normal output, session recovered\n');
    const r = scanNewLoginExpiryReading(p, firstOffset);
    expect(r.loginExpiredDetected).toBe(false);
  });

  it('detects both the countdown banner and the expired line in the same slice', () => {
    const content = bannerLine(1) + '\n' + expiredLine() + '\n';
    const p = writeLog(ctxRoot, 'anna', content);
    const r = scanNewLoginExpiryReading(p, 0);
    expect(r.daysRemaining).toBe(1);
    expect(r.loginExpiredDetected).toBe(true);
  });
});

describe('pollLoginExpiryReadings', () => {
  let ctxRoot: string;
  const now = Date.now();
  beforeEach(() => { ctxRoot = mkCtxRoot(); });
  afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); });

  it('returns no expiring agents when logs dir is empty', () => {
    const r = pollLoginExpiryReadings(ctxRoot, {}, 1, now);
    expect(r.expiring).toEqual([]);
  });

  it('flags an agent whose banner is at or below the threshold', () => {
    writeLog(ctxRoot, 'anna', bannerLine(1) + '\n');
    const r = pollLoginExpiryReadings(ctxRoot, {}, 1, now);
    expect(r.expiring).toEqual([{ agent: 'anna', daysRemaining: 1 }]);
  });

  it('does not flag an agent whose banner is above the threshold', () => {
    writeLog(ctxRoot, 'anna', bannerLine(5) + '\n');
    const r = pollLoginExpiryReadings(ctxRoot, {}, 1, now);
    expect(r.expiring).toEqual([]);
  });

  it('carries a captured reading forward across polls with no new banner', () => {
    writeLog(ctxRoot, 'anna', bannerLine(1) + '\n');
    const r1 = pollLoginExpiryReadings(ctxRoot, {}, 1, now);
    appendFileSync(join(ctxRoot, 'logs', 'anna', 'stdout.log'), 'unrelated output\n');
    const r2 = pollLoginExpiryReadings(ctxRoot, r1.state, 1, now + 60_000);
    expect(r2.expiring).toEqual([{ agent: 'anna', daysRemaining: 1 }]);
  });

  it('excludes a captured reading older than the TTL', () => {
    writeLog(ctxRoot, 'anna', bannerLine(1) + '\n');
    const r1 = pollLoginExpiryReadings(ctxRoot, {}, 1, now);
    const stalePoll = now + LOGIN_EXPIRY_READING_TTL_MS + 60_000;
    appendFileSync(join(ctxRoot, 'logs', 'anna', 'stdout.log'), 'unrelated output\n');
    const r2 = pollLoginExpiryReadings(ctxRoot, r1.state, 1, stalePoll);
    expect(r2.expiring).toEqual([]);
  });

  it('reports multiple expiring agents independently of a healthy one', () => {
    writeLog(ctxRoot, 'expiring-1', bannerLine(1) + '\n');
    writeLog(ctxRoot, 'expiring-2', bannerLine(1) + '\n');
    writeLog(ctxRoot, 'healthy', 'no banner here\n');
    const r = pollLoginExpiryReadings(ctxRoot, {}, 1, now);
    expect(r.expiring.map(e => e.agent).sort()).toEqual(['expiring-1', 'expiring-2']);
  });

  it('skips an agent log dir with no stdout.log at all', () => {
    mkdirSync(join(ctxRoot, 'logs', 'never-booted'), { recursive: true });
    expect(() => pollLoginExpiryReadings(ctxRoot, {}, 1, now)).not.toThrow();
    expect(pollLoginExpiryReadings(ctxRoot, {}, 1, now).expiring).toEqual([]);
  });

  it('reports an agent whose new slice contains the reactive expired line', () => {
    writeLog(ctxRoot, 'anna', expiredLine() + '\n');
    const r = pollLoginExpiryReadings(ctxRoot, {}, 1, now);
    expect(r.expired).toEqual(['anna']);
  });

  it('does not carry an expired detection forward once the triggering bytes are consumed', () => {
    writeLog(ctxRoot, 'anna', expiredLine() + '\n');
    const r1 = pollLoginExpiryReadings(ctxRoot, {}, 1, now);
    expect(r1.expired).toEqual(['anna']);
    appendFileSync(join(ctxRoot, 'logs', 'anna', 'stdout.log'), 'normal output\n');
    const r2 = pollLoginExpiryReadings(ctxRoot, r1.state, 1, now + 60_000);
    expect(r2.expired).toEqual([]);
  });

  it('reports expiring and expired independently — a countdown banner alone is not an expired detection', () => {
    writeLog(ctxRoot, 'anna', bannerLine(1) + '\n');
    const r = pollLoginExpiryReadings(ctxRoot, {}, 1, now);
    expect(r.expiring).toEqual([{ agent: 'anna', daysRemaining: 1 }]);
    expect(r.expired).toEqual([]);
  });
});

describe('login-expiry state persistence', () => {
  let ctxRoot: string;
  beforeEach(() => { ctxRoot = mkCtxRoot(); });
  afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); });

  it('returns empty object when no state file exists', () => {
    expect(readLoginExpiryState(ctxRoot)).toEqual({});
  });

  it('returns empty object on corrupt state file', () => {
    writeFileSync(loginExpiryStatePath(ctxRoot), 'not valid json{{{', 'utf-8');
    expect(readLoginExpiryState(ctxRoot)).toEqual({});
  });

  it('round-trips write -> read', () => {
    const state: LoginExpiryState = {
      anna: { offset: 100, daysRemaining: 1, capturedAt: '2026-08-16T10:00:00.000Z', lastAlertAt: null, lastExpiredAlertAt: null },
    };
    writeLoginExpiryState(ctxRoot, state);
    expect(readLoginExpiryState(ctxRoot)).toEqual(state);
  });
});

describe('selectLoginExpiryAgentsToAlert', () => {
  const now = Date.now();
  const mk = (agent: string, daysRemaining = 1) => ({ agent, daysRemaining });
  const stateWith = (agent: string, lastAlertAt: string | null): LoginExpiryState => ({
    [agent]: { offset: 0, daysRemaining: 1, capturedAt: null, lastAlertAt, lastExpiredAlertAt: null },
  });

  it('includes an agent never alerted before', () => {
    const result = selectLoginExpiryAgentsToAlert([mk('anna')], {}, now);
    expect(result.map(e => e.agent)).toEqual(['anna']);
  });

  it('excludes an agent alerted recently (inside cooldown)', () => {
    const state = stateWith('anna', new Date(now - 60 * 60 * 1000).toISOString()); // 1h ago
    const result = selectLoginExpiryAgentsToAlert([mk('anna')], state, now);
    expect(result).toEqual([]);
  });

  it('includes an agent again once the cooldown has elapsed', () => {
    const state = stateWith('anna', new Date(now - LOGIN_EXPIRY_ALERT_COOLDOWN_MS - 60_000).toISOString());
    const result = selectLoginExpiryAgentsToAlert([mk('anna')], state, now);
    expect(result.map(e => e.agent)).toEqual(['anna']);
  });

  it('treats an unparseable prior alert timestamp as never-alerted', () => {
    const state = stateWith('anna', 'garbage-timestamp');
    const result = selectLoginExpiryAgentsToAlert([mk('anna')], state, now);
    expect(result.map(e => e.agent)).toEqual(['anna']);
  });

  it('evaluates each expiring agent independently', () => {
    const state: LoginExpiryState = {
      ...stateWith('anna', new Date(now - 60 * 60 * 1000).toISOString()), // cooling down
      reni: { offset: 0, daysRemaining: 1, capturedAt: null, lastAlertAt: null, lastExpiredAlertAt: null },
    };
    const result = selectLoginExpiryAgentsToAlert([mk('anna'), mk('reni')], state, now);
    expect(result.map(e => e.agent)).toEqual(['reni']);
  });
});

describe('selectLoginExpiredAgentsToAlert', () => {
  const now = Date.now();
  const stateWith = (agent: string, lastExpiredAlertAt: string | null): LoginExpiryState => ({
    [agent]: { offset: 0, daysRemaining: null, capturedAt: null, lastAlertAt: null, lastExpiredAlertAt },
  });

  it('includes an agent never alerted before', () => {
    const result = selectLoginExpiredAgentsToAlert(['anna'], {}, now);
    expect(result).toEqual(['anna']);
  });

  it('excludes an agent alerted recently (inside the shorter expired cooldown)', () => {
    const state = stateWith('anna', new Date(now - 10 * 60 * 1000).toISOString()); // 10m ago
    const result = selectLoginExpiredAgentsToAlert(['anna'], state, now);
    expect(result).toEqual([]);
  });

  it('includes an agent again once the expired cooldown has elapsed', () => {
    const state = stateWith('anna', new Date(now - LOGIN_EXPIRED_ALERT_COOLDOWN_MS - 60_000).toISOString());
    const result = selectLoginExpiredAgentsToAlert(['anna'], state, now);
    expect(result).toEqual(['anna']);
  });

  it('treats an unparseable prior alert timestamp as never-alerted', () => {
    const state = stateWith('anna', 'garbage-timestamp');
    const result = selectLoginExpiredAgentsToAlert(['anna'], state, now);
    expect(result).toEqual(['anna']);
  });

  it('uses a separate cooldown from the countdown-banner alert — recent countdown alert does not suppress an expired alert', () => {
    const state: LoginExpiryState = {
      anna: { offset: 0, daysRemaining: 1, capturedAt: null, lastAlertAt: new Date(now - 60 * 1000).toISOString(), lastExpiredAlertAt: null },
    };
    const result = selectLoginExpiredAgentsToAlert(['anna'], state, now);
    expect(result).toEqual(['anna']);
  });
});
