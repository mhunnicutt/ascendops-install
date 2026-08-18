---
name: local-version-control
description: "Daily git snapshots of agent workspace changes. Stages files with safety checks, reviews diff for PII, commits with descriptive message. Never pushes automatically."
triggers: ["auto-commit", "git snapshot", "commit changes", "version control"]
---

# Local Version Control

Daily snapshot of all agent workspace changes. Runs via auto-commit.sh with a two-layer safety review.

## Scope (worktree-aware)

This skill snapshots **agent state files only** — `memory/`, `MEMORY.md`, `GOALS.md`,
`config.json`, and the rest of each agent's directory under `orgs/`. Worktree-tree code
work is NOT auto-committed here — it ships via the PR workflow (feature branch on the
agent's worktree + `gh pr create`).

`orgs/` lives inside `$CTX_FRAMEWORK_ROOT` but is its own, separate, **local-only** git
repo (`$CTX_FRAMEWORK_ROOT/orgs/.git`) — not part of the framework repo's history.
`$CTX_FRAMEWORK_ROOT` is the public install repo; it deliberately gitignores `orgs/`
because org data is real business/PII data that must never land in a public repo's
history (see that repo's `.gitignore` comment on the `orgs/` line — added as a fast-follow
after a 2026-06-02 PII leak). `cortextos bus auto-commit` creates the `orgs/.git` repo
automatically on first run if it doesn't exist yet, and only ever operates inside it.

Because it's a separate repo, every git command in this skill (`git diff --cached`,
`git reset`, `git commit`) must run with cwd inside `orgs/` — running them from
`$CTX_FRAMEWORK_ROOT` itself will show the framework repo's own (always-empty-for-this-purpose)
staged diff, not the org data that `auto-commit` actually staged. Every bash block below
starts with `cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}/orgs"`; each shell
invocation in an agent session is a fresh shell. Running this skill from a per-agent
worktree would miss the canonical agent state files entirely — worktrees don't contain `orgs/`.

## When to Run

- Daily cron (configured via `cortextos bus add-cron`)
- After major agent work sessions
- Before any destructive operations

## Workflow

### Step 1: Run auto-commit.sh

```bash
cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}"
RESULT=$(cortextos bus auto-commit)
```

This initializes `orgs/.git` on first run if needed, then stages files with safety checks:
- Blocks .env files and credentials
- Blocks files over 10MB
- Blocks binary/temp files
- Respects `orgs/.gitignore` rules

### Step 2: Review the staged diff

```bash
cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}/orgs"
git diff --cached
```

Check for:
- PII: names, emails, phone numbers in memory files
- Secrets: tokens, API keys, passwords
- Large diffs that look wrong
- Files that should not be committed

On a brand-new agent directory, its first appearance may show as one collapsed line
(`?? agent-name/`) rather than individual files — that's normal git behavior for a wholly
untracked directory, not a bug. `git diff --cached` still expands it to per-file detail
once staged, so the PII review below still works file-by-file.

If anything looks sensitive, unstage it:
```bash
cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}/orgs"
git reset HEAD <file>
```

### Step 3: Commit

Generate a descriptive commit message summarizing what changed:
```bash
cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}/orgs"
git commit -m "daily: <summary of changes>"
```

### Step 4: Do NOT push

Auto-commit never pushes, and the `orgs/.git` repo never gets a remote configured in the
first place — there is nothing to push to. This is deliberate: org data must stay local.

## Config

Requires `ecosystem.local_version_control.enabled: true` in config.json.

## Safety

- Never commits .env files
- Never commits files matching credential patterns
- Always reviews diff before committing
- Never pushes automatically
