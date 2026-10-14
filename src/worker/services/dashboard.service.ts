import { parseStays } from "../repositories/stay-sql.ts";
import { stayActions } from "../../shared/stay.ts";
import { balanceDue } from "../../shared/booking-rules.ts";
import type { BookingStatus, PaymentStatus } from "../../shared/booking-types.ts";
import type { CalendarDto, DashboardDto, RevenueDto, StayRowDto } from "../../shared/dashboard-types.ts";
import { CALENDAR_MAX_DAYS } from "../../shared/dashboard-types.ts";
import { addDays, diffDays, isIsoDate, monthRange, todayIn, utcOffsetMinutes, DEFAULT_TIMEZONE } from "../../shared/dates.ts";
import type { LocaleCode } from "../../shared/i18n/locales.ts";
import { ValidationError } from "../http/errors.ts";
import type { BookingItemListRow, DashboardRepository, RevenueRow } from "../repositories/dashboard.repository.ts";
import type { InventoryRepository } from "../repositories/inventory.repository.ts";
import type { AuthContext, Clock, RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { Ga4DashboardResult } from "./ga4-report.service.ts";

const TREND_DAYS = 14;
const ANALYTICS_DAYS = 30;

/** Dashboard (spec §48) and booking calendar (spec §49). Widgets follow the viewer's permissions. */
export class DashboardService {
  constructor(
    private readonly repo: DashboardRepository,
    private readonly inventory: InventoryRepository,
    private readonly authz: AuthorizationService,
    private readonly clock: Clock,
    /** GA4 Data API numbers for the date range (Phase 14); absent = not connected. */
    private readonly ga4: ((from: string, to: string) => Promise<Ga4DashboardResult>) | null = null,
  ) {}

  private async zone() {
    const tz = (await this.inventory.siteTimezone()) ?? DEFAULT_TIMEZONE;
    const now = this.clock();
    const minutes = utcOffsetMinutes(tz, now);
    return { today: todayIn(tz, now), offset: `${minutes >= 0 ? "+" : ""}${minutes} minutes` };
  }

  async dashboard(actor: AuthContext, meta: RequestMeta): Promise<DashboardDto> {
    await this.authz.requirePermission(actor, "dashboard.view", meta);
    const { today, offset } = await this.zone();
    const { start: monthStart, next: nextMonth } = monthRange(today);
    const seesBookings = this.authz.can(actor, "bookings.view");
    const seesMoney = this.authz.can(actor, "payments.view") || this.authz.can(actor, "reports.view");

    const analyticsFrom = addDays(today, -(ANALYTICS_DAYS - 1));
    const [counts, due, inv, analytics, web] = await Promise.all([
      this.repo.counts(today, monthStart, offset),
      this.repo.balanceDue(),
      this.repo.inventoryTonight(today),
      this.repo.analytics(analyticsFrom, offset),
      this.ga4 ? this.ga4(analyticsFrom, today).catch((): Ga4DashboardResult => ({ status: "ERROR", fetchedAt: null, numbers: null }))
        : Promise.resolve<Ga4DashboardResult>({ status: "NOT_CONFIGURED", fetchedAt: null, numbers: null }),
    ]);
    const ga = web.numbers;
    const units = (type: string) => inv.units.find((u) => u.unit_type === type) ?? { total: 0, available: 0 };
    const campingEnabled = inv.camping?.is_enabled === 1;
    const campingMax = campingEnabled ? inv.camping?.max_tents ?? 0 : 0;
    const campingUsed = inv.camping?.used ?? 0;

    let arrivals: StayRowDto[] | null = null;
    let departures: StayRowDto[] | null = null;
    if (seesBookings) {
      const [a, d] = await Promise.all([this.repo.arrivals(today), this.repo.departures(today)]);
      arrivals = a.map((r) => stayRow(r, today));
      departures = d.map((r) => stayRow(r, today));
    }

    let money: DashboardDto["money"] = null;
    if (seesMoney) {
      const trendFrom = addDays(today, -(TREND_DAYS - 1));
      const [day, month, trendRows] = await Promise.all([
        this.repo.revenue(today, addDays(today, 1)),
        this.repo.revenue(monthStart, nextMonth),
        this.repo.trend(trendFrom, offset),
      ]);
      const byDay = new Map(trendRows.map((r) => [r.day, r]));
      money = {
        pendingPaymentSatang: counts.pending_satang,
        balanceDueSatang: due.satang,
        today: revenue(day),
        month: revenue(month),
        trend: Array.from({ length: TREND_DAYS }, (_, i) => {
          const date = addDays(trendFrom, i);
          const r = byDay.get(date);
          return { date, bookings: r?.bookings ?? 0, revenueSatang: r?.revenue ?? 0 };
        }),
      };
    }

    return {
      date: today,
      monthStart,
      counts: {
        checkInsToday: counts.check_ins,
        checkOutsToday: counts.check_outs,
        inHouse: counts.in_house,
        bookingsCreatedToday: counts.created_today,
        bookingsCreatedMonth: counts.created_month,
        pendingPayment: counts.pending_payment,
        slipsToReview: counts.slips,
        balanceDue: due.bookings,
      },
      inventory: {
        houses: { total: units("HOUSE").total, available: units("HOUSE").available },
        vip: { total: units("VIP_TENT").total, available: units("VIP_TENT").available },
        camping: { enabled: campingEnabled, max: campingMax, used: campingUsed, remaining: Math.max(0, campingMax - campingUsed) },
      },
      arrivals,
      departures,
      money,
      analytics: {
        days: ANALYTICS_DAYS,
        ga4: { status: web.status, fetchedAt: web.fetchedAt },
        visitors: ga?.visitors ?? null,
        pageViews: ga?.pageViews ?? null,
        accommodationViews: ga?.events.view_accommodation ?? null,
        bookingStarted: ga?.events.begin_booking ?? null,
        checkoutStarted: ga?.events.begin_checkout ?? null,
        searches: analytics.searches,
        bookingsCreated: analytics.created,
        paymentSubmitted: analytics.slips,
        confirmedBookings: analytics.confirmed,
        revenueSatang: seesMoney ? analytics.revenue : null,
        foodOrders: analytics.food_orders,
      },
    };
  }

  async calendar(actor: AuthContext, from: string | undefined, to: string | undefined, meta: RequestMeta): Promise<CalendarDto> {
    await this.authz.requirePermission(actor, "calendar.view", meta);
    const { today } = await this.zone();
    const start = from ?? today;
    const end = to ?? addDays(start, 7);
    if (!isIsoDate(start)) throw new ValidationError({ from: "INVALID_DATE" });
    if (!isIsoDate(end)) throw new ValidationError({ to: "INVALID_DATE" });
    const days = diffDays(start, end);
    if (days < 1 || days > CALENDAR_MAX_DAYS) throw new ValidationError({ to: "RANGE_TOO_LONG" });
    const details = this.authz.can(actor, "bookings.view");

    const [unitRows, nights, bookings, camping] = await Promise.all([
      this.repo.calendarUnits(),
      this.repo.calendarNights(start, end),
      this.repo.calendarBookings(start, end),
      this.repo.calendarCamping(start, end),
    ]);

    const units = new Map<string, CalendarDto["units"][number]>();
    for (const r of unitRows) {
      const unit = units.get(r.id) ?? { id: r.id, type: r.unit_type, code: r.unit_code, status: r.status, names: {} };
      if (r.language_code && r.name) unit.names[r.language_code as LocaleCode] = r.name;
      units.set(r.id, unit);
    }
    const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
    const campingByDate = new Map(camping.nights.map((n) => [n.stay_date, n]));
    const campingEnabled = camping.settings?.is_enabled === 1;

    return {
      from: start,
      to: end,
      today,
      dates,
      units: [...units.values()],
      nights: nights.map((n) => ({
        unitId: n.unit_id, date: n.stay_date, bookingCode: n.booking_code, blockReason: n.booking_code ? null : n.block_reason,
      })),
      bookings: bookings.map((b) => ({
        bookingCode: b.booking_code,
        customerName: details ? b.customer_name : null,
        itemType: b.item_type,
        unitId: b.unit_id,
        itemName: b.item_name,
        quantity: b.quantity,
        stays: parseStays(b.stays_json),
        tarps: b.tarps,
        adults: b.adults,
        children: b.children,
        checkIn: b.check_in,
        checkOut: b.check_out,
        nights: b.nights,
        status: b.booking_status as BookingStatus,
        paymentStatus: b.payment_status as PaymentStatus,
        totalSatang: details ? b.total_satang : null,
      })),
      camping: {
        enabled: campingEnabled,
        nights: dates.map((date) => {
          const n = campingByDate.get(date);
          return { date, max: n?.max_tents ?? (camping.settings?.max_tents_per_night ?? 0), used: n?.tents_used ?? 0 };
        }),
      },
    };
  }
}

function stayRow(r: BookingItemListRow, today: string): StayRowDto {
  return {
    bookingCode: r.booking_code,
    customerName: r.customer_name,
    itemType: r.item_type,
    itemName: r.item_name,
    quantity: r.quantity,
    stays: parseStays(r.stays_json),
    tarps: r.tarps,
    adults: r.adults,
    children: r.children,
    checkIn: r.check_in,
    checkOut: r.check_out,
    status: r.booking_status as BookingStatus,
    paymentStatus: r.payment_status as PaymentStatus,
    totalSatang: r.total_satang,
    balanceSatang: balanceDue(r.total_satang, r.paid_satang),
    depositSatang: r.deposit_satang,
    stayActions: stayActions(r.booking_status, r.check_in, r.check_out, today),
  };
}

function revenue(r: RevenueRow): RevenueDto {
  return { bookings: r.bookings, accommodationSatang: r.accommodation, foodSatang: r.food, totalSatang: r.total };
}
