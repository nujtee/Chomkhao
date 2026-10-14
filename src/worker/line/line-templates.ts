import { formatBaht } from "../../shared/booking-rules.ts";
import type { LocaleCode } from "../../shared/i18n/locales.ts";

/**
 * LINE message texts (spec §47: TH / EN / ZH-CN). Plain text only — every value is data from
 * D1 (snapshots), so nothing a guest typed can turn into markup or a link we did not build.
 */

export interface MsgFood {
  date: string;
  category: string;
  time: string | null;
  dish: string;
  quantity: number;
}

export interface MsgBooking {
  code: string;
  customerName: string;
  /** Half hidden (maskPhoneHalf / maskEmailHalf) — the full contact never reaches a message. */
  customerPhoneMasked?: string;
  customerEmailMasked?: string | null;
  checkIn: string;
  checkOut: string;
  nights: number;
  itemType: "HOUSE" | "VIP_TENT" | "OWN_TENT";
  itemName: string;
  tents: number;
  /** Every stay of the booking, in the order chosen (several houses / VIP tents / camping). */
  stays?: { type: "HOUSE" | "VIP_TENT" | "OWN_TENT"; name: string; quantity: number }[];
  /** Tarp areas booked with the tents (camping add-on). */
  tarps?: number;
  adults: number;
  children: number;
  bookingStatus: string;
  paymentStatus: string;
  totalSatang: number;
  /** Deposit plan: the amount paid online; the rest is paid at check-in (migration 0025). */
  depositSatang?: number | null;
  /** Money received so far (verified / paid payments). */
  paidSatang?: number;
  food: MsgFood[];
  /** Why staff cancelled (guest messages). */
  cancelReason?: string | null;
  /** Payment deadline of a PENDING booking. */
  expiresAt?: string | null;
  createdAt?: string;
}

export interface KitchenDish {
  category: string;
  time: string | null;
  dish: string;
  confirmed: number;
  pending: number;
}

const th = {
  when: (n: number) => (n === 0 ? "วันนี้" : n === 1 ? "พรุ่งนี้" : `อีก ${n} วัน`),
  checkinTitle: "📅 เช็กอิน{when}: {date}",
  bookingsCount: "{n} การจอง",
  noCheckins: "ไม่มีการเช็กอิน",
  more: "…และอีก {n} การจอง ดูทั้งหมดในระบบหลังบ้าน",
  bookingId: "Booking ID",
  customer: "ผู้จอง",
  phone: "โทร",
  email: "อีเมล",
  openAdmin: "เปิดในระบบหลังบ้าน",
  checkIn: "เช็กอิน",
  checkOut: "เช็กเอาต์",
  nights: "{n} คืน",
  houseVip: "บ้านพัก/VIP",
  camping: "ลานกางเต็นท์",
  tents: "{n} เต็นท์",
  tarp: "พื้นที่กางทาร์ป",
  guests: "ผู้เข้าพัก",
  guestsValue: "ผู้ใหญ่ {a} · เด็ก {c}",
  food: "อาหาร",
  none: "—",
  payment: "การชำระเงิน",
  total: "ยอดรวม",
  amount: "ยอดโอน",
  depositOnline: "มัดจำ (ชำระออนไลน์)",
  depositPaid: "มัดจำที่ชำระแล้ว",
  balanceAtCheckIn: "คงเหลือ ชำระวันเช็กอิน",
  balanceLabel: "ยอดคงเหลือ",
  balanceReceivedTitle: "💰 ได้รับยอดคงเหลือแล้ว — ชำระครบ",
  balanceSlip: "ยอดคงเหลือ (รับมัดจำแล้ว)",
  balanceDueLine: "💰 ค้างรับตอนเช็กอิน: {amount}",
  payAhead: "โอนล่วงหน้าได้ที่หน้าการจอง",
  guestBalanceRejectedTitle: "⚠️ สลิปยอดคงเหลือยังไม่ผ่านการตรวจสอบ",
  guestBalanceRejectedIntro: "คุณ{name} สลิปยอดคงเหลือของการจอง {code} ยังไม่ผ่านการตรวจสอบ การจองของคุณยังยืนยันอยู่",
  payBalanceAgain: "ส่งสลิปใหม่ที่หน้าการจอง หรือชำระที่จุดเช็กอิน",
  open: "เปิดดู",
  kitchenTitle: "🍽️ อาหารที่ต้องเตรียม{when}: {date}",
  noFood: "ไม่มีรายการอาหาร",
  pendingPart: "(รอชำระ +{n})",
  foodOrderTitle: "🍽️ คำสั่งอาหารใหม่ (การจองยืนยันแล้ว)",
  foodCancelledTitle: "❌ ยกเลิกอาหาร — การจองถูกยกเลิก",
  reviewTitle: "🧾 สลิปรอตรวจสอบ",
  confirmedTitle: "✅ ชำระเงินแล้ว — การจองยืนยัน",
  paidBy: "ชำระโดย",
  guestConfirmedTitle: "✅ ยืนยันการจองแล้ว",
  guestConfirmedIntro: "ขอบคุณที่จองกับเรา คุณ{name} เราได้รับการชำระเงินเรียบร้อยแล้ว",
  guestCheckinTitle: "📅 แจ้งเตือน: เช็กอิน{when}",
  guestHello: "สวัสดีคุณ{name}",
  address: "ที่อยู่",
  map: "แผนที่",
  contact: "ติดต่อ",
  viewBooking: "ดูการจอง",
  seeYou: "แล้วพบกันเร็ว ๆ นี้",
  testTitle: "✅ ทดสอบการแจ้งเตือน",
  testBody: "แชตนี้ (“{name}”) เชื่อมต่อแล้ว และจะได้รับ: {kinds}",
  kinds: { booking: "การจองใหม่", checkin: "เช็กอินล่วงหน้า", food: "อาหาร/ครัว", payment: "การชำระเงิน", nothing: "ยังไม่ได้เลือกประเภท" },
  staffLinked: "✅ เชื่อมต่อแล้ว: แชตนี้ (“{name}”) จะได้รับการแจ้งเตือน{site}",
  guestLinked: "✅ เชื่อมต่อการจอง {code} กับ LINE แล้ว เราจะส่งการยืนยันและการแจ้งเตือนก่อนวันเข้าพักทางแชตนี้ ยกเลิกได้ทุกเมื่อในหน้าการจอง",
  guestOneToOne: "กรุณาส่งรหัสนี้ในแชตส่วนตัวกับบัญชีนี้ (ไม่ใช่ในกลุ่ม)",
  fromSite: " จาก {site}",
  bookingStatus: {
    PENDING: "การจองยังไม่ยืนยัน", CONFIRMED: "ยืนยันแล้ว", CHECKED_IN: "เช็กอินแล้ว", CHECKED_OUT: "เช็กเอาต์แล้ว",
    CANCELLED: "ยกเลิก", EXPIRED: "หมดเวลา", NO_SHOW: "ไม่มาเข้าพัก",
  } as Record<string, string>,
  paymentStatus: {
    UNPAID: "ยังไม่ชำระ", PENDING_VERIFICATION: "รอตรวจสลิป", VERIFIED: "ชำระแล้ว (ตรวจสลิปแล้ว)", PAID: "ชำระแล้ว",
    REJECTED: "สลิปไม่ผ่าน รอชำระใหม่", REFUNDED: "คืนเงินแล้ว",
  } as Record<string, string>,
  methods: { BANK_TRANSFER: "โอนเงิน", PROMPTPAY: "พร้อมเพย์", CASH: "เงินสด", OTHER: "อื่น ๆ" } as Record<string, string>,
  channels: { PROMPTPAY: "พร้อมเพย์", BANK_TRANSFER: "โอนเข้าบัญชี", QR_CODE: "สแกน QR Code", PAYPAL: "PayPal" } as Record<string, string>,
  newBookingTitle: "🆕 การจองใหม่ — รอชำระเงิน",
  payBy: "ชำระภายใน",
  autoPassed: "ตรวจสลิปอัตโนมัติ: ถูกต้อง — รอแอดมินอนุมัติ",
  autoFailed: "ตรวจสลิปอัตโนมัติไม่ผ่าน: {reason} — กรุณาตรวจสอบ",
  failures: {
    AMOUNT_MISMATCH: "ยอดเงินไม่ตรง", DATE_OUT_OF_RANGE: "วันเวลาโอนไม่ตรงกับการจอง", RECEIVER_MISMATCH: "บัญชีผู้รับไม่ตรง",
    RECEIVER_UNCONFIRMED: "ยืนยันบัญชีผู้รับไม่ได้", DUPLICATE_TRANSACTION: "สลิปนี้ถูกใช้แล้ว", other: "ระบบตรวจไม่ได้ ({code})",
  } as Record<string, string>,
  guestRejectedTitle: "⚠️ การชำระเงินยังไม่ผ่านการตรวจสอบ",
  guestRejectedIntro: "คุณ{name} สลิปสำหรับการจอง {code} ยังไม่ผ่านการตรวจสอบ",
  reason: "เหตุผล",
  payAgainUntil: "กรุณาชำระเงินหรือส่งสลิปใหม่ภายใน {time}",
  payAgain: "กรุณาชำระเงินหรือส่งสลิปใหม่ที่หน้าการจอง",
  guestCancelledTitle: "❌ การจองถูกยกเลิก",
  guestCancelledIntro: "คุณ{name} การจอง {code} ถูกยกเลิกแล้ว",
  questions: "หากมีข้อสงสัย กรุณาติดต่อ",
  itemTypes: { HOUSE: "บ้านพัก", VIP_TENT: "VIP Tent", OWN_TENT: "ลานกางเต็นท์" } as Record<string, string>,
};

type Texts = typeof th;

const en: Texts = {
  when: (n) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`),
  checkinTitle: "📅 Check-ins {when}: {date}",
  bookingsCount: "{n} booking(s)",
  noCheckins: "No check-ins.",
  more: "…and {n} more — see the admin.",
  bookingId: "Booking ID",
  customer: "Customer",
  phone: "Phone",
  email: "E-mail",
  openAdmin: "Open in admin",
  checkIn: "Check-in",
  checkOut: "Check-out",
  nights: "{n} night(s)",
  houseVip: "House/VIP",
  camping: "Camping",
  tents: "{n} tent(s)",
  tarp: "tarp area",
  guests: "Guests",
  guestsValue: "{a} adult(s) · {c} child(ren)",
  food: "Food",
  none: "—",
  payment: "Payment",
  total: "Total",
  amount: "Amount",
  depositOnline: "Deposit (paid online)",
  depositPaid: "Deposit paid",
  balanceAtCheckIn: "Balance, paid at check-in",
  balanceLabel: "Balance",
  balanceReceivedTitle: "💰 Balance received — paid in full",
  balanceSlip: "Balance (deposit already paid)",
  balanceDueLine: "💰 Still due at check-in: {amount}",
  payAhead: "You can also transfer it ahead on your booking page.",
  guestBalanceRejectedTitle: "⚠️ Your balance transfer could not be accepted yet",
  guestBalanceRejectedIntro: "{name}, the slip for the balance of booking {code} was not accepted. Your booking stays confirmed.",
  payBalanceAgain: "Send a new slip on your booking page, or pay at check-in.",
  open: "Open",
  kitchenTitle: "🍽️ Food to prepare {when}: {date}",
  noFood: "No food orders.",
  pendingPart: "(awaiting payment +{n})",
  foodOrderTitle: "🍽️ New food order (booking confirmed)",
  foodCancelledTitle: "❌ Food cancelled — booking cancelled",
  reviewTitle: "🧾 Payment slip to review",
  confirmedTitle: "✅ Paid — booking confirmed",
  paidBy: "Paid by",
  guestConfirmedTitle: "✅ Your booking is confirmed",
  guestConfirmedIntro: "Thank you, {name}. We have received your payment.",
  guestCheckinTitle: "📅 Reminder: check-in {when}",
  guestHello: "Hello {name},",
  address: "Address",
  map: "Map",
  contact: "Contact",
  viewBooking: "Your booking",
  seeYou: "See you soon!",
  testTitle: "✅ Test notification",
  testBody: "This chat (“{name}”) is connected and will receive: {kinds}",
  kinds: { booking: "new bookings", checkin: "upcoming check-ins", food: "food / kitchen", payment: "payments", nothing: "no types selected yet" },
  staffLinked: "✅ Connected: this chat (“{name}”) will receive notifications{site}.",
  guestLinked: "✅ Booking {code} is now linked to LINE. We will send your confirmation and a reminder before your stay here. You can stop this any time on your booking page.",
  guestOneToOne: "Please send this code in a one-to-one chat with this account (not in a group).",
  fromSite: " from {site}",
  bookingStatus: {
    PENDING: "not confirmed yet", CONFIRMED: "confirmed", CHECKED_IN: "checked in", CHECKED_OUT: "checked out",
    CANCELLED: "cancelled", EXPIRED: "expired", NO_SHOW: "no-show",
  },
  paymentStatus: {
    UNPAID: "Unpaid", PENDING_VERIFICATION: "Slip under review", VERIFIED: "Paid (slip verified)", PAID: "Paid",
    REJECTED: "Slip rejected — awaiting payment", REFUNDED: "Refunded",
  },
  methods: { BANK_TRANSFER: "bank transfer", PROMPTPAY: "PromptPay", CASH: "cash", OTHER: "other" },
  channels: { PROMPTPAY: "PromptPay", BANK_TRANSFER: "bank transfer", QR_CODE: "QR code", PAYPAL: "PayPal" },
  newBookingTitle: "🆕 New booking — awaiting payment",
  payBy: "Pay by",
  autoPassed: "Automatic slip check: correct — waiting for your approval",
  autoFailed: "Automatic slip check failed: {reason} — please review",
  failures: {
    AMOUNT_MISMATCH: "amount does not match", DATE_OUT_OF_RANGE: "transfer time does not fit the booking", RECEIVER_MISMATCH: "wrong receiving account",
    RECEIVER_UNCONFIRMED: "receiving account could not be confirmed", DUPLICATE_TRANSACTION: "slip already used", other: "could not be checked ({code})",
  },
  guestRejectedTitle: "⚠️ Your payment could not be accepted yet",
  guestRejectedIntro: "{name}, the slip for booking {code} was not accepted.",
  reason: "Reason",
  payAgainUntil: "Please pay or send a new slip by {time}.",
  payAgain: "Please pay or send a new slip on your booking page.",
  guestCancelledTitle: "❌ Your booking was cancelled",
  guestCancelledIntro: "{name}, booking {code} has been cancelled.",
  questions: "Questions? Contact us",
  itemTypes: { HOUSE: "House", VIP_TENT: "VIP Tent", OWN_TENT: "Camping" },
};

const zh: Texts = {
  when: (n) => (n === 0 ? "今天" : n === 1 ? "明天" : `${n}天后`),
  checkinTitle: "📅 {when}入住：{date}",
  bookingsCount: "{n} 个预订",
  noCheckins: "没有入住。",
  more: "……还有 {n} 个预订，请在后台查看。",
  bookingId: "预订编号",
  customer: "预订人",
  phone: "电话",
  email: "邮箱",
  openAdmin: "在后台打开",
  checkIn: "入住",
  checkOut: "退房",
  nights: "{n} 晚",
  houseVip: "房屋/VIP",
  camping: "露营",
  tents: "{n} 顶帐篷",
  tarp: "天幕区",
  guests: "入住人数",
  guestsValue: "成人 {a} · 儿童 {c}",
  food: "餐饮",
  none: "—",
  payment: "付款",
  total: "合计",
  amount: "金额",
  depositOnline: "定金（在线支付）",
  depositPaid: "已付定金",
  balanceAtCheckIn: "余款（入住时支付）",
  balanceLabel: "余款",
  balanceReceivedTitle: "💰 已收到余款 — 已付清",
  balanceSlip: "余款（定金已付）",
  balanceDueLine: "💰 入住时待收：{amount}",
  payAhead: "也可在预订页面提前转账。",
  guestBalanceRejectedTitle: "⚠️ 您的余款转账暂未通过审核",
  guestBalanceRejectedIntro: "{name}，预订 {code} 的余款转账凭证未通过审核。您的预订仍然有效。",
  payBalanceAgain: "请在预订页面重新上传凭证，或在入住时付款。",
  open: "查看",
  kitchenTitle: "🍽️ {when}需准备的餐饮：{date}",
  noFood: "没有餐饮订单。",
  pendingPart: "（待付款 +{n}）",
  foodOrderTitle: "🍽️ 新餐饮订单（预订已确认）",
  foodCancelledTitle: "❌ 餐饮取消 — 预订已取消",
  reviewTitle: "🧾 待审核的转账凭证",
  confirmedTitle: "✅ 已付款 — 预订已确认",
  paidBy: "付款方式",
  guestConfirmedTitle: "✅ 您的预订已确认",
  guestConfirmedIntro: "{name}，感谢您的预订，我们已收到您的付款。",
  guestCheckinTitle: "📅 提醒：{when}入住",
  guestHello: "{name}，您好：",
  address: "地址",
  map: "地图",
  contact: "联系",
  viewBooking: "查看预订",
  seeYou: "期待您的光临！",
  testTitle: "✅ 测试通知",
  testBody: "此聊天（“{name}”）已连接，将收到：{kinds}",
  kinds: { booking: "新预订", checkin: "入住提醒", food: "餐饮/厨房", payment: "付款", nothing: "尚未选择类型" },
  staffLinked: "✅ 已连接：此聊天（“{name}”）将收到通知{site}。",
  guestLinked: "✅ 预订 {code} 已与 LINE 连接。我们会在此发送确认信息和入住前提醒。您可以随时在预订页面停止。",
  guestOneToOne: "请在与本账号的一对一聊天中发送此代码（不要在群组中）。",
  fromSite: "（{site}）",
  bookingStatus: {
    PENDING: "尚未确认", CONFIRMED: "已确认", CHECKED_IN: "已入住", CHECKED_OUT: "已退房",
    CANCELLED: "已取消", EXPIRED: "已过期", NO_SHOW: "未入住",
  },
  paymentStatus: {
    UNPAID: "未付款", PENDING_VERIFICATION: "凭证审核中", VERIFIED: "已付款（凭证已核实）", PAID: "已付款",
    REJECTED: "凭证未通过 — 待重新付款", REFUNDED: "已退款",
  },
  methods: { BANK_TRANSFER: "银行转账", PROMPTPAY: "PromptPay", CASH: "现金", OTHER: "其他" },
  channels: { PROMPTPAY: "PromptPay", BANK_TRANSFER: "银行转账", QR_CODE: "扫码支付", PAYPAL: "PayPal" },
  newBookingTitle: "🆕 新预订 — 待付款",
  payBy: "付款截止",
  autoPassed: "自动核验凭证：正确 — 等待管理员批准",
  autoFailed: "自动核验凭证未通过：{reason} — 请人工审核",
  failures: {
    AMOUNT_MISMATCH: "金额不符", DATE_OUT_OF_RANGE: "转账时间与预订不符", RECEIVER_MISMATCH: "收款账户不符",
    RECEIVER_UNCONFIRMED: "无法确认收款账户", DUPLICATE_TRANSACTION: "凭证已被使用", other: "无法核验（{code}）",
  },
  guestRejectedTitle: "⚠️ 您的付款暂未通过审核",
  guestRejectedIntro: "{name}，预订 {code} 的转账凭证未通过审核。",
  reason: "原因",
  payAgainUntil: "请在 {time} 前付款或重新上传凭证。",
  payAgain: "请在预订页面付款或重新上传凭证。",
  guestCancelledTitle: "❌ 您的预订已取消",
  guestCancelledIntro: "{name}，预订 {code} 已取消。",
  questions: "如有疑问，请联系",
  itemTypes: { HOUSE: "房屋", VIP_TENT: "VIP 帐篷", OWN_TENT: "露营" },
};

/** Trilingual: the code's language is unknown when it does not match anything. */
export const INVALID_CODE_REPLY = "รหัสไม่ถูกต้องหรือหมดอายุ กรุณาสร้างรหัสใหม่\nInvalid or expired code. Please create a new one.\n代码无效或已过期，请重新生成。";

const DICTS: Record<LocaleCode, Texts> = { th, en, "zh-CN": zh };

export function lineTexts(lang: string): Texts {
  return DICTS[(lang as LocaleCode) in DICTS ? (lang as LocaleCode) : "th"];
}

export const LINE_TEXT_DICTIONARIES = DICTS;

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
}

export class LineFormatter {
  readonly t: Texts;
  private readonly dateFmt: Intl.DateTimeFormat;
  private readonly shortDate: Intl.DateTimeFormat;

  constructor(readonly lang: string) {
    this.t = lineTexts(lang);
    const code = lang in DICTS ? lang : "th";
    this.dateFmt = new Intl.DateTimeFormat(code, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    this.shortDate = new Intl.DateTimeFormat(code, { day: "numeric", month: "short", timeZone: "UTC" });
  }

  fill = fill;

  date(d: string): string {
    return this.dateFmt.format(new Date(`${d}T00:00:00Z`));
  }

  short(d: string): string {
    return this.shortDate.format(new Date(`${d}T00:00:00Z`));
  }

  money(satang: number): string {
    return formatBaht(satang, this.lang in DICTS ? this.lang : "th");
  }

  /** An instant (ISO) as date + time in the property's time zone. */
  dateTime(instant: string, timeZone = "Asia/Bangkok"): string {
    const code = this.lang in DICTS ? this.lang : "th";
    return new Intl.DateTimeFormat(code, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(instant));
  }

  failure(code: string): string {
    return this.t.failures[code] ?? fill(this.t.failures.other!, { code });
  }

  paidBy(method: string | null, channel: string | null): string | null {
    if (channel) return this.t.channels[channel] ?? channel;
    return method ? this.t.methods[method] ?? method : null;
  }

  payment(b: Pick<MsgBooking, "paymentStatus" | "bookingStatus">): string {
    const pay = this.t.paymentStatus[b.paymentStatus] ?? b.paymentStatus;
    return b.bookingStatus === "CONFIRMED" ? pay : `${pay} · ${this.t.bookingStatus[b.bookingStatus] ?? b.bookingStatus}`;
  }

  foodLines(food: MsgFood[]): string[] {
    return food.map((f) => `• ${this.short(f.date)} ${f.category}${f.time ? ` ${f.time}` : ""} — ${f.dish} ×${f.quantity}`);
  }

  stayLine(b: MsgBooking): string {
    // Several stays: the houses / VIP tents on one line, the camping tents on the next.
    if (b.stays && b.stays.length > 1) {
      const units = b.stays.filter((s) => s.type !== "OWN_TENT").map((s) => s.name);
      const camp = b.stays.find((s) => s.type === "OWN_TENT");
      return [
        ...(units.length ? [`${this.t.houseVip}: ${units.join(", ")}`] : []),
        ...(camp ? [`${this.t.camping}: ${fill(this.t.tents, { n: camp.quantity })}${b.tarps ? ` + ${this.t.tarp}` : ""}`] : []),
      ].join("\n");
    }
    return b.itemType === "OWN_TENT"
      ? `${this.t.camping}: ${fill(this.t.tents, { n: b.tents })}${b.tarps ? ` + ${this.t.tarp}` : ""}`
      : `${this.t.houseVip}: ${b.itemName}`;
  }

  /** The booking fields of spec §47, one per line; `contact` adds the guest's half-hidden phone / e-mail (staff). */
  bookingBlock(b: MsgBooking, opts: { customer?: boolean; contact?: boolean } = {}): string {
    const t = this.t;
    const lines = [
      `${t.bookingId}: ${b.code}`,
      ...(opts.customer === false ? [] : [`${t.customer}: ${b.customerName}`]),
      ...(opts.customer !== false && opts.contact && b.customerPhoneMasked ? [`${t.phone}: ${b.customerPhoneMasked}`] : []),
      ...(opts.customer !== false && opts.contact && b.customerEmailMasked ? [`${t.email}: ${b.customerEmailMasked}`] : []),
      `${t.checkIn}: ${this.date(b.checkIn)}`,
      `${t.checkOut}: ${this.date(b.checkOut)} (${fill(t.nights, { n: b.nights })})`,
      this.stayLine(b),
      `${t.guests}: ${fill(t.guestsValue, { a: b.adults, c: b.children })}`,
      b.food.length ? `${t.food}:\n${this.foodLines(b.food).join("\n")}` : `${t.food}: ${t.none}`,
      `${t.payment}: ${this.payment(b)}`,
    ];
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------- builders

export function checkinDigestBlocks(f: LineFormatter, p: { date: string; daysBefore: number; siteName: string | null; bookings: MsgBooking[]; link: string | null }): string[] {
  const t = f.t;
  const head = [
    fill(t.checkinTitle, { when: t.when(p.daysBefore), date: f.date(p.date) }),
    ...(p.siteName ? [p.siteName] : []),
    p.bookings.length ? fill(t.bookingsCount, { n: p.bookings.length }) : t.noCheckins,
    ...(p.link ? [`${t.open}: ${p.link}`] : []),
  ].join("\n");
  return [head, ...p.bookings.map((b, i) => [
    `${i + 1}) ${f.bookingBlock(b)}`,
    ...(b.bookingStatus === "CONFIRMED" && stillDue(b) > 0 ? [fill(t.balanceDueLine, { amount: f.money(stillDue(b)) })] : []),
  ].join("\n"))];
}

export function kitchenDigestBlocks(f: LineFormatter, p: { date: string; daysBefore: number; dishes: KitchenDish[]; link: string | null }): string[] {
  const t = f.t;
  const head = [fill(t.kitchenTitle, { when: t.when(p.daysBefore), date: f.date(p.date) }), ...(p.dishes.length ? [] : [t.noFood]), ...(p.link ? [`${t.open}: ${p.link}`] : [])].join("\n");
  const groups = new Map<string, KitchenDish[]>();
  for (const d of p.dishes) {
    const key = `${d.category}${d.time ? ` · ${d.time}` : ""}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [head, ...[...groups.entries()].map(([key, dishes]) => [
    key,
    ...dishes.map((d) => `• ${d.dish} ×${d.confirmed}${d.pending ? ` ${fill(t.pendingPart, { n: d.pending })}` : ""}`),
  ].join("\n"))];
}

export function foodOrderText(f: LineFormatter, b: MsgBooking, cancelled: boolean): string {
  const t = f.t;
  return [
    cancelled ? t.foodCancelledTitle : t.foodOrderTitle,
    `${b.code} · ${b.customerName}`,
    f.stayLine(b),
    `${t.guests}: ${fill(t.guestsValue, { a: b.adults, c: b.children })}`,
    ...f.foodLines(b.food),
  ].join("\n");
}

/** `check`: the newest automatic slip check (null = none ran). */
export function paymentReviewText(
  f: LineFormatter, b: MsgBooking, amountSatang: number, link: string | null,
  extra: { channel?: string | null; check?: { result: string; failure_code: string | null } | null } = {},
): string {
  const t = f.t;
  const check = extra.check;
  return [
    t.reviewTitle,
    `${b.code} · ${b.customerName}`,
    `${t.amount}: ${f.money(amountSatang)}${extra.channel ? ` · ${t.channels[extra.channel] ?? extra.channel}` : ""}`,
    // The rest of a deposit: the booking is already confirmed.
    ...(b.depositSatang && b.bookingStatus === "CONFIRMED" ? [t.balanceSlip] : []),
    `${t.checkIn}: ${f.date(b.checkIn)} (${fill(t.nights, { n: b.nights })})`,
    f.stayLine(b),
    ...(check ? [check.result === "PASSED" ? t.autoPassed : fill(t.autoFailed, { reason: f.failure(check.failure_code ?? "INTERNAL") })] : []),
    ...(link ? [`${t.open}: ${link}`] : []),
  ].join("\n");
}

/** Deposit plan: "deposit … · balance at check-in …" lines (nothing for a booking paid in full). */
function depositLines(f: LineFormatter, b: MsgBooking, paid: boolean): string[] {
  if (!b.depositSatang) return [];
  return [
    `${paid ? f.t.depositPaid : f.t.depositOnline}: ${f.money(b.depositSatang)}`,
    `${f.t.balanceAtCheckIn}: ${f.money(stillDue(b))}`,
  ];
}

/** Deposit plan: what the booking still owes (total − money received; the deposit alone if that is unknown). */
export function stillDue(b: MsgBooking): number {
  return b.depositSatang ? Math.max(0, b.totalSatang - (b.paidSatang ?? b.depositSatang)) : 0;
}

/** Staff: the rest of a deposit came in (the guest's transfer verified, or taken at reception). */
export function balanceReceivedText(f: LineFormatter, b: MsgBooking, amountSatang: number, method: string | null, channel: string | null): string {
  const t = f.t;
  const by = f.paidBy(method, channel);
  return [
    t.balanceReceivedTitle,
    `${b.code} · ${b.customerName}`,
    `${t.balanceLabel}: ${f.money(amountSatang)}${by ? ` · ${t.paidBy}: ${by}` : ""}`,
    `${t.total}: ${f.money(b.totalSatang)}`,
    `${t.checkIn}: ${f.date(b.checkIn)} (${fill(t.nights, { n: b.nights })})`,
    f.stayLine(b),
  ].join("\n");
}

/** Guest: the slip for the rest was turned down — the booking stays confirmed; send another or pay at check-in. */
export function guestBalanceRejectedText(f: LineFormatter, b: MsgBooking, p: { reason: string | null; link: string | null; siteName: string | null }): string {
  const t = f.t;
  return [
    t.guestBalanceRejectedTitle,
    fill(t.guestBalanceRejectedIntro, { name: b.customerName, code: b.code }),
    ...(p.reason ? [`${t.reason}: ${p.reason}`] : []),
    "",
    t.payBalanceAgain,
    `${t.balanceLabel}: ${f.money(stillDue(b))}`,
    ...(p.link ? [`${t.viewBooking}: ${p.link}`] : []),
    ...(p.siteName ? ["", p.siteName] : []),
  ].join("\n");
}

export function paymentConfirmedText(f: LineFormatter, b: MsgBooking, method: string | null, channel: string | null = null): string {
  const t = f.t;
  const by = f.paidBy(method, channel);
  return [
    t.confirmedTitle,
    f.bookingBlock(b),
    `${t.total}: ${f.money(b.totalSatang)}${by ? ` · ${t.paidBy}: ${by}` : ""}`,
    ...depositLines(f, b, true),
  ].join("\n");
}

/** Staff: a guest booked (awaiting payment until the deadline). */
/** Staff: a guest booked — who (phone / e-mail half hidden), what, how much, pay-by, and the admin page. */
export function newBookingText(f: LineFormatter, b: MsgBooking, link: string | null): string {
  const t = f.t;
  return [
    t.newBookingTitle,
    f.bookingBlock(b, { contact: true }),
    `${t.total}: ${f.money(b.totalSatang)}`,
    ...depositLines(f, b, false),
    ...(b.expiresAt ? [`${t.payBy}: ${f.dateTime(b.expiresAt)}`] : []),
    ...(link ? ["", `${t.openAdmin}:`, link] : []),
  ].join("\n");
}

/** Guest: the slip was turned down; the reason, and until when they can pay again. */
export function guestPaymentRejectedText(f: LineFormatter, b: MsgBooking, p: { reason: string | null; link: string | null; siteName: string | null }): string {
  const t = f.t;
  return [
    t.guestRejectedTitle,
    fill(t.guestRejectedIntro, { name: b.customerName, code: b.code }),
    ...(p.reason ? [`${t.reason}: ${p.reason}`] : []),
    "",
    b.expiresAt ? fill(t.payAgainUntil, { time: f.dateTime(b.expiresAt) }) : t.payAgain,
    `${t.amount}: ${f.money(b.depositSatang ?? b.totalSatang)}`,
    ...(p.link ? [`${t.viewBooking}: ${p.link}`] : []),
    ...(p.siteName ? ["", p.siteName] : []),
  ].join("\n");
}

/** Guest: staff cancelled the booking, with their reason. */
export function guestCancelledText(f: LineFormatter, b: MsgBooking, p: { siteName: string | null; phone: string | null }): string {
  const t = f.t;
  return [
    t.guestCancelledTitle,
    fill(t.guestCancelledIntro, { name: b.customerName, code: b.code }),
    ...(b.cancelReason ? [`${t.reason}: ${b.cancelReason}`] : []),
    "",
    `${t.checkIn}: ${f.date(b.checkIn)} → ${f.date(b.checkOut)}`,
    f.stayLine(b),
    ...(p.phone ? ["", `${t.questions}: ${p.phone}`] : []),
    ...(p.siteName ? ["", p.siteName] : []),
  ].join("\n");
}

export function guestConfirmedText(f: LineFormatter, b: MsgBooking, p: { siteName: string | null; link: string | null }): string {
  const t = f.t;
  return [
    t.guestConfirmedTitle,
    fill(t.guestConfirmedIntro, { name: b.customerName }),
    "",
    f.bookingBlock(b, { customer: false }),
    `${t.total}: ${f.money(b.totalSatang)}`,
    ...depositLines(f, b, true),
    ...(p.link ? ["", `${t.viewBooking}: ${p.link}`] : []),
    ...(p.siteName ? ["", p.siteName] : []),
  ].join("\n");
}

export function guestCheckinText(
  f: LineFormatter,
  b: MsgBooking,
  p: { daysBefore: number; siteName: string | null; address: string | null; mapUrl: string | null; phone: string | null; link: string | null },
): string {
  const t = f.t;
  return [
    fill(t.guestCheckinTitle, { when: t.when(p.daysBefore) }),
    fill(t.guestHello, { name: b.customerName }),
    "",
    f.bookingBlock(b, { customer: false }),
    // Deposit plan: what to bring for check-in.
    ...(b.bookingStatus === "CONFIRMED" && stillDue(b) > 0
      ? [`${t.balanceAtCheckIn}: ${f.money(stillDue(b))}`, ...(p.link ? [t.payAhead] : [])] : []),
    ...(p.address || p.mapUrl || p.phone ? [""] : []),
    ...(p.address ? [`${t.address}: ${p.address}`] : []),
    ...(p.mapUrl ? [`${t.map}: ${p.mapUrl}`] : []),
    ...(p.phone ? [`${t.contact}: ${p.phone}`] : []),
    ...(p.link ? [`${t.viewBooking}: ${p.link}`] : []),
    "",
    `${t.seeYou}${p.siteName ? ` — ${p.siteName}` : ""}`,
  ].join("\n");
}

export function testText(f: LineFormatter, p: { name: string; checkin: boolean; food: boolean; payment: boolean; booking?: boolean; siteName: string | null }): string {
  const t = f.t;
  const kinds = [p.booking && t.kinds.booking, p.checkin && t.kinds.checkin, p.food && t.kinds.food, p.payment && t.kinds.payment].filter(Boolean).join(", ") || t.kinds.nothing;
  return [t.testTitle, ...(p.siteName ? [p.siteName] : []), fill(t.testBody, { name: p.name, kinds })].join("\n");
}

export function staffLinkedText(f: LineFormatter, name: string, siteName: string | null): string {
  return fill(f.t.staffLinked, { name, site: siteName ? fill(f.t.fromSite, { site: siteName }) : "" });
}

export function guestLinkedText(f: LineFormatter, code: string): string {
  return fill(f.t.guestLinked, { code });
}
