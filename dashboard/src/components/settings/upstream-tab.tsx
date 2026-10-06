'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { UpstreamStatus, UpstreamCommit } from '@/lib/upstream';

type ViewState = 'idle' | 'applying' | 'applied' | 'error';

// Parse conventional commit format: "type(scope): description"
function parseCommitMessage(msg: string): { type: string; scope: string; description: string } {
  const match = msg.match(/^(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
  if (match) {
    return { type: match[1], scope: match[2] ?? '', description: match[3] };
  }
  // Merge commits and others
  const mergeMatch = msg.match(/^Merge .+\/(.+)$/);
  if (mergeMatch) {
    return { type: 'merge', scope: '', description: mergeMatch[1].replace(/-/g, ' ') };
  }
  return { type: 'update', scope: '', description: msg };
}

function typeBadgeVariant(type: string): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (type === 'feat') return 'default';
  if (type === 'fix') return 'destructive';
  if (type === 'merge') return 'outline';
  return 'secondary';
}

function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    feat: 'New feature',
    fix: 'Bug fix',
    chore: 'Maintenance',
    refactor: 'Refactor',
    docs: 'Docs',
    test: 'Tests',
    merge: 'Merged',
    update: 'Update',
  };
  return labels[type] ?? type;
}

// Human-readable area names
function areaLabel(key: string): string {
  const labels: Record<string, string> = {
    bus: 'Bus commands',
    scripts: 'Scripts',
    templates: 'Agent templates',
    skills: 'Skills',
    community: 'Community agents',
    other: 'Core framework',
  };
  return labels[key] ?? key;
}

function affectedAreas(
  changes: UpstreamStatus['changes'],
  commitIndex: number,
  totalCommits: number,
): string[] {
  // With a single commit or only 1 commit shown, attribute all areas to it.
  // With multiple commits we can't easily split per-commit without git blame,
  // so show areas on the last (most recent) non-merge commit.
  if (totalCommits <= 1 || commitIndex === 0) {
    return Object.entries(changes)
      .filter(([, files]) => files.length > 0)
      .map(([key]) => areaLabel(key));
  }
  return [];
}

function CommitCard({
  commit,
  changes,
  index,
  total,
}: {
  commit: UpstreamCommit;
  changes: UpstreamStatus['changes'];
  index: number;
  total: number;
}) {
  const { type, scope, description } = parseCommitMessage(commit.message);
  const areas = affectedAreas(changes, index, total);

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-2">
        <div className="flex items-start gap-2 flex-wrap">
          <Badge variant={typeBadgeVariant(type)} className="shrink-0 mt-0.5">
            {typeLabel(type)}
          </Badge>
          {scope && (
            <Badge variant="outline" className="shrink-0 mt-0.5 font-mono text-xs">
              {scope}
            </Badge>
          )}
        </div>
        <CardTitle className="text-base mt-2 leading-snug">{description}</CardTitle>
      </CardHeader>

      {areas.length > 0 && (
        <CardContent className="pt-0 pb-3">
          <p className="text-xs text-muted-foreground mb-2">Affects</p>
          <div className="flex flex-wrap gap-1.5">
            {areas.map((area) => (
              <span
                key={area}
                className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
              >
                {area}
              </span>
            ))}
          </div>
        </CardContent>
      )}

      <CardFooter className="pt-0 pb-3">
        <code className="text-xs text-muted-foreground/60">{commit.hash.slice(0, 7)}</code>
      </CardFooter>
    </Card>
  );
}

export function UpstreamTab() {
  const [status, setStatus] = useState<UpstreamStatus | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [viewState, setViewState] = useState<ViewState>('idle');
  const [applyMsg, setApplyMsg] = useState('');

  const load = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const res = await fetch('/api/upstream');
      const data: UpstreamStatus = await res.json();
      setStatus(data);
      setViewState('idle');
    } catch {
      setViewState('error');
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleApply() {
    setViewState('applying');
    try {
      const res = await fetch('/api/upstream', { method: 'POST' });
      const data: { success: boolean; message: string } = await res.json();
      setApplyMsg(data.message);
      setViewState('applied');
      if (data.success) setTimeout(load, 2000);
    } catch {
      setApplyMsg('Apply failed — check agent logs.');
      setViewState('error');
    }
  }

  if (isRefreshing && !status) {
    return <div className="h-64 rounded-xl bg-muted/30 animate-pulse" />;
  }

  const hasUpdates = status?.status === 'updates_available';
  const isUpToDate = status?.status === 'up_to_date';
  const commits = status?.commits_parsed ?? [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Available updates</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Releases from the shared AscendOps framework. Checked daily at 7am.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={isRefreshing}>
          {isRefreshing ? 'Checking…' : 'Check now'}
        </Button>
      </div>

      {/* Status messages */}
      {isUpToDate && (
        <Card className="border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30">
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-green-800 dark:text-green-200 font-medium">You are up to date.</p>
            <p className="text-xs text-green-700 dark:text-green-300 mt-0.5">No pending updates from upstream.</p>
          </CardContent>
        </Card>
      )}

      {status?.status === 'error' && (
        <Card className="border-destructive/30 bg-destructive/10">
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-destructive font-medium">Could not reach upstream.</p>
            <p className="text-xs text-destructive/80 mt-0.5">{status.error}</p>
          </CardContent>
        </Card>
      )}

      {viewState === 'applied' && (
        <Card className={applyMsg.toLowerCase().includes('fail') || applyMsg.toLowerCase().includes('error')
          ? 'border-destructive/30 bg-destructive/10'
          : 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30'}>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm font-medium">{applyMsg}</p>
          </CardContent>
        </Card>
      )}

      {/* Update cards */}
      {hasUpdates && (
        <>
          <div className="flex items-center gap-2">
            <Badge variant="default">
              {commits.length} update{commits.length !== 1 ? 's' : ''} available
            </Badge>
            {status?.diff_stat && (
              <span className="text-xs text-muted-foreground font-mono">{status.diff_stat.trim()}</span>
            )}
          </div>

          <div className="space-y-3">
            {commits.map((commit, i) => (
              <CommitCard
                key={commit.hash}
                commit={commit}
                changes={status!.changes}
                index={i}
                total={commits.length}
              />
            ))}
          </div>

          {/* Apply all */}
          <div className="pt-1">
            <Button
              onClick={handleApply}
              disabled={viewState === 'applying' || viewState === 'applied'}
              size="default"
            >
              {viewState === 'applying' ? 'Applying…' : `Apply ${commits.length > 1 ? 'all updates' : 'update'}`}
            </Button>
            <p className="text-xs text-muted-foreground mt-2">
              Applies all pending commits from upstream. Framework patches are low risk.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
