import { listTurns } from '@/lib/data/turns';
import { TurnsTable } from '@/components/turns/turns-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function TurnsPage() {
  const turns = await listTurns();
  const open = turns.filter((t) => t.status !== 'CLOSED');

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Make-Ready Turns</h1>
        <p className="text-sm text-muted-foreground">
          {open.length} open turn{open.length === 1 ? '' : 's'} of {turns.length} total.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>All turns</CardTitle>
        </CardHeader>
        <CardContent>
          <TurnsTable turns={turns} />
        </CardContent>
      </Card>
    </div>
  );
}
