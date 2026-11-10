import { listTurns } from '@/lib/data/turns';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/turns - List all turns (lean V1 field set, see lib/data/turns.ts)
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const turns = await listTurns();
    return Response.json({ turns });
  } catch (err) {
    console.error('[api/turns] GET error:', err);
    return Response.json({ error: 'Failed to fetch turns' }, { status: 500 });
  }
}
