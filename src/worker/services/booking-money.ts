import type { BookingRow } from "../repositories/booking.repository.ts";

/**
 * Money of one booking (deposit plan, migration 0025). Kept apart so the booking, payment, slip and PayPal
 * services agree on the same two numbers.
 */

/** Amount asked online to confirm a booking: the deposit on a deposit plan, else the whole total. */
export function dueOnline(row: Pick<BookingRow, "deposit_satang" | "total_satang">): number {
  return row.deposit_satang ?? row.total_satang;
}

/** Money received: verified / paid payments. */
export function paidOf(payments: { status: string; amount_satang: number }[]): number {
  return payments.filter((p) => p.status === "VERIFIED" || p.status === "PAID").reduce((acc, p) => acc + p.amount_satang, 0);
}
