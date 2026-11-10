import { listTurns } from '@/lib/data/turns';
import { groupTurns, type TurnTypeGroup, type ClosePathGroup } from '@/lib/data/turns-grouping';
import { TurnsTable } from '@/components/turns/turns-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

const TURN_TYPE_LABEL: Record<TurnTypeGroup, string> = {
  FPM: 'FPM',
  HYBRID: 'Hybrid',
  OWNER: 'Owner',
  UNSET: 'Type not set',
};

const CLOSE_PATH_LABEL: Record<ClosePathGroup, string> = {
  to_marketing: 'To Marketing',
  no_longer_managing: 'No Longer Managing',
  APPFOLIO_CLOSED: 'Closed in AppFolio',
};

export default async function TurnsPage() {
  const turns = await listTurns();
  const board = groupTurns(turns);
  const activeCount = (['FPM', 'HYBRID', 'OWNER', 'UNSET'] as const).reduce((n, k) => n + board.active[k].length, 0);
  const closedCount = (['to_marketing', 'no_longer_managing', 'APPFOLIO_CLOSED'] as const).reduce(
    (n, k) => n + board.closed[k].length,
    0,
  );

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Make-Ready Turns</h1>
        <p className="text-sm text-muted-foreground">
          {activeCount} active · {board.upcoming.length} upcoming · {closedCount} closed
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Active</h2>
        {activeCount === 0 ? (
          <p className="text-sm text-muted-foreground">No active turns.</p>
        ) : (
          (['FPM', 'HYBRID', 'OWNER', 'UNSET'] as const)
            .filter((k) => board.active[k].length > 0)
            .map((k) => (
              <Card key={k}>
                <CardHeader>
                  <CardTitle>
                    {TURN_TYPE_LABEL[k]} ({board.active[k].length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <TurnsTable turns={board.active[k]} />
                </CardContent>
              </Card>
            ))
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Upcoming</h2>
        <Card>
          <CardContent>
            <TurnsTable turns={board.upcoming} />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Closed</h2>
        {closedCount === 0 ? (
          <p className="text-sm text-muted-foreground">No closed turns yet.</p>
        ) : (
          (['to_marketing', 'no_longer_managing', 'APPFOLIO_CLOSED'] as const)
            .filter((k) => board.closed[k].length > 0)
            .map((k) => (
              <Card key={k}>
                <CardHeader>
                  <CardTitle>
                    {CLOSE_PATH_LABEL[k]} ({board.closed[k].length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <TurnsTable turns={board.closed[k]} />
                </CardContent>
              </Card>
            ))
        )}
      </section>
    </div>
  );
}
