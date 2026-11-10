import { describe, expect, it } from 'vitest';
import { groupTurns } from '../turns-grouping';
import type { Turn } from '../turns';

function baseTurn(overrides: Partial<Turn>): Turn {
  return {
    id: 'x',
    appfolio_unit_turn_id: 1,
    property_id: null,
    unit_id: null,
    property_name: null,
    unit_label: null,
    move_out_date: '2026-11-01',
    move_in_date: null,
    move_in_date_ambiguous: false,
    tenancy_length_days: null,
    turn_type: null,
    status: 'INSPECTION_PULLED',
    sd_available_cents: null,
    rekey_flag: false,
    owner_exception_flag: false,
    leadsimple_process_id: null,
    close_path: null,
    revision: 0,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

const TODAY = new Date('2026-11-10T12:00:00Z');

describe('groupTurns', () => {
  it('puts a past move-out, open turn into active, grouped by turn_type', () => {
    const t = baseTurn({ id: 'a', move_out_date: '2026-11-01', turn_type: 'FPM' });
    const board = groupTurns([t], TODAY);
    expect(board.active.FPM).toEqual([t]);
    expect(board.active.UNSET).toEqual([]);
    expect(board.upcoming).toEqual([]);
  });

  it('buckets a null turn_type into UNSET within active', () => {
    const t = baseTurn({ id: 'b', move_out_date: '2026-11-01', turn_type: null });
    const board = groupTurns([t], TODAY);
    expect(board.active.UNSET).toEqual([t]);
  });

  it('puts a future move-out, open turn into upcoming regardless of turn_type', () => {
    const t = baseTurn({ id: 'c', move_out_date: '2026-12-01', turn_type: 'OWNER' });
    const board = groupTurns([t], TODAY);
    expect(board.upcoming).toEqual([t]);
    expect(board.active.OWNER).toEqual([]);
  });

  it('treats today as already past move-out (active, not upcoming)', () => {
    const t = baseTurn({ id: 'd', move_out_date: '2026-11-10' });
    const board = groupTurns([t], TODAY);
    expect(board.upcoming).toEqual([]);
    expect(board.active.UNSET).toEqual([t]);
  });

  it('closed turns go to closed, sub-divided by close_path', () => {
    const toMarketing = baseTurn({ id: 'e', status: 'CLOSED', close_path: 'to_marketing' });
    const noLongerManaging = baseTurn({ id: 'f', status: 'CLOSED', close_path: 'no_longer_managing' });
    const closedByAppfolio = baseTurn({ id: 'g', status: 'CLOSED', close_path: null });
    const board = groupTurns([toMarketing, noLongerManaging, closedByAppfolio], TODAY);
    expect(board.closed.to_marketing).toEqual([toMarketing]);
    expect(board.closed.no_longer_managing).toEqual([noLongerManaging]);
    expect(board.closed.APPFOLIO_CLOSED).toEqual([closedByAppfolio]);
  });

  it('a closed turn never lands in active or upcoming even with a future move-out', () => {
    const t = baseTurn({ id: 'h', status: 'CLOSED', close_path: 'to_marketing', move_out_date: '2027-01-01' });
    const board = groupTurns([t], TODAY);
    expect(board.closed.to_marketing).toEqual([t]);
    expect(board.upcoming).toEqual([]);
  });
});
