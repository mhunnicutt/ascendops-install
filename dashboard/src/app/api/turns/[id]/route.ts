import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { getTurn, listInspectionItems, listAuditLog, updateTurnStatus, type TurnStatus } from '@/lib/data/turns';

export const dynamic = 'force-dynamic';

const VALID_STATUSES: TurnStatus[] = [
  'INSPECTION_PULLED',
  'REVIEW_IN_PROGRESS',
  'REVIEW_COMPLETE',
  'WOS_ACTIVE',
  'CLOSED',
];

// ---------------------------------------------------------------------------
// GET /api/turns/[id] - Turn detail + inspection items + audit trail
// ---------------------------------------------------------------------------

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const turn = await getTurn(id);
    if (!turn) return Response.json({ error: 'Turn not found' }, { status: 404 });
    const [items, audit] = await Promise.all([listInspectionItems(id), listAuditLog(id)]);
    return Response.json({ turn, items, audit });
  } catch (err) {
    console.error(`[api/turns/${id}] GET error:`, err);
    return Response.json({ error: 'Failed to fetch turn' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/turns/[id] - Update turn status
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.status || !VALID_STATUSES.includes(body.status as TurnStatus)) {
    return Response.json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 });
  }
  const session = await auth();
  const byPerson = session?.user?.name ?? 'unknown';
  try {
    const updated = await updateTurnStatus(id, body.status as TurnStatus, byPerson);
    return Response.json({ turn: updated });
  } catch (err) {
    console.error(`[api/turns/${id}] PATCH error:`, err);
    return Response.json({ error: 'Failed to update turn' }, { status: 500 });
  }
}
