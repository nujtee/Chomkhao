import { useState } from "react";
import type { PublicSiteDto } from "../../../shared/api-types.ts";
import type { AdminBookingDto } from "../../../shared/booking-types.ts";
import { getBookingMessages } from "../../../shared/i18n/booking-messages.ts";
import { apiGet } from "../../api/client.ts";
import { BookingBill } from "../../booking/Bill.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Button } from "../ui.tsx";

/** Staff side: the same printable statement the guest gets (full phone number), from the booking detail page. */
export function AdminBillButton({ booking }: { booking: AdminBookingDto }) {
  const { locale } = useAdmin();
  const [site, setSite] = useState<PublicSiteDto | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function show() {
    if (!site) {
      setBusy(true);
      setSite(await apiGet<PublicSiteDto>(`/api/public/site?lang=${locale.path}`).catch(() => null));
      setBusy(false);
    }
    setOpen(true);
  }

  return (
    <>
      <Button variant="secondary" busy={busy} onClick={() => void show()}>{getBookingMessages(locale.code).viewBill}</Button>
      {open && (
        <BookingBill booking={booking} lang={locale.code} siteName={site?.siteName ?? null} logoUrl={site?.logo.main?.url ?? null}
          phone={booking.customerPhone} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
