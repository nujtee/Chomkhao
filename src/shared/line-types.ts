import type { LocaleCode } from "./i18n/locales.ts";

/** LINE Messaging API ids: U… (user), C… (group), R… (room) + 32 lowercase hex. */
export const LINE_TARGET_PATTERN = /^[UCR][0-9a-f]{32}$/;
export const LINE_USER_PATTERN = /^U[0-9a-f]{32}$/;
/** Basic ID of an Official Account, e.g. "@123abcde". */
export const LINE_BASIC_ID_PATTERN = /^@[A-Za-z0-9._-]{2,38}$/;

/** One-time link code: 8 characters without look-alikes (no 0/O, 1/I), shown as ABCD-EFGH. */
export const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Message the user sends to the Official Account. "LINK" + code is required so ordinary chat is never mistaken for a code. */
export const LINK_MESSAGE_PATTERN = /\bLINK\s*[:：]?\s*([A-HJ-NP-Z2-9]{4})-([A-HJ-NP-Z2-9]{4})\b/i;
export const LINK_CODE_TTL_MINUTES = 30;

export const NOTIFICATION_TYPES = [
  "CHECKIN_DIGEST", // staff: tomorrow's check-ins (spec §47)
  "FOOD_DIGEST", // staff (kitchen): tomorrow's food to prepare
  "FOOD_ORDER", // staff (kitchen): a confirmed booking with food
  "FOOD_CANCELLED", // staff (kitchen): a confirmed booking with food was cancelled
  "PAYMENT_REVIEW", // staff: a slip waits for manual review
  "PAYMENT_CONFIRMED", // staff: a booking is paid and confirmed
  "NEW_BOOKING", // staff: a guest made a booking (awaiting payment)
  "GUEST_CONFIRMED", // guest: payment received, booking confirmed
  "GUEST_PAYMENT_REJECTED", // guest: the slip was not accepted (with the reason) — pay again
  "GUEST_CANCELLED", // guest: the booking was cancelled (with the reason)
  "GUEST_CHECKIN", // guest: check-in reminder
  "TEST", // staff: test message from the admin
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_STATUSES = ["PENDING", "SENT", "FAILED", "CANCELLED"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const REMINDER_DAYS_MAX = 7;

export interface LineSettingsDto {
  enabled: boolean;
  guestEnabled: boolean;
  publicButton: boolean;
  reminderDaysBefore: number;
  /** "HH:MM", property time zone. */
  reminderTime: string;
  sendWhenEmpty: boolean;
  /** Cloudflare Secrets present? Values are never returned. */
  tokenConfigured: boolean;
  secretConfigured: boolean;
  /** Paste into LINE Developers → Messaging API → Webhook URL. */
  webhookUrl: string;
  timezone: string;
  bot: { basicId: string | null; displayName: string | null; checkedAt: string | null };
  /** Public "add friend" link (Website settings URL, or derived from the bot's Basic ID). */
  addFriendUrl: string | null;
  updatedAt: string;
}

export interface LineSettingsInput {
  enabled: boolean;
  guestEnabled: boolean;
  publicButton: boolean;
  reminderDaysBefore: number;
  reminderTime: string;
  sendWhenEmpty: boolean;
}

export interface LineConnectionDto {
  ok: true;
  basicId: string | null;
  displayName: string | null;
  /** null = no monthly limit reported by LINE. */
  quotaLimit: number | null;
  quotaUsed: number | null;
}

export type LineTargetKind = "USER" | "GROUP" | "ROOM";

export interface LineRecipientDto {
  id: string;
  name: string;
  kind: LineTargetKind;
  /** Masked (U1234…cdef) — the full id is not needed in the UI. */
  targetMasked: string;
  language: LocaleCode;
  notifyCheckin: boolean;
  notifyFood: boolean;
  notifyPayment: boolean;
  /** Every new booking (migration 0023). */
  notifyBooking: boolean;
  active: boolean;
  linkedVia: "CODE" | "MANUAL";
  createdAt: string;
  updatedAt: string;
}

export interface LineRecipientInput {
  name: string;
  language: LocaleCode;
  notifyCheckin: boolean;
  notifyFood: boolean;
  notifyPayment: boolean;
  /** Optional for older clients: unchanged when left out. */
  notifyBooking?: boolean;
}

export interface LineLinkCodeDto {
  id: string;
  /** Shown once. */
  code: string;
  message: string;
  expiresAt: string;
  addFriendUrl: string | null;
  /** Opens the chat with the Official Account with `message` filled in (scan on a phone); null until the bot is checked. */
  url: string | null;
}

export interface LineLinkStatusDto {
  status: "PENDING" | "LINKED" | "EXPIRED";
  recipient: LineRecipientDto | null;
}

export interface NotificationLogDto {
  id: string;
  type: NotificationType;
  status: NotificationStatus;
  audience: "STAFF" | "GUEST";
  recipientName: string | null;
  bookingCode: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  scheduledFor: string;
  nextAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

/** Guest side, part of the public booking view. */
export interface GuestLineDto {
  /** LINE updates can be turned on for this booking. */
  available: boolean;
  linked: boolean;
}

export interface GuestLineLinkDto {
  code: string;
  expiresAt: string;
  /** Opens the chat with the Official Account with the link message pre-filled. */
  url: string;
  message: string;
}

export function maskLineId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 5)}…${id.slice(-4)}` : "…";
}

export function lineTargetKind(id: string): LineTargetKind {
  return id.startsWith("C") ? "GROUP" : id.startsWith("R") ? "ROOM" : "USER";
}

/** "https://line.me/R/ti/p/@basicid" — opens the Official Account profile (add friend). */
export function addFriendUrl(basicId: string | null): string | null {
  return basicId && LINE_BASIC_ID_PATTERN.test(basicId) ? `https://line.me/R/ti/p/${basicId}` : null;
}

/** "https://line.me/R/oaMessage/@basicid/?text" — opens the chat with a pre-filled message. */
export function oaMessageUrl(basicId: string, text: string): string {
  return `https://line.me/R/oaMessage/${basicId}/?${encodeURIComponent(text)}`;
}
