/**
 * The property's contact phone field may hold several numbers ("063 795 1218, 095 579 0679").
 * They are separated by a comma, semicolon, slash or new line; each one is checked on its own.
 */
export const MAX_CONTACT_PHONES = 5;
const ONE_PHONE = /^[0-9+()\- ]{6,30}$/;

/** The numbers in a contact phone field, trimmed, empty parts dropped. */
export function splitPhones(value: string | null | undefined): string[] {
  return (value ?? "").split(/[,;/\n]+/).map((p) => p.trim()).filter(Boolean);
}

/** Stored form ("a, b"), or null when any number is malformed or there are too many. Empty → "". */
export function normalizePhones(value: string): string | null {
  const parts = splitPhones(value);
  if (parts.length > MAX_CONTACT_PHONES || parts.some((p) => !ONE_PHONE.test(p) || p.replace(/\D/g, "").length < 6)) return null;
  return parts.join(", ");
}

/** tel: link target for one number (digits and a leading +). */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}
