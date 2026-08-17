"""
Supabase pgvector storage backend for mmrag.py.

Exposes the same collection API surface mmrag.py already calls on a chromadb
Collection/PersistentClient (count/get/upsert/query/delete,
get_or_create_collection/get_collection/list_collections) so the multimodal
ingestion logic elsewhere in mmrag.py needs zero changes -- only
get_chroma_collection()/get_chroma_client() get swapped for
get_pgvector_collection()/get_pgvector_client() based on the `kb_backend`
config value.

Talks to Supabase entirely over its REST API (PostgREST) using SUPABASE_URL +
SUPABASE_API_KEY -- no direct Postgres connection, no psycopg2/vecs
dependency, nothing beyond the `requests` library already present in the KB
venv. Schema + RPC functions are created once via the one-time script at
knowledge-base/supabase/001_kb_pgvector_setup.sql.
"""
import os

import requests

REST_TIMEOUT_SECONDS = 30
PAGE_SIZE = 1000

# mmrag.py's --type flag maps to these stored `type` metadata values.
# Mirrors the type_map in cmd_query -- kept here too since the RPC needs an
# array of concrete stored-type values, not the chromadb-style $or dict.
_TYPE_FILTER_MAP = {
    "image": ["image"],
    "video": ["video_chunk"],
    "text": ["text"],
    "pdf": ["pdf_page"],
    "audio": ["audio", "audio_chunk"],
}


class PgvectorError(RuntimeError):
    """Raised on any non-2xx response from the Supabase REST API."""


def _get_env():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_API_KEY")
    if not url or not key:
        raise PgvectorError(
            "SUPABASE_URL and SUPABASE_API_KEY must be set (see "
            "orgs/<org>/secrets.env) to use the pgvector KB backend."
        )
    return url.rstrip("/"), key


def _pg_in_escape(value):
    """Escape one value for a PostgREST `in.(...)` filter list."""
    v = str(value)
    if any(c in v for c in ',()"'):
        return '"' + v.replace('"', '\\"') + '"'
    return v


def _where_to_type_filters(where):
    """
    Translate mmrag.py's chromadb-style `where` dict into a list of stored
    `type` values for kb_match_documents' p_type_filters array.

    mmrag.py only ever passes one of:
      - None
      - {"type": "<value>"}
      - {"$or": [{"type": "a"}, {"type": "b"}, ...]}
    which is the full shape this needs to support -- not a general chromadb
    `where` DSL translator.
    """
    if not where:
        return None
    if "type" in where:
        return [where["type"]]
    if "$or" in where:
        values = []
        for clause in where["$or"]:
            t = clause.get("type")
            if t:
                values.append(t)
        return values or None
    return None


class PgvectorCollection:
    """Mimics a chromadb Collection, scoped to one `collection` value in the
    shared kb_documents table."""

    def __init__(self, name):
        self.name = name
        self._url, self._key = _get_env()
        self._headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Content-Type": "application/json",
        }

    def _request(self, path, method="GET", params=None, json_body=None,
                 extra_headers=None, prefer=None):
        headers = dict(self._headers)
        if prefer:
            headers["Prefer"] = prefer
        if extra_headers:
            headers.update(extra_headers)
        resp = requests.request(
            method, f"{self._url}{path}",
            headers=headers, params=params, json=json_body,
            timeout=REST_TIMEOUT_SECONDS,
        )
        if resp.status_code >= 400:
            raise PgvectorError(
                f"{method} {path} -> {resp.status_code}: {resp.text[:500]}"
            )
        return resp

    def _paginate(self, path, params):
        """PostgREST caps unbounded selects around 1000 rows by default --
        page through with Range headers so get(include=[...]) on a large
        collection (cmd_status/cmd_list/cmd_delete all rely on a full dump)
        doesn't silently truncate."""
        rows = []
        offset = 0
        while True:
            headers = {"Range-Unit": "items", "Range": f"{offset}-{offset + PAGE_SIZE - 1}"}
            resp = self._request(path, params=params, extra_headers=headers)
            batch = resp.json()
            rows.extend(batch)
            if len(batch) < PAGE_SIZE:
                break
            offset += PAGE_SIZE
        return rows

    def count(self):
        resp = self._request(
            "/rest/v1/kb_documents",
            params={"collection": f"eq.{self.name}", "select": "id", "limit": 1},
            prefer="count=exact",
        )
        content_range = resp.headers.get("Content-Range", "")
        if "/" in content_range:
            total = content_range.split("/")[-1]
            return int(total) if total.isdigit() else 0
        return len(resp.json())

    def get(self, ids=None, include=None):
        params = {"collection": f"eq.{self.name}"}
        select_fields = ["id"]
        if include and "metadatas" in include:
            select_fields.append("metadata")
        if include and "documents" in include:
            select_fields.append("document")
        params["select"] = ",".join(select_fields)
        if ids:
            id_list = ",".join(_pg_in_escape(i) for i in ids)
            params["id"] = f"in.({id_list})"

        rows = self._paginate("/rest/v1/kb_documents", params)
        result = {"ids": [r["id"] for r in rows]}
        if include and "metadatas" in include:
            result["metadatas"] = [r.get("metadata") or {} for r in rows]
        if include and "documents" in include:
            result["documents"] = [r.get("document") for r in rows]
        return result

    def upsert(self, ids, embeddings, documents=None, metadatas=None):
        rows = []
        for i, doc_id in enumerate(ids):
            row = {"id": doc_id, "collection": self.name, "embedding": embeddings[i]}
            if documents is not None:
                row["document"] = documents[i]
            if metadatas is not None:
                row["metadata"] = metadatas[i]
            rows.append(row)
        self._request(
            "/rest/v1/kb_documents",
            method="POST",
            json_body=rows,
            params={"on_conflict": "collection,id"},
            prefer="resolution=merge-duplicates",
        )

    def query(self, query_embeddings, n_results=10, where=None, include=None):
        resp = self._request(
            "/rest/v1/rpc/kb_match_documents",
            method="POST",
            json_body={
                "p_collection": self.name,
                "p_query_embedding": query_embeddings[0],
                "p_match_count": n_results,
                "p_type_filters": _where_to_type_filters(where),
            },
        )
        rows = resp.json()
        # chromadb's query() nests one result-list per input query embedding;
        # mmrag.py always passes exactly one, so wrap in a single-element list
        # to match the shape callers already index as results["ids"][0][i].
        return {
            "ids": [[r["id"] for r in rows]],
            "documents": [[r["document"] for r in rows]],
            "metadatas": [[r["metadata"] or {} for r in rows]],
            "distances": [[1 - r["similarity"] for r in rows]],
        }

    def delete(self, ids):
        id_list = ",".join(_pg_in_escape(i) for i in ids)
        self._request(
            "/rest/v1/kb_documents",
            method="DELETE",
            params={"collection": f"eq.{self.name}", "id": f"in.({id_list})"},
        )


class PgvectorClient:
    """Mimics chromadb.PersistentClient's collection-management surface."""

    def __init__(self):
        # Validate credentials resolve up front, same failure point as
        # chromadb.PersistentClient(path=...) raising on a bad path.
        _get_env()

    def get_or_create_collection(self, name, metadata=None):
        # No DDL needed per collection -- kb_documents already exists (or the
        # first upsert to it will fail loudly with a clear PgvectorError if
        # the one-time setup script hasn't been run yet).
        return PgvectorCollection(name)

    def get_collection(self, name):
        return PgvectorCollection(name)

    def list_collections(self):
        url, key = _get_env()
        resp = requests.post(
            f"{url}/rest/v1/rpc/kb_list_collections",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            json={},
            timeout=REST_TIMEOUT_SECONDS,
        )
        if resp.status_code >= 400:
            raise PgvectorError(
                f"POST /rest/v1/rpc/kb_list_collections -> "
                f"{resp.status_code}: {resp.text[:500]}"
            )
        return [row["collection"] for row in resp.json()]

    def delete_collection(self, name):
        # kb_documents is one shared table (see 001_kb_pgvector_setup.sql) --
        # "deleting a collection" means deleting every row scoped to it,
        # there is no separate table to drop. Filters by collection alone
        # (not an id list) so this works regardless of collection size --
        # an `in.(...)` id list for a large collection risks the URL length
        # limit PgvectorCollection.delete() is fine with for small batches.
        url, key = _get_env()
        resp = requests.delete(
            f"{url}/rest/v1/kb_documents",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            params={"collection": f"eq.{name}"},
            timeout=REST_TIMEOUT_SECONDS,
        )
        if resp.status_code >= 400:
            raise PgvectorError(
                f"DELETE /rest/v1/kb_documents -> {resp.status_code}: {resp.text[:500]}"
            )
