/**
 * Who may read a connected mailbox, and what for (owner, 23 Nov 2026: "lets give agent access to read mails ! this will be
 * admin based if he wants to give access or not"). Pure and client-safe — the settings screen and the server read the same
 * list. An admin turns reading on for the workspace and then, person by person, which of these may read their mailbox.
 */

export const MAIL_READERS = [
  { key: "timeline", name: "Timeline", does: "Puts emails with customers, vendors and leads on their activity timeline." },
  { key: "arjun", name: "Arjun", does: "Reads payment advices, promises to pay and vendor bills sent by email, and suggests receipts and draft bills." },
  { key: "tara", name: "Tara and Ved", does: "See a lead's or customer's replies in this mailbox and draft the next step." },
  { key: "support", name: "Support", does: "Customer emails become tickets, and Kabir drafts the answer." },
] as const;

export type MailReader = (typeof MAIL_READERS)[number]["key"];

export const isMailReader = (v: unknown): v is MailReader => typeof v === "string" && MAIL_READERS.some((r) => r.key === v);

/** "Acme Pvt Ltd <a@acme.in>" → "a@acme.in"; lower case; "" for nothing usable. */
export function addressOf(v: string | null | undefined): string {
  const m = /<([^>]+)>/.exec(v ?? "") ?? [null, v ?? ""];
  const a = String(m[1]).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) ? a : "";
}

export const domainOf = (address: string) => address.split("@")[1] ?? "";

/** "https://www.acme.in/about" → "acme.in". */
export function websiteDomain(v: string | null | undefined): string {
  const t = String(v ?? "").trim().toLowerCase();
  if (!t) return "";
  try {
    return new URL(/^https?:\/\//.test(t) ? t : `https://${t}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
