import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import {
  getTurn,
  listInspectionItems,
  listAuditLog,
  updateTurnStatus,
  updateTurnType,
  type TurnStatus,
  type TurnType,
} from '@/lib/data/turns';

export const dynamic = 'force-dynamic';

// CLOSED is deliberately not settable here -- it requires a close_path
// (Maranda, 2026-11-10), so it only happens via POST /api/turns/[id]/close
// or the AppFolio sync picking up a TurnEndDate on an already-tracked turn.
const VALID_STATUSES: TurnStatus[] = [
  'INSPECTION_PULLED',
  'REVIEW_IN_PROGRESS',
  'REVIEW_COMPLETE',
  'WOS_ACTIVE',
];

const VALID_TURN_TYPES: TurnType[] = ['FPM', 'OWNER', 'HYBRID'];

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
// PATCH /api/turns/[id] - Update turn status and/or turn_type
//
// turn_type is user-editable (Maranda, 2026-11-10): Lorrie sets/changes it
// via a dropdown, not agent-auto-classified. Each field updates and audits
// independently so a client can send either or both in one request.
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { status?: string; turn_type?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (body.status !== undefined && !VALID_STATUSES.includes(body.status as TurnStatus)) {
    return Response.json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 });
  }
  if (body.turn_type !== undefined && !VALID_TURN_TYPES.includes(body.turn_type as TurnType)) {
    return Response.json({ error: `turn_type must be one of: ${VALID_TURN_TYPES.join(', ')}` }, { status: 400 });
  }
  if (body.status === undefined && body.turn_type === undefined) {
    return Response.json({ error: 'status or turn_type is required' }, { status: 400 });
  }

  const session = await auth();
  const byPerson = session?.user?.name ?? 'unknown';
  try {
    let updated = await getTurn(id);
    if (!updated) return Response.json({ error: 'Turn not found' }, { status: 404 });
    if (body.status !== undefined) updated = await updateTurnStatus(id, body.status as TurnStatus, byPerson);
    if (body.turn_type !== undefined) updated = await updateTurnType(id, body.turn_type as TurnType, byPerson);
    return Response.json({ turn: updated });
  } catch (err) {
    console.error(`[api/turns/${id}] PATCH error:`, err);
    return Response.json({ error: 'Failed to update turn' }, { status: 500 });
  }
}
