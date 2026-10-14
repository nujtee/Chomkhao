import type { BookingStatus, PaymentStatus } from "../../../shared/booking-types.ts";
import { useAdmin } from "../AdminContext.tsx";

const TONE: Record<BookingStatus, string> = {
  PENDING: "warning",
  CONFIRMED: "active",
  CHECKED_IN: "active",
  CHECKED_OUT: "muted",
  CANCELLED: "deleted",
  EXPIRED: "muted",
  NO_SHOW: "deleted",
};

export function BookingStatusBadge({ status }: { status: BookingStatus }) {
  const { t } = useAdmin();
  return <span className={`adm-badge adm-badge--${TONE[status]}`}>{t.bk[`s${status}`]}</span>;
}

/** Business date (YYYY-MM-DD) in the admin language, never shifted by the browser's time zone. */
export function useStayDate() {
  const { locale } = useAdmin();
  const fmt = new Intl.DateTimeFormat(locale.code, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return (date: string) => fmt.format(new Date(`${date}T00:00:00Z`));
}

const PAY_TONE: Record<PaymentStatus, string> = {
  UNPAID: "warning",
  PENDING_VERIFICATION: "warning",
  VERIFIED: "active",
  PAID: "active",
  REJECTED: "deleted",
  REFUNDED: "muted",
};

export function PaymentBadge({ status }: { status: PaymentStatus }) {
  const { t } = useAdmin();
  return <span className={`adm-badge adm-badge--${PAY_TONE[status]}`}>{t.bk[`p${status}`]}</span>;
}

/** Every stay of a booking in one line: "House 01 + VIP-02 + Camping · 2 tents". */
export function staysText(stays: { type: string; name: string; quantity: number }[], tents: (n: number) => string): string {
  return stays.map((s) => (s.type === "OWN_TENT" ? `${s.name} · ${tents(s.quantity)}` : s.name)).join(" + ");
}
