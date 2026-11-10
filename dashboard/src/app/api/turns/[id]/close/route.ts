import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { closeTurn, type ClosePath } from '@/lib/data/turns';

export const dynamic = 'force-dynamic';

const VALID_CLOSE_PATHS: ClosePath[] = ['to_marketing', 'no_longer_managing'];

// ---------------------------------------------------------------------------
// POST /api/turns/[id]/close - Lorrie closes a turn, picking the close path
// (Maranda, 2026-11-10). Distinct from the PATCH status/turn_type edits --
// this is a one-way terminal action with its own required choice and its
// own audit action (TURN_CLOSED).
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { close_path?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.close_path || !VALID_CLOSE_PATHS.includes(body.close_path as ClosePath)) {
    return Response.json({ error: `close_path must be one of: ${VALID_CLOSE_PATHS.join(', ')}` }, { status: 400 });
  }

  const session = await auth();
  const byPerson = session?.user?.name ?? 'unknown';
  try {
    const updated = await closeTurn(id, body.close_path as ClosePath, byPerson);
    return Response.json({ turn: updated });
  } catch (err) {
    console.error(`[api/turns/${id}/close] POST error:`, err);
    return Response.json({ error: 'Failed to close turn' }, { status: 500 });
  }
}
