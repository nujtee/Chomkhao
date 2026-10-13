import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MoveDayState } from "../../src/shared/booking-types.ts";
import { MOVE_TONE, monthWeeks } from "../../src/client/admin/bookings/MoveDates.tsx";
import { adminEn, adminTh, adminZhCN } from "../../src/shared/i18n/admin-messages.ts";

describe("change dates calendar", () => {
  it("weeks start on Sunday: February 2027 starts on a Monday, March 2026 on a Sunday", () => {
    const feb = Array.from({ length: 28 }, (_, i) => i + 1);
    const weeks = monthWeeks("2027-02-01", feb);
    assert.deepEqual(weeks[0], [null, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(weeks.at(-1), [28, null, null, null, null, null, null]);
    assert.ok(weeks.every((w) => w.length === 7));
    assert.deepEqual(monthWeeks("2026-03-01", [1, 2])[0], [1, 2, null, null, null, null, null]);
  });

  it("only a free day is green; every taken reason is red; past / too far are grey", () => {
    const tones = Object.fromEntries(Object.entries(MOVE_TONE)) as Record<MoveDayState, string>;
    assert.deepEqual(Object.keys(tones).filter((s) => tones[s as MoveDayState] === "ok"), ["OK"]);
    assert.deepEqual(["TAKEN", "FOOD_FULL", "TARP_FULL"].map((s) => tones[s as MoveDayState]), ["taken", "taken", "taken"]);
    assert.deepEqual(["PAST", "TOO_FAR"].map((s) => tones[s as MoveDayState]), ["off", "off"]);
  });

  it("every refusal the Worker can give has a message in all three languages", () => {
    for (const dict of [adminTh, adminEn, adminZhCN]) {
      const errors = dict.errors as Record<string, string>;
      for (const code of ["DATES_UNAVAILABLE", "TARP_FULL", "FOOD_UNAVAILABLE", "KITCHEN_STARTED", "SAME_DATES", "DATE_TOO_FAR", "BOOKING_CHANGED"]) {
        assert.ok(errors[code], code);
      }
    }
  });
});
