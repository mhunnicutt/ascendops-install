-- KB pgvector migration (C2) — one-time schema setup.
--
-- Run this once in the Supabase SQL Editor (Project -> SQL Editor -> New query
-- -> paste -> Run). This is DDL (CREATE EXTENSION / CREATE TABLE / CREATE
-- FUNCTION) which PostgREST cannot execute over the REST API even with the
-- service role key — that's the only reason this needs a manual run. Every
-- read/write after this point (upsert, query, delete, list) goes through the
-- plain REST API using SUPABASE_URL + SUPABASE_API_KEY already in
-- orgs/foothills-pm/secrets.env — no further manual steps, no DB password
-- needed.
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / OR REPLACE).

create extension if not exists vector;

-- One shared table across all KB collections (agent-anna, agent-reni,
-- shared-foothills-pm, etc.) rather than one table per collection, so a
-- newly added agent's collection needs zero further DDL — just a new
-- `collection` value on insert. Isolation between collections is enforced
-- entirely in application code (every read/write is always scoped by
-- `collection`), matching the existing kb-privacy.ts query-identity guard.
create table if not exists kb_documents (
  id text not null,
  collection text not null,
  embedding vector(3072) not null,
  document text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  primary key (collection, id)
);

-- No vector index (HNSW or IVFFlat) on `embedding`: both pgvector index
-- types cap out at 2000 dimensions and our Gemini embeddings are 3072 --
-- this is a hard limit of the index types themselves, not something IVFFlat
-- fixes over HNSW. Deliberately relying on an unindexed sequential scan
-- instead: at current scale (~1500 rows total across every collection) this
-- is exact nearest-neighbor search (strictly MORE accurate than an
-- approximate HNSW/IVFFlat index would be) and runs in low single-digit
-- milliseconds -- no real cost today. If a collection grows into the tens
-- of thousands of rows and sequential-scan latency becomes a real problem,
-- revisit with pgvector's `halfvec` type (half-precision, indexable up to
-- 4000 dims -- requires pgvector >= 0.7.0) rather than reducing embedding
-- dimensionality, which would require re-embedding everything.

create index if not exists kb_documents_collection_idx
  on kb_documents (collection);

-- Cosine similarity search, scoped to one collection, with an optional
-- metadata `type` filter (mirrors mmrag.py's --type image/video/text/pdf/audio
-- filter -- audio maps to two stored types, hence an array rather than a
-- single value). Exposed automatically as POST /rest/v1/rpc/kb_match_documents.
create or replace function kb_match_documents(
  p_collection text,
  p_query_embedding vector(3072),
  p_match_count int default 20,
  p_type_filters text[] default null
)
returns table (
  id text,
  document text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    id,
    document,
    metadata,
    1 - (embedding <=> p_query_embedding) as similarity
  from kb_documents
  where collection = p_collection
    and (p_type_filters is null or metadata->>'type' = any(p_type_filters))
  order by embedding <=> p_query_embedding
  limit p_match_count;
$$;

-- Distinct collections + doc counts, for the `kb-collections` CLI command.
-- Exposed as POST /rest/v1/rpc/kb_list_collections.
create or replace function kb_list_collections()
returns table (collection text, doc_count bigint)
language sql stable
as $$
  select collection, count(*) as doc_count
  from kb_documents
  group by collection
  order by collection;
$$;

grant execute on function kb_match_documents to service_role;
grant execute on function kb_list_collections to service_role;
grant all on kb_documents to service_role;
