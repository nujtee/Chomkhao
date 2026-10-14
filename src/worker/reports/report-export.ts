import { format } from "../../shared/i18n/admin-messages.ts";
import { getReportMessages, type ReportMessages } from "../../shared/i18n/report-messages.ts";
import type { LocaleCode } from "../../shared/i18n/locales.ts";
import type { Cell, ReportColumn, ReportDto } from "../../shared/report-types.ts";
import { buildXlsx, type XlsxKind, type XlsxSheet, type XlsxValue } from "./xlsx.ts";

const WIDTH: Record<ReportColumn["kind"], number> = {
  text: 26, code: 18, date: 12, datetime: 18, period: 12, money: 15, int: 11, percent: 12,
};

/** Local wall-clock "YYYY-MM-DD HH:mm" of a timestamp in the property time zone. */
export function localDateTime(isoString: string, timeZone: string): string {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function exportValue(c: ReportColumn, v: Cell, m: ReportMessages, tz: string): XlsxValue {
  if (v === null || v === undefined) return null;
  switch (c.kind) {
    case "money": return typeof v === "number" ? v / 100 : v;
    case "code": return (m.codes as Record<string, string>)[String(v)] ?? String(v);
    case "datetime": return typeof v === "string" ? localDateTime(v, tz) : v;
    default: return v;
  }
}

function kindOf(c: ReportColumn): XlsxKind {
  return c.kind === "money" ? "money" : c.kind === "int" ? "int" : c.kind === "percent" ? "percent" : "text";
}

/** One sheet per report table; title, period and notes in every sheet so a printed sheet stands alone. */
export function reportToXlsx(report: ReportDto, lang: LocaleCode, siteName: string | null): Uint8Array {
  const m = getReportMessages(lang);
  const title = [siteName, `${m.ui.title}: ${m.types[report.type]}`].filter(Boolean).join(" — ");
  const header = [
    title,
    format(m.ui.periodLabel, { from: report.from, to: report.to }),
    `${format(m.ui.generatedAt, { time: localDateTime(report.generatedAt, report.timezone) })} · ${format(m.ui.timezone, { tz: report.timezone })}`,
  ];
  const notes = report.notes.map((n) => (m.notes as Record<string, string>)[n] ?? n);
  const sheets: XlsxSheet[] = report.tables.map((t) => {
    const columns = t.columns.map((c) => {
      const label = (m.cols as Record<string, string>)[c.key] ?? c.key;
      return { label, kind: kindOf(c), width: Math.max(WIDTH[c.kind], Math.min(40, [...label].length + 2)) };
    });
    const totals = t.totals
      ? t.columns.map((c, i) => (i === 0 ? m.ui.totals : t.totals![c.key] === undefined ? null : exportValue(c, t.totals![c.key]!, m, report.timezone)))
      : null;
    return {
      name: (m.tables as Record<string, string>)[t.key] ?? t.key,
      titleLines: [...header, (m.tables as Record<string, string>)[t.key] ?? t.key],
      columns,
      rows: t.rows.map((r) => t.columns.map((c) => exportValue(c, r[c.key] ?? null, m, report.timezone))),
      totals,
      footer: [...notes, ...(t.truncated ? [format(m.ui.truncated, { n: t.rows.length })] : [])],
    };
  });
  return buildXlsx(sheets, { title, createdAt: report.generatedAt });
}

export function reportFileName(report: ReportDto, ext: string): string {
  return `chomkhao-${report.type}-${report.from}_${report.to}.${ext}`;
}
