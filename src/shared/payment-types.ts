/** Payment & receiving-account API contract (Worker ↔ UI). Money is integer satang. */

export type PaymentMethod = "BANK_TRANSFER" | "PROMPTPAY" | "CASH" | "OTHER";
export type PaymentRecordStatus = "UNPAID" | "PENDING_VERIFICATION" | "VERIFIED" | "PAID" | "REJECTED" | "REFUNDED";
export type ReceivingAccountStatus = "ACTIVE" | "INACTIVE";

export const PAYMENT_METHODS: readonly PaymentMethod[] = ["BANK_TRANSFER", "PROMPTPAY", "CASH", "OTHER"];

/** How the guest pays online. The first three end with a slip upload; PayPal is paid at PayPal. */
export type PaymentChannel = "PROMPTPAY" | "BANK_TRANSFER" | "QR_CODE" | "PAYPAL";
export const PAYMENT_CHANNELS: readonly PaymentChannel[] = ["PROMPTPAY", "BANK_TRANSFER", "QR_CODE", "PAYPAL"];
export const SLIP_CHANNELS = ["PROMPTPAY", "BANK_TRANSFER", "QR_CODE"] as const;
export type SlipChannel = (typeof SLIP_CHANNELS)[number];

/** AUTO: a slip the verification service proves correct confirms the booking. MANUAL: staff approve every slip. */
export type ApprovalMode = "AUTO" | "MANUAL";

export interface PaymentSettingsDto {
  approvalMode: ApprovalMode;
  /** Channels the owner offers (each also needs its detail on the primary receiving account). */
  channels: Record<PaymentChannel, boolean>;
  /** Slip verification service (Cloudflare Secrets present?). Without it every slip waits for staff. */
  slipVerifier: { configured: boolean; provider: string | null };
  /** PayPal REST app (Cloudflare Secrets present?) and which PayPal it talks to. */
  paypal: { configured: boolean; environment: "sandbox" | "live" };
  /** What the primary receiving account can offer; null = no primary account yet. */
  account: { promptpay: boolean; bankAccount: boolean; qr: boolean } | null;
  updatedAt: string;
}

export interface PaymentSettingsInput {
  approvalMode: ApprovalMode;
  channels: Record<PaymentChannel, boolean>;
}

/** Thai bank account: digits with optional dashes. */
export const ACCOUNT_NUMBER_PATTERN = /^[0-9][0-9-]{4,22}[0-9]$/;
/** PromptPay: mobile (10), national/tax ID (13) or e-wallet (15) digits. */
export const PROMPTPAY_PATTERN = /^(\d{10}|\d{13}|\d{15})$/;

export interface ReceivingAccountDto {
  id: string;
  bankName: string;
  accountName: string;
  accountNumber: string | null;
  promptpayNumber: string | null;
  qrAssetId: string | null;
  qrUrl: string | null;
  status: ReceivingAccountStatus;
  isPrimary: boolean;
  sortOrder: number;
  updatedAt: string;
}

export interface ReceivingAccountInput {
  bankName: string;
  accountName: string;
  accountNumber: string | null;
  promptpayNumber: string | null;
  qrAssetId: string | null;
  status: ReceivingAccountStatus;
  sortOrder: number;
}

/** Ways staff take the rest of a deposit booking at reception. */
export const BALANCE_METHODS = ["CASH", "PROMPTPAY", "BANK_TRANSFER"] as const;
export type BalanceMethod = (typeof BALANCE_METHODS)[number];

/**
 * Admin → Check in a deposit booking with money still due: what to collect and where (deposit plan, migration 0025).
 * The account is the current primary receiving account (else the one copied when the booking was made).
 */
export interface BalanceDueDto {
  bookingCode: string;
  totalSatang: number;
  /** Received so far (the deposit, …). */
  paidSatang: number;
  /** total − paid: what the guest pays now. */
  balanceSatang: number;
  account: { bankName: string; accountName: string; accountNumber: string | null; promptpayNumber: string | null; qrUrl: string | null } | null;
  /** PromptPay Thai QR for exactly the balance; null without a PromptPay number. */
  promptpayPayload: string | null;
  /** The guest already sent a transfer slip for the rest: verify or reject it before taking money here. */
  pendingSlip: { paymentId: string; amountSatang: number; submittedAt: string } | null;
}

/** Deposit plan: the guest pays the rest themselves before the stay (transfer + slip). */
export interface BalancePaymentDto {
  /** How to pay the rest (from the booking's account snapshot, PayPal not offered); null while a slip is being checked. */
  instructions: PaymentInstructionsDto | null;
  /** A slip for the rest is being checked (verification service or staff). */
  reviewing: boolean;
  /** Staff turned the last slip for the rest down: their reason ("" = none given); null otherwise. */
  rejectedReason: string | null;
}

/** How to pay this booking — from the account snapshot taken when the booking was made. */
export interface PaymentInstructionsDto {
  bankName: string;
  accountName: string;
  accountNumber: string | null;
  promptpayNumber: string | null;
  qrUrl: string | null;
  amountDueSatang: number;
  /** Channels the guest can choose now, in display order (offered by the owner and possible for this booking). */
  channels: PaymentChannel[];
  /** Thai QR (EMVCo) PromptPay payload with this exact amount; the page draws it as a QR code. */
  promptpayPayload: string | null;
}

export interface PaymentDto {
  id: string;
  amountSatang: number;
  method: PaymentMethod;
  /** Channel the guest chose online (null = recorded by staff). */
  channel: PaymentChannel | null;
  status: PaymentRecordStatus;
  reference: string | null;
  note: string | null;
  paidAt: string | null;
  submittedAt: string;
  verifiedAt: string | null;
  verifiedByName: string | null;
  refundedAt: string | null;
  refundAmountSatang: number | null;
  refundReason: string | null;
  /** Authenticated URL of the private slip (slips.view) when this payment came with a slip. */
  slipUrl: string | null;
}

/** Admin view of the account snapshot (immutable). */
export interface PaymentAccountSnapshotDto {
  receivingAccountId: string;
  bankName: string;
  accountName: string;
  accountNumber: string | null;
  promptpayNumber: string | null;
  qrUrl: string | null;
  capturedAt: string;
}

// ------------------------------------------------------------------ slips (spec §27)

export interface SlipVerificationDto {
  method: "MANUAL" | "AUTO";
  provider: string | null;
  result: "PASSED" | "FAILED" | "ERROR";
  /** AMOUNT_MISMATCH, DATE_OUT_OF_RANGE, RECEIVER_MISMATCH, RECEIVER_UNCONFIRMED, DUPLICATE_TRANSACTION, SLIP_NOT_FOUND, PROVIDER_…, REJECTED_BY_STAFF */
  failureCode: string | null;
  amountSatang: number | null;
  transferredAt: string | null;
  senderBank: string | null;
  receiverBank: string | null;
  receiverAccountMasked: string | null;
  transactionRef: string | null;
  verifiedByName: string | null;
  createdAt: string;
}

export interface SlipQueueItemDto {
  paymentId: string;
  channel: PaymentChannel | null;
  bookingCode: string;
  bookingStatus: string;
  customerName: string;
  checkIn: string;
  checkOut: string;
  totalSatang: number;
  amountSatang: number;
  status: PaymentRecordStatus;
  submittedAt: string;
  /** Authenticated URL of the private slip image (slips.view); null for a PayPal payment (no slip). */
  slipUrl: string | null;
  /** PayPal capture id for a PayPal payment held by PayPal for review. */
  reference: string | null;
  /** Sent after the booking was confirmed: the rest of a deposit (the booking stays confirmed either way). */
  balance: boolean;
  rejectedReason: string | null;
  verifications: SlipVerificationDto[];
}

export interface SlipQueueDto {
  items: SlipQueueItemDto[];
  nextCursor: string | null;
  /** Context for the review page. */
  approvalMode: ApprovalMode;
  verifierConfigured: boolean;
}

/** Guest result after uploading a slip. */
export interface SlipUploadResultDto {
  /** VERIFIED: the verification service proved the payment — booking confirmed. PENDING_REVIEW: staff will check. */
  outcome: "VERIFIED" | "PENDING_REVIEW";
}

/** Staff decision on a slip: approve, or turn it down with a reason (the guest is told the reason). */
export interface SlipRejectInput {
  reason: string;
  /** true: also cancel the booking (nights / tents / food released). false: the guest may pay again. */
  cancelBooking: boolean;
}

// ------------------------------------------------------------------ PayPal Checkout

export interface PaypalOrderDto {
  orderId: string;
  /** PayPal page where the guest approves the payment. */
  approveUrl: string;
}

/** Admin: "Check PayPal connection" — a token plus a test order PayPal never charges (nobody approves it). */
export interface PaypalCheckDto {
  ok: boolean;
  /** Which PayPal the credentials were tried against; null = no PayPal secrets. */
  environment: "sandbox" | "live" | null;
  /** PAYPAL_NOT_CONFIGURED, PAYPAL_AUTH_401_INVALID_CLIENT, PAYPAL_ORDER_422_…, PAYPAL_TIMEOUT… */
  error: string | null;
  checkedAt: string;
}

export interface PaypalCaptureDto {
  /**
   * PAID: money taken, booking confirmed. PENDING_REVIEW: PayPal holds the payment, staff will confirm.
   * DECLINED: PayPal refused the funding source — try again. NOT_PAYABLE: booking expired / already paid / cancelled —
   * nothing was charged. PROCESSING: not settled yet, check again shortly.
   */
  outcome: "PAID" | "PENDING_REVIEW" | "DECLINED" | "NOT_PAYABLE" | "PROCESSING";
  bookingCode: string;
}
