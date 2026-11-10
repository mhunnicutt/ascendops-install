import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabaseSelect, supabaseUpdate, supabaseInsert, SupabaseRestError } from '../supabase';

const ORIGINAL_ENV = { ...process.env };

function mockFetchOnce(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_API_KEY = 'test-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe('supabaseSelect', () => {
  it('builds select/order/filter query params and auth headers', async () => {
    const fetchMock = mockFetchOnce([{ id: '1' }]);
    const rows = await supabaseSelect('turns', {
      select: 'id,status',
      order: 'move_out_date.asc',
      filters: { status: 'eq.CLOSED' },
    });
    expect(rows).toEqual([{ id: '1' }]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://example.supabase.co/rest/v1/turns?');
    const params = new URL(url).searchParams;
    expect(params.get('select')).toBe('id,status');
    expect(params.get('order')).toBe('move_out_date.asc');
    expect(params.get('status')).toBe('eq.CLOSED');
    expect(init.headers).toMatchObject({ apikey: 'test-key', Authorization: 'Bearer test-key' });
  });

  it('throws SupabaseRestError on a non-ok response', async () => {
    mockFetchOnce({ message: 'nope' }, 500);
    await expect(supabaseSelect('turns')).rejects.toBeInstanceOf(SupabaseRestError);
  });

  it('requires SUPABASE_URL and SUPABASE_API_KEY to be set', async () => {
    delete process.env.SUPABASE_URL;
    await expect(supabaseSelect('turns')).rejects.toThrow(/SUPABASE_URL/);
  });
});

describe('supabaseUpdate', () => {
  it('PATCHes with filters in the query string and the patch as the body', async () => {
    const fetchMock = mockFetchOnce([{ id: '1', status: 'CLOSED' }]);
    await supabaseUpdate('turns', { id: 'eq.1' }, { status: 'CLOSED' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).searchParams.get('id')).toBe('eq.1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ status: 'CLOSED' });
    expect(init.headers).toMatchObject({ Prefer: 'return=representation' });
  });
});

describe('supabaseInsert', () => {
  it('POSTs the row as the body', async () => {
    const fetchMock = mockFetchOnce([{ id: '1' }]);
    await supabaseInsert('turn_audit_log', { turn_id: '1', action: 'STATUS_CHANGE', by_person: 'anna' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ turn_id: '1', action: 'STATUS_CHANGE', by_person: 'anna' });
  });
});
