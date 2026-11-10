// Make-Ready Turns — data layer.
//
// Reads/writes the Supabase turns/turn_inspection_items/turn_audit_log tables
// (orgs/foothills-pm/scripts/make-ready-turns/supabase/001_turns_schema.sql,
// live 2026-11-10). Lean V1 field set only (Option 1, confirmed by Maranda
// 2026-11-10): no room inventories, equipment/standards checklists, pre-move-
// out visits, final-lock-verification detail, or a separate leasing sign-off
// -- see reports/make-ready-turns-ui-adaptation-plan-2026-11-10.md for the
// full starter-vs-schema mapping that this intentionally does not cover yet.
//
// Access model (Maranda, 2026-11-09): global role check. Any signed-in
// dashboard user sees/edits every turn -- enforced by the dashboard's
// existing middleware (src/middleware.ts), not here. No per-turn ACL.
import { supabaseSelect, supabaseSelectOne, supabaseUpdate, supabaseInsert } from './supabase';

export type TurnType = 'FPM' | 'OWNER' | 'HYBRID';
export type TurnStatus = 'INSPECTION_PULLED' | 'REVIEW_IN_PROGRESS' | 'REVIEW_COMPLETE' | 'WOS_ACTIVE' | 'CLOSED';
export type ItemClassification = 'TCB' | 'NORMAL_WEAR' | 'NOT_NEEDED';
export type ItemStatus = 'NEEDED' | 'ASSIGNED' | 'COMPLETED';

export interface Turn {
  id: string;
  appfolio_unit_turn_id: number | null;
  property_id: string | null;
  unit_id: string | null;
  property_name: string | null;
  unit_label: string | null;
  move_out_date: string;
  move_in_date: string | null;
  move_in_date_ambiguous: boolean;
  tenancy_length_days: number | null;
  turn_type: TurnType | null; // null until the LeadSimple "09 Unit Turn" lookup is built (002_turns_turn_type_nullable.sql)
  status: TurnStatus;
  sd_available_cents: number | null;
  rekey_flag: boolean;
  owner_exception_flag: boolean;
  leadsimple_process_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface TurnInspectionItem {
  id: string;
  turn_id: string;
  zinspector_item_id: string | null;
  description: string;
  room_area: string | null;
  inspector_notes: string | null;
  ashley_annotation: string | null;
  photo_url: string | null;
  classification: ItemClassification | null;
  item_status: ItemStatus;
  tcb_amount_cents: number | null;
  wo_vendor: string | null;
  wo_sort_order: number | null;
  created_at: string;
  updated_at: string;
}

export interface TurnAuditEntry {
  id: string;
  turn_id: string;
  item_id: string | null;
  action: string;
  by_person: string;
  details: unknown;
  at: string;
}

export async function listTurns(): Promise<Turn[]> {
  return supabaseSelect<Turn>('turns', { order: 'move_out_date.asc' });
}

export async function getTurn(id: string): Promise<Turn | null> {
  return supabaseSelectOne<Turn>('turns', { filters: { id: `eq.${id}` } });
}

export async function listInspectionItems(turnId: string): Promise<TurnInspectionItem[]> {
  return supabaseSelect<TurnInspectionItem>('turn_inspection_items', {
    filters: { turn_id: `eq.${turnId}` },
    order: 'wo_sort_order.asc',
  });
}

export async function listAuditLog(turnId: string): Promise<TurnAuditEntry[]> {
  return supabaseSelect<TurnAuditEntry>('turn_audit_log', {
    filters: { turn_id: `eq.${turnId}` },
    order: 'at.desc',
  });
}

export async function logTurnAudit(entry: {
  turn_id: string;
  item_id?: string;
  action: string;
  by_person: string;
  details?: unknown;
}): Promise<void> {
  await supabaseInsert('turn_audit_log', entry);
}

export async function updateTurnStatus(id: string, status: TurnStatus, byPerson: string): Promise<Turn> {
  const [updated] = await supabaseUpdate<Turn>('turns', { id: `eq.${id}` }, { status });
  await logTurnAudit({ turn_id: id, action: 'STATUS_CHANGE', by_person: byPerson, details: { status } });
  return updated;
}

export async function updateInspectionItem(
  turnId: string,
  itemId: string,
  patch: Partial<Pick<TurnInspectionItem, 'classification' | 'item_status' | 'ashley_annotation' | 'wo_vendor' | 'wo_sort_order' | 'tcb_amount_cents'>>,
  byPerson: string,
): Promise<TurnInspectionItem> {
  const [updated] = await supabaseUpdate<TurnInspectionItem>('turn_inspection_items', { id: `eq.${itemId}` }, patch);
  await logTurnAudit({ turn_id: turnId, item_id: itemId, action: 'ITEM_UPDATE', by_person: byPerson, details: patch });
  return updated;
}
