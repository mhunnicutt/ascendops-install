import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { checkUpstream } from '../../../src/bus/metrics';

function git(cwd: string, cmd: string) {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

describe('checkUpstream', () => {
  let base: string;
  let upstreamDir: string;
  let localDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cortextos-check-upstream-test-'));
    upstreamDir = join(base, 'upstream');
    localDir = join(base, 'local');

    execSync(`git init -q -b main ${upstreamDir}`, { stdio: 'pipe' });
    git(upstreamDir, 'config user.email test@test.com');
    git(upstreamDir, 'config user.name test');
    writeFileSync(join(upstreamDir, 'f.txt'), 'a\n');
    git(upstreamDir, 'add f.txt');
    git(upstreamDir, 'commit -qm c1');

    execSync(`git clone -q ${upstreamDir} ${localDir}`, { stdio: 'pipe' });
    git(localDir, 'remote add upstream ../upstream');
    git(localDir, 'config user.email test@test.com');
    git(localDir, 'config user.name test');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('reports up_to_date when HEAD equals upstream/main', () => {
    const result = checkUpstream(localDir);
    expect(result.status).toBe('up_to_date');
  });

  it('reports up_to_date (not a false-positive updates_available) when local HEAD has diverged via a local-only commit but upstream is fully merged', () => {
    writeFileSync(join(localDir, 'f.txt'), 'a\nb\n');
    git(localDir, 'commit -qam "local-only commit"');

    const result = checkUpstream(localDir);
    // Regression check: old head-equality gate would report 'updates_available'
    // here even though rev-list HEAD..upstream/main --count is 0.
    expect(result.status).toBe('up_to_date');
  });

  it('reports updates_available with the correct commit count when upstream has new commits', () => {
    writeFileSync(join(upstreamDir, 'g.txt'), 'x\n');
    git(upstreamDir, 'add g.txt');
    git(upstreamDir, 'commit -qm c2');

    const result = checkUpstream(localDir);
    expect(result.status).toBe('updates_available');
    expect(result.commits).toBe(1);
  });
});
