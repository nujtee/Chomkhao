import type { MoveDayState } from "../../shared/booking-types.ts";
import { addDays } from "../../shared/dates.ts";

/** How far ahead a stay can be moved. */
export const MOVE_MAX_DAYS_AHEAD = 730;

export interface MoveInputs {
  /** The booking's current stay. */
  checkIn: string;
  nights: number;
  today: string;
  /** A house / VIP tent: nights held by another booking or blocked (the booking's own nights excluded). */
  unitTaken: ReadonlySet<string> | null;
  /** Own-tent camping: tents needed, and tents free on a date counting this booking's own as free. */
  tents: { need: number; free: (date: string) => number } | null;
  tarps: { need: number; free: (date: string) => number } | null;
  /** The booking's meal orders that hold kitchen capacity: day offset from check-in, and how many. */
  food: { offset: number; categoryId: string; need: number }[];
  foodFree: (categoryId: string, date: string) => number;
}

/**
 * Whether the stay could start on `date` instead (same number of nights). Pure: the data comes from D1 and
 * the D1 batch of the move re-checks every limit itself (PK / CHECK constraints), so this only paints the
 * calendar and gives a clear reason before trying.
 */
export function moveDayState(date: string, x: MoveInputs): MoveDayState {
  if (date === x.checkIn) return "CURRENT";
  if (date < x.today) return "PAST";
  if (date > addDays(x.today, MOVE_MAX_DAYS_AHEAD)) return "TOO_FAR";
  const nights = Array.from({ length: x.nights }, (_, i) => addDays(date, i));
  if (x.unitTaken && nights.some((n) => x.unitTaken!.has(n))) return "TAKEN";
  if (x.tents && nights.some((n) => x.tents!.free(n) < x.tents!.need)) return "TAKEN";
  if (x.tarps && nights.some((n) => x.tarps!.free(n) < x.tarps!.need)) return "TARP_FULL";
  if (x.food.some((f) => x.foodFree(f.categoryId, addDays(date, f.offset)) < f.need)) return "FOOD_FULL";
  return "OK";
}
