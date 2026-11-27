import { z } from "zod";
import type { ToolSpec } from "@/lib/copilot/types";
import { gstinChecksOut } from "@/lib/bill-reader/rules";
import { expenseCategoryValues } from "@/lib/expenses";

/**
 * Arjun reading an expense receipt (owner, 20 Nov 2026 — "build expense receipts next"), without a database: what the
 * model is asked and may hand back, the receipt as read, the checks on it, and what it fills in on the claim. Pure, so
 * the server (./receipt-server.ts), the expense form and check:receipt-reader read the same answers.
 *
 * Nothing is kept or saved by reading: the claim's fields are filled in for the person to check, and the receipt is
 * attached to the claim as it always was when they save it.
 */

/** The expense module's own categories (src/lib/expenses.ts). */
export const EXPENSE_CATEGORIES = expenseCategoryValues;
export type ReceiptCategory = (typeof EXPENSE_CATEGORIES)[number];

/** The workspace's tax, as the receipt reader speaks of it (src/lib/country-pack.ts): India's GST, or another country's VAT. */
export type ReceiptTax = { india: boolean; name: string };

/** What the model is told — in the workspace's own tax: GST and a GSTIN in India, VAT and a TRN in the UAE. */
export function readReceiptSystem(tax: ReceiptTax): string {
  return [
    `You read one receipt or bill an employee${tax.india ? " in India" : ""} paid for work — a cab, a train or flight ticket, a hotel, a meal, fuel, a toll, a courier, a phone bill, supplies — and hand back what is printed on it.`,
    "Read only what is there; never work out, total or guess anything, and leave out whatever you can't read clearly.",
    `Amounts as plain numbers without currency signs or commas; the date as yyyy-mm-dd. total is the amount paid, taxes included. tax is the ${tax.india ? "GST on it (CGST and SGST together, or IGST)" : `${tax.name} on it`} only where the receipt shows it.`,
    `merchantGstin: the seller's ${tax.india ? "GSTIN" : "tax registration number (TRN)"}, where printed.`,
    `what: a few words on what was bought — "Cab, airport to office", "Dinner for two", "Fuel, 30 litres". category: the one of the list that fits best. paidBy: cash, card${tax.india ? " or upi" : ""}, only where the receipt says.`,
    "If the file isn't a receipt, bill or ticket at all, say what it is in notAReceipt and nothing else. Call propose_receipt exactly once.",
  ].join(" ");
}

export const PROPOSE_RECEIPT: ToolSpec = {
  name: "propose_receipt",
  description: "Hand back what the receipt says. Call it once.",
  parameters: {
    type: "object",
    properties: {
      notAReceipt: { type: "string", description: "What the file is, when it isn't a receipt." },
      merchant: { type: "string" },
      merchantGstin: { type: "string" },
      invoiceNumber: { type: "string" },
      date: { type: "string", description: "yyyy-mm-dd" },
      total: { type: "number" },
      tax: { type: "number" },
      currency: { type: "string", description: "Three letters; INR for rupees." },
      what: { type: "string" },
      category: { type: "string", enum: [...EXPENSE_CATEGORIES] },
      paidBy: { type: "string", enum: ["cash", "card", "upi"] },
    },
  },
};

const amount = z.preprocess((v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const n = Number(v.replace(/[₹,\s]|rs\.?|inr/gi, ""));
  return v.trim() && Number.isFinite(n) ? n : undefined;
}, z.number().nonnegative().optional().catch(undefined));
const text = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : undefined), z.string().optional());

export const proposedReceiptSchema = z.object({
  notAReceipt: text(200),
  merchant: text(120),
  merchantGstin: z.preprocess((v) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, "").toUpperCase() : undefined), z.string().optional()),
  invoiceNumber: text(64),
  date: z.preprocess((v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : undefined), z.string().optional()),
  total: amount,
  tax: amount,
  currency: z.preprocess((v) => (typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : undefined), z.string().optional()),
  what: text(120),
  category: z.enum(EXPENSE_CATEGORIES).optional().catch(undefined),
  paidBy: z.enum(["cash", "card", "upi"]).optional().catch(undefined),
});
export type ReadReceipt = z.infer<typeof proposedReceiptSchema>;

export type ReceiptCheck = { level: "stop" | "warn"; text: string };

/** What's wrong with the receipt as read, or worth a look — most serious first. `today` is yyyy-mm-dd, the workspace's. */
export function checkReceipt(r: ReadReceipt, ctx: { today: string; baseCurrency: string; sameClaim: string | null; tax?: ReceiptTax }): ReceiptCheck[] {
  const tax = ctx.tax ?? { india: true, name: "GST" };
  if (r.notAReceipt) return [{ level: "stop", text: `This doesn't look like a receipt — it reads as ${r.notAReceipt.replace(/\.$/, "")}.` }];
  const out: ReceiptCheck[] = [];
  if (r.total === undefined) out.push({ level: "stop", text: "No amount could be read off it — try a clearer photo, or type it in." });
  if (r.currency && r.currency !== ctx.baseCurrency) out.push({ level: "warn", text: `It's in ${r.currency} — put in what it came to in ${ctx.baseCurrency}.` });
  if (!r.date) out.push({ level: "warn", text: "No date could be read — put in the day you spent it." });
  else if (r.date > ctx.today) out.push({ level: "warn", text: `It's dated ${r.date}, after today.` });
  else if (Date.parse(ctx.today) - Date.parse(r.date) > 90 * 86_400_000) out.push({ level: "warn", text: `It's dated ${r.date}, more than three months ago.` });
  if (r.tax !== undefined && r.total !== undefined && r.tax >= r.total) out.push({ level: "warn", text: "The tax read off it is more than the total — left out." });
  if (r.tax && !r.merchantGstin) {
    out.push({ level: "warn", text: tax.india ? "It shows GST but no GSTIN for the seller — no input credit can be claimed on it." : `It shows ${tax.name} but no tax number for the seller — no input ${tax.name} can be claimed on it.` });
  }
  // A GSTIN has its own check character; a TRN is checked by the authority, not here.
  if (tax.india && r.merchantGstin && !gstinChecksOut(r.merchantGstin)) out.push({ level: "warn", text: `The seller's GSTIN ${r.merchantGstin} doesn't check out.` });
  if (ctx.sameClaim) out.push({ level: "warn", text: ctx.sameClaim });
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "stop" ? -1 : 1));
}

export type ReceiptFill = {
  amount: string | null;
  taxAmount: string | null;
  spentOn: string | null;
  category: ReceiptCategory | null;
  description: string | null;
  paymentMode: "CASH" | "PERSONAL_CARD" | "UPI" | null;
};

const fixed = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** What the claim's fields become — only what was read; the rest is left as the person had it. */
export function receiptFill(r: ReadReceipt, baseCurrency: string): ReceiptFill {
  const sameCurrency = !r.currency || r.currency === baseCurrency;
  const what = [r.what, r.merchant].filter(Boolean).join(" — ");
  return {
    amount: r.total !== undefined && sameCurrency ? fixed(r.total) : null,
    taxAmount: r.tax !== undefined && r.total !== undefined && r.tax < r.total && sameCurrency ? fixed(r.tax) : null,
    spentOn: r.date ?? null,
    category: r.category ?? null,
    description: what ? `${what}${r.invoiceNumber ? ` (bill ${r.invoiceNumber})` : ""}`.slice(0, 300) : null,
    paymentMode: r.paidBy === "cash" ? "CASH" : r.paidBy === "upi" ? "UPI" : r.paidBy === "card" ? "PERSONAL_CARD" : null,
  };
}
