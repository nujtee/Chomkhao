import type { CreditRepository } from "../repositories/credit.repository.ts";
import { creditState } from "../services/credit.service.ts";
import { creditMessage, type CreditMessage } from "./credit-messages.ts";

export const CREDIT_NOTICE_TYPES = new Set(["CREDIT_LOW", "CREDIT_EMPTY", "CREDIT_TOPUP_REQUEST", "CREDIT_TOPUP_RESULT"]);

/** Admin page a notice links to (path under /{lang}/admin/). */
export function creditNoticePath(m: CreditMessage): string {
  return m.forAdmin ? "credit-admin" : "credit-topup";
}

/**
 * Builds a credit notice from current D1 data at send time (e-mail and LINE alike). A notice whose reason is gone —
 * credits topped up since, a top-up decided meanwhile — is skipped.
 */
export async function renderCreditNotice(repo: CreditRepository, type: string, payload: Record<string, unknown>, lang: string): Promise<CreditMessage | { skip: string }> {
  switch (type) {
    case "CREDIT_LOW":
    case "CREDIT_EMPTY": {
      const [s, a] = await Promise.all([repo.settings(), repo.account()]);
      const now = creditState(s, a);
      if (type === "CREDIT_LOW" && now.state !== "LOW") return { skip: "NOT_RELEVANT" };
      if (type === "CREDIT_EMPTY" && now.state !== "EMPTY") return { skip: "NOT_RELEVANT" };
      return type === "CREDIT_LOW"
        ? creditMessage({ kind: "LOW", available: now.available, units: now.unitsLeft ?? 0, threshold: s!.low_threshold }, lang)
        : creditMessage({ kind: "EMPTY", available: now.available, feePerUnit: s!.fee_per_unit }, lang);
    }
    case "CREDIT_TOPUP_REQUEST":
    case "CREDIT_TOPUP_RESULT": {
      const topup = typeof payload.topupId === "string" ? await repo.topup(payload.topupId) : null;
      if (!topup) return { skip: "NOT_RELEVANT" };
      if (type === "CREDIT_TOPUP_REQUEST") {
        if (topup.status !== "PENDING") return { skip: "NOT_RELEVANT" };
        let reasons: string[] = [];
        try {
          reasons = topup.verify_reasons ? (JSON.parse(topup.verify_reasons) as string[]) : [];
        } catch {
          reasons = [];
        }
        return creditMessage({ kind: "TOPUP_REQUEST", requester: topup.requested_by_name, plan: topup.plan, amount: topup.amount_requested, reasons }, lang);
      }
      if (topup.status === "APPROVED") {
        const a = await repo.account();
        return creditMessage({ kind: "TOPUP_APPROVED", amount: topup.amount_credited ?? 0, plan: topup.plan, balance: a?.balance ?? 0 }, lang);
      }
      if (topup.status === "REJECTED") return creditMessage({ kind: "TOPUP_REJECTED", amount: topup.amount_requested, reason: topup.reject_reason ?? "" }, lang);
      return { skip: "NOT_RELEVANT" };
    }
    default:
      return { skip: "UNKNOWN_TYPE" };
  }
}
