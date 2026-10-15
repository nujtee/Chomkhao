import type { LocaleCode } from "../../shared/i18n/locales.ts";

/**
 * E-mail texts (TH / EN / ZH-CN). Every message has a plain-text and an HTML part built from the same
 * lines; every value is escaped, so nothing a guest typed can become markup or a link we did not build.
 * Booking details reuse the LINE formatter, so both channels say the same thing.
 */

const th = {
  subjects: {
    NEW_BOOKING: "การจองใหม่ {code} — {name}",
    PAYMENT_REVIEW: "การชำระเงินรอตรวจสอบ — {code}",
    PAYMENT_CONFIRMED: "ชำระเงินแล้ว — ยืนยันการจอง {code}",
    GUEST_BOOKING_CREATED: "ได้รับการจอง {code} แล้ว — กรุณาชำระเงิน",
    GUEST_CONFIRMED: "ยืนยันการจอง {code} แล้ว",
    GUEST_PAYMENT_REJECTED: "การชำระเงินสำหรับการจอง {code} ยังไม่ผ่านการตรวจสอบ",
    GUEST_CANCELLED: "การจอง {code} ถูกยกเลิก",
    TEST: "ทดสอบอีเมลแจ้งเตือน",
  } as Record<string, string>,
  createdTitle: "ได้รับการจองของคุณแล้ว",
  createdIntro: "ขอบคุณคุณ{name} เราได้รับการจองแล้ว กรุณาชำระเงินเพื่อยืนยันการจอง",
  payBy: "กรุณาชำระภายใน {time}",
  amountDue: "ยอดที่ต้องชำระ",
  appFee: "ค่าธรรมเนียมการใช้ App ({n} หลัง)",
  keepCode: "เก็บรหัสการจองไว้ ใช้คู่กับเบอร์โทรศัพท์เพื่อดูการจอง ชำระเงิน หรือส่งสลิป",
  payNow: "ชำระเงิน / ดูการจอง",
  viewBooking: "ดูการจอง",
  openAdmin: "เปิดในระบบหลังบ้าน",
  testIntro: "อีเมลนี้ส่งจากระบบหลังบ้านเพื่อทดสอบ ผู้รับ “{name}” จะได้รับ: {kinds}",
  kinds: { booking: "การจองใหม่", payment: "การชำระเงิน", nothing: "ยังไม่ได้เลือกประเภท" },
  automated: "อีเมลนี้ส่งอัตโนมัติจากระบบจอง",
};

type Texts = typeof th;

const en: Texts = {
  subjects: {
    NEW_BOOKING: "New booking {code} — {name}",
    PAYMENT_REVIEW: "Payment to review — {code}",
    PAYMENT_CONFIRMED: "Paid — booking {code} confirmed",
    GUEST_BOOKING_CREATED: "We received booking {code} — please pay",
    GUEST_CONFIRMED: "Booking {code} is confirmed",
    GUEST_PAYMENT_REJECTED: "Payment for booking {code} could not be accepted",
    GUEST_CANCELLED: "Booking {code} was cancelled",
    TEST: "Test e-mail notification",
  },
  createdTitle: "We received your booking",
  createdIntro: "Thank you, {name}. Your booking is reserved — please pay to confirm it.",
  payBy: "Please pay by {time}.",
  amountDue: "Amount due",
  appFee: "App usage fee ({n} units)",
  keepCode: "Keep your Booking ID: with your phone number it opens your booking to pay or send a slip.",
  payNow: "Pay / view booking",
  viewBooking: "View booking",
  openAdmin: "Open in the admin",
  testIntro: "This test e-mail comes from the admin. Recipient “{name}” will receive: {kinds}",
  kinds: { booking: "new bookings", payment: "payments", nothing: "no types selected yet" },
  automated: "This e-mail was sent automatically by the booking system.",
};

const zh: Texts = {
  subjects: {
    NEW_BOOKING: "新预订 {code} — {name}",
    PAYMENT_REVIEW: "待审核付款 — {code}",
    PAYMENT_CONFIRMED: "已付款 — 预订 {code} 已确认",
    GUEST_BOOKING_CREATED: "已收到预订 {code} — 请付款",
    GUEST_CONFIRMED: "预订 {code} 已确认",
    GUEST_PAYMENT_REJECTED: "预订 {code} 的付款未通过审核",
    GUEST_CANCELLED: "预订 {code} 已取消",
    TEST: "测试邮件通知",
  },
  createdTitle: "已收到您的预订",
  createdIntro: "{name}，感谢您的预订。请付款以确认预订。",
  payBy: "请在 {time} 前付款。",
  amountDue: "应付金额",
  appFee: "应用使用费（{n} 个单位）",
  keepCode: "请保存预订编号：配合手机号码可查看预订、付款或上传凭证。",
  payNow: "付款 / 查看预订",
  viewBooking: "查看预订",
  openAdmin: "在后台打开",
  testIntro: "这是后台发送的测试邮件。收件人“{name}”将收到：{kinds}",
  kinds: { booking: "新预订", payment: "付款", nothing: "尚未选择类型" },
  automated: "此邮件由预订系统自动发送。",
};

const DICTS: Record<LocaleCode, Texts> = { th, en, "zh-CN": zh };
export const EMAIL_TEXT_DICTIONARIES = DICTS;

export function emailTexts(lang: string): Texts {
  return DICTS[(lang as LocaleCode) in DICTS ? (lang as LocaleCode) : "th"];
}

export function fillText(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * One message: a heading, body text (blank line = new paragraph), an optional button (https links we
 * built only) and a footer. `body` is plain text; the HTML part is the same text, escaped.
 */
export function renderEmail(p: {
  lang: string;
  subject: string;
  title: string;
  body: string;
  button: { label: string; url: string } | null;
  siteName: string | null;
}): RenderedEmail {
  const t = emailTexts(p.lang);
  const button = p.button && /^https:\/\//.test(p.button.url) ? p.button : null;
  const footer = [p.siteName, t.automated].filter(Boolean).join(" · ");
  const text = [p.title, "", p.body.trim(), ...(button ? ["", `${button.label}: ${button.url}`] : []), "", "—", footer].join("\n");
  const paragraphs = p.body.trim().split(/\n{2,}/).map((para) =>
    `<p style="margin:0 0 14px;line-height:1.6">${para.split("\n").map(escapeHtml).join("<br>")}</p>`).join("");
  const lang = p.lang === "zh-CN" ? "zh-CN" : p.lang === "en" ? "en" : "th";
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(p.subject)}</title></head>`
    + `<body style="margin:0;padding:0;background:#f3f1ec;color:#1f2a24;font-family:-apple-system,'Segoe UI','Noto Sans Thai','Noto Sans SC',Roboto,Arial,sans-serif;font-size:15px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1ec"><tr><td align="center" style="padding:24px 12px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;border:1px solid #e2ddd2">`
    + `<tr><td style="padding:24px 24px 8px">${p.siteName ? `<div style="font-size:13px;color:#5b665f;margin-bottom:6px">${escapeHtml(p.siteName)}</div>` : ""}`
    + `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.35;color:#1f3d2e">${escapeHtml(p.title)}</h1>${paragraphs}`
    + (button ? `<p style="margin:20px 0 8px"><a href="${escapeHtml(button.url)}" style="display:inline-block;background:#1f5c43;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">${escapeHtml(button.label)}</a></p>` : "")
    + `</td></tr><tr><td style="padding:12px 24px 20px;border-top:1px solid #eee9df;font-size:12px;color:#6b746e">${escapeHtml(footer)}</td></tr>`
    + `</table></td></tr></table></body></html>`;
  return { subject: p.subject.replace(/[\r\n]+/g, " ").slice(0, 200), text, html };
}
