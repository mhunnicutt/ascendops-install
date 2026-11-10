// Make-Ready Turns — board grouping (Maranda, 2026-11-10).
//
// Three sections: Active (move-out date has passed, not yet closed --
// grouped by turn_type), Upcoming (move-out date hasn't arrived yet), and
// Closed (sub-divided by close_path). Pure and date-injectable so it's
// testable without mocking the clock.
import type { Turn, TurnType, ClosePath } from './turns';

export type TurnTypeGroup = TurnType | 'UNSET';
export type ClosePathGroup = ClosePath | 'APPFOLIO_CLOSED';

export interface TurnBoard {
  active: Record<TurnTypeGroup, Turn[]>;
  upcoming: Turn[];
  closed: Record<ClosePathGroup, Turn[]>;
}

const TURN_TYPE_GROUPS: TurnTypeGroup[] = ['FPM', 'HYBRID', 'OWNER', 'UNSET'];
const CLOSE_PATH_GROUPS: ClosePathGroup[] = ['to_marketing', 'no_longer_managing', 'APPFOLIO_CLOSED'];

function emptyGroups<K extends string>(keys: K[]): Record<K, Turn[]> {
  const result = {} as Record<K, Turn[]>;
  for (const k of keys) result[k] = [];
  return result;
}

export function groupTurns(turns: Turn[], today: Date = new Date()): TurnBoard {
  const todayStr = today.toISOString().slice(0, 10);
  const active = emptyGroups(TURN_TYPE_GROUPS);
  const upcoming: Turn[] = [];
  const closed = emptyGroups(CLOSE_PATH_GROUPS);

  for (const turn of turns) {
    if (turn.status === 'CLOSED') {
      closed[turn.close_path ?? 'APPFOLIO_CLOSED'].push(turn);
    } else if (turn.move_out_date > todayStr) {
      upcoming.push(turn);
    } else {
      active[turn.turn_type ?? 'UNSET'].push(turn);
    }
  }

  return { active, upcoming, closed };
}
