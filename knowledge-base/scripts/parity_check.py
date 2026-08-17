#!/usr/bin/env python3
"""
Side-by-side parity check: run the same real queries against chromadb and
Supabase pgvector for one collection and compare results, before flipping
kb_backend to "pgvector" in config.json.

Does not touch config.json's kb_backend at all -- constructs both backend
collections directly and compares their .query() output, independent of
whatever the live default currently is.

Usage:
    python3 parity_check.py --collection shared-foothills-pm --questions questions.txt
    python3 parity_check.py --collection shared-foothills-pm --question "what is the late payment policy"

Exit code 0 if every question's top result matches (same top-1 doc id) and
every compared similarity score is within TOLERANCE; 1 otherwise. Run
migrate_to_pgvector.py first -- this assumes the Supabase side already has
the data.
"""
import argparse
import sys

from mmrag import (  # noqa: E402
    get_chroma_collection,
    load_config,
    get_api_key,
    get_genai_client,
    embed_query,
)
from pgvector_store import PgvectorCollection  # noqa: E402

TOLERANCE = 0.01  # cosine similarity is exact float math on both sides for
                   # verbatim-copied vectors, so any real mismatch beyond
                   # floating-point noise is worth flagging, not averaging away


def run_query(collection, query_embedding, top_k):
    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=top_k,
        include=["documents", "metadatas", "distances"],
    )
    if not results["ids"] or not results["ids"][0]:
        return []
    return [
        {
            "id": results["ids"][0][i],
            "similarity": 1 - results["distances"][0][i],
            "source": (results["metadatas"][0][i] or {}).get("source", "?"),
        }
        for i in range(len(results["ids"][0]))
    ]


def compare_one(question, collection_name, client, config, top_k):
    query_embedding = embed_query(client, config, question)

    chroma_results = run_query(get_chroma_collection(collection_name), query_embedding, top_k)
    pg_results = run_query(PgvectorCollection(collection_name), query_embedding, top_k)

    print(f"\n=== \"{question}\" ===")
    print(f"chromadb top-{top_k}:")
    for r in chroma_results:
        print(f"  {r['similarity']:.4f}  {r['id']}  {r['source']}")
    print(f"supabase top-{top_k}:")
    for r in pg_results:
        print(f"  {r['similarity']:.4f}  {r['id']}  {r['source']}")

    if not chroma_results and not pg_results:
        print("BOTH EMPTY -- ok (nothing to compare)")
        return True

    if not chroma_results or not pg_results:
        print("MISMATCH -- one backend returned results, the other returned none")
        return False

    top1_match = chroma_results[0]["id"] == pg_results[0]["id"]
    score_diff = abs(chroma_results[0]["similarity"] - pg_results[0]["similarity"])
    score_ok = score_diff <= TOLERANCE

    if top1_match and score_ok:
        print(f"MATCH (top-1 id equal, score diff {score_diff:.5f})")
        return True

    print(f"MISMATCH -- top1_match={top1_match} score_diff={score_diff:.5f} (tolerance {TOLERANCE})")
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collection", required=True)
    parser.add_argument("--question", action="append", default=[], help="Repeatable")
    parser.add_argument("--questions", help="Path to a file, one question per line")
    parser.add_argument("--top-k", type=int, default=5)
    args = parser.parse_args()

    questions = list(args.question)
    if args.questions:
        with open(args.questions) as f:
            questions.extend(line.strip() for line in f if line.strip())

    if not questions:
        print("ERROR: pass at least one --question or --questions <file>", file=sys.stderr)
        sys.exit(2)

    config = load_config()
    client = get_genai_client(get_api_key(config))

    results = [compare_one(q, args.collection, client, config, args.top_k) for q in questions]

    passed = sum(results)
    print(f"\n{passed}/{len(results)} questions matched.")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
