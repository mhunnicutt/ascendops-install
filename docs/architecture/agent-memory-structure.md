# Agent Memory Structure

*A file layout and migration method for giving persistent AI agents small boots,
deep memory, and a full audit trail. Proven in production across a 10-agent fleet,
June 2026.*

---

## The problem

Long-running AI agents accumulate memory the way old codebases accumulate config:
everything lands in the boot file. Identity, rules, project state, lessons learned,
one-off findings — all of it gets read into context on every single session start.

Symptoms when this goes unmanaged:

- **Boot bloat.** Boot files grow past 12–16KB. Every restart pays the full cost,
  and the agent's working context starts each day partly spent.
- **Recall noise.** The agent re-reads hundreds of stale lines to find the three
  facts that matter for the current task.
- **Silent rot.** Dead references survive for weeks because nothing forces a review.
- **Lossy cleanup.** When someone finally trims the file, content gets deleted
  instead of moved — and a month later nobody can reconstruct what was known.

## The structure

Each agent owns a directory with four layers, ordered by how often they are read:

```
agent/
├── CLAUDE.md (or AGENTS.md)     ← boot file: identity + rules ONLY (~8KB target)
├── MEMORY.md                    ← index: one line per memory, with pointers
├── knowledge/
│   ├── ops/        + INDEX.md   ← how-to notes, runbooks
│   ├── lessons/    + INDEX.md   ← post-mortems, learned constraints
│   ├── process/    + INDEX.md   ← pipeline / workflow canon
│   ├── projects/   + INDEX.md   ← active initiative state
│   └── archive/    + INDEX.md   ← superseded files, moved here — never deleted
└── *.mdb                        ← byte-exact backup of every file before any change
```

**Layer 1 — the boot file.** Read on every session start, so it earns its place
byte by byte. Identity, authorization, hard rules, and pointers to layer 2.
Nothing that changes weekly belongs here. Target: under ~8KB.

**Layer 2 — the index (MEMORY.md).** One line per memory: a title, a link to the
topic file, and a hook ("when X, see Y"). Hard size cap; details never live here.
The agent scans the index cheaply and opens only the files the task needs.

**Layer 3 — topic notes (knowledge/).** One fact or finding per file, with a
small frontmatter header (name, one-line description, type). Files are grouped
into domains — the set varies per agent (a QA agent carries `process/` and `qa/`,
a designer carries `design/`) — and every domain folder carries an `INDEX.md`
router so a reader can navigate without grepping. Notes link to related notes
by name. Deliberately lean agents may skip this layer entirely and carry only
a slim boot file: the structure is a ceiling, not a quota.

**Layer 4 — the archive.** Cleanup means *move*, not delete. Superseded files go
to `knowledge/archive/` with a provenance `INDEX.md` recording what moved, when,
and why. Anything ever known stays reconstructible.

Two cross-cutting standards:

- **Provenance banner.** Every note moved out of a monolith carries one line at
  the top: where it came from, when, under what approval, and where the original
  is preserved. The note self-attests its own audit trail.
- **.mdb sibling backups.** Before any file is modified, a byte-exact copy is
  written next to it. Rollback is `cp`, not archaeology.

## The migration method

Restructuring a live agent's memory is surgery on a running system. The method
that survived a real fleet migration — including two reviewer restarts, one of
them a fleet-wide daemon restart, mid-process — has four gates:

1. **Stage.** A worker produces the complete proposed end-state as staged files
   plus diffs, in a scratch area. It applies nothing.
2. **Written verdict.** An independent reviewer (not the worker, not the author)
   rules per-agent in writing: pass / pass-with-conditions / hold, with every
   condition spelled out. The verdict is a document, not a conversation — it
   survives restarts and is reproduced verbatim in the applier's brief.
3. **Apply.** A fresh worker applies exactly what the verdict passed, condition
   by condition: backup first, move don't delete, diff-verify each applied file
   against staging, keep a running apply-log on disk as it goes.
4. **Independent live-verify.** The reviewer checks the applied state at the
   source — file by file, count by count — not on the worker's word. An agent's
   migration is not DONE until this green lands.

Rules that made it safe:

- **One agent, one lane.** Each agent migrates as an independent unit; a problem
  in one lane never blocks the other six.
- **The verdict travels with the work.** Because the ruling is reproduced
  verbatim in the applier's brief, a reviewer crash mid-run costs nothing — the
  next reviewer instance verifies from the same written verdict.
- **Don't fix what you're moving.** Stale or wrong content found during a format
  migration gets moved verbatim and *flagged*, never silently corrected. Content
  fixes are separate, reviewable changes.
- **Commit the applied state.** Once live, the slimmed boot files are committed
  to version control so a stray `git restore` cannot erase the migration.

## Results from the production run

- **10 agents processed, 10 verified green** — 8 fully restructured into the
  four layers, 2 kept deliberately lean (boot-file fix only, by explicit
  reviewer ruling). Zero content loss; every move reconstructible from
  archive + backups + provenance banners.
- **Boot files cut roughly a third** (e.g. 12.5→8.1KB, 13.2→8.6KB, 15.9→12.1KB),
  with everything trimmed still reachable through the index.
- **Agents proven in the wild on slim boots** — the first agent ran ~8 hours
  of live build work on the new structure before the fleet followed.
- **The process survived chaos:** the reviewer hit a context restart mid-gate
  and a fleet-wide daemon restart landed mid-verify; the written-verdict +
  apply-log discipline carried both without losing a step.

## Adopting it

Start with one agent. Split its boot file into the four layers, write the index,
back up everything, and let it run a day. Then use the four-gate migration for
the rest of the fleet — the structure is simple; the discipline of *stage,
written verdict, apply, independent verify* is what makes it safe at scale.
