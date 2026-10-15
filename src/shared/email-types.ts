import type { LocaleCode } from "./i18n/locales.ts";

/**
 * E-mail notifications, sent from the shop's Zoho Mail mailbox (Cloudflare Secrets ZOHO_CLIENT_ID,
 * ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN) or through Resend (RESEND_API_KEY).
 */
export type EmailProviderName = "ZOHO" | "RESEND";

export const EMAIL_TYPES = [
  "NEW_BOOKING", // staff: a guest booked
  "PAYMENT_REVIEW", // staff: a payment waits for review (manual mode, or the automatic check did not pass)
  "PAYMENT_CONFIRMED", // staff: a booking is paid and confirmed
  "GUEST_BOOKING_CREATED", // guest: booking received + how and until when to pay
  "GUEST_CONFIRMED", // guest: payment received, booking confirmed
  "GUEST_PAYMENT_REJECTED", // guest: payment not accepted (reason) — pay again
  "GUEST_CANCELLED", // guest: booking cancelled (reason)
  "TEST", // staff: test message from the admin
  "CREDIT_LOW", // back-office users: app-usage credits below the low threshold (once a day)
  "CREDIT_EMPTY", // back-office users: not enough credit for one unit — online booking closed (twice a day)
  "CREDIT_TOPUP_REQUEST", // Super Admin: a top-up waits for approval
  "CREDIT_TOPUP_RESULT", // the user who asked: top-up approved / rejected
] as const;
export type EmailType = (typeof EMAIL_TYPES)[number];

export const EMAIL_STATUSES = ["PENDING", "SENT", "FAILED", "CANCELLED"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export interface EmailSettingsDto {
  enabled: boolean;
  /** Guests with an e-mail address get their booking e-mails. */
  guestEnabled: boolean;
  fromName: string | null;
  /** Zoho: an address of the Zoho mailbox; Resend: on a domain verified in Resend (e.g. booking@your-domain). */
  fromEmail: string | null;
  replyTo: string | null;
  /** Provider secrets present? Their values are never returned. */
  providerConfigured: boolean;
  /** Which provider sends (Zoho Mail when its secrets are set, else Resend); null = none. */
  provider: EmailProviderName | null;
  updatedAt: string;
}

export interface EmailSettingsInput {
  enabled: boolean;
  guestEnabled: boolean;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
}

export interface EmailRecipientDto {
  id: string;
  email: string;
  name: string;
  language: LocaleCode;
  notifyBooking: boolean;
  notifyPayment: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EmailRecipientInput {
  email: string;
  name: string;
  language: LocaleCode;
  notifyBooking: boolean;
  notifyPayment: boolean;
  active?: boolean;
}

export interface EmailLogDto {
  id: string;
  type: EmailType;
  status: EmailStatus;
  audience: "STAFF" | "GUEST";
  /** Staff recipient name; never the guest's address. */
  recipientName: string | null;
  bookingCode: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}
