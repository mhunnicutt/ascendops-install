#!/usr/bin/env python3
"""
One-time migration: copy every chunk (id, embedding, document, metadata) from
the existing chromadb collections into Supabase pgvector (kb_documents),
verbatim -- chromadb exposes the raw stored embeddings directly, so this does
NOT call Gemini again. No re-embedding, no risk of quality drift, no API
cost.

Requires knowledge-base/supabase/001_kb_pgvector_setup.sql to have already
been run once in the Supabase SQL Editor.

Non-destructive: only reads from chromadb, only upserts into Supabase.
Chromadb is left completely untouched, so it keeps serving live production
queries (kb_backend stays "chromadb" in config.json) throughout and after
this run -- switching the active backend is a separate, later step.

Usage:
    python3 migrate_to_pgvector.py [--collection NAME] [--batch-size N] [--dry-run]

Without --collection, migrates every collection chromadb currently has.
"""
import argparse
import sys

from mmrag import get_chroma_client  # noqa: E402 -- reuses the untouched chromadb path
from pgvector_store import PgvectorCollection, PgvectorError  # noqa: E402

DEFAULT_BATCH_SIZE = 100  # keeps each REST payload well under Supabase's request-size limit (embeddings are 3072 floats each)


def migrate_collection(name, batch_size, dry_run):
    chroma_client = get_chroma_client()
    chroma_collection = chroma_client.get_collection(name)
    total = chroma_collection.count()
    print(f"[{name}] {total} chunks in chromadb")
    if total == 0:
        return 0, 0

    data = chroma_collection.get(include=["embeddings", "documents", "metadatas"])
    ids = data["ids"]
    embeddings = data["embeddings"]
    documents = data["documents"]
    metadatas = data["metadatas"]

    if dry_run:
        print(f"[{name}] DRY RUN -- would upsert {len(ids)} chunks, embedding dim {len(embeddings[0]) if len(embeddings) else 'n/a'}")
        return len(ids), 0

    pg_collection = PgvectorCollection(name)
    migrated = 0
    failed = 0
    for start in range(0, len(ids), batch_size):
        end = start + batch_size
        try:
            pg_collection.upsert(
                ids=ids[start:end],
                embeddings=[list(e) for e in embeddings[start:end]],
                documents=documents[start:end],
                metadatas=metadatas[start:end],
            )
            migrated += end - start if end <= len(ids) else len(ids) - start
        except PgvectorError as exc:
            failed += end - start if end <= len(ids) else len(ids) - start
            print(f"[{name}] ERROR batch {start}-{end}: {exc}", file=sys.stderr)
        print(f"[{name}] {min(end, len(ids))}/{len(ids)} upserted", end="\r")
    print()
    return migrated, failed


def verify_collection(name):
    """Compare chromadb count vs the freshly-migrated Supabase count for one
    collection -- the cheap half of the parity check (the real semantic
    parity check is a separate query-comparison script run after this)."""
    chroma_count = get_chroma_client().get_collection(name).count()
    pg_count = PgvectorCollection(name).count()
    match = chroma_count == pg_count
    status = "OK" if match else "MISMATCH"
    print(f"[{name}] chromadb={chroma_count} supabase={pg_count} [{status}]")
    return match


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collection", help="Migrate only this collection (default: all)")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--dry-run", action="store_true", help="Read from chromadb and report counts only, write nothing")
    parser.add_argument("--verify-only", action="store_true", help="Skip migration, just compare chromadb vs Supabase counts")
    args = parser.parse_args()

    if args.collection:
        names = [args.collection]
    else:
        names = get_chroma_client().list_collections()
        names = [c.name if hasattr(c, "name") else c for c in names]

    if not names:
        print("No chromadb collections found.")
        return

    if args.verify_only:
        all_ok = True
        for name in names:
            if not verify_collection(name):
                all_ok = False
        sys.exit(0 if all_ok else 1)

    total_migrated = 0
    total_failed = 0
    for name in names:
        migrated, failed = migrate_collection(name, args.batch_size, args.dry_run)
        total_migrated += migrated
        total_failed += failed

    print(f"\nDone. {total_migrated} chunks migrated, {total_failed} failed across {len(names)} collection(s).")
    if not args.dry_run:
        print("\nVerifying counts:")
        all_ok = True
        for name in names:
            if not verify_collection(name):
                all_ok = False
        if not all_ok:
            print("\nOne or more collections have a count mismatch -- do not switch kb_backend until resolved.", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
