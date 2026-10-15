import type {
  CreateBookingRequest,
  FoodCatalogueDto,
  FoodSelection,
  PublicBookingDto,
  QuoteDto,
  QuoteRequest,
} from "../../shared/booking-types.ts";
import type { BookingMessages } from "../../shared/i18n/booking-messages.ts";
import type { PaypalCaptureDto, PaypalOrderDto } from "../../shared/payment-types.ts";
import { ApiError, apiGet, apiRequest } from "../api/client.ts";

export function fetchFoodCatalogue(checkIn: string, checkOut: string, lang: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ checkIn, checkOut, lang });
  return apiGet<FoodCatalogueDto>(`/api/public/food-options?${params}`, signal);
}

/** Whether online booking is open right now (it pauses when the site's app credit runs out). */
export function fetchBookingStatus(signal?: AbortSignal) {
  return apiGet<{ open: boolean }>("/api/public/bookings/status", signal);
}

export function fetchQuote(body: QuoteRequest, signal?: AbortSignal) {
  return apiRequest<QuoteDto>("POST", "/api/public/bookings/quote", body, signal);
}

export function createBooking(body: CreateBookingRequest) {
  return apiRequest<PublicBookingDto>("POST", "/api/public/bookings", body);
}

export function lookupBooking(bookingCode: string, phone: string) {
  return apiRequest<PublicBookingDto>("POST", "/api/public/bookings/lookup", { bookingCode, phone });
}

// ------------------------------------------------------------------ PayPal Checkout

export function createPaypalOrder(bookingCode: string, phone: string) {
  return apiRequest<PaypalOrderDto>("POST", "/api/public/bookings/paypal/order", { bookingCode, phone });
}

export function capturePaypalOrder(orderId: string) {
  return apiRequest<PaypalCaptureDto>("POST", "/api/public/bookings/paypal/capture", { orderId });
}

export function cancelPaypalOrder(orderId: string) {
  return apiRequest<{ bookingCode: string | null }>("POST", "/api/public/bookings/paypal/cancel", { orderId });
}

const PAYPAL_MEMORY = "phasakura.paypal";

/**
 * The phone the guest proved ownership with, kept for this tab only while they are at PayPal, so the
 * booking can be shown again when PayPal sends them back. Read once, then removed.
 */
export function rememberForPaypal(bookingCode: string, phone: string): void {
  try {
    sessionStorage.setItem(PAYPAL_MEMORY, JSON.stringify({ code: bookingCode, phone, at: Date.now() }));
  } catch {
    // storage blocked: the guest types the phone again on return
  }
}

export function recallAfterPaypal(bookingCode: string | null): { code: string; phone: string } | null {
  try {
    const raw = sessionStorage.getItem(PAYPAL_MEMORY);
    sessionStorage.removeItem(PAYPAL_MEMORY);
    const v = raw ? (JSON.parse(raw) as { code?: unknown; phone?: unknown; at?: unknown }) : null;
    if (!v || typeof v.code !== "string" || typeof v.phone !== "string" || typeof v.at !== "number") return null;
    if (Date.now() - v.at > 3 * 60 * 60_000 || (bookingCode && v.code !== bookingCode)) return null;
    return { code: v.code, phone: v.phone };
  } catch {
    return null;
  }
}

/** Random key so a double click or retry cannot create two bookings. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Localised text for an API error: the first known field code, then the error code. */
export function bookingErrorText(bt: BookingMessages, error: unknown): string {
  const errors = bt.errors as Record<string, string>;
  if (error instanceof ApiError) {
    for (const code of Object.values(error.details)) if (errors[code]) return errors[code]!;
    if (errors[error.code]) return errors[error.code]!;
    if (error.status === 429) return bt.errors.TOO_MANY_REQUESTS;
    if (error.status === 0) return bt.errors.NETWORK;
  }
  return bt.errors.UNKNOWN;
}

/** Food selection keyed by "optionId|date". */
export type FoodCart = Record<string, { adults: number; children: number; quantity: number }>;

export function cartToSelections(cart: FoodCart, perPerson: (optionId: string) => boolean): FoodSelection[] {
  return Object.entries(cart).flatMap(([key, v]): FoodSelection[] => {
    const [optionId, serviceDate] = key.split("|") as [string, string];
    if (perPerson(optionId)) {
      return v.adults + v.children > 0 ? [{ optionId, serviceDate, adults: v.adults, children: v.children }] : [];
    }
    return v.quantity > 0 ? [{ optionId, serviceDate, quantity: v.quantity }] : [];
  });
}
