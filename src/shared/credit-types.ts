/**
 * App-usage credits (migration 0027) — contract shared by the Worker and the admin UI.
 *
 * Every booking carries an app fee (fee per unit × houses / VIP tents / own tents) on the guest's bill; the property
 * pre-pays it as credits (1 credit = 1 baht). A booking holds its fee when made, the fee is deducted when the booking
 * is paid, and released if it expires or is cancelled unpaid. Credits never expire.
 */

export type CreditPlan = "STANDARD" | "PREMIUM";
export const CREDIT_PLANS: readonly CreditPlan[] = ["STANDARD", "PREMIUM"];
export type CreditApprovalMode = "MANUAL" | "EASYSLIP";
export type TopupStatus = "PENDING" | "APPROVED" | "REJECTED";
export type LedgerEntryType = "TOPUP" | "ADJUST_ADD" | "ADJUST_SUB" | "FEE_CAPTURE" | "PLAN_CHANGE";

/**
 * NORMAL: bookings open, enough credit · LOW: below the low threshold · EMPTY: not enough for one unit — online
 * booking is closed · OFF: the credit system is switched off (no fee, no limits).
 */
export type CreditState = "OFF" | "NORMAL" | "LOW" | "EMPTY";

/** Permissions a STANDARD plan removes from everyone but SUPER_ADMIN (Reports, Marketing, Theme). */
export const PREMIUM_ONLY_PERMISSIONS = ["reports.view", "reports.export", "marketing.view", "marketing.edit", "settings.theme"] as const;
/** Sidebar items of those permissions (shown with a lock on STANDARD). */
export const PREMIUM_ONLY_MENU_PATHS = ["reports", "ga4", "meta-pixel", "capi", "settings-theme"] as const;

/** Biggest top-up / adjustment accepted at once (credits = baht). */
export const MAX_CREDIT_AMOUNT = 10_000_000;

/** GET /api/admin/credits/summary (credits.view) — the status bar and the cards. */
export interface CreditSummaryDto {
  enabled: boolean;
  balance: number;
  held: number;
  /** balance − held: what new bookings can use. */
  available: number;
  feePerUnit: number;
  lowThreshold: number;
  state: CreditState;
  /** Units still bookable with the available credits (null when off). */
  unitsLeft: number | null;
  plan: CreditPlan;
}

/** Where top-ups are paid, and the plan minimums (GET /api/admin/credits/topup-info, credits.topup). */
export interface CreditPaymentInfoDto {
  bankName: string | null;
  accountName: string | null;
  accountNumber: string | null;
  promptpayNumber: string | null;
  qrUrl: string | null;
  /** Minimum top-up per plan (baht); null = that plan cannot be chosen yet. */
  minimums: Record<CreditPlan, number | null>;
  /** Locked features of the STANDARD plan (sidebar paths). */
  premiumOnly: string[];
  summary: CreditSummaryDto;
}

export interface CreditTopupDto {
  id: string;
  plan: CreditPlan;
  amountRequested: number;
  amountCredited: number | null;
  status: TopupStatus;
  requestedBy: { id: string; name: string };
  verifyResult: "PASSED" | "FAILED" | "NOT_A_SLIP" | "ERROR" | null;
  /** Why the automatic check did not approve (codes: AMOUNT_MISMATCH, RECEIVER_MISMATCH, BELOW_MINIMUM …). */
  verifyReasons: string[];
  verifiedAmount: number | null;
  transactionRef: string | null;
  decidedBy: { id: string; name: string } | null;
  decidedVia: "STAFF" | "EASYSLIP" | null;
  decidedAt: string | null;
  rejectReason: string | null;
  createdAt: string;
}

export interface CreditLedgerEntryDto {
  id: string;
  type: LedgerEntryType;
  amount: number;
  balanceAfter: number;
  plan: CreditPlan | null;
  bookingCode: string | null;
  units: number | null;
  note: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Result of POST /api/admin/credits/topups. */
export interface TopupResultDto {
  topup: CreditTopupDto;
  /** APPROVED = EasySlip approved it right away; PENDING = waiting for Super Admin. */
  outcome: "APPROVED" | "PENDING";
  summary: CreditSummaryDto;
}

/** GET / PUT /api/admin/credit-admin/settings (credits.manage). */
export interface CreditSettingsDto {
  enabled: boolean;
  feePerUnit: number;
  lowThreshold: number;
  approvalMode: CreditApprovalMode;
  standardMin: number | null;
  premiumMin: number | null;
  bankName: string | null;
  accountName: string | null;
  accountNumber: string | null;
  promptpayNumber: string | null;
  qrAssetId: string | null;
  qrUrl: string | null;
  notifyEmail: string | null;
  alertTime1: string;
  alertTime2: string;
  /** EasySlip key present (SLIP_VERIFICATION_API_KEY): the EASYSLIP mode can work. */
  verifierConfigured: boolean;
  /** Channels that can carry the notices right now. */
  emailReady: boolean;
  lineReady: boolean;
  updatedAt: string;
}

export interface CreditSettingsInput {
  enabled: boolean;
  feePerUnit: number;
  lowThreshold: number;
  approvalMode: CreditApprovalMode;
  standardMin: number | null;
  premiumMin: number | null;
  bankName: string | null;
  accountName: string | null;
  accountNumber: string | null;
  promptpayNumber: string | null;
  qrAssetId: string | null;
  notifyEmail: string | null;
  alertTime1: string;
  alertTime2: string;
}

/** Back-office users who get the low / empty notices, and whether their LINE is linked. */
export interface CreditRecipientDto {
  userId: string;
  name: string;
  email: string;
  roles: string[];
  lineLinked: boolean;
}

/** GET /api/admin/me/line — the signed-in user's own LINE link ("My account"). */
export interface MyLineDto {
  linked: boolean;
  linkedAt: string | null;
  /** LINE notices can reach users at all (LINE on, token + webhook secret set). */
  available: boolean;
}

/** POST /api/admin/me/line/link-code */
export interface MyLineCodeDto {
  id: string;
  code: string;
  message: string;
  expiresAt: string;
  addFriendUrl: string | null;
  url: string | null;
}

/** App fee line of a quote / booking: units × fee per unit. */
export interface AppFeeDto {
  units: number;
  perUnitSatang: number;
  totalSatang: number;
}
