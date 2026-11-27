/**
 * VAT outside India (owner, 31 Oct 2026 — the UAE country pack's phase 1; plan doc
 * https://claude.ai/artifact/6VwBxfZ6SEHjJURvZvhutR, "What the rules say"). Nothing here reaches a server: the forms
 * read it too.
 *
 *   · Every line has a category. Standard-rated is charged at the pack's rate; zero-rated, exempt and out of scope
 *     carry 0%, and the VAT 201 return reports the first two apart and leaves the third out. A rate of 0 alone
 *     can't say which, so the category is kept on the line (`TradeDocumentLine.taxCategory`).
 *   · The TRN is 15 digits. Most start 100; the FTA doesn't say all do, so that is a warning, never a refusal.
 *   · Box 1 of the return is split by the emirate of the business's own establishment — the branch that raised
 *     the invoice — never the customer's.
 */

export const TAX_CATEGORIES = ["STANDARD", "ZERO_RATED", "EXEMPT", "OUT_OF_SCOPE"] as const;
export type TaxCategoryKey = (typeof TAX_CATEGORIES)[number];

export const taxCategoryLabels: Record<TaxCategoryKey, string> = {
  STANDARD: "Standard",
  ZERO_RATED: "Zero-rated",
  EXEMPT: "Exempt",
  OUT_OF_SCOPE: "Out of scope",
};

export const isTaxCategory = (v: unknown): v is TaxCategoryKey => typeof v === "string" && (TAX_CATEGORIES as readonly string[]).includes(v);

/**
 * A line's category and rate as they are kept: standard at the pack's rate, the rest at 0. An unknown category reads
 * from the rate — above 0 standard, else zero-rated.
 *
 * Security audit round three, 14 Nov 2026 (R3-09): a standard-rated line kept whatever rate was typed, so a UAE invoice
 * could charge 3% "standard" VAT and report it in box 1. The UAE has one standard rate; a standard line is charged it.
 */
export function settleLineTax(category: unknown, rate: number, standardRate: number): { category: TaxCategoryKey; rate: number } {
  const given = isTaxCategory(category) ? category : rate > 0 ? "STANDARD" : "ZERO_RATED";
  if (given !== "STANDARD") return { category: given, rate: 0 };
  return { category: "STANDARD", rate: standardRate > 0 ? standardRate : rate };
}

/** The category a stored line reads as: its own, else by its rate (a line from before categories). */
export function lineCategory(category: string | null | undefined, rate: number): TaxCategoryKey {
  return isTaxCategory(category) ? category : rate > 0 ? "STANDARD" : "ZERO_RATED";
}

/** A TRN as typed, kept as its 15 digits — or why it isn't one. A warning when it doesn't start 100. */
export function readTrn(raw: string | null | undefined): { ok: true; trn: string | null; warning?: string } | { ok: false; error: string } {
  const typed = (raw ?? "").trim();
  if (!typed) return { ok: true, trn: null };
  const digits = typed.replace(/[\s-]/g, "");
  if (!/^\d{15}$/.test(digits)) return { ok: false, error: `A TRN is 15 digits — "${typed}" isn't one.` };
  return digits.startsWith("100") ? { ok: true, trn: digits } : { ok: true, trn: digits, warning: `${digits} doesn't start with 100, as most TRNs do — check it against the VAT certificate.` };
}

/** The seven emirates, as the return lists them. */
export const EMIRATES = ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"] as const;
export type Emirate = (typeof EMIRATES)[number];

const EMIRATE_KEYS: Record<string, Emirate> = {
  abudhabi: "Abu Dhabi",
  dubai: "Dubai",
  sharjah: "Sharjah",
  ajman: "Ajman",
  ummalquwain: "Umm Al Quwain",
  ummalqaiwain: "Umm Al Quwain",
  rasalkhaimah: "Ras Al Khaimah",
  fujairah: "Fujairah",
};

/** An address's state as one of the seven — "dubai", "Ras al-Khaimah", "Abu Dhabi Emirate" — or null. */
export function emirateOf(state: string | null | undefined): Emirate | null {
  const key = (state ?? "").toLowerCase().replace(/emirate( of)?/g, "").replace(/[^a-z]/g, "");
  return EMIRATE_KEYS[key] ?? null;
}
