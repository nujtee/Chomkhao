import { useState } from "react";
import type { AdminBookingDto } from "../../../shared/booking-types.ts";
import type { StayAction } from "../../../shared/dashboard-types.ts";
import { formatBaht } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import type { StayActionsDto, StayGate } from "../../../shared/stay.ts";
import { ApiError, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Button, ConfirmDialog, detailMessage } from "../ui.tsx";
import { BalanceDialog } from "./BalanceDialog.tsx";
import { useStayDate } from "./shared.tsx";

/**
 * Check in / Check out / No-show for one booking, wherever staff see it (booking page, bookings list,
 * dashboard arrivals / departures). `compact` (lists) shows only what can be done today; the booking page
 * also shows what opens later, disabled, with the day it opens. The Worker checks the same rules (shared/stay.ts).
 */
export function StayButtons({ code, checkIn, actions, compact = false, only, balanceSatang = 0, onDone }: {
  code: string;
  checkIn: string;
  actions: StayActionsDto;
  compact?: boolean;
  /** Deposit plan: still due — check-in then opens the "take the balance" dialog first. */
  balanceSatang?: number;
  /** Limit to these actions (dashboard: arrivals check in / no-show, departures check out). */
  only?: StayAction[];
  onDone: (booking: AdminBookingDto, message: string) => void;
}) {
  const { c, t, can, locale } = useAdmin();
  const stayDate = useStayDate();
  const [confirm, setConfirm] = useState<StayAction | null>(null);
  /** The balance dialog (deposit plan) — opened by check-in while money is due. */
  const [paying, setPaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const all: { action: StayAction; gate: StayGate | null; label: string; confirm: string; variant: "primary" | "secondary" }[] = [
    { action: "check-in", gate: actions.checkIn, label: c.stay.checkIn, confirm: c.stay.confirmCheckIn, variant: "primary" },
    { action: "check-out", gate: actions.checkOut, label: c.stay.checkOut, confirm: c.stay.confirmCheckOut, variant: "primary" },
    { action: "no-show", gate: actions.noShow, label: c.stay.noShow, confirm: c.stay.confirmNoShow, variant: "secondary" },
  ];
  const shown = all.filter((b) => (b.gate === "OK" || (!compact && b.gate === "NOT_YET")) && (!only || only.includes(b.action)));
  if (!can("bookings.edit") || shown.length === 0) return null;
  const pending = all.find((b) => b.action === confirm) ?? null;

  async function run(action: StayAction, label: string) {
    setConfirm(null);
    setBusy(true);
    setError(null);
    try {
      const booking = await apiRequest<AdminBookingDto>("POST", `/api/admin/bookings/${encodeURIComponent(code)}/stay/${action}`);
      onDone(booking, format(c.stay.doneFor, { code, action: label }));
    } catch (err) {
      // Money still due (deposit plan, not known here): take it first.
      if (action === "check-in" && err instanceof ApiError && err.code === "BALANCE_DUE") setPaying(true);
      else setError(detailMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`adm-stay${compact ? " adm-stay--compact" : ""}`}>
      <div className="adm-row adm-row--wrap">
        {shown.map((b) => (
          <Button key={b.action} variant={b.variant} busy={busy} disabled={b.gate !== "OK"}
            onClick={() => (b.action === "check-in" && balanceSatang > 0 ? setPaying(true) : setConfirm(b.action))}
            aria-label={compact ? `${b.label} ${code}` : undefined}>
            {b.label}
          </Button>
        ))}
      </div>
      {shown.some((b) => b.gate === "NOT_YET") && <p className="adm-field__hint">{format(c.stay.opensOn, { date: stayDate(checkIn) })}</p>}
      {balanceSatang > 0 && shown.some((b) => b.action === "check-in") && (
        <p className="adm-field__hint adm-stay__due">{format(t.pay.balanceBadge, { amount: formatBaht(balanceSatang, locale.code) })}</p>
      )}
      {error && <p className="adm-field__error" role="alert">{error}</p>}
      <BalanceDialog code={code} open={paying} onClose={() => setPaying(false)}
        onDone={(booking, message) => { setPaying(false); onDone(booking, message); }} />
      <ConfirmDialog open={pending !== null} danger={pending?.action === "no-show"}
        message={pending ? `${code} — ${pending.confirm}` : ""} confirmLabel={pending?.label ?? ""}
        onConfirm={() => pending && void run(pending.action, pending.label)} onCancel={() => setConfirm(null)} />
    </div>
  );
}
