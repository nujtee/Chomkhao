/**
 * Stay-window rules shared by the Worker (enforcement) and the UI (date pickers).
 * These are business configuration; they move to admin settings in Phase 9.
 */
export const STAY_RULES = {
  maxNights: 30,
  /** How far ahead a stay may start (days from today). */
  maxAdvanceDays: 365,
  /** Admin availability grid window. */
  maxGridDays: 62,
} as const;

/** Money is integer satang in the API and DB (1 THB = 100 satang). */
export const SATANG_PER_BAHT = 100;
export const MAX_PRICE_SATANG = 100_000_000; // 1,000,000 THB

/** ฿3,500 for whole baht, ฿2,450.50 otherwise (never "2,450.5"). */
export function formatBaht(satang: number, locale: string): string {
  const digits = satang % SATANG_PER_BAHT === 0 ? 0 : 2;
  return new Intl.NumberFormat(locale, {
    style: "currency", currency: "THB", currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits,
  })
    .format(satang / SATANG_PER_BAHT);
}

/** "1,234.50" / "1234.5" → 123450 satang; null if not a valid non-negative amount with ≤ 2 decimals. */
export function parseBahtToSatang(input: string): number | null {
  const clean = input.replace(/[,\s฿]/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, frac = ""] = clean.split(".");
  return Number(whole) * SATANG_PER_BAHT + Number(frac.padEnd(2, "0"));
}

/** How a stay is paid: all now, or half of the stay now and the rest at reception before check-in (migration 0025). */
export const PAYMENT_MODES = ["FULL", "DEPOSIT_50"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/**
 * Amount asked online to confirm a DEPOSIT_50 booking: everything except half of the stay (accommodation + tarp
 * area). The half left for check-in is rounded down to whole baht, so the deposit is never less than half; food is
 * paid in full now. null = nothing would be left for later (pay the full total).
 */
export function depositDue(mode: PaymentMode, accommodationSubtotalSatang: number, totalSatang: number): number | null {
  if (mode !== "DEPOSIT_50") return null;
  const later = Math.min(Math.floor(accommodationSubtotalSatang / 2 / SATANG_PER_BAHT) * SATANG_PER_BAHT, totalSatang);
  const now = totalSatang - later;
  return later > 0 && now > 0 ? now : null;
}

/** What a booking still owes: the total minus money received (verified / paid payments, never below zero). */
export function balanceDue(totalSatang: number, paidSatang: number): number {
  return Math.max(0, totalSatang - paidSatang);
}
