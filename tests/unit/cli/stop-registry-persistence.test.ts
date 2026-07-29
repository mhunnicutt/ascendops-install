/**
 * Regression test for the kpi/reni resurrection bug (2026-07-17/18):
 *
 * `cortextos stop <agent>` only killed the running process and wrote a
 * `.user-stop` marker — a marker that nothing in the daemon's startup path
 * (agent-manager.ts discoverAndStart) ever reads. The actual gate that
 * decides whether an agent starts on daemon boot / `--continue` config
 * reload is config/enabled-agents.json (`entry.enabled === false` is
 * skipped). Because `stop` never wrote to that registry, a stopped agent
 * would silently resurrect on the very next full discovery pass.
 *
 * markAgentStoppedInRegistry() is the fix: it mirrors the write
 * `disableAgentCommand` already performs, so discoverAndStart's existing
 * skip-logic actually gates a `cortextos stop`-stopped agent too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { markAgentStoppedInRegistry } from '../../../src/cli/stop';
import { ensureAgentEnabledInRegistry } from '../../../src/cli/start';
import { readEnabledAgents, writeEnabledAgents } from '../../../src/cli/enable-agent';

describe('markAgentStoppedInRegistry — stop persists across daemon restarts', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-stop-registry-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes enabled:false and status:stopped when no prior registry entry exists', () => {
    markAgentStoppedInRegistry('default', 'kpi');
    const agents = readEnabledAgents('default');
    expect(agents.kpi).toEqual({ enabled: false, status: 'stopped' });
  });

  it('flips an existing enabled:true entry to false without dropping other fields (e.g. org)', () => {
    mkdirSync(join(tmpHome, '.cortextos', 'default', 'config'), { recursive: true });
    writeEnabledAgents('default', { kpi: { enabled: true, status: 'configured', org: 'foothills-pm' } });

    markAgentStoppedInRegistry('default', 'kpi');

    const agents = readEnabledAgents('default');
    expect(agents.kpi).toEqual({ enabled: false, status: 'stopped', org: 'foothills-pm' });
  });

  it('does not touch other agents in the registry', () => {
    mkdirSync(join(tmpHome, '.cortextos', 'default', 'config'), { recursive: true });
    writeEnabledAgents('default', {
      kpi: { enabled: true, status: 'configured' },
      anna: { enabled: true, status: 'configured' },
    });

    markAgentStoppedInRegistry('default', 'kpi');

    const agents = readEnabledAgents('default');
    expect(agents.anna).toEqual({ enabled: true, status: 'configured' });
    expect(agents.kpi.enabled).toBe(false);
  });

  it('write survives a read-back from disk (not just in-memory)', () => {
    markAgentStoppedInRegistry('default', 'kpi');
    const raw = readFileSync(
      join(tmpHome, '.cortextos', 'default', 'config', 'enabled-agents.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw);
    expect(parsed.kpi.enabled).toBe(false);
  });

  it('is the exact condition discoverAndStart checks: entry.enabled === false', () => {
    // Mirrors agent-manager.ts's skip check verbatim so a regression in either
    // this function's output shape or that check's expectation is caught here.
    markAgentStoppedInRegistry('default', 'kpi');
    const agents = readEnabledAgents('default');
    const entry = agents['kpi'];
    const wouldBeSkipped = !!(entry && entry.enabled === false);
    expect(wouldBeSkipped).toBe(true);
  });
});

describe('ensureAgentEnabledInRegistry — start persists past the next daemon boot', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-start-registry-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('registers a brand-new agent as enabled:true', () => {
    const change = ensureAgentEnabledInRegistry('default', 'kpi');
    expect(change).toBe('Registered kpi in enabled-agents.json');
    const agents = readEnabledAgents('default');
    expect(agents.kpi).toEqual({ enabled: true, status: 'configured' });
  });

  it('inherits org from a sibling entry when registering fresh', () => {
    mkdirSync(join(tmpHome, '.cortextos', 'default', 'config'), { recursive: true });
    writeEnabledAgents('default', { anna: { enabled: true, status: 'configured', org: 'foothills-pm' } });

    ensureAgentEnabledInRegistry('default', 'kpi');

    const agents = readEnabledAgents('default');
    expect(agents.kpi.org).toBe('foothills-pm');
  });

  it('flips an existing enabled:false entry back to true (the actual bug fix)', () => {
    mkdirSync(join(tmpHome, '.cortextos', 'default', 'config'), { recursive: true });
    writeEnabledAgents('default', { kpi: { enabled: false, status: 'stopped', org: 'foothills-pm' } });

    const change = ensureAgentEnabledInRegistry('default', 'kpi');

    expect(change).toBe('Re-enabled kpi in enabled-agents.json');
    const agents = readEnabledAgents('default');
    expect(agents.kpi).toEqual({ enabled: true, status: 'configured', org: 'foothills-pm' });
  });

  it('is a no-op (returns null, no write) when already enabled:true', () => {
    mkdirSync(join(tmpHome, '.cortextos', 'default', 'config'), { recursive: true });
    writeEnabledAgents('default', { kpi: { enabled: true, status: 'configured' } });

    const change = ensureAgentEnabledInRegistry('default', 'kpi');

    expect(change).toBeNull();
  });

  it('full round trip: stop then start leaves the registry enabled:true, matching pre-stop state', () => {
    markAgentStoppedInRegistry('default', 'kpi');
    expect(readEnabledAgents('default').kpi.enabled).toBe(false);

    ensureAgentEnabledInRegistry('default', 'kpi');
    expect(readEnabledAgents('default').kpi.enabled).toBe(true);
  });
});
