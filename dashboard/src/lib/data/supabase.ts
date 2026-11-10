// Minimal server-side Supabase REST (PostgREST) client.
//
// Server-only: uses the service-role SUPABASE_API_KEY, which bypasses RLS --
// never import this from a 'use client' component. Matches the convention
// already established in knowledge-base/scripts/pgvector_store.py (same env
// vars, same apikey/Bearer header shape, same on_conflict + Prefer upsert
// pattern) so Supabase access looks the same whether it's Python or TS.

export class SupabaseRestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_API_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_API_KEY must be set (see orgs/foothills-pm/secrets.env).');
  }
  return { url, key };
}

function headers(extra?: Record<string, string>) {
  const { key } = getConfig();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export interface SelectOptions {
  select?: string;
  filters?: Record<string, string>; // e.g. { id: 'eq.123' }
  order?: string; // e.g. 'created_at.desc'
  limit?: number;
}

export async function supabaseSelect<T>(table: string, options: SelectOptions = {}): Promise<T[]> {
  const { url } = getConfig();
  const params = new URLSearchParams();
  params.set('select', options.select ?? '*');
  if (options.order) params.set('order', options.order);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.filters) {
    for (const [col, expr] of Object.entries(options.filters)) params.set(col, expr);
  }
  const resp = await fetch(`${url}/rest/v1/${table}?${params.toString()}`, {
    headers: headers(),
    cache: 'no-store',
  });
  if (!resp.ok) throw new SupabaseRestError(`GET ${table} -> ${resp.status}: ${(await resp.text()).slice(0, 500)}`, resp.status);
  return resp.json();
}

export async function supabaseSelectOne<T>(table: string, options: SelectOptions = {}): Promise<T | null> {
  const rows = await supabaseSelect<T>(table, { ...options, limit: 1 });
  return rows[0] ?? null;
}

export async function supabaseUpdate<T>(
  table: string,
  filters: Record<string, string>,
  patch: Record<string, unknown>,
): Promise<T[]> {
  const { url } = getConfig();
  const params = new URLSearchParams();
  for (const [col, expr] of Object.entries(filters)) params.set(col, expr);
  const resp = await fetch(`${url}/rest/v1/${table}?${params.toString()}`, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(patch),
    cache: 'no-store',
  });
  if (!resp.ok) throw new SupabaseRestError(`PATCH ${table} -> ${resp.status}: ${(await resp.text()).slice(0, 500)}`, resp.status);
  return resp.json();
}

export async function supabaseInsert<T>(table: string, row: Record<string, unknown>): Promise<T[]> {
  const { url } = getConfig();
  const resp = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
    cache: 'no-store',
  });
  if (!resp.ok) throw new SupabaseRestError(`POST ${table} -> ${resp.status}: ${(await resp.text()).slice(0, 500)}`, resp.status);
  return resp.json();
}
