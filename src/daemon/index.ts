import { AgentManager } from './agent-manager.js';
import { IPCServer } from './ipc-server.js';
import { redactSSN } from '../utils/ssn-redaction.js';
import { readdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';
import { resolveCanonicalCtxRoot } from '../utils/paths.js';

// Each fast-checker registers a process-level SIGUSR1 handler (see
// fast-checker.ts:102). With >10 active agents the default Node listener cap
// trips MaxListenersExceededWarning. Bump for the full fleet.
process.setMaxListeners(20);

// ---------------------------------------------------------------------------
// Crash handling: turn silent daemon deaths into attributable, observable
// events. Three responsibilities:
//   1. Write a .daemon-crashed marker per agent — hook-crash-alert.ts uses
//      this on the next session boot to emit "🚨 daemon crashed" instead of
//      the misleading "🚨 agent crashed" default.
//   2. Maintain a small crash-history JSON so we can detect crash-loops.
//   3. On ≥3 crashes in 15 min, send ONE Telegram alert to the operator chat
//      (with a 30-min cooldown). PM2's max_restarts: 10 is the final
//      circuit breaker; our alert fires before the fleet goes fully dead.
// Context: root cause of 2026-04-22 restart storm was unguarded this.pty!
// in worker-process.ts:93 — PR #196 fixed 3 sister sites but missed this
// one. The inject.ts try/catch + worker-process ?. land the structural fix;
// this module is the visibility layer.
// ---------------------------------------------------------------------------

export interface CrashEvent { ts: string; err: string; }
export interface CrashHistory { crashes: CrashEvent[]; lastAlertAt?: string; }

export const CRASH_HISTORY_MAX = 20;
export const CRASH_LOOP_WINDOW_MS = 15 * 60 * 1000;    // 15 min detection window
export const CRASH_LOOP_THRESHOLD = 3;                  // 3 crashes trips the alert
export const CRASH_LOOP_COOLDOWN_MS = 30 * 60 * 1000;   // 30 min between alerts
const TELEGRAM_SEND_TIMEOUT_MS = 3000;           // bounded — we're crashing

export function crashHistoryPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '.daemon-crash-history.json');
}

export function readCrashHistory(ctxRoot: string): CrashHistory {
  const p = crashHistoryPath(ctxRoot);
  if (!existsSync(p)) return { crashes: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as CrashHistory;
    return { crashes: parsed.crashes ?? [], lastAlertAt: parsed.lastAlertAt };
  } catch {
    return { crashes: [] };
  }
}

export function writeCrashHistory(ctxRoot: string, history: CrashHistory): void {
  try {
    ensureDir(join(ctxRoot, 'state'));
    writeFileSync(crashHistoryPath(ctxRoot), JSON.stringify(history, null, 2), 'utf-8');
  } catch {
    // disk full / permission issue — don't block exit
    console.error('[daemon] Failed to persist crash history (non-fatal)');
  }
}

export function recordCrash(ctxRoot: string, errStr: string): CrashHistory {
  const history = readCrashHistory(ctxRoot);
  history.crashes.push({ ts: new Date().toISOString(), err: errStr.slice(0, 2000) });
  if (history.crashes.length > CRASH_HISTORY_MAX) {
    history.crashes = history.crashes.slice(-CRASH_HISTORY_MAX);
  }
  writeCrashHistory(ctxRoot, history);
  return history;
}

export function shouldSendCrashLoopAlert(history: CrashHistory): boolean {
  const now = Date.now();
  const windowStart = now - CRASH_LOOP_WINDOW_MS;
  const recent = history.crashes.filter(c => Date.parse(c.ts) >= windowStart).length;
  if (recent < CRASH_LOOP_THRESHOLD) return false;
  if (history.lastAlertAt) {
    const cooldownEnd = Date.parse(history.lastAlertAt) + CRASH_LOOP_COOLDOWN_MS;
    if (now < cooldownEnd) return false;
  }
  return true;
}

export function countRecentCrashes(history: CrashHistory): number {
  const windowStart = Date.now() - CRASH_LOOP_WINDOW_MS;
  return history.crashes.filter(c => Date.parse(c.ts) >= windowStart).length;
}

export function writeDaemonCrashedMarkers(ctxRoot: string): void {
  // Scan state/ for per-agent dirs (each agent has state/<name>/ created
  // by AgentProcess). Writing here parallels the .daemon-stop marker path
  // in agent-manager.ts:stopAll — lets hook-crash-alert.ts distinguish
  // crash from planned stop. Each write is independently try/catch'd so
  // a single bad agent dir can't block the exit path.
  const stateDir = join(ctxRoot, 'state');
  if (!existsSync(stateDir)) return;
  let names: string[];
  try {
    names = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return; }
  const ts = new Date().toISOString();
  for (const name of names) {
    try {
      writeFileSync(join(stateDir, name, '.daemon-crashed'), ts, 'utf-8');
    } catch { /* swallow per-agent */ }
  }
}

export function getOperatorChatCreds(frameworkRoot: string): { chatId: string; botToken: string } | null {
  // Priority 1: explicit operator env (recommended for production).
  const envChat = process.env.CTX_OPERATOR_CHAT_ID;
  const envToken = process.env.CTX_OPERATOR_BOT_TOKEN;
  if (envChat && envToken && /^\d+:[A-Za-z0-9_-]+$/.test(envToken)) {
    return { chatId: envChat, botToken: envToken };
  }
  // Priority 2: fall back to the first agent's .env. Good enough for
  // small single-operator installs — alert still lands SOMEWHERE visible.
  try {
    const orgsRoot = join(frameworkRoot, 'orgs');
    if (!existsSync(orgsRoot)) return null;
    const orgs = readdirSync(orgsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const org of orgs) {
      const agentsRoot = join(orgsRoot, org.name, 'agents');
      if (!existsSync(agentsRoot)) continue;
      const agents = readdirSync(agentsRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        // Match agent-manager.ts discoverAgents() filter: skip _shared/ and
        // hidden dirs so operator-cred fallback never inherits creds from
        // a non-agent directory. Belt-and-suspenders against the same
        // _shared rogue-spawn class of bug.
        .filter(d => !d.name.startsWith('_') && !d.name.startsWith('.'));
      for (const a of agents) {
        const envFile = join(agentsRoot, a.name, '.env');
        if (!existsSync(envFile)) continue;
        try {
          const content = readFileSync(envFile, 'utf-8');
          const tokenMatch = content.match(/^BOT_TOKEN=(.+)$/m);
          const chatMatch = content.match(/^CHAT_ID=(.+)$/m);
          if (!tokenMatch || !chatMatch) continue;
          const botToken = tokenMatch[1].trim();
          const chatId = chatMatch[1].trim();
          if (/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
            return { chatId, botToken };
          }
        } catch { /* skip this agent */ }
      }
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Whether ANY agent has a `.env` file on disk (regardless of whether it
 * carries valid creds). Used to distinguish a fresh-install-pre-any-agent
 * state (nothing could ever back the crash-loop alert) from a configured
 * install whose creds simply didn't resolve. Mirrors getOperatorChatCreds'
 * orgs/<org>/agents/<agent> walk and the same _shared/hidden-dir filter.
 */
function anyAgentEnvExists(frameworkRoot: string): boolean {
  try {
    const orgsRoot = join(frameworkRoot, 'orgs');
    if (!existsSync(orgsRoot)) return false;
    const orgs = readdirSync(orgsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const org of orgs) {
      const agentsRoot = join(orgsRoot, org.name, 'agents');
      if (!existsSync(agentsRoot)) continue;
      const agents = readdirSync(agentsRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .filter(d => !d.name.startsWith('_') && !d.name.startsWith('.'));
      for (const a of agents) {
        if (existsSync(join(agentsRoot, a.name, '.env'))) return true;
      }
    }
  } catch { /* fall through to false */ }
  return false;
}

/**
 * Classify the daemon's ability to deliver a crash-loop alert, evaluated
 * once at startup so the operator learns about a gap WHILE they are watching
 * the boot — not buried in a stderr line 15 minutes into a crash-loop (the
 * silent-drop failure from arch-map surprise #3).
 *
 *   'ok'       — operator env creds OR a valid agent .env resolved.
 *   'degraded' — no creds resolved, but agent .env(s) exist (mid-life creds
 *                loss / invalid token). Warn loudly, keep running: breaking
 *                startup is worse than the alert gap, and the install is
 *                otherwise functional.
 *   'blind'    — no creds AND no agent .env anywhere (fresh-install pre-any-
 *                agent). The one-alert-before-fleet-dies promise is
 *                structurally impossible; hard-fail with a clear fix message
 *                rather than boot into a silent-no-alerts state.
 */
export function assessOperatorAlertReadiness(frameworkRoot: string): 'ok' | 'degraded' | 'blind' {
  if (getOperatorChatCreds(frameworkRoot)) return 'ok';
  return anyAgentEnvExists(frameworkRoot) ? 'degraded' : 'blind';
}

function sendCrashLoopAlertBestEffort(
  frameworkRoot: string,
  crashCount: number,
  errStr: string,
): boolean {
  const creds = getOperatorChatCreds(frameworkRoot);
  if (!creds) {
    console.error('[daemon] Crash-loop alert: no operator chat configured ' +
      '(set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN, or ensure at least one agent .env exists)');
    return false;
  }
  const message =
    `🚨 CRITICAL: cortextos daemon is crash-looping\n` +
    `${crashCount} crashes in 15 minutes\n` +
    `Last error: ${errStr.slice(0, 500)}\n` +
    `Next alert in 30 min if the pattern continues.`;
  try {
    const r = spawnSync('curl', [
      '-s', '--max-time', '3',
      '-X', 'POST',
      `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
      '-d', `chat_id=${creds.chatId}`,
      // Raw egress (no TelegramAPI primitive on this crash-alert path) — scrub here.
      '--data-urlencode', `text=${redactSSN(message)}`,
    ], { timeout: TELEGRAM_SEND_TIMEOUT_MS, stdio: 'pipe' });
    if (r.status === 0) {
      console.error('[daemon] Crash-loop alert sent to operator chat');
      return true;
    }
    console.error('[daemon] Crash-loop alert send failed (non-fatal)');
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Login-expiry watchdog: scan each agent's stdout.log for the Claude Code
// login-expiry countdown banner ("Your login expires in N days") and alert
// the operator once it drops to LOGIN_EXPIRY_ALERT_THRESHOLD_DAYS or fewer.
// Context: the 2026-08-12 fleet-wide 19h outage was root-caused to a shared
// Claude account session expiring silently — every agent's log had already
// printed this exact countdown banner (3 -> 2 -> 1 days) in the days before,
// completely unread. Passive post-failure log scanning can't catch the hang
// itself (confirmed: no auth-error text ever appears once a session is
// actually dead), but this banner is a free, already-present early-warning
// signal that just needs something to read it. This watchdog runs on the
// daemon's own interval, independent of any agent session, so it keeps
// working even as a fleet-wide dark period approaches.
//
// stdout.log grows continuously (appended across restarts, rotated only at
// the 50MB MAX_LOG_BYTES threshold in output-buffer.ts) while the banner
// prints just ONCE, near PTY start. A fixed-size tail scan was tried first
// and empirically failed within hours of boot — verified against live logs
// on 2026-08-16, it missed 4 of 5 agents once normal session output pushed
// the banner past a 200KB tail window. Fix: track a per-agent byte offset
// and scan only NEW bytes since the last poll, so the banner is caught
// within one poll interval of being printed regardless of file size or
// how much has accumulated since. A captured reading is treated as stale
// after LOGIN_EXPIRY_READING_TTL_MS so a stale pre-/login reading can't
// alert forever after the credential has actually been renewed (renewal
// itself may not print a fresh banner for days, since it only appears when
// close to expiry).
// ---------------------------------------------------------------------------

export const LOGIN_EXPIRY_ALERT_THRESHOLD_DAYS = 1;
export const LOGIN_EXPIRY_WATCHDOG_INTERVAL_MS = 15 * 60 * 1000;   // poll cadence
export const LOGIN_EXPIRY_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;  // re-alert cadence while still expiring soon
export const LOGIN_EXPIRY_READING_TTL_MS = 20 * 60 * 60 * 1000;    // a captured reading older than this is ignored — just under the daily restart cadence, so a renewed credential's stale "1 day" reading can't out-live the next legitimate boot

export interface LoginExpiryAgentState {
  offset: number;
  daysRemaining: number | null;
  capturedAt: string | null;
  lastAlertAt: string | null;
}

export type LoginExpiryState = Record<string, LoginExpiryAgentState>;

export function loginExpiryStatePath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '.login-expiry-watch.json');
}

export function readLoginExpiryState(ctxRoot: string): LoginExpiryState {
  const p = loginExpiryStatePath(ctxRoot);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeLoginExpiryState(ctxRoot: string, state: LoginExpiryState): void {
  try {
    ensureDir(join(ctxRoot, 'state'));
    writeFileSync(loginExpiryStatePath(ctxRoot), JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    console.error('[daemon] Failed to persist login-expiry-watch state (non-fatal)');
  }
}

/**
 * Scan the bytes of an agent's stdout.log written since `fromOffset` for the
 * Claude Code login-expiry countdown banner. Returns the new end-of-file
 * offset (to persist for next poll) and the LAST (most recent) banner
 * reading found in that new slice, or null if none appeared.
 *
 * Handles log rotation/truncation: if the current file size is smaller than
 * fromOffset (output-buffer.ts rotated stdout.log to stdout.log.1 and
 * started a fresh file), rescans from 0 instead of returning stale/negative
 * ranges.
 */
export function scanNewLoginExpiryReading(
  logPath: string,
  fromOffset: number,
): { newOffset: number; daysRemaining: number | null } {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return { newOffset: fromOffset, daysRemaining: null };
  }
  const startAt = size < fromOffset ? 0 : fromOffset;
  if (size <= startAt) return { newOffset: size, daysRemaining: null };
  try {
    const fd = readFileSync(logPath);
    const slice = fd.slice(startAt, size).toString('utf-8');
    const text = slice.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const matches = [...text.matchAll(/login expires in (\d+) days?/gi)];
    const daysRemaining = matches.length === 0
      ? null
      : Number.parseInt(matches[matches.length - 1][1], 10);
    return { newOffset: size, daysRemaining };
  } catch {
    return { newOffset: size, daysRemaining: null };
  }
}

/**
 * Advance every agent's offset by scanning new log bytes since the last
 * poll, updating captured readings in place, and returning the mutated
 * state alongside the set of agents whose CURRENT, non-stale reading is at
 * or below thresholdDays.
 */
export function pollLoginExpiryReadings(
  ctxRoot: string,
  state: LoginExpiryState,
  thresholdDays: number = LOGIN_EXPIRY_ALERT_THRESHOLD_DAYS,
  now: number = Date.now(),
): { state: LoginExpiryState; expiring: Array<{ agent: string; daysRemaining: number }> } {
  const logsDir = join(ctxRoot, 'logs');
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(logsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return { state, expiring: [] };
  }

  const expiring: Array<{ agent: string; daysRemaining: number }> = [];
  for (const agent of agentDirs) {
    const logPath = join(logsDir, agent, 'stdout.log');
    if (!existsSync(logPath)) continue;

    const prior: LoginExpiryAgentState = state[agent] ?? {
      offset: 0,
      daysRemaining: null,
      capturedAt: null,
      lastAlertAt: null,
    };
    const { newOffset, daysRemaining } = scanNewLoginExpiryReading(logPath, prior.offset);

    const next: LoginExpiryAgentState = { ...prior, offset: newOffset };
    if (daysRemaining !== null) {
      next.daysRemaining = daysRemaining;
      next.capturedAt = new Date(now).toISOString();
    }
    state[agent] = next;

    if (next.daysRemaining === null || !next.capturedAt) continue;
    const age = now - Date.parse(next.capturedAt);
    if (Number.isNaN(age) || age > LOGIN_EXPIRY_READING_TTL_MS) continue;
    if (next.daysRemaining <= thresholdDays) {
      expiring.push({ agent, daysRemaining: next.daysRemaining });
    }
  }
  return { state, expiring };
}

/**
 * Filter expiring agents down to those due a NEW alert: never alerted, or
 * past LOGIN_EXPIRY_ALERT_COOLDOWN_MS since the last one for that agent.
 * Mirrors selectAgentsToAlert's cooldown pattern from the heartbeat-staleness
 * watchdog so a persistently-expiring credential re-alerts periodically
 * instead of once-ever, without re-sending on every poll tick.
 */
export function selectLoginExpiryAgentsToAlert(
  expiring: Array<{ agent: string; daysRemaining: number }>,
  state: LoginExpiryState,
  now: number = Date.now(),
): Array<{ agent: string; daysRemaining: number }> {
  return expiring.filter(e => {
    const lastAlert = state[e.agent]?.lastAlertAt;
    if (!lastAlert) return true;
    const lastAlertMs = Date.parse(lastAlert);
    if (Number.isNaN(lastAlertMs)) return true;
    return now - lastAlertMs >= LOGIN_EXPIRY_ALERT_COOLDOWN_MS;
  });
}

function sendLoginExpiryAlertBestEffort(
  frameworkRoot: string,
  toAlert: Array<{ agent: string; daysRemaining: number }>,
): boolean {
  const creds = getOperatorChatCreds(frameworkRoot);
  if (!creds) {
    console.error('[daemon] Login-expiry alert: no operator chat configured ' +
      '(set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN, or ensure at least one agent .env exists)');
    return false;
  }
  const lines = toAlert.map(e => `  - ${e.agent}: expires in ${e.daysRemaining} day${e.daysRemaining === 1 ? '' : 's'}`);
  const message =
    `⚠️ Claude login expiring soon:\n${lines.join('\n')}\n` +
    `Run /login in any agent session to renew the shared credential before it goes dark fleet-wide.`;
  try {
    const r = spawnSync('curl', [
      '-s', '--max-time', '3',
      '-X', 'POST',
      `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
      '-d', `chat_id=${creds.chatId}`,
      '--data-urlencode', `text=${message}`,
    ], { timeout: TELEGRAM_SEND_TIMEOUT_MS, stdio: 'pipe' });
    if (r.status === 0) {
      console.error(`[daemon] Login-expiry alert sent for ${toAlert.length} agent(s)`);
      return true;
    }
    console.error('[daemon] Login-expiry alert send failed (non-fatal)');
    return false;
  } catch {
    return false;
  }
}

export function runLoginExpiryWatchdogCheck(ctxRoot: string, frameworkRoot: string): void {
  const priorState = readLoginExpiryState(ctxRoot);
  const { state, expiring } = pollLoginExpiryReadings(ctxRoot, priorState);
  // Always persist — offsets must advance even when nothing is currently
  // expiring, or the next poll would rescan already-processed bytes.
  const toAlert = expiring.length === 0 ? [] : selectLoginExpiryAgentsToAlert(expiring, state);
  if (toAlert.length > 0 && sendLoginExpiryAlertBestEffort(frameworkRoot, toAlert)) {
    const now = new Date().toISOString();
    for (const e of toAlert) state[e.agent].lastAlertAt = now;
  }
  writeLoginExpiryState(ctxRoot, state);
}

/**
 * Shared fatal-error handler for both uncaughtException and
 * unhandledRejection. Performs marker writes + crash recording + optional
 * telegram alert, then optionally exits. Stays fully synchronous so it
 * finishes before Node's default crash behavior triggers.
 */
function handleFatal(
  tag: 'uncaughtException' | 'unhandledRejection',
  err: unknown,
  ctxRoot: string,
  frameworkRoot: string,
  doExit: boolean,
): void {
  const errStr = err instanceof Error ? (err.stack || err.message) : String(err);
  console.error(`[daemon] FATAL ${tag} — exiting for PM2 respawn`);
  console.error(errStr);

  writeDaemonCrashedMarkers(ctxRoot);
  const history = recordCrash(ctxRoot, errStr);

  if (shouldSendCrashLoopAlert(history)) {
    const recent = countRecentCrashes(history);
    if (sendCrashLoopAlertBestEffort(frameworkRoot, recent, errStr)) {
      history.lastAlertAt = new Date().toISOString();
      writeCrashHistory(ctxRoot, history);
    }
  }

  if (doExit) process.exit(1);
}

/**
 * cortextOS Daemon - single process managing all agents.
 * Run via `pm2 start ecosystem.config.js` or `cortextos ecosystem && pm2 start`.
 */
class Daemon {
  private agentManager: AgentManager | null = null;
  private ipcServer: IPCServer | null = null;
  private instanceId: string;
  private ctxRoot: string;

  constructor() {
    this.instanceId = process.env.CTX_INSTANCE_ID || 'default';
    // Always derive ctxRoot from instanceId to avoid inheriting a parent cortextOS's CTX_ROOT
    this.ctxRoot = resolveCanonicalCtxRoot(this.instanceId);
  }

  async start(): Promise<void> {
    // Force restrictive default permissions for everything the daemon writes:
    // 0700 dirs, 0600 files. Belt-and-suspenders for explicit chmod calls.
    if (process.platform !== 'win32') {
      process.umask(0o077);
    }

    console.log(`[daemon] Starting cortextOS daemon (instance: ${this.instanceId})`);

    // Expose computed ctxRoot so sub-modules (crons.ts, cron-execution-log.ts)
    // that use process.env.CTX_ROOT pick up the correct path rather than
    // falling back to process.cwd() (the framework root).
    process.env.CTX_ROOT = this.ctxRoot;

    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || '';
    const org = process.env.CTX_ORG || '';

    if (!frameworkRoot) {
      console.error('[daemon] CTX_FRAMEWORK_ROOT not set');
      process.exit(1);
    }

    // Crash-loop alert readiness (arch-map surprise #3): surface a missing
    // alert destination AT STARTUP rather than silently dropping the alert to
    // stderr mid-crash-loop. Two failure modes, two responses:
    //   - 'blind' (fresh install, no creds + no agent .env): the safety net is
    //     structurally impossible — hard-fail with a fix message.
    //   - 'degraded' (creds didn't resolve but agent .env(s) exist): warn
    //     loudly and keep running; breaking startup is worse than the gap.
    const alertReadiness = assessOperatorAlertReadiness(frameworkRoot);
    if (alertReadiness === 'blind') {
      console.error(
        '\n[daemon] FATAL: no crash-loop alert destination configured and no agent .env exists.\n' +
        '  The daemon could not notify you if it crash-loops — the one-alert-before-fleet-dies\n' +
        '  safety net is structurally impossible in this state.\n' +
        '  Fix one of:\n' +
        '    • set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN in the daemon environment, or\n' +
        '    • create at least one agent with BOT_TOKEN + CHAT_ID in its .env\n' +
        '  then restart the daemon.\n',
      );
      process.exit(1);
    }
    if (alertReadiness === 'degraded') {
      console.warn(
        '\n[daemon] WARNING: no operator alert destination resolved.\n' +
        '  Crash-loop alerts will be UNDELIVERABLE until CTX_OPERATOR_CHAT_ID +\n' +
        '  CTX_OPERATOR_BOT_TOKEN are set, or an agent .env carries a valid\n' +
        '  BOT_TOKEN + CHAT_ID. Daemon continues; agent operation is unaffected.\n',
      );
    }

    // Write PID file
    const pidFile = join(this.ctxRoot, 'daemon.pid');
    ensureDir(this.ctxRoot);
    writeFileSync(pidFile, String(process.pid), 'utf-8');
    if (process.platform !== 'win32') {
      try {
        chmodSync(pidFile, 0o600);
      } catch { /* best effort */ }
    }

    // Create agent manager
    this.agentManager = new AgentManager(this.instanceId, this.ctxRoot, frameworkRoot, org);

    // F2 fix: register shutdown-signal + fatal-error handlers BEFORE any boot
    // work (IPC server start + serial multi-agent discoverAndStart, which can
    // take minutes). A SIGTERM or crash arriving DURING boot must still run
    // stopAll() and write crash markers — otherwise every already-started
    // agent's SessionEnd hook fires a false CRASH alert and no crash history
    // is recorded. The handlers only need ctxRoot/frameworkRoot/pidFile
    // (all available here) and null-check agentManager/ipcServer, so early
    // registration is safe.

    // Handle shutdown signals
    const shutdown = async () => {
      console.log('[daemon] Shutting down...');
      try {
        if (this.agentManager) {
          await this.agentManager.stopAll();
        }
      } catch (err) {
        console.error('[daemon] Error during shutdown:', err);
      }
      if (this.ipcServer) {
        this.ipcServer.stop();
      }
      // Clean up PID file
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(pidFile);
      } catch { /* ignore */ }
      process.exit(0);
    };

    // BUG-003 fix: re-entrancy guard. A second SIGTERM arriving while
    // shutdown() is in flight would start a parallel stopAll(), causing
    // unpredictable signal cascades across child PTY processes.
    let shuttingDown = false;
    const handleSignal = () => {
      if (shuttingDown) {
        console.log('[daemon] Shutdown already in progress, ignoring signal');
        return;
      }
      shuttingDown = true;
      shutdown().catch((err) => {
        console.error('[daemon] Fatal shutdown error:', err);
        process.exit(1);
      });
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);

    // Global fatal-error handlers. uncaughtException exits for PM2 respawn.
    // unhandledRejection logs + records but does not exit (rejected promises
    // shouldn't be fatal by default; matches Node 15+ behavior without
    // adopting the new strict default). Both paths write .daemon-crashed
    // markers and increment the crash-loop counter.
    const ctxRootForHandler = this.ctxRoot;
    const frameworkRootForHandler = frameworkRoot;
    process.on('uncaughtException', (err) => {
      handleFatal('uncaughtException', err, ctxRootForHandler, frameworkRootForHandler, true);
    });
    process.on('unhandledRejection', (reason) => {
      handleFatal('unhandledRejection', reason, ctxRootForHandler, frameworkRootForHandler, false);
    });
    console.log('[daemon] Fatal-error handlers registered (uncaughtException + unhandledRejection)');

    // Debug-only: SIGUSR2 induces a controlled uncaughtException for
    // live crash-path verification. Off in production unless
    // CTX_DEBUG_ALLOW_CRASH_TRIGGER=1 is explicitly set. See docs/debugging.md.
    if (process.env.CTX_DEBUG_ALLOW_CRASH_TRIGGER === '1') {
      process.on('SIGUSR2', () => {
        console.error('[daemon] SIGUSR2 received — inducing test crash (CTX_DEBUG_ALLOW_CRASH_TRIGGER=1)');
        throw new Error('Simulated daemon crash via SIGUSR2 (test harness)');
      });
      console.log('[daemon] SIGUSR2 crash trigger ENABLED (debug mode)');
    }

    // Fallback cleanup on exit (belt-and-suspenders for Windows)
    process.on('exit', () => {
      if (this.ipcServer) {
        this.ipcServer.stop();
      }
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(pidFile);
      } catch { /* ignore */ }
    });

    // --- Boot work begins only AFTER all handlers above are installed (F2) ---

    // Start IPC server
    this.ipcServer = new IPCServer(this.agentManager, this.instanceId);
    await this.ipcServer.start();

    // Discover and start agents
    await this.agentManager.discoverAndStart();

    // Login-expiry watchdog: runs on the daemon's own interval, scanning each
    // agent's stdout.log for the pre-expiry countdown banner and the reactive
    // confirmed-dead "Login expired" line. See runLoginExpiryWatchdogCheck.
    const ctxRootForLoginWatchdog = this.ctxRoot;
    const frameworkRootForLoginWatchdog = frameworkRoot;
    setInterval(() => {
      try {
        runLoginExpiryWatchdogCheck(ctxRootForLoginWatchdog, frameworkRootForLoginWatchdog);
      } catch (err) {
        console.error('[daemon] Login-expiry watchdog check failed (non-fatal):', err);
      }
    }, LOGIN_EXPIRY_WATCHDOG_INTERVAL_MS);

    console.log(`[daemon] Running (pid: ${process.pid})`);
  }
}

// Only auto-start when run directly (e.g. `node dist/daemon.js` or via PM2).
// Guarding with require.main prevents accidental daemon spawn when the module
// is require()'d for testing or class imports — which would start a full daemon
// with TelegramPollers, IPC server, and Claude PTY processes as a side effect.
// See: https://github.com/grandamenium/cortextos/issues/44
if (require.main === module) {
  const daemon = new Daemon();
  daemon.start().catch(err => {
    console.error('[daemon] Fatal error:', err);
    process.exit(1);
  });
}
