/**
 * Zoho Mail — notifications go out from the shop's own Zoho mailbox (e.g. booking@chomkhao.com) through the
 * Zoho Mail REST API, so the domain's existing Zoho SPF / DKIM records cover them.
 *
 *   refresh token ─► access token (1 h, cached per isolate)
 *                 ─► GET  /api/accounts                         (the mailbox that owns the sender address, cached)
 *                 ─► POST /api/accounts/{accountId}/messages    (the message)
 *
 * Cloudflare Secrets: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN — a Zoho API Console "Self Client"
 * with the scopes ZohoMail.messages.CREATE,ZohoMail.accounts.READ. ZOHO_REGION picks the data centre
 * (com = US by default, eu, in, com.au, jp, ca, sa).
 *
 * The sender must be an address of that mailbox (primary, alias or "send mail as"). The From name is the
 * mailbox's own display name, and replies go to the sender: the API has no Reply-To. Zoho has no idempotency
 * key, so a send whose answer is lost (timeout) may arrive twice when it is retried. Nothing that identifies a
 * person is put into errors; the credentials are only sent to Zoho's accounts server.
 */

import type { EmailSender, FetchLike, OutgoingEmail, SendResult } from "./sender.ts";

export const ZOHO_REGIONS = {
  com: { accounts: "https://accounts.zoho.com", mail: "https://mail.zoho.com" },
  eu: { accounts: "https://accounts.zoho.eu", mail: "https://mail.zoho.eu" },
  in: { accounts: "https://accounts.zoho.in", mail: "https://mail.zoho.in" },
  "com.au": { accounts: "https://accounts.zoho.com.au", mail: "https://mail.zoho.com.au" },
  jp: { accounts: "https://accounts.zoho.jp", mail: "https://mail.zoho.jp" },
  ca: { accounts: "https://accounts.zohocloud.ca", mail: "https://mail.zohocloud.ca" },
  sa: { accounts: "https://accounts.zoho.sa", mail: "https://mail.zoho.sa" },
} as const;
export type ZohoRegion = keyof typeof ZOHO_REGIONS;

/** "", "com", "us" → com; "au" → com.au; anything unknown → null. */
export function zohoRegion(value: string | undefined): ZohoRegion | null {
  const v = (value ?? "").trim().toLowerCase().replace(/^\./, "");
  if (!v || v === "us") return "com";
  if (v === "au") return "com.au";
  return Object.hasOwn(ZOHO_REGIONS, v) ? (v as ZohoRegion) : null;
}

type Json = Record<string, unknown>;
type Failure = Extract<SendResult, { ok: false }>;
type Answer = { ok: true; status: number; body: Json | null } | { ok: false; error: string };

const TOKEN_MARGIN_MS = 5 * 60_000;
const ACCOUNT_TTL_MS = 6 * 60 * 60_000;
const tokens = new Map<string, { token: string; expiresAt: number }>();
const accounts = new Map<string, { accountId: string; expiresAt: number }>();

/** Tests: forget cached tokens / mailbox ids. */
export function resetZohoCache(): void {
  tokens.clear();
  accounts.clear();
}

const fail = (retryable: boolean, error: string, retryAfterSeconds: number | null = null): Failure =>
  ({ ok: false, retryable, error: error.slice(0, 80), retryAfterSeconds });

/** Zoho's error code only ([A-Z0-9_]) — descriptions can echo addresses. */
function code(value: unknown): string {
  return typeof value === "string" ? value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase().slice(0, 40) : "";
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/** Status in the body ({status:{code}}) wins over the HTTP status: Zoho reports some errors with HTTP 200. */
function statusOf(res: { status: number; body: Json | null }): number {
  const c = (res.body?.status as Json | undefined)?.code;
  return typeof c === "number" ? c : res.status;
}

function errorCodeOf(body: Json | null): string {
  return code((body?.data as Json | undefined)?.errorCode);
}

/** Retry later: throttled, Zoho's hourly sending limit, or a Zoho-side failure. */
function retryable(status: number, errorCode: string): { retry: boolean; after: number | null } {
  if (/LIMIT|TOO_?MANY|THROTTL/.test(errorCode)) return { retry: true, after: 3600 };
  if (status === 429) return { retry: true, after: 60 };
  return { retry: status >= 500 || status === 408, after: null };
}

export class ZohoMailClient implements EmailSender {
  readonly provider = "ZOHO" as const;
  private readonly domains: (typeof ZOHO_REGIONS)[ZohoRegion];
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly refreshToken: string,
    readonly region: ZohoRegion,
    fetchImpl?: FetchLike,
    private readonly timeoutMs = 15_000,
  ) {
    this.domains = ZOHO_REGIONS[region];
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private get cacheKey(): string {
    return `${this.region}:${this.clientId}`;
  }

  private async call(url: string, init: RequestInit): Promise<Answer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const text = await res.text();
      let body: Json | null = null;
      try {
        const parsed: unknown = text ? JSON.parse(text) : null;
        body = parsed && typeof parsed === "object" ? (parsed as Json) : null;
      } catch {
        body = null;
      }
      return { ok: true, status: res.status, body };
    } catch {
      return { ok: false, error: controller.signal.aborted ? "ZOHO_TIMEOUT" : "ZOHO_UNREACHABLE" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Access token from the refresh token (form body: the secrets never go into a URL). */
  private async token(fresh: boolean): Promise<{ token: string } | Failure> {
    const cached = tokens.get(this.cacheKey);
    if (!fresh && cached && cached.expiresAt > Date.now() + TOKEN_MARGIN_MS) return { token: cached.token };
    const res = await this.call(`${this.domains.accounts}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: this.refreshToken, client_id: this.clientId, client_secret: this.clientSecret,
      }).toString(),
    });
    if (!res.ok) return fail(true, res.error);
    const token = str(res.body?.access_token, 4096);
    if (res.status === 200 && token) {
      const seconds = typeof res.body?.expires_in === "number" && res.body.expires_in > 0 ? res.body.expires_in : 3600;
      tokens.set(this.cacheKey, { token, expiresAt: Date.now() + seconds * 1000 });
      return { token };
    }
    const description = typeof res.body?.error_description === "string" ? res.body.error_description : "";
    // Zoho limits how often one refresh token may mint access tokens ("too many requests … try again after some time").
    if (res.status === 429 || res.body?.error === "Access Denied" || /too many requests/i.test(description)) return fail(true, "ZOHO_TOKEN_RATE_LIMITED", 600);
    if (res.status >= 500) return fail(true, `ZOHO_TOKEN_${res.status}`);
    // invalid_client / invalid_code / … : the secrets or the region are wrong — retrying will not help.
    return fail(false, `ZOHO_AUTH_${code(res.body?.error) || res.status}`);
  }

  private headers(token: string): Record<string, string> {
    return { Authorization: `Zoho-oauthtoken ${token}`, Accept: "application/json" };
  }

  /** The id of the mailbox that may send as `fromEmail` (primary address, alias or "send mail as"). */
  private async accountId(token: string, fromEmail: string): Promise<{ accountId: string } | { unauthorized: true; error: string } | Failure> {
    const from = fromEmail.trim().toLowerCase();
    const key = `${this.cacheKey}:${from}`;
    const cached = accounts.get(key);
    if (cached && cached.expiresAt > Date.now()) return { accountId: cached.accountId };
    const res = await this.call(`${this.domains.mail}/api/accounts`, { method: "GET", headers: this.headers(token) });
    if (!res.ok) return fail(true, res.error);
    const status = statusOf(res);
    const errorCode = errorCodeOf(res.body);
    if (status === 401 || res.status === 401) return { unauthorized: true, error: `ZOHO_ACCOUNTS_401${errorCode ? `_${errorCode}` : ""}` };
    if (res.status !== 200 || status !== 200) {
      const r = retryable(status, errorCode);
      return fail(r.retry, `ZOHO_ACCOUNTS_${status}${errorCode ? `_${errorCode}` : ""}`, r.after);
    }
    const list = Array.isArray(res.body?.data) ? (res.body!.data as Json[]) : [];
    for (const account of list) {
      const id = account.accountId;
      const accountId = typeof id === "string" || typeof id === "number" ? String(id) : null;
      if (!accountId || !/^\d{1,30}$/.test(accountId)) continue;
      const addresses = [
        account.primaryEmailAddress,
        account.mailboxAddress,
        ...(Array.isArray(account.sendMailDetails) ? (account.sendMailDetails as Json[]).map((d) => d.fromAddress) : []),
        ...(Array.isArray(account.emailAddress) ? (account.emailAddress as Json[]).map((d) => d.mailId) : []),
      ].filter((a): a is string => typeof a === "string").map((a) => a.trim().toLowerCase());
      if (addresses.includes(from)) {
        accounts.set(key, { accountId, expiresAt: Date.now() + ACCOUNT_TTL_MS });
        return { accountId };
      }
    }
    return fail(false, "ZOHO_SENDER_NOT_IN_MAILBOX");
  }

  async send(mail: OutgoingEmail): Promise<SendResult> {
    let lastAuthError = "ZOHO_401";
    // A second round only after Zoho turned the access token down (expired / revoked early).
    for (let round = 0; round < 2; round++) {
      const t = await this.token(round > 0);
      if ("ok" in t) return t;
      const account = await this.accountId(t.token, mail.fromEmail);
      if ("unauthorized" in account) {
        lastAuthError = account.error;
        tokens.delete(this.cacheKey);
        continue;
      }
      if ("ok" in account) return account;
      const res = await this.call(`${this.domains.mail}/api/accounts/${encodeURIComponent(account.accountId)}/messages`, {
        method: "POST",
        headers: { ...this.headers(t.token), "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAddress: mail.fromEmail,
          toAddress: mail.to,
          subject: mail.subject,
          content: mail.html,
          mailFormat: "html",
          encoding: "UTF-8",
          askReceipt: "no",
        }),
      });
      if (!res.ok) return fail(true, res.error);
      const status = statusOf(res);
      const errorCode = errorCodeOf(res.body);
      if (res.status === 200 && status === 200) {
        const id = (res.body?.data as Json | undefined)?.messageId;
        return { ok: true, id: typeof id === "string" || typeof id === "number" ? String(id).slice(0, 100) : null };
      }
      if (status === 401 || res.status === 401) {
        lastAuthError = `ZOHO_401${errorCode ? `_${errorCode}` : ""}`;
        tokens.delete(this.cacheKey);
        continue;
      }
      const r = retryable(status, errorCode);
      return fail(r.retry, `ZOHO_${status}${errorCode ? `_${errorCode}` : ""}`, r.after);
    }
    // Refused twice with a brand-new token: a missing scope or a revoked client, not a passing glitch.
    return fail(false, lastAuthError);
  }
}
