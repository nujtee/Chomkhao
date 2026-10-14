import { useEffect } from "react";
import type { PublicCampingDto, PublicUnitDto } from "../../shared/accommodation-types.ts";
import type { TrackItem } from "../../shared/analytics.ts";
import type { FoodCatalogueDto, PublicBookingDto, QuoteDto } from "../../shared/booking-types.ts";
import type { FoodCart } from "../booking/api.ts";
import { track, trackOnce } from "./tracker.ts";

/** Website events of the booking flow (spec §43–44). Only ids, names and prices — never guest details. */

const baht = (satang: number) => Math.round(satang) / 100;

export function unitItem(unit: PublicUnitDto): TrackItem {
  return { id: unit.slug, name: unit.name, category: unit.unitType, price: baht(unit.priceSatang), quantity: 1 };
}

export function campingItem(camping: Pick<PublicCampingDto, "name" | "pricePerAdultNightSatang"> | null, fallbackName: string, tents: number): TrackItem {
  return { id: "camping", name: camping?.name ?? fallbackName, category: "CAMPING", price: baht(camping?.pricePerAdultNightSatang ?? 0), quantity: tents };
}

/** Stays + paid food lines of a price quote (several stays: one item each). */
export function quoteItems(q: QuoteDto): TrackItem[] {
  const stays = (q.items?.length ? q.items : [q.item]).filter((x) => x.status !== "CANCELLED").map((x): TrackItem => ({
    id: x.type === "OWN_TENT" ? "camping" : x.slug ?? x.type,
    name: x.name,
    category: x.type === "OWN_TENT" ? "CAMPING" : x.type,
    price: baht(x.subtotalSatang / Math.max(1, x.quantity)),
    quantity: x.quantity,
  }));
  const food = q.food.filter((f) => f.subtotalSatang > 0).map((f): TrackItem => ({
    id: f.optionId, name: f.name, category: "FOOD", price: baht(f.unitPriceSatang), quantity: Math.max(1, f.quantity || f.adults + f.children),
  }));
  // Camping add-on: price for the whole stay per area.
  const tarp: TrackItem[] = q.tarp
    ? [{ id: "camping_tarp", name: "Tarp area", category: "CAMPING", price: baht(q.tarp.subtotalSatang / q.tarp.quantity), quantity: q.tarp.quantity }]
    : [];
  return [...stays, ...tarp, ...food];
}

const count = (v: FoodCart[string] | undefined) => (v ? Math.max(v.quantity, v.adults + v.children) : 0);

/** select_food when a dish is first picked, add_food for every increase. */
export function foodChangeEvents(prev: FoodCart, next: FoodCart, catalogue: FoodCatalogueDto | null): void {
  for (const [key, value] of Object.entries(next)) {
    const before = count(prev[key]);
    const after = count(value);
    if (after <= before) continue;
    const optionId = key.split("|")[0]!;
    const option = catalogue?.categories.flatMap((c) => c.options).find((o) => o.id === optionId);
    if (!option) continue;
    const item: TrackItem = { id: option.id, name: option.name, category: "FOOD", price: baht(option.priceSatang), quantity: after - before };
    if (before === 0) track({ name: "select_food", item });
    track({ name: "add_food", item });
  }
}

const SOLD = new Set(["CONFIRMED", "CHECKED_IN", "CHECKED_OUT"]);

/**
 * Purchase / booking_confirmed in the browser only once the server says the booking is confirmed
 * (payment verified). Once per booking per browser; Meta keeps one copy of browser + server events
 * (same event_id), GA4 one purchase per transaction_id.
 */
export function useConfirmedBookingEvent(booking: PublicBookingDto | null): void {
  const code = booking?.bookingCode;
  const sold = !!booking && SOLD.has(booking.status);
  useEffect(() => {
    if (!booking || !sold) return;
    trackOnce(`purchase.${booking.bookingCode}`, { name: "booking_confirmed", bookingCode: booking.bookingCode, value: baht(booking.totalSatang), items: quoteItems(booking) });
  }, [code, sold]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function paymentSubmittedEvent(booking: PublicBookingDto): void {
  track({ name: "payment_submitted", bookingCode: booking.bookingCode, value: baht(booking.totalSatang) });
}
