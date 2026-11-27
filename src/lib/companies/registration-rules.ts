/**
 * A company's registrations (owner, 20 Nov 2026 — "where can i see vat no, trn number etc in uae workspace customer? and
 * gst number, cin number in Indian workspace customer?"). What holds no data, so the card can use it too: the shapes of
 * a CIN or LLPIN and a trade licence, and where a licence stands against its expiry.
 *
 * Where each number lives:
 * - India: PAN on the company (Company.panNumber, finance's to change); CIN or LLPIN here; a GSTIN on each address.
 * - UAE: the trade licence here; the TRN on each address (CompanyLocation.gstNumber — invoices print it from there).
 */

/** L or U, the industry's five digits, the state's two letters, the year, the company's class, six digits. */
export const CIN_PATTERN = /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/;
/** A limited liability partnership's identity number: three letters, a dash, four digits. */
export const LLPIN_PATTERN = /^[A-Z]{3}-\d{4}$/;

/** As people type it — spaces gone, upper case. */
export function normaliseCin(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, "").toUpperCase();
}

/** Why a CIN won't do; null when it will — an empty one clears it. */
export function cinRefusal(raw: unknown): string | null {
  const value = normaliseCin(raw);
  if (!value) return null;
  if (CIN_PATTERN.test(value) || LLPIN_PATTERN.test(value)) return null;
  return "A CIN looks like U72200DL2010PTC123456 (21 characters); an LLPIN like AAB-1234.";
}

export const LICENCE_NUMBER_MAX = 40;
export const LICENCE_AUTHORITY_MAX = 80;

/** A licence number as kept: letters, digits and the few marks they carry; spaces tidied. */
export function cleanLicenceNumber(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

export function licenceNumberRefusal(raw: unknown): string | null {
  const value = cleanLicenceNumber(raw);
  if (!value) return null;
  if (value.length > LICENCE_NUMBER_MAX) return `A trade licence number is at most ${LICENCE_NUMBER_MAX} characters.`;
  if (!/^[A-Z0-9][A-Z0-9 /.-]*$/.test(value)) return "A trade licence number has only letters, digits, spaces and / . -";
  return null;
}

/** Who issued it — "DED Dubai", "DMCC" — as typed, without anything a page could take for markup. */
export function cleanAuthority(raw: unknown): string {
  return String(raw ?? "").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, LICENCE_AUTHORITY_MAX);
}

/** A yyyy-mm-dd day that is a real day; "" for none; null when it isn't one. */
export function cleanDay(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value;
}

/** Within this many days of running out, a licence is "expiring soon". */
export const LICENCE_SOON_DAYS = 30;

export type LicenceStanding = "expired" | "soon" | "valid";

/** Where a licence stands on `today` (yyyy-mm-dd, the workspace's day); null when it has no expiry on file. */
export function licenceStanding(expiresOn: string | null | undefined, today: string): LicenceStanding | null {
  if (!expiresOn) return null;
  const days = Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days < 0) return "expired";
  return days <= LICENCE_SOON_DAYS ? "soon" : "valid";
}

/** The tax numbers on its addresses, once each, in the order they come. */
export function addressTaxNumbers(locations: { gstNumber: string | null }[]): string[] {
  const seen = new Set<string>();
  for (const l of locations) {
    const v = (l.gstNumber ?? "").trim().toUpperCase();
    if (v) seen.add(v);
  }
  return [...seen];
}
