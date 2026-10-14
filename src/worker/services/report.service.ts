import { parseStays, type StayBriefRow } from "../repositories/stay-sql.ts";
import type { NightPriceDto } from "../../shared/booking-types.ts";
import { addDays, diffDays, isIsoDate, stayNights, todayIn, utcOffsetMinutes, DEFAULT_TIMEZONE } from "../../shared/dates.ts";
import {
  DETAIL_ROW_LIMIT, KITCHEN_MAX_DAYS, periodKey, REPORT_EXPORT_PERMISSION, REPORT_LIMITS, REPORT_VIEW_PERMISSION,
  type Cell, type ReportColumn, type ReportDto, type ReportGroup, type ReportTable, type ReportType,
} from "../../shared/report-types.ts";
import { ValidationError } from "../http/errors.ts";
import type { InventoryRepository } from "../repositories/inventory.repository.ts";
import type { ReportRepository, StayRow } from "../repositories/report.repository.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";

const AGGREGATE_LIMIT = 50_000;
const SOLD = new Set(["CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "NO_SHOW"]);
const PAID = new Set(["PAID", "VERIFIED"]);

export interface ReportRequest {
  type: ReportType;
  from: string;
  to: string;
  group: ReportGroup;
  lang: string;
}

type Row = Record<string, Cell>;

const col = (key: string, kind: ReportColumn["kind"]): ReportColumn => ({ key, kind });

/** A table whose rows are the periods of the range, every period present (zeros included). */
function periodTable(key: string, periods: string[], columns: ReportColumn[], values: Map<string, Row>, chart?: string): ReportTable {
  const rows: Row[] = periods.map((p) => ({ period: p, ...(values.get(p) ?? {}) }));
  for (const r of rows) for (const c of columns) if (c.key !== "period" && r[c.key] === undefined) r[c.key] = 0;
  return { key, columns: [col("period", "period"), ...columns], rows, totals: sumRows(rows, columns), truncated: false, chart };
}

function sumRows(rows: Row[], columns: ReportColumn[]): Row {
  const totals: Row = {};
  for (const c of columns) {
    if (c.kind === "int" || c.kind === "money") totals[c.key] = rows.reduce((a, r) => a + (typeof r[c.key] === "number" ? (r[c.key] as number) : 0), 0);
  }
  return totals;
}

function add(map: Map<string, Row>, key: string, values: Record<string, number>) {
  const row = map.get(key) ?? {};
  for (const [k, v] of Object.entries(values)) row[k] = ((row[k] as number | undefined) ?? 0) + v;
  map.set(key, row);
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/**
 * Splits a stay's accommodation revenue over its nights by each night's snapshot price,
 * so a stay crossing a month boundary is counted in both months. Exact: the parts sum to the total.
 */
export function allocateNights(stay: Pick<StayRow, "check_in" | "check_out" | "nightly_prices_json">, amount: number): Map<string, number> {
  const nights = stayNights(stay.check_in, stay.check_out);
  const prices = new Map<string, number>();
  try {
    for (const n of (stay.nightly_prices_json ? JSON.parse(stay.nightly_prices_json) : []) as NightPriceDto[]) prices.set(n.date, n.priceSatang);
  } catch {
    // equal split below
  }
  const weights = nights.map((d) => Math.max(0, prices.get(d) ?? 1));
  const sum = weights.reduce((a, w) => a + w, 0) || nights.length;
  const out = new Map<string, number>();
  let used = 0;
  nights.forEach((d, i) => {
    const part = i === nights.length - 1 ? amount - used : Math.floor((amount * weights[i]!) / sum);
    used += part;
    out.set(d, part);
  });
  return out;
}

/**
 * One stay's accommodation money after any booking discount (shared by stay price): a booking may hold several
 * stays (migration 0026), each reported on its own nights.
 */
export function stayNet(s: Pick<StayRow, "stay_subtotal_satang" | "accommodation_subtotal_satang" | "discount_satang">): number {
  const discount = Math.min(s.discount_satang, s.accommodation_subtotal_satang);
  const share = s.accommodation_subtotal_satang > 0 ? Math.round((discount * s.stay_subtotal_satang) / s.accommodation_subtotal_satang) : 0;
  return Math.max(0, s.stay_subtotal_satang - share);
}

/** Splits `amount` over parts in proportion to their weights (the last part takes the rounding). */
function splitBy(amount: number, weights: number[]): number[] {
  const sum = weights.reduce((a, w) => a + w, 0);
  let used = 0;
  return weights.map((w, i) => {
    const part = i === weights.length - 1 ? amount - used : sum > 0 ? Math.floor((amount * w) / sum) : 0;
    used += part;
    return part;
  });
}

/** Reports (spec §50). Every figure from D1; money as integer satang. */
export class ReportService {
  constructor(
    private readonly repo: ReportRepository,
    private readonly inventory: InventoryRepository,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
  ) {}

  private async zone() {
    const tz = (await this.inventory.siteTimezone()) ?? DEFAULT_TIMEZONE;
    const now = this.clock();
    const minutes = utcOffsetMinutes(tz, now);
    return { tz, today: todayIn(tz, now), offset: `${minutes >= 0 ? "+" : ""}${minutes} minutes` };
  }

  /** Validates the period. `to` is inclusive. */
  validate(req: ReportRequest): void {
    const errors: Record<string, string> = {};
    if (!isIsoDate(req.from)) errors.from = "INVALID_DATE";
    if (!isIsoDate(req.to)) errors.to = "INVALID_DATE";
    if (!errors.from && !errors.to) {
      const days = diffDays(req.from, req.to) + 1;
      if (days < 1) errors.to = "BEFORE_START";
      else if (days > (req.type === "kitchen" ? KITCHEN_MAX_DAYS : REPORT_LIMITS[req.group])) errors.to = "RANGE_TOO_LONG";
    }
    if (Object.keys(errors).length) throw new ValidationError(errors);
  }

  async run(actor: AuthContext, req: ReportRequest, meta: RequestMeta, exportFormat?: "xlsx" | "pdf"): Promise<ReportDto> {
    await this.authz.requirePermission(actor, REPORT_VIEW_PERMISSION[req.type], meta);
    if (exportFormat) await this.authz.requirePermission(actor, REPORT_EXPORT_PERMISSION[req.type], meta);
    this.validate(req);
    const zone = await this.zone();
    const group: ReportGroup = req.type === "kitchen" ? "day" : req.group;
    const periods = [...new Set(Array.from({ length: diffDays(req.from, req.to) + 1 }, (_, i) => periodKey(addDays(req.from, i), group)))];
    const ctx = { ...req, group, periods, toEx: addDays(req.to, 1), zone, names: this.authz.can(actor, "bookings.view") };

    let body: Pick<ReportDto, "tables" | "notes">;
    switch (req.type) {
      case "revenue": body = await this.revenue(ctx); break;
      case "booking": body = await this.booking(ctx); break;
      case "accommodation": body = await this.accommodation(ctx); break;
      case "camping": body = await this.camping(ctx); break;
      case "food": body = await this.food(ctx); break;
      case "kitchen": body = await this.kitchen(ctx); break;
      case "payment": body = await this.payment(ctx); break;
    }
    if (exportFormat) {
      // Exports are data leaving the system: who, which report, which period, which format (never the data).
      await this.log.auditStatement(actor.userId, "EXPORT_REPORT", "reports", req.type, null,
        { type: req.type, from: req.from, to: req.to, group, format: exportFormat }, meta).run();
    }
    return { type: req.type, from: req.from, to: req.to, group, timezone: zone.tz, generatedAt: iso(this.clock()), ...body };
  }

  // ================================================================ revenue

  private async revenue(c: Ctx): Promise<Pick<ReportDto, "tables" | "notes">> {
    const [stays, food, payments] = await Promise.all([
      this.repo.soldStays(c.from, c.toEx),
      this.repo.paidFood(c.from, c.toEx),
      this.repo.payments(c.from, c.to, c.zone.offset, AGGREGATE_LIMIT),
    ]);
    const byPeriod = new Map<string, Row>();
    const byType = new Map<string, Row>();
    for (const s of stays) {
      if (!PAID.has(s.payment_status)) continue;
      const net = stayNet(s);
      for (const [date, amount] of allocateNights(s, net)) {
        if (date < c.from || date > c.to) continue;
        const nights: Record<string, number> = s.item_type === "OWN_TENT" ? { tentNights: s.quantity } : { unitNights: 1 };
        add(byPeriod, periodKey(date, c.group), { accommodation: amount, total: amount, ...nights });
        add(byType, s.item_type, { nights: s.item_type === "OWN_TENT" ? s.quantity : 1, revenue: amount });
      }
    }
    for (const f of food) {
      add(byPeriod, periodKey(f.service_date, c.group), { food: f.subtotal_satang, total: f.subtotal_satang });
      add(byType, "FOOD", { revenue: f.subtotal_satang });
    }
    for (const p of payments) {
      if (p.received_day && p.received_day >= c.from && p.received_day <= c.to) {
        add(byPeriod, periodKey(p.received_day, c.group), { received: p.amount_satang, net: p.amount_satang });
      }
      if (p.refunded_day && p.refund_amount_satang && p.refunded_day >= c.from && p.refunded_day <= c.to) {
        add(byPeriod, periodKey(p.refunded_day, c.group), { refunded: p.refund_amount_satang, net: -p.refund_amount_satang });
      }
    }
    const typeRows = ["HOUSE", "VIP_TENT", "OWN_TENT", "FOOD"].map((t) => ({ type: t, nights: t === "FOOD" ? null : 0, revenue: 0, ...(byType.get(t) ?? {}) }));
    const typeColumns = [col("type", "code"), col("nights", "int"), col("revenue", "money")];
    return {
      notes: ["stayBasis", "cashBasis"],
      tables: [
        periodTable("byPeriod", c.periods, [
          col("accommodation", "money"), col("food", "money"), col("total", "money"), col("unitNights", "int"), col("tentNights", "int"),
          col("received", "money"), col("refunded", "money"), col("net", "money"),
        ], byPeriod, "total"),
        { key: "byType", columns: typeColumns, rows: typeRows, totals: sumRows(typeRows, typeColumns), truncated: false },
      ],
    };
  }

  // ================================================================ bookings

  private async booking(c: Ctx): Promise<Pick<ReportDto, "tables" | "notes">> {
    const rows = await this.repo.bookingsCreated(c.from, c.to, c.zone.offset, AGGREGATE_LIMIT);
    const byPeriod = new Map<string, Row>();
    const byStatus = new Map<string, Row>();
    const byItem = new Map<string, Row & { item: string; type: string }>();
    for (const b of rows) {
      const live = b.booking_status !== "CANCELLED" && b.booking_status !== "EXPIRED";
      const bucket = SOLD.has(b.booking_status) ? (b.booking_status === "NO_SHOW" ? "noShow" : "confirmed")
        : b.booking_status === "PENDING" ? "pending" : b.booking_status === "CANCELLED" ? "cancelled" : "expired";
      add(byPeriod, periodKey(b.created_day, c.group), {
        created: 1, [bucket]: 1, nights: live ? b.nights : 0, guests: live ? b.adults + b.children : 0, value: live ? b.total_satang : 0,
      });
      add(byStatus, b.booking_status, { count: 1, value: b.total_satang });
      // By accommodation: each stay of the booking, its value the booking's share by stay price.
      const stays = parseStays(b.stays_json);
      const list = stays.length ? stays : [{ type: b.item_type as StayBriefRow["type"], name: b.item_name, quantity: 1, subtotal: 1 }];
      const values = splitBy(live ? b.total_satang : 0, list.map((x) => x.subtotal ?? 1));
      list.forEach((x, i) => {
        const itemKey = `${x.type}|${x.name}`;
        const item = byItem.get(itemKey) ?? { item: x.name, type: x.type };
        byItem.set(itemKey, item);
        for (const [k, v] of Object.entries({ count: 1, nights: live ? b.nights : 0, value: values[i]! })) {
          item[k] = ((item[k] as number | undefined) ?? 0) + v;
        }
      });
    }
    const statusColumns = [col("status", "code"), col("count", "int"), col("value", "money")];
    const statusRows = ["PENDING", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "NO_SHOW", "CANCELLED", "EXPIRED"]
      .map((s) => ({ status: s, count: 0, value: 0, ...(byStatus.get(s) ?? {}) }));
    const itemColumns = [col("item", "text"), col("type", "code"), col("count", "int"), col("nights", "int"), col("value", "money")];
    const itemRows = [...byItem.values()].sort((a, b) => (b.count as number) - (a.count as number));
    const detailColumns = [
      col("bookingCode", "text"), col("createdAt", "date"), ...(c.names ? [col("customer", "text")] : []), col("item", "text"),
      col("checkIn", "date"), col("checkOut", "date"), col("nights", "int"), col("adults", "int"), col("children", "int"),
      col("status", "code"), col("paymentStatus", "code"), col("source", "code"), col("total", "money"),
    ];
    const details = rows.slice(0, DETAIL_ROW_LIMIT).map((b) => ({
      bookingCode: b.booking_code, createdAt: b.created_day, ...(c.names ? { customer: b.customer_name } : {}), item: b.item_name,
      checkIn: b.check_in, checkOut: b.check_out, nights: b.nights, adults: b.adults, children: b.children,
      status: b.booking_status, paymentStatus: b.payment_status, source: b.source, total: b.total_satang,
    }));
    return {
      notes: ["bookingBasis", ...(c.names ? [] : ["piiHidden"])],
      tables: [
        periodTable("byPeriod", c.periods, [
          col("created", "int"), col("confirmed", "int"), col("pending", "int"), col("cancelled", "int"), col("expired", "int"),
          col("noShow", "int"), col("nights", "int"), col("guests", "int"), col("value", "money"),
        ], byPeriod, "created"),
        { key: "byStatus", columns: statusColumns, rows: statusRows, totals: sumRows(statusRows, statusColumns), truncated: false },
        { key: "byAccommodation", columns: itemColumns, rows: itemRows, totals: sumRows(itemRows, itemColumns), truncated: false },
        { key: "details", columns: detailColumns, rows: details, totals: null, truncated: rows.length > DETAIL_ROW_LIMIT },
      ],
    };
  }

  // ================================================================ accommodation (occupancy)

  private async accommodation(c: Ctx): Promise<Pick<ReportDto, "tables" | "notes">> {
    const [units, stays, blocked] = await Promise.all([
      this.repo.units(c.lang), this.repo.soldStays(c.from, c.toEx), this.repo.blockedNights(c.from, c.toEx),
    ]);
    const days = diffDays(c.from, c.to) + 1;
    const perUnit = new Map<string, { sold: number; revenue: number; blocked: number }>();
    const byPeriod = new Map<string, Row>();
    const dates = Array.from({ length: days }, (_, i) => addDays(c.from, i));
    const active = units.filter((u) => u.status === "ACTIVE");
    for (const d of dates) add(byPeriod, periodKey(d, c.group), { available: active.length });
    for (const b of blocked) {
      const u = perUnit.get(b.unit_id) ?? { sold: 0, revenue: 0, blocked: 0 };
      u.blocked++;
      perUnit.set(b.unit_id, u);
      if (active.some((a) => a.id === b.unit_id)) add(byPeriod, periodKey(b.stay_date, c.group), { available: -1, blocked: 1 });
    }
    for (const s of stays) {
      if (s.item_type === "OWN_TENT" || !s.unit_id) continue;
      const net = PAID.has(s.payment_status) ? stayNet(s) : 0;
      for (const [date, amount] of allocateNights(s, net)) {
        if (date < c.from || date > c.to) continue;
        const u = perUnit.get(s.unit_id) ?? { sold: 0, revenue: 0, blocked: 0 };
        u.sold++;
        u.revenue += amount;
        perUnit.set(s.unit_id, u);
        add(byPeriod, periodKey(date, c.group), { sold: 1, revenue: amount });
      }
    }
    const unitColumns = [
      col("unit", "text"), col("type", "code"), col("available", "int"), col("blocked", "int"), col("sold", "int"),
      col("occupancy", "percent"), col("revenue", "money"), col("adr", "money"), col("revpar", "money"),
    ];
    const unitRows = units
      .filter((u) => u.status === "ACTIVE" || perUnit.has(u.id))
      .map((u) => {
        const x = perUnit.get(u.id) ?? { sold: 0, revenue: 0, blocked: 0 };
        const available = u.status === "ACTIVE" ? Math.max(0, days - x.blocked) : x.sold;
        return {
          unit: u.name, type: u.unit_type, available, blocked: x.blocked, sold: x.sold, occupancy: pct(x.sold, available),
          revenue: x.revenue, adr: x.sold ? Math.round(x.revenue / x.sold) : 0, revpar: available ? Math.round(x.revenue / available) : 0,
        };
      });
    const totals = sumRows(unitRows, unitColumns);
    const tAvail = totals.available as number;
    const tSold = totals.sold as number;
    const tRev = totals.revenue as number;
    Object.assign(totals, { occupancy: pct(tSold, tAvail), adr: tSold ? Math.round(tRev / tSold) : 0, revpar: tAvail ? Math.round(tRev / tAvail) : 0 });
    const period = periodTable("byPeriod", c.periods, [col("available", "int"), col("sold", "int"), col("occupancy", "percent"), col("revenue", "money")], byPeriod, "occupancy");
    for (const r of period.rows) r.occupancy = pct(r.sold as number, r.available as number);
    period.totals = { ...period.totals, occupancy: pct(period.totals!.sold as number, period.totals!.available as number) };
    return {
      notes: ["occupancyBasis", "stayBasis"],
      tables: [{ key: "byUnit", columns: unitColumns, rows: unitRows, totals, truncated: false }, period],
    };
  }

  // ================================================================ camping

  private async camping(c: Ctx): Promise<Pick<ReportDto, "tables" | "notes">> {
    const [stays, cap] = await Promise.all([this.repo.soldStays(c.from, c.toEx), this.repo.camping(c.from, c.toEx)]);
    const byPeriod = new Map<string, Row>();
    const override = new Map(cap.nights.map((n) => [n.stay_date, n.max_tents]));
    const defaultMax = cap.settings?.is_enabled === 1 ? cap.settings.max_tents_per_night : 0;
    for (let i = 0; i <= diffDays(c.from, c.to); i++) {
      const d = addDays(c.from, i);
      add(byPeriod, periodKey(d, c.group), { capacity: override.get(d) ?? defaultMax });
    }
    for (const s of stays) {
      if (s.item_type !== "OWN_TENT") continue;
      const net = PAID.has(s.payment_status) ? stayNet(s) : 0;
      for (const [date, amount] of allocateNights(s, net)) {
        if (date < c.from || date > c.to) continue;
        add(byPeriod, periodKey(date, c.group), {
          tentsSold: s.quantity, tarpsSold: s.tarps ?? 0, adults: s.adults, children: s.children, guestNights: s.adults + s.children, revenue: amount,
        });
      }
    }
    const table = periodTable("byPeriod", c.periods, [
      col("capacity", "int"), col("tentsSold", "int"), col("occupancy", "percent"), col("tarpsSold", "int"), col("adults", "int"), col("children", "int"),
      col("revenue", "money"),
    ], byPeriod, "tentsSold");
    for (const r of table.rows) r.occupancy = pct(r.tentsSold as number, r.capacity as number);
    table.totals = { ...table.totals, occupancy: pct(table.totals!.tentsSold as number, table.totals!.capacity as number) };
    return { notes: ["campingBasis", "stayBasis"], tables: [table] };
  }

  // ================================================================ food (sales)

  private async food(c: Ctx): Promise<Pick<ReportDto, "tables" | "notes">> {
    const [lines, cats] = await Promise.all([this.repo.paidFood(c.from, c.toEx), this.repo.categoryNames(c.lang)]);
    const catName = new Map(cats.map((x) => [x.code, x.name]));
    const byDish = new Map<string, Row>();
    const byCat = new Map<string, Row>();
    const byPeriod = new Map<string, Row>();
    for (const f of lines) {
      const values = { quantity: f.quantity, included: f.included_quantity, extra: f.quantity - f.included_quantity, revenue: f.subtotal_satang };
      const dishKey = `${f.category_code_snapshot}|${f.option_name_snapshot}`;
      const dish = byDish.get(dishKey) ?? { category: catName.get(f.category_code_snapshot) ?? f.category_code_snapshot, dish: f.option_name_snapshot, pricingType: f.pricing_type_snapshot };
      byDish.set(dishKey, dish);
      add(byDish, dishKey, values);
      byCat.set(f.category_code_snapshot, byCat.get(f.category_code_snapshot) ?? { category: catName.get(f.category_code_snapshot) ?? f.category_code_snapshot });
      add(byCat, f.category_code_snapshot, values);
      add(byPeriod, periodKey(f.service_date, c.group), values);
    }
    const qtyCols = [col("quantity", "int"), col("included", "int"), col("extra", "int"), col("revenue", "money")];
    const dishColumns = [col("category", "text"), col("dish", "text"), col("pricingType", "code"), ...qtyCols];
    const dishRows = [...byDish.values()].sort((a, b) => String(a.category).localeCompare(String(b.category)) || (b.quantity as number) - (a.quantity as number));
    const catColumns = [col("category", "text"), ...qtyCols];
    const catRows = [...byCat.values()];
    return {
      notes: ["foodBasis"],
      tables: [
        periodTable("byPeriod", c.periods, qtyCols, byPeriod, "revenue"),
        { key: "byCategory", columns: catColumns, rows: catRows, totals: sumRows(catRows, catColumns), truncated: false },
        { key: "byDish", columns: dishColumns, rows: dishRows, totals: sumRows(dishRows, dishColumns), truncated: false },
      ],
    };
  }

  // ================================================================ kitchen (operations, no money)

  private async kitchen(c: Ctx): Promise<Pick<ReportDto, "tables" | "notes">> {
    const [orders, lines, cats] = await Promise.all([
      this.repo.kitchenOrders(c.from, c.toEx), this.repo.kitchenLines(c.from, c.toEx), this.repo.categoryNames(c.lang),
    ]);
    const catName = new Map(cats.map((x) => [x.id, x.name]));
    const linesByOrder = new Map<string, typeof lines>();
    for (const l of lines) linesByOrder.set(l.food_order_id, [...(linesByOrder.get(l.food_order_id) ?? []), l]);
    const production = new Map<string, Row>();
    for (const o of orders) {
      const confirmed = SOLD.has(o.booking_status);
      for (const l of linesByOrder.get(o.order_id) ?? []) {
        const key = `${o.service_date}|${o.category_code}|${l.option_name_snapshot}`;
        production.set(key, production.get(key) ?? {
          date: o.service_date, category: catName.get(o.category_id) ?? o.category_code, serviceTime: o.service_time, dish: l.option_name_snapshot,
        });
        add(production, key, {
          portions: confirmed ? l.quantity : 0, portionsPending: confirmed ? 0 : l.quantity, included: l.included_quantity,
        });
      }
    }
    const prodColumns = [col("date", "date"), col("category", "text"), col("serviceTime", "text"), col("dish", "text"),
      col("portions", "int"), col("portionsPending", "int"), col("included", "int")];
    const prodRows = [...production.values()];
    const orderColumns = [
      col("date", "date"), col("category", "text"), col("bookingCode", "text"), ...(c.names ? [col("customer", "text")] : []),
      col("item", "text"), col("adults", "int"), col("children", "int"), col("dishes", "text"), col("status", "code"),
      col("paymentStatus", "code"), col("note", "text"),
    ];
    const orderRows = orders.slice(0, DETAIL_ROW_LIMIT).map((o) => ({
      date: o.service_date, category: catName.get(o.category_id) ?? o.category_code, bookingCode: o.booking_code,
      ...(c.names ? { customer: o.customer_name } : {}), item: o.item_name, adults: o.adults, children: o.children,
      dishes: (linesByOrder.get(o.order_id) ?? []).map((l) => `${l.option_name_snapshot} ×${l.quantity}`).join(", "),
      status: `ORDER_${o.status}`, paymentStatus: o.payment_status, note: o.kitchen_note,
    }));
    return {
      notes: ["kitchenBasis", ...(c.names ? [] : ["piiHidden"])],
      tables: [
        { key: "production", columns: prodColumns, rows: prodRows, totals: sumRows(prodRows, prodColumns), truncated: false },
        { key: "orders", columns: orderColumns, rows: orderRows, totals: null, truncated: orders.length > DETAIL_ROW_LIMIT },
      ],
    };
  }

  // ================================================================ payments

  private async payment(c: Ctx): Promise<Pick<ReportDto, "tables" | "notes">> {
    const rows = await this.repo.payments(c.from, c.to, c.zone.offset, AGGREGATE_LIMIT);
    const inRange = (d: string | null): d is string => !!d && d >= c.from && d <= c.to;
    const byPeriod = new Map<string, Row>();
    const byMethod = new Map<string, Row>();
    const byVerification = new Map<string, Row>();
    const received = rows.filter((p) => inRange(p.received_day));
    const verification = (p: (typeof rows)[number]) => (p.status === "PAID" || (!p.slip_asset_id && p.verified_by)) ? "RECORDED" : p.verified_by ? "STAFF" : "AUTO";
    for (const p of received) {
      add(byPeriod, periodKey(p.received_day!, c.group), { receivedCount: 1, received: p.amount_satang, net: p.amount_satang });
      add(byMethod, p.method, { count: 1, amount: p.amount_satang });
      add(byVerification, verification(p), { count: 1, amount: p.amount_satang });
    }
    for (const p of rows) {
      if (inRange(p.refunded_day) && p.refund_amount_satang) {
        add(byPeriod, periodKey(p.refunded_day, c.group), { refundCount: 1, refunded: p.refund_amount_satang, net: -p.refund_amount_satang });
      }
      if (p.slip_asset_id && inRange(p.submitted_day)) {
        add(byPeriod, periodKey(p.submitted_day, c.group), { slipsSubmitted: 1, rejected: p.status === "REJECTED" ? 1 : 0 });
      }
    }
    const methodColumns = [col("method", "code"), col("count", "int"), col("amount", "money")];
    const methodRows = ["BANK_TRANSFER", "PROMPTPAY", "CASH", "OTHER"].map((m) => ({ method: m, count: 0, amount: 0, ...(byMethod.get(m) ?? {}) }));
    const verColumns = [col("verification", "code"), col("count", "int"), col("amount", "money")];
    const verRows = ["AUTO", "STAFF", "RECORDED"].map((v) => ({ verification: v, count: 0, amount: 0, ...(byVerification.get(v) ?? {}) }));
    const detailColumns = [
      col("receivedAt", "datetime"), col("bookingCode", "text"), col("method", "code"), col("verification", "code"), col("status", "code"),
      col("amount", "money"), col("refund", "money"), col("reference", "text"),
    ];
    const details = received.slice(0, DETAIL_ROW_LIMIT).map((p) => ({
      receivedAt: p.verified_at, bookingCode: p.booking_code, method: p.method, verification: verification(p), status: p.status,
      amount: p.amount_satang, refund: p.refund_amount_satang ?? 0, reference: p.reference,
    }));
    return {
      notes: ["paymentBasis"],
      tables: [
        periodTable("byPeriod", c.periods, [
          col("receivedCount", "int"), col("received", "money"), col("refundCount", "int"), col("refunded", "money"), col("net", "money"),
          col("slipsSubmitted", "int"), col("rejected", "int"),
        ], byPeriod, "received"),
        { key: "byMethod", columns: methodColumns, rows: methodRows, totals: sumRows(methodRows, methodColumns), truncated: false },
        { key: "byVerification", columns: verColumns, rows: verRows, totals: sumRows(verRows, verColumns), truncated: false },
        { key: "details", columns: detailColumns, rows: details, totals: sumRows(details, detailColumns), truncated: received.length > DETAIL_ROW_LIMIT },
      ],
    };
  }

  /** Today in the property time zone (report defaults). */
  async today(): Promise<string> {
    return (await this.zone()).today;
  }
}

interface Ctx extends ReportRequest {
  group: ReportGroup;
  periods: string[];
  toEx: string;
  zone: { tz: string; today: string; offset: string };
  names: boolean;
}
