import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { updateInspectionItem, type ItemClassification, type ItemStatus } from '@/lib/data/turns';

export const dynamic = 'force-dynamic';

const VALID_CLASSIFICATIONS: ItemClassification[] = ['TCB', 'NORMAL_WEAR', 'NOT_NEEDED'];
const VALID_ITEM_STATUSES: ItemStatus[] = ['NEEDED', 'ASSIGNED', 'COMPLETED'];

interface ItemPatchBody {
  classification?: ItemClassification;
  item_status?: ItemStatus;
  ashley_annotation?: string;
  wo_vendor?: string;
  wo_sort_order?: number;
  tcb_amount_cents?: number;
}

// ---------------------------------------------------------------------------
// PATCH /api/turns/[id]/items/[itemId] - Update one inspection item
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id, itemId } = await params;
  let body: ItemPatchBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (body.classification !== undefined && !VALID_CLASSIFICATIONS.includes(body.classification)) {
    return Response.json({ error: `classification must be one of: ${VALID_CLASSIFICATIONS.join(', ')}` }, { status: 400 });
  }
  if (body.item_status !== undefined && !VALID_ITEM_STATUSES.includes(body.item_status)) {
    return Response.json({ error: `item_status must be one of: ${VALID_ITEM_STATUSES.join(', ')}` }, { status: 400 });
  }

  const session = await auth();
  const byPerson = session?.user?.name ?? 'unknown';
  try {
    const updated = await updateInspectionItem(id, itemId, body, byPerson);
    return Response.json({ item: updated });
  } catch (err) {
    console.error(`[api/turns/${id}/items/${itemId}] PATCH error:`, err);
    return Response.json({ error: 'Failed to update inspection item' }, { status: 500 });
  }
}
