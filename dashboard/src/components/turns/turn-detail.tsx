'use client';

import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import type { Turn, TurnInspectionItem, TurnAuditEntry, TurnStatus, TurnType, ClosePath, ItemClassification, ItemStatus } from '@/lib/data/turns';

// CLOSED is reached only via the dedicated Close action below (which also
// requires a close_path) or by the AppFolio sync -- never offered in this
// dropdown, so a turn can't land in Closed without a path recorded or an
// AppFolio TurnEndDate behind it.
const STATUSES: TurnStatus[] = ['INSPECTION_PULLED', 'REVIEW_IN_PROGRESS', 'REVIEW_COMPLETE', 'WOS_ACTIVE'];
const TURN_TYPES: TurnType[] = ['FPM', 'OWNER', 'HYBRID'];
const CLASSIFICATIONS: ItemClassification[] = ['TCB', 'NORMAL_WEAR', 'NOT_NEEDED'];
const ITEM_STATUSES: ItemStatus[] = ['NEEDED', 'ASSIGNED', 'COMPLETED'];
const CLOSE_PATH_LABEL: Record<ClosePath, string> = { to_marketing: 'To Marketing', no_longer_managing: 'No Longer Managing' };

function centsToDollars(cents: number | null): string {
  if (cents === null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

export function TurnDetail({
  turn: initialTurn,
  items: initialItems,
  audit,
}: {
  turn: Turn;
  items: TurnInspectionItem[];
  audit: TurnAuditEntry[];
}) {
  const [turn, setTurn] = useState(initialTurn);
  const [items, setItems] = useState(initialItems);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onStatusChange(status: TurnStatus) {
    setError(null);
    startTransition(async () => {
      const resp = await fetch(`/api/turns/${turn.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!resp.ok) {
        setError('Failed to update status.');
        return;
      }
      const { turn: updated } = await resp.json();
      setTurn(updated);
    });
  }

  function onTurnTypeChange(turn_type: TurnType) {
    setError(null);
    startTransition(async () => {
      const resp = await fetch(`/api/turns/${turn.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turn_type }),
      });
      if (!resp.ok) {
        setError('Failed to update turn type.');
        return;
      }
      const { turn: updated } = await resp.json();
      setTurn(updated);
    });
  }

  function onClose(closePath: ClosePath) {
    setError(null);
    startTransition(async () => {
      const resp = await fetch(`/api/turns/${turn.id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ close_path: closePath }),
      });
      if (!resp.ok) {
        setError('Failed to close turn.');
        return;
      }
      const { turn: updated } = await resp.json();
      setTurn(updated);
    });
  }

  function onItemChange(itemId: string, patch: Partial<Pick<TurnInspectionItem, 'classification' | 'item_status' | 'wo_vendor'>>) {
    setError(null);
    startTransition(async () => {
      const resp = await fetch(`/api/turns/${turn.id}/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!resp.ok) {
        setError('Failed to update item.');
        return;
      }
      const { item: updated } = await resp.json();
      setItems((prev) => prev.map((i) => (i.id === itemId ? updated : i)));
    });
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {turn.property_name ?? 'Unknown property'} — {turn.unit_label ?? turn.unit_id ?? '—'}
        </h1>
        <p className="text-sm text-muted-foreground">
          Move-out {turn.move_out_date}
          {turn.move_in_date && ` · Move-in ${turn.move_in_date}${turn.move_in_date_ambiguous ? ' (ambiguous — 2+ matching tenancies)' : ''}`}
          {turn.tenancy_length_days !== null && ` · ${turn.tenancy_length_days}d tenancy`}
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4">
          {turn.status === 'CLOSED' ? (
            <Badge variant="outline">
              Closed{turn.close_path ? ` — ${CLOSE_PATH_LABEL[turn.close_path]}` : ' — closed in AppFolio'}
            </Badge>
          ) : (
            <select
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              value={turn.status}
              disabled={isPending}
              onChange={(e) => onStatusChange(e.target.value as TurnStatus)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          )}
          <select
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            value={turn.turn_type ?? ''}
            disabled={isPending}
            onChange={(e) => onTurnTypeChange(e.target.value as TurnType)}
          >
            <option value="" disabled>
              Set type…
            </option>
            {TURN_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <span className="text-sm text-muted-foreground">SD available: {centsToDollars(turn.sd_available_cents)}</span>
          {turn.rekey_flag && <Badge variant="outline">Rekey</Badge>}
          {turn.owner_exception_flag && (
            <Badge variant="outline" title="Owner has a standing rekey policy -- confirm before dispatching a rekey vendor">
              Owner exception
            </Badge>
          )}
          {turn.status !== 'CLOSED' && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Close turn:</span>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                disabled={isPending}
                onClick={() => onClose('to_marketing')}
              >
                To Marketing
              </button>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                disabled={isPending}
                onClick={() => onClose('no_longer_managing')}
              >
                No Longer Managing
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inspection items</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No flagged items on this turn.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Room</TableHead>
                  <TableHead>Classification</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>TCB</TableHead>
                  <TableHead>Vendor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="font-medium">{item.description}</div>
                      {item.ashley_annotation && (
                        <div className="text-xs text-muted-foreground">{item.ashley_annotation}</div>
                      )}
                    </TableCell>
                    <TableCell>{item.room_area ?? '—'}</TableCell>
                    <TableCell>
                      <select
                        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                        value={item.classification ?? ''}
                        disabled={isPending}
                        onChange={(e) =>
                          onItemChange(item.id, { classification: (e.target.value || null) as ItemClassification })
                        }
                      >
                        <option value="">Unclassified</option>
                        {CLASSIFICATIONS.map((c) => (
                          <option key={c} value={c}>
                            {c.replaceAll('_', ' ')}
                          </option>
                        ))}
                      </select>
                    </TableCell>
                    <TableCell>
                      <select
                        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                        value={item.item_status}
                        disabled={isPending}
                        onChange={(e) => onItemChange(item.id, { item_status: e.target.value as ItemStatus })}
                      >
                        {ITEM_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </TableCell>
                    <TableCell>{centsToDollars(item.tcb_amount_cents)}</TableCell>
                    <TableCell>{item.wo_vendor ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {audit.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Audit trail</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {audit.map((entry) => (
              <p key={entry.id} className="text-xs text-muted-foreground">
                {new Date(entry.at).toLocaleString()} — {entry.by_person} — {entry.action}
              </p>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
