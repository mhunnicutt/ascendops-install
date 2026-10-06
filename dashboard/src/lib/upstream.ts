import { spawnSync } from 'child_process';

export interface UpstreamCommit {
  hash: string;
  message: string;
}

export interface UpstreamStatus {
  status: 'up_to_date' | 'updates_available' | 'error';
  commits: number;
  diff_stat: string;
  commit_log: string;
  commits_parsed: UpstreamCommit[];
  changes: {
    bus: string[];
    scripts: string[];
    templates: string[];
    skills: string[];
    community: string[];
    other: string[];
  };
  error?: string;
}

export interface ApplyResult {
  success: boolean;
  message: string;
}

function parseCommits(log: string): UpstreamCommit[] {
  if (!log) return [];
  return log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ');
      return { hash: line.slice(0, space), message: line.slice(space + 1) };
    });
}

export async function checkUpstream(): Promise<UpstreamStatus> {
  const result = spawnSync('cortextos', ['bus', 'check-upstream'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env },
  });

  if (result.error || result.status !== 0) {
    const raw = result.stdout || result.stderr || String(result.error ?? 'unknown error');
    try {
      const parsed = JSON.parse(raw);
      return { ...parsed, commits_parsed: [] };
    } catch {
      return {
        status: 'error',
        commits: 0,
        diff_stat: '',
        commit_log: '',
        commits_parsed: [],
        changes: { bus: [], scripts: [], templates: [], skills: [], community: [], other: [] },
        error: raw,
      };
    }
  }

  try {
    const data = JSON.parse(result.stdout);
    return {
      ...data,
      commits_parsed: parseCommits(data.commit_log ?? ''),
    };
  } catch {
    return {
      status: 'error',
      commits: 0,
      diff_stat: '',
      commit_log: '',
      commits_parsed: [],
      changes: { bus: [], scripts: [], templates: [], skills: [], community: [], other: [] },
      error: result.stdout,
    };
  }
}

export async function applyUpstream(): Promise<ApplyResult> {
  const result = spawnSync('cortextos', ['bus', 'check-upstream', '--apply'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, CORTEXTOS_CONFIRM_UPSTREAM_MERGE: 'yes' },
  });

  const raw = result.stdout || result.stderr || '';
  try {
    const data = JSON.parse(raw);
    return {
      success: data.status === 'merged' || data.status === 'up_to_date',
      message: data.message ?? raw,
    };
  } catch {
    return { success: result.status === 0, message: raw };
  }
}
