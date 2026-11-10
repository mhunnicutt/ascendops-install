import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import type { Turn, TurnStatus } from '@/lib/data/turns';

const STATUS_VARIANT: Record<TurnStatus, 'secondary' | 'default' | 'outline' | 'destructive'> = {
  INSPECTION_PULLED: 'secondary',
  REVIEW_IN_PROGRESS: 'default',
  REVIEW_COMPLETE: 'default',
  WOS_ACTIVE: 'destructive',
  CLOSED: 'outline',
};

function daysSince(dateStr: string): number {
  const ms = Date.now() - new Date(dateStr).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

export function TurnsTable({ turns }: { turns: Turn[] }) {
  if (turns.length === 0) {
    return <p className="text-sm text-muted-foreground">No turns yet. The AppFolio sync populates this list.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Property / Unit</TableHead>
          <TableHead>Move-Out</TableHead>
          <TableHead>Age</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Flags</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {turns.map((turn) => (
          <TableRow key={turn.id}>
            <TableCell>
              <Link href={`/turns/${turn.id}`} className="font-medium hover:underline">
                {turn.property_name ?? 'Unknown property'} — {turn.unit_label ?? turn.unit_id ?? '—'}
              </Link>
            </TableCell>
            <TableCell>{turn.move_out_date}</TableCell>
            <TableCell>{daysSince(turn.move_out_date)}d</TableCell>
            <TableCell>{turn.turn_type ?? '—'}</TableCell>
            <TableCell>
              <Badge variant={STATUS_VARIANT[turn.status]}>{turn.status.replaceAll('_', ' ')}</Badge>
            </TableCell>
            <TableCell className="space-x-1">
              {turn.rekey_flag && <Badge variant="outline">Rekey</Badge>}
              {turn.owner_exception_flag && <Badge variant="outline">Owner exception</Badge>}
              {turn.move_in_date_ambiguous && <Badge variant="outline">Tenancy unclear</Badge>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
