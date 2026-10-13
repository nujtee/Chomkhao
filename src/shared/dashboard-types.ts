/** Admin dashboard (spec §48) and booking calendar (spec §49) API contract. */
import type { StayActionsDto } from "./stay.ts";
import type { BookingStatus, PaymentStatus } from "./booking-types.ts";
import type { LocaleCode } from "./i18n/locales.ts";

export type ItemType = "HOUSE" | "VIP_TENT" | "OWN_TENT";

export interface StayRowDto {
  bookingCode: string;
  customerName: string;
  itemType: ItemType;
  itemName: string;
  quantity: number;
  /** Tarp areas booked with own-tent camping (0 = none). */
  tarps: number;
  adults: number;
  children: number;
  checkIn: string;
  checkOut: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  totalSatang: number;
  /** Still to pay (deposit plan: the rest, taken at check-in); 0 when paid in full. */
  balanceSatang: number;
  /** Deposit plan: amount asked online; null = full payment. */
  depositSatang: number | null;
  /** Check-in / check-out / no-show today (see shared/stay.ts). */
  stayActions: StayActionsDto;
}

export interface RevenueDto {
  bookings: number;
  accommodationSatang: number;
  foodSatang: number;
  totalSatang: number;
}

export interface DashboardDto {
  /** Today in the property time zone. */
  date: string;
  monthStart: string;
  counts: {
    checkInsToday: number;
    checkOutsToday: number;
    inHouse: number;
    bookingsCreatedToday: number;
    bookingsCreatedMonth: number;
    pendingPayment: number;
    slipsToReview: number;
    /** Deposit plan: confirmed bookings that still owe the rest (taken at check-in or transferred before). */
    balanceDue: number;
  };
  /** Tonight's inventory. */
  inventory: {
    houses: { total: number; available: number };
    vip: { total: number; available: number };
    camping: { enabled: boolean; max: number; used: number; remaining: number };
  };
  /** Arrivals / departures — only with `bookings.view` (customer names). */
  arrivals: StayRowDto[] | null;
  departures: StayRowDto[] | null;
  /**
   * Money — only with `payments.view` or `reports.view`.
   * Revenue = paid & confirmed bookings by check-in date (stay basis), from booking snapshots.
   */
  money: {
    pendingPaymentSatang: number;
    /** Deposit plan: the rest still to receive from confirmed bookings (sum of total − paid). */
    balanceDueSatang: number;
    today: RevenueDto;
    month: RevenueDto;
    trend: { date: string; bookings: number; revenueSatang: number }[];
  } | null;
  /**
   * Last 30 days. Web analytics (visitors, page views, accommodation views, booking / checkout
   * started) come from the GA4 Data API (Phase 14) and are null when it is not connected or
   * unreachable; the rest is counted in D1. D1 is never replaced by analytics for money.
   */
  analytics: {
    days: number;
    /** GA4 connection: OK, NOT_CONFIGURED (no property id / key), ERROR (numbers may be from fetchedAt). */
    ga4: { status: "OK" | "NOT_CONFIGURED" | "ERROR"; fetchedAt: string | null };
    visitors: number | null;
    pageViews: number | null;
    accommodationViews: number | null;
    bookingStarted: number | null;
    checkoutStarted: number | null;
    searches: number;
    bookingsCreated: number;
    paymentSubmitted: number;
    confirmedBookings: number;
    revenueSatang: number | null;
    foodOrders: number;
  };
}

export interface CalendarUnitDto {
  id: string;
  type: "HOUSE" | "VIP_TENT";
  code: string;
  status: string;
  names: Partial<Record<LocaleCode, string>>;
}

export interface CalendarNightDto {
  unitId: string;
  date: string;
  bookingCode: string | null;
  blockReason: string | null;
}

export interface CalendarBookingDto {
  bookingCode: string;
  /** null without `bookings.view`. */
  customerName: string | null;
  itemType: ItemType;
  unitId: string | null;
  itemName: string;
  quantity: number;
  tarps: number;
  adults: number;
  children: number;
  checkIn: string;
  checkOut: string;
  nights: number;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  /** null without `bookings.view`. */
  totalSatang: number | null;
}

export interface CalendarDto {
  from: string;
  /** Exclusive. */
  to: string;
  today: string;
  dates: string[];
  units: CalendarUnitDto[];
  nights: CalendarNightDto[];
  bookings: CalendarBookingDto[];
  camping: { enabled: boolean; nights: { date: string; max: number; used: number }[] };
}

export const CALENDAR_MAX_DAYS = 62;

export interface AdminPaymentListItemDto {
  id: string;
  bookingCode: string;
  amountSatang: number;
  method: string;
  /** Channel the guest chose online (PROMPTPAY, BANK_TRANSFER, QR_CODE, PAYPAL); null = recorded by staff. */
  channel: string | null;
  status: PaymentStatus;
  hasSlip: boolean;
  reference: string | null;
  submittedAt: string;
  paidAt: string | null;
  verifiedAt: string | null;
  refundAmountSatang: number | null;
  refundedAt: string | null;
}

export interface BookingSettingsDto {
  holdMinutes: number;
  maxNights: number;
  maxAdvanceDays: number;
  maxTentsPerBooking: number;
  updatedAt: string | null;
}

export const STAY_ACTIONS = ["check-in", "check-out", "no-show"] as const;
export type StayAction = (typeof STAY_ACTIONS)[number];
