/** Accommodation / camping / availability API contract (Worker ↔ UI). */
import type { LocaleCode } from "./i18n/locales.ts";
import type { PaymentMode } from "./booking-rules.ts";

export type UnitType = "HOUSE" | "VIP_TENT";
export type UnitStatus = "DRAFT" | "ACTIVE" | "INACTIVE" | "MAINTENANCE" | "DELETED";
export type ImageStatus = "DRAFT" | "PUBLISHED" | "UNPUBLISHED";

export interface MediaTextDto {
  altText: string | null;
  title: string | null;
  caption: string | null;
}

export interface UnitTranslationDto {
  name: string;
  shortDescription: string | null;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface AdminUnitImageDto {
  id: string;
  mediaAssetId: string;
  url: string;
  width: number | null;
  height: number | null;
  sortOrder: number;
  status: ImageStatus;
  isCover: boolean;
  texts: Partial<Record<LocaleCode, MediaTextDto>>;
}

export interface AmenityDto {
  id: string;
  code: string;
  icon: string | null;
  status: "ACTIVE" | "INACTIVE";
  sortOrder: number;
  names: Partial<Record<LocaleCode, string>>;
}

/**
 * Open bookings made with a deposit (migration 0025). The deposit agreed at booking time never changes, so these
 * keep their plan when the owner later switches the stay to full payment.
 */
export interface DepositBookingsDto {
  /** Confirmed with the deposit paid; the rest is still due (taken at check-in, or transferred before). */
  paid: number;
  /** What those bookings still owe in total. */
  dueSatang: number;
  /** Booked with a deposit that is not paid yet (hold running, or the slip being checked). */
  awaiting: number;
}

export interface AdminUnitDto {
  id: string;
  unitCode: string;
  unitType: UnitType;
  slug: string;
  basePriceSatang: number;
  /** FULL, or DEPOSIT_50 = guests pay half of the stay online and the rest before check-in. */
  paymentMode: PaymentMode;
  /** Open deposit bookings of this house / VIP tent (single-unit reads only). */
  depositBookings?: DepositBookingsDto;
  standardGuests: number;
  maxGuests: number;
  maxAdults: number | null;
  status: UnitStatus;
  sortOrder: number;
  coverAssetId: string | null;
  coverUrl: string | null;
  translations: Partial<Record<LocaleCode, UnitTranslationDto>>;
  amenityIds: string[];
  images: AdminUnitImageDto[];
  createdAt: string;
  updatedAt: string;
}

export interface PublicImageDto {
  url: string;
  alt: string;
  caption: string | null;
  width: number | null;
  height: number | null;
  /** Responsive renditions "url 480w, …" (Phase 12); null when only the original exists. */
  srcset?: string | null;
}

export interface PublicUnitDto {
  id: string;
  slug: string;
  unitCode: string;
  unitType: UnitType;
  name: string;
  shortDescription: string | null;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  priceSatang: number;
  standardGuests: number;
  maxGuests: number;
  maxAdults: number | null;
  cover: PublicImageDto | null;
  images: PublicImageDto[];
  amenities: { code: string; icon: string | null; name: string }[];
}

export interface PublicCampingDto {
  enabled: boolean;
  name: string | null;
  description: string | null;
  pricePerAdultNightSatang: number;
  childFreeUnderAge: number;
  maxGuestsPerTent: number | null;
  maxTentsPerNight: number;
  cover: PublicImageDto | null;
  /** Tarp area add-on (per area per night, one per booking); null when not offered. */
  tarp: { pricePerNightSatang: number } | null;
}

export interface PublicAccommodationsDto {
  language: LocaleCode;
  houses: PublicUnitDto[];
  vipTents: PublicUnitDto[];
  camping: PublicCampingDto;
}

export interface CampingNightDto {
  date: string;
  capacity: number;
  used: number;
  remaining: number;
  isOverride: boolean;
}

/** GET /api/public/availability */
export interface AvailabilityDto {
  checkIn: string;
  checkOut: string;
  nights: number;
  units: { unitId: string; slug: string; unitType: UnitType; available: boolean; fitsGuests: boolean }[];
  camping: {
    enabled: boolean;
    remaining: number;
    nights: { date: string; remaining: number }[];
    /** Can the requested tents (and guests) be booked for every night? null when no tents were asked. */
    fitsTents: boolean | null;
    /** Why not: FULL (some night lacks space), TOO_FEW_TENTS (guests need more tents), TOO_MANY_TENTS (per-booking limit). */
    reason: "FULL" | "TOO_FEW_TENTS" | "TOO_MANY_TENTS" | null;
    /** Nights that cannot take the requested tents (multi-night stays). */
    shortNights: string[];
    /** Tents the guests need (max guests per tent); 1 when unlimited. */
    minTents: number;
    maxTentsPerBooking: number;
    /** Tarp areas: offered at all, the fewest left on any night, nights without one. */
    tarp: { offered: boolean; remaining: number; shortNights: string[] };
  };
}

/** Tarp areas of one night (admin). */
export interface TarpNightDto {
  date: string;
  capacity: number;
  used: number;
  remaining: number;
}

export interface CampingSettingsDto {
  isEnabled: boolean;
  maxTentsPerNight: number;
  pricePerAdultNightSatang: number;
  childFreeUnderAge: number;
  maxGuestsPerTent: number | null;
  coverAssetId: string | null;
  /** Tarp area add-on: offered, price per area per night, areas per night. */
  tarpEnabled: boolean;
  tarpPricePerNightSatang: number;
  maxTarpsPerNight: number;
  /** FULL, or DEPOSIT_50 = guests pay half of the stay online and the rest before check-in. */
  paymentMode: PaymentMode;
  /** Open deposit bookings of the camping ground (admin reads). */
  depositBookings?: DepositBookingsDto;
  translations: Partial<Record<LocaleCode, { name: string; description: string | null; seoTitle: string | null; seoDescription: string | null }>>;
}

export type NightState = "FREE" | "BOOKED" | "BLOCKED";

/** GET /api/admin/availability */
export interface AdminAvailabilityDto {
  from: string;
  to: string;
  dates: string[];
  units: {
    id: string;
    unitCode: string;
    unitType: UnitType;
    name: string;
    status: UnitStatus;
    nights: Record<string, { state: NightState; bookingCode?: string; blockReason?: string }>;
  }[];
  camping: CampingNightDto[];
  /** Tarp areas per night (empty when the option is off and nothing is booked). */
  tarps: TarpNightDto[];
}

/** GET /api/admin/camping/integrity — counters vs bookings, from today on. */
export interface CampingIntegrityDto {
  checkedFrom: string;
  consistent: boolean;
  /** Nights whose counter disagrees with the bookings (expected = from bookings). */
  drift: { date: string; expected: number; actual: number; maxTents: number | null }[];
  /** Same check for the tarp-area counters. */
  tarpDrift: { date: string; expected: number; actual: number; maxTarps: number | null }[];
}
