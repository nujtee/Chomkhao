/**
 * Slip verification (spec §27).
 *
 * Auto verification must use a real transaction / slip verification service — never OCR
 * alone. The service reads the bank's own transaction data behind the slip's QR code.
 * This module is FAIL-SAFE: a payment is auto-confirmed only when the provider answered,
 * the answer parsed cleanly, and every business check passed. Anything else (no provider
 * configured, timeout, unexpected response, a failed check) leaves the payment for staff.
 */

/** What we keep from a provider answer. Payer names and full account numbers are never kept. */
export interface VerifiedSlip {
  transactionRef: string;
  amountSatang: number;
  transferredAt: string; // ISO instant
  senderBank: string | null;
  receiverBank: string | null;
  /** As masked by the bank / provider, e.g. "xxx-x-x5678-x". */
  receiverAccountMasked: string | null;
  receiverProxyMasked: string | null;
}

export type ProviderResult =
  | { kind: "OK"; slip: VerifiedSlip }
  | { kind: "NOT_A_SLIP"; code: string } // provider could not find a real transaction behind this image
  | { kind: "ERROR"; code: string }; // provider unreachable, quota, auth, unexpected answer…

export interface SlipVerifier {
  readonly provider: string;
  verify(image: Uint8Array, mime: string): Promise<ProviderResult>;
}

export type FailureCode =
  | "AMOUNT_MISMATCH"
  | "DATE_OUT_OF_RANGE"
  | "RECEIVER_MISMATCH"
  | "RECEIVER_UNCONFIRMED"
  | "DUPLICATE_TRANSACTION";

export interface SlipExpectation {
  amountSatang: number;
  /** Booking creation time: a transfer for this booking cannot be older (minus a small tolerance). */
  notBefore: string;
  now: string;
  /** Destination from the booking's payment account snapshot. */
  accountNumber: string | null;
  promptpayNumber: string | null;
  /** Was this bank transaction already accepted for another payment? */
  transactionAlreadyUsed: boolean;
}

export const DATE_TOLERANCE_MS = { before: 15 * 60_000, after: 5 * 60_000 };

/** All checks; returns the first failure or null when the slip proves this exact payment. */
export function evaluateSlip(slip: VerifiedSlip, expect: SlipExpectation): FailureCode | null {
  if (expect.transactionAlreadyUsed) return "DUPLICATE_TRANSACTION";
  if (slip.amountSatang !== expect.amountSatang) return "AMOUNT_MISMATCH";
  const at = Date.parse(slip.transferredAt);
  if (!Number.isFinite(at)
    || at < Date.parse(expect.notBefore) - DATE_TOLERANCE_MS.before
    || at > Date.parse(expect.now) + DATE_TOLERANCE_MS.after) return "DATE_OUT_OF_RANGE";
  const targets = [expect.accountNumber, expect.promptpayNumber].filter((x): x is string => !!x).flatMap(withCountryCode);
  const candidates = [slip.receiverAccountMasked, slip.receiverProxyMasked].filter((x): x is string => !!x);
  if (!candidates.length) return "RECEIVER_UNCONFIRMED";
  let comparable = false;
  for (const masked of candidates) {
    for (const target of targets) {
      const m = maskedMatches(masked, target);
      if (m === true) return null;
      if (m === false) comparable = true;
    }
  }
  return comparable ? "RECEIVER_MISMATCH" : "RECEIVER_UNCONFIRMED";
}

/**
 * A Thai mobile PromptPay number (0XXXXXXXXX) can come back from the bank as 66XXXXXXXXX / +66-XX-…:
 * both spellings are compared.
 */
function withCountryCode(n: string): string[] {
  const d = n.replace(/\D/g, "");
  return /^0\d{9}$/.test(d) ? [n, `66${d.slice(1)}`] : [n];
}

/** What the provider read as the destination (bank · account · PromptPay), for staff to compare by eye. */
export function receiverSummary(slip: VerifiedSlip): string | null {
  const parts = [slip.receiverBank, slip.receiverAccountMasked, slip.receiverProxyMasked].filter((x): x is string => !!x);
  return parts.length ? parts.join(" · ").slice(0, 160) : null;
}

/**
 * Compares a bank-masked number ("xxx-x-x5678-x") with our full number ("123-4-56789-0"),
 * right-aligned on digit positions. true = every visible digit matches (≥ 4 visible);
 * false = a visible digit differs; null = too few visible digits to tell.
 */
export function maskedMatches(masked: string, full: string): boolean | null {
  const m = masked.replace(/[^0-9xX*•]/g, "").toLowerCase().replace(/[*•]/g, "x");
  const f = full.replace(/\D/g, "");
  if (!m || !f) return null;
  let visible = 0;
  for (let i = 1; i <= m.length; i++) {
    const c = m[m.length - i]!;
    if (c === "x") continue;
    const d = f[f.length - i];
    if (d === undefined || d !== c) return false;
    visible++;
  }
  return visible >= 4 ? true : null;
}

// ================================================================ providers

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * EasySlip adapter (https://easyslip.com — Thai bank slip verification via the slip's QR
 * transaction data). Request/response follow the provider's v1 verify API: POST multipart
 * `file`, `Authorization: Bearer <key>`, answer `{ status, data: { transRef, date,
 * amount: { amount }, sender, receiver } }`. The parser is strict: any shape it does not
 * recognise becomes ERROR → manual review, never an approval. Confirm against the
 * provider's current documentation before enabling in production.
 */
export class EasySlipVerifier implements SlipVerifier {
  readonly provider = "easyslip";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike,
    private readonly endpoint = "https://developer.easyslip.com/api/v1/verify",
    private readonly timeoutMs = 10_000,
  ) {}

  async verify(image: Uint8Array, mime: string): Promise<ProviderResult> {
    const form = new FormData();
    form.set("file", new Blob([image as BlobPart], { type: mime }), "slip");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch {
      return { kind: "ERROR", code: controller.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNREACHABLE" };
    } finally {
      clearTimeout(timer);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: "ERROR", code: `PROVIDER_HTTP_${res.status}` };
    }
    const message = typeof (body as { message?: unknown })?.message === "string" ? (body as { message: string }).message : "";
    if (!res.ok) {
      if (res.status === 404 || /slip_not_found|qrcode_not_found|invalid_image|invalid_payload/.test(message)) {
        return { kind: "NOT_A_SLIP", code: (message || "SLIP_NOT_FOUND").toUpperCase().slice(0, 40) };
      }
      return { kind: "ERROR", code: (message || `PROVIDER_HTTP_${res.status}`).toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 40) };
    }
    const slip = parseEasySlip(body);
    return slip ? { kind: "OK", slip } : { kind: "ERROR", code: "UNEXPECTED_RESPONSE" };
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null;
}

/** Strict parse of the provider answer; null when anything required is missing or odd. */
export function parseEasySlip(body: unknown): VerifiedSlip | null {
  const outer = (body as { data?: Record<string, unknown> })?.data;
  // v1 answers { data: { transRef, … } }; newer answers wrap the same slip fields in data.rawSlip.
  const data = (outer && typeof outer.rawSlip === "object" && outer.rawSlip ? outer.rawSlip : outer) as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return null;
  const transRef = str(data.transRef);
  const date = str(data.date);
  const amountObj = data.amount as { amount?: unknown } | undefined;
  const amount = typeof amountObj?.amount === "number" ? amountObj.amount : null;
  if (!transRef || !date || amount === null || !Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return null;
  if (!Number.isFinite(Date.parse(date))) return null;
  const party = (p: unknown) => p as { bank?: { short?: unknown; name?: unknown }; account?: { bank?: { account?: unknown }; proxy?: { account?: unknown } } } | undefined;
  const sender = party(data.sender);
  const receiver = party(data.receiver);
  return {
    transactionRef: transRef,
    amountSatang: Math.round(amount * 100),
    transferredAt: new Date(date).toISOString(),
    senderBank: str(sender?.bank?.short) ?? str(sender?.bank?.name),
    receiverBank: str(receiver?.bank?.short) ?? str(receiver?.bank?.name),
    receiverAccountMasked: str(receiver?.account?.bank?.account),
    receiverProxyMasked: str(receiver?.account?.proxy?.account),
  };
}

/**
 * Provider from configuration; null = manual verification only. The key lives in Cloudflare Secrets.
 * EasySlip is the supported service, so a key without a provider name means EasySlip.
 */
export function createSlipVerifier(env: { SLIP_VERIFY_PROVIDER?: string; SLIP_VERIFICATION_API_KEY?: string }, fetchImpl: FetchLike = fetch): SlipVerifier | null {
  const key = env.SLIP_VERIFICATION_API_KEY?.trim();
  const provider = env.SLIP_VERIFY_PROVIDER?.trim().toLowerCase() || (key ? "easyslip" : "");
  if (!provider || !key) return null;
  if (provider === "easyslip") return new EasySlipVerifier(key, (input, init) => fetchImpl(input, init));
  return null;
}
