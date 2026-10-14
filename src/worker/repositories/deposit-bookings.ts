import type { DepositBookingsDto } from "../../shared/accommodation-types.ts";
import type { D1DatabaseLike } from "../env.ts";
import { PAID_SQL } from "./booking.repository.ts";
import { withFallback } from "./schema-fallback.ts";

/**
 * Open deposit bookings of one house / VIP tent (`unitId`), or of the camping ground (`unitId` = null): confirmed ones
 * that still owe the rest, and those still waiting for the deposit. Their deposit is frozen (trigger
 * trg_bookings_deposit_frozen), so they keep the deposit plan when the owner switches the stay to full payment —
 * this tells the owner how many there are. Before migration 0025 there are none.
 */
export function openDepositBookings(db: D1DatabaseLike, unitId: string | null, now: string): Promise<DepositBookingsDto> {
  const none: DepositBookingsDto = { paid: 0, dueSatang: 0, awaiting: 0 };
  return withFallback(async () => {
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN booking_status = 'CONFIRMED' AND due > 0 THEN 1 ELSE 0 END), 0) AS paid,
                COALESCE(SUM(CASE WHEN booking_status = 'CONFIRMED' AND due > 0 THEN due ELSE 0 END), 0) AS due_satang,
                COALESCE(SUM(CASE WHEN booking_status = 'PENDING' THEN 1 ELSE 0 END), 0) AS awaiting
           FROM (SELECT b.booking_status,
                        b.total_satang - ${PAID_SQL} AS due
                   FROM bookings b
                  WHERE b.deposit_satang IS NOT NULL
                    AND (b.booking_status = 'CONFIRMED' OR (b.booking_status = 'PENDING' AND (b.expires_at IS NULL OR b.expires_at > ?2)))
                    AND EXISTS (SELECT 1 FROM booking_items i WHERE i.booking_id = b.id
                                  AND ((?1 IS NULL AND i.item_type = 'OWN_TENT') OR i.unit_id = ?1)))`,
      )
      .bind(unitId, now)
      .first<{ paid: number; due_satang: number; awaiting: number }>();
    return row ? { paid: row.paid, dueSatang: row.due_satang, awaiting: row.awaiting } : none;
  }, async () => none);
}

/**
 * How the stay of booking `bookingId` is paid TODAY (its house / VIP tent, or the camping ground) — not how this
 * booking is paid, which was fixed when it was made.
 */
export function currentPaymentMode(db: D1DatabaseLike, bookingId: string): Promise<"FULL" | "DEPOSIT_50"> {
  return withFallback(async () => {
    const row = await db
      .prepare(
        `SELECT CASE WHEN i.item_type = 'OWN_TENT' THEN (SELECT payment_mode FROM camping_settings WHERE id = 1)
                     ELSE (SELECT payment_mode FROM accommodation_units WHERE id = i.unit_id) END AS mode
           FROM booking_items i WHERE i.booking_id = ?1 ORDER BY i.created_at, i.id LIMIT 1`,
      )
      .bind(bookingId)
      .first<{ mode: "FULL" | "DEPOSIT_50" | null }>();
    return row?.mode ?? "FULL";
  }, async () => "FULL" as const);
}
