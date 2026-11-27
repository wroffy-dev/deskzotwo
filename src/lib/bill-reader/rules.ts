import { z } from "zod";
import type { ToolSpec } from "@/lib/copilot/types";
import { GST_STATE_CODES, gstinCheckCharacter, isGstSlabRate, isValidGstin, stateCodeFromGstin } from "@/lib/gst-engine";

/**
 * Arjun reading a vendor's bill (owner, 20 Nov 2026 — "yes build vendor bills first"), without a database: what the model
 * is asked and may hand back, the bill as read, the checks on it, and the draft bill it becomes. Pure, so the server
 * (./server.ts), the screen and check:bill-reader read the same answers.
 *
 *   · The model reads the file — a PDF or a photo — and hands back only what is printed on it: the vendor and their
 *     GSTIN, who it's billed to, the number and dates, each line with its HSN, quantity, rate and GST rate, the tax
 *     totals and the bill's total. It works nothing out.
 *   · Deskzo then checks it: the GSTIN's own check character, whether it's billed to one of the company's GSTINs, each
 *     line's arithmetic, the GST the rates come to against the GST charged, CGST and SGST against IGST for where the
 *     vendor and the branch are, the total, and whether the bill is already entered. A check that stops it ("not a
 *     bill", "already entered", no lines, another currency) means no draft; the rest are said beside the draft.
 *   · The draft is an ordinary bill in DRAFT, raised through the same door the bill form uses
 *     (src/actions/trade-document.ts `createTradeDocument`), so every rule a typed bill meets, this one meets. Nothing is
 *     posted: a person reads it next to the vendor's file, changes what's wrong and saves it.
 */

export const ACCEPTED_TYPES = { "application/pdf": "PDF", "image/jpeg": "JPG", "image/png": "PNG", "image/webp": "WebP" } as const;
export type AcceptedType = keyof typeof ACCEPTED_TYPES;
export const isAcceptedType = (v: unknown): v is AcceptedType => typeof v === "string" && v in ACCEPTED_TYPES;
/** The most a file may weigh — under the 6 MB a server action takes (next.config.ts); the screen shrinks a photo first. */
export const FILE_MAX_BYTES = 5 * 1024 * 1024;
/** A bill is a page or two; more is a statement or a bundle. */
export const PDF_MAX_PAGES = 5;

export const READ_BILL_SYSTEM = [
  "You read one bill — a vendor's tax invoice to us — from India, and hand back exactly what is printed on it.",
  "Read only what is there. Never work out, total, guess or correct anything; leave out whatever you can't read clearly.",
  "Amounts as plain numbers, without currency signs or commas. Dates as yyyy-mm-dd. GSTINs as printed, 15 characters.",
  "vendorGstin is the seller's; billedToGstin the GSTIN it's billed to. For each line: the description, HSN or SAC, quantity, unit, the rate per unit before tax, any discount on the line as an amount, the line's taxable value, and its GST rate — CGST and SGST together, or IGST.",
  "cgst, sgst, igst and cess are the bill's totals of each; freight is a delivery or freight charge outside the lines, with its GST rate; roundOff as printed, negative when it takes away; total is the bill's grand total.",
  "If the file isn't a bill or invoice at all — a quotation, a delivery challan, a statement, a receipt — say what it is in notABill and nothing else.",
  "Call propose_bill exactly once.",
].join(" ");

const num = { type: "number" };
const str = { type: "string" };
export const PROPOSE_BILL: ToolSpec = {
  name: "propose_bill",
  description: "Hand back what the bill says. Call it once.",
  parameters: {
    type: "object",
    properties: {
      notABill: { type: "string", description: "What the file is, when it isn't a bill." },
      vendorName: str,
      vendorGstin: str,
      billedToGstin: str,
      billNumber: str,
      billDate: { type: "string", description: "yyyy-mm-dd" },
      dueDate: { type: "string", description: "yyyy-mm-dd" },
      poNumber: { type: "string", description: "Our purchase order number, where the bill quotes one." },
      endCustomer: { type: "string", description: "The end customer or end user the goods or licences are for, where the bill names one — often after \"End customer\" or \"End user\"." },
      placeOfSupply: { type: "string", description: "As printed: a state's name or its two-digit code." },
      reverseCharge: { type: "boolean" },
      currency: { type: "string", description: "Three letters; INR when the bill shows rupees." },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: { description: str, hsn: str, quantity: num, unit: str, rate: num, discount: num, taxable: num, gstRate: num },
          required: ["description"],
        },
      },
      freight: num,
      freightGstRate: num,
      cgst: num,
      sgst: num,
      igst: num,
      cess: num,
      roundOff: num,
      total: num,
    },
  },
};

/** A number as a model may hand one back — 1200, "1,200.00", "₹ 1,200" — or undefined. */
const amount = z.preprocess((v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const cleaned = v.replace(/[₹,\s]|rs\.?|inr/gi, "");
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}, z.number().optional());
const text = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : undefined), z.string().optional());
const day = z.preprocess((v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : undefined), z.string().optional());

const lineSchema = z.object({
  description: text(500),
  hsn: z.preprocess((v) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "") || undefined : undefined), z.string().optional()),
  quantity: amount,
  unit: text(30),
  rate: amount,
  discount: amount,
  taxable: amount,
  gstRate: amount,
});

export const proposedBillSchema = z.object({
  notABill: text(200),
  vendorName: text(200),
  vendorGstin: z.preprocess((v) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, "").toUpperCase() : undefined), z.string().optional()),
  billedToGstin: z.preprocess((v) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, "").toUpperCase() : undefined), z.string().optional()),
  billNumber: text(64),
  billDate: day,
  dueDate: day,
  poNumber: text(64),
  endCustomer: text(200),
  placeOfSupply: text(60),
  reverseCharge: z.boolean().optional().catch(undefined),
  currency: z.preprocess((v) => (typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : undefined), z.string().optional()),
  lines: z.array(lineSchema).max(200).optional().catch(undefined),
  freight: amount,
  freightGstRate: amount,
  cgst: amount,
  sgst: amount,
  igst: amount,
  cess: amount,
  roundOff: amount,
  total: amount,
});
export type ProposedBill = z.infer<typeof proposedBillSchema>;

const r2 = (n: number) => Math.round(n * 100) / 100;

export type ReadLine = { description: string; hsn: string | null; quantity: number; unit: string | null; rate: number; discount: number; taxable: number; gstRate: number };

/** The bill as read, every figure settled: a line without a quantity is one of its taxable value. */
export type ReadBill = {
  notABill: string | null;
  vendorName: string | null;
  vendorGstin: string | null;
  billedToGstin: string | null;
  billNumber: string | null;
  billDate: string | null;
  dueDate: string | null;
  poNumber: string | null;
  /** Whom it was bought for, where the bill says — a reseller's end customer (owner, 23 Nov 2026). */
  endCustomer: string | null;
  placeOfSupply: string | null;
  reverseCharge: boolean;
  currency: string;
  lines: ReadLine[];
  freight: number;
  freightGstRate: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  roundOff: number;
  total: number | null;
};

export function settleBill(p: ProposedBill): ReadBill {
  const lines: ReadLine[] = (p.lines ?? [])
    .filter((l) => l.description || l.taxable !== undefined || l.rate !== undefined)
    .map((l) => {
      const discount = Math.max(0, l.discount ?? 0);
      let quantity = l.quantity && l.quantity > 0 ? l.quantity : 1;
      let rate = l.rate !== undefined && l.rate >= 0 ? l.rate : null;
      const taxable = l.taxable !== undefined && l.taxable >= 0 ? l.taxable : rate !== null ? r2(quantity * rate - discount) : 0;
      if (rate === null) {
        // Only a taxable value printed: one of it, before the discount.
        rate = r2((taxable + discount) / quantity);
        if (!l.quantity) quantity = 1;
      }
      return { description: l.description ?? "Item", hsn: l.hsn ?? null, quantity, unit: l.unit ?? null, rate, discount, taxable: r2(taxable), gstRate: Math.max(0, l.gstRate ?? 0) };
    });
  return {
    notABill: p.notABill ?? null,
    vendorName: p.vendorName ?? null,
    vendorGstin: p.vendorGstin ?? null,
    billedToGstin: p.billedToGstin ?? null,
    billNumber: p.billNumber ?? null,
    billDate: p.billDate ?? null,
    dueDate: p.dueDate ?? null,
    poNumber: p.poNumber ?? null,
    endCustomer: p.endCustomer ?? null,
    placeOfSupply: p.placeOfSupply ?? null,
    reverseCharge: p.reverseCharge === true,
    currency: p.currency ?? "INR",
    lines,
    freight: Math.max(0, p.freight ?? 0),
    freightGstRate: Math.max(0, p.freightGstRate ?? 0),
    cgst: Math.max(0, p.cgst ?? 0),
    sgst: Math.max(0, p.sgst ?? 0),
    igst: Math.max(0, p.igst ?? 0),
    cess: Math.max(0, p.cess ?? 0),
    roundOff: p.roundOff ?? 0,
    total: p.total ?? null,
  };
}

// ─── The checks ───────────────────────────────────────────────────────────────────────────────────────────────────

/** "stop": no draft is made; "warn": said beside the draft. */
export type BillCheck = { level: "stop" | "warn"; text: string };

/** A GSTIN that's the right shape and whose fifteenth character is its own check character. */
export function gstinChecksOut(gstin: string): boolean {
  return isValidGstin(gstin) && gstinCheckCharacter(gstin.slice(0, 14)) === gstin[14];
}

const money = (n: number) => `₹${r2(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const stateName = (code: string | null) => (code ? (GST_STATE_CODES[code] ?? code) : null);

export type CheckContext = {
  /** The company's own GSTINs. */
  ourGstins: string[];
  /** The branch it's billed to's state — where the bill should be intra-state from. */
  ourStateCode: string | null;
  /** The company's own currency. */
  baseCurrency: string;
  /** "This vendor's bill X is already entered", when it is. */
  duplicate: string | null;
  /** Lines whose HSN isn't a code the GST directory lists (by index). */
  unknownHsn: number[];
  /** yyyy-mm-dd, the workspace's. */
  today: string;
};

/** What's wrong with the bill as read, or worth a second look — most serious first. */
export function checkBill(b: ReadBill, ctx: CheckContext): BillCheck[] {
  const out: BillCheck[] = [];
  if (b.notABill) return [{ level: "stop", text: `This doesn't look like a bill — it reads as ${b.notABill.replace(/\.$/, "")}.` }];
  if (!b.lines.length) out.push({ level: "stop", text: "No lines could be read off it. Try a clearer photo, or the vendor's PDF." });
  if (ctx.duplicate) out.push({ level: "stop", text: ctx.duplicate });
  if (b.currency !== ctx.baseCurrency) out.push({ level: "stop", text: `It's in ${b.currency}. Bills in another currency aren't read yet — enter it by hand, with the day's rate.` });
  if (!b.billNumber) out.push({ level: "warn", text: "No bill number could be read — type the vendor's number in before saving." });

  if (!b.vendorGstin) out.push({ level: "warn", text: "No GSTIN on it for the vendor — it'll be an unregistered vendor's bill, with no input tax credit." });
  else if (!gstinChecksOut(b.vendorGstin)) out.push({ level: "warn", text: `The vendor's GSTIN ${b.vendorGstin} doesn't check out — read it again off the bill.` });
  if (b.billedToGstin && ctx.ourGstins.length && !ctx.ourGstins.includes(b.billedToGstin)) {
    out.push({ level: "warn", text: `It's billed to GSTIN ${b.billedToGstin}, which isn't one of yours — no input tax credit unless it's corrected.` });
  }

  if (!b.billDate) out.push({ level: "warn", text: "No bill date could be read — today's is put in; change it to the bill's." });
  else if (b.billDate > ctx.today) out.push({ level: "warn", text: `It's dated ${b.billDate}, after today.` });
  else if (Date.parse(ctx.today) - Date.parse(b.billDate) > 548 * 86_400_000) out.push({ level: "warn", text: `It's dated ${b.billDate}, more than 18 months ago — too late for input tax credit.` });

  b.lines.forEach((l, i) => {
    const expected = r2(l.quantity * l.rate - l.discount);
    if (Math.abs(expected - l.taxable) > 1) out.push({ level: "warn", text: `Line ${i + 1}: ${l.quantity} × ${money(l.rate)}${l.discount ? ` − ${money(l.discount)}` : ""} is ${money(expected)}, but the bill says ${money(l.taxable)}.` });
    if (!isGstSlabRate(l.gstRate)) out.push({ level: "warn", text: `Line ${i + 1}: ${l.gstRate}% isn't a GST rate.` });
  });
  for (const i of ctx.unknownHsn) out.push({ level: "warn", text: `Line ${i + 1}: HSN/SAC ${b.lines[i]?.hsn} isn't in the GST directory — left off; put the right one in.` });

  // The GST the rates come to, against what's charged.
  const taxable = r2(b.lines.reduce((t, l) => t + l.taxable, 0));
  const byRates = r2(b.lines.reduce((t, l) => t + (l.taxable * l.gstRate) / 100, 0) + (b.freight * b.freightGstRate) / 100);
  const charged = r2(b.cgst + b.sgst + b.igst);
  if (b.lines.length && Math.abs(byRates - charged) > Math.max(1, b.lines.length * 0.5)) {
    out.push({ level: "warn", text: `The GST charged is ${money(charged)}; the lines' rates make it ${money(byRates)}.` });
  }
  // CGST and SGST within a state, IGST across states.
  const vendorState = stateCodeFromGstin(b.vendorGstin);
  if (vendorState && ctx.ourStateCode && charged > 0) {
    const same = vendorState === ctx.ourStateCode;
    if (same && b.igst > 0) out.push({ level: "warn", text: `The vendor and your branch are both in ${stateName(vendorState)}, but the bill charges IGST — it should be CGST and SGST.` });
    if (!same && b.cgst + b.sgst > 0) out.push({ level: "warn", text: `The vendor is in ${stateName(vendorState)} and your branch in ${stateName(ctx.ourStateCode)}, but the bill charges CGST and SGST — it should be IGST.` });
  }
  if (Math.abs(b.cgst - b.sgst) > 1) out.push({ level: "warn", text: `CGST (${money(b.cgst)}) and SGST (${money(b.sgst)}) should be equal.` });
  if (b.cess > 0) out.push({ level: "warn", text: `Cess of ${money(b.cess)} isn't carried onto the draft — add it by hand.` });
  // The bill's total, from its own parts.
  if (b.total !== null && b.lines.length) {
    const parts = r2(taxable + b.freight + charged + b.cess + b.roundOff);
    if (Math.abs(parts - b.total) > 1) out.push({ level: "warn", text: `The lines, freight and taxes add to ${money(parts)}; the bill's total is ${money(b.total)}.` });
  }
  return out.sort((a, b2) => (a.level === b2.level ? 0 : a.level === "stop" ? -1 : 1));
}

// ─── The draft ────────────────────────────────────────────────────────────────────────────────────────────────────

export type DraftChoice = {
  vendorId: string;
  locationId: string | null;
  poId: string | null;
  billNumber: string;
  billDate: string;
  dueDate: string | null;
  /** By line: our catalogue item it is, where one was matched. */
  itemIds: (string | null)[];
};

/**
 * The bill as the document form would send it (src/lib/validation/trade-document.ts `tradeDocumentSchema`), for the
 * same door to check. An HSN the directory doesn't list is left off rather than refused.
 */
export function draftInput(b: ReadBill, choice: DraftChoice, ctx: { unknownHsn: number[]; fileName: string }) {
  return {
    docType: "BILL" as const,
    companyId: choice.vendorId,
    locationId: choice.locationId ?? "",
    docNumber: choice.billNumber.trim(),
    gstTreatment: b.vendorGstin && gstinChecksOut(b.vendorGstin) ? ("REGISTERED_REGULAR" as const) : ("UNREGISTERED" as const),
    buyerGstin: b.vendorGstin && gstinChecksOut(b.vendorGstin) ? b.vendorGstin : "",
    reverseCharge: b.reverseCharge,
    issueDate: choice.billDate,
    dueDate: choice.dueDate ?? "",
    reference: b.poNumber ?? "",
    notes: [b.endCustomer ? `End customer: ${b.endCustomer}` : null, `Read from the vendor's file (${ctx.fileName.slice(0, 120)}) by Arjun — check it against the bill before saving.`].filter(Boolean).join("\n"),
    billing: {},
    shippingSameAsBilling: true,
    shipping: {},
    shippingCharge: b.freight,
    shippingTaxRatePercent: b.freight > 0 ? b.freightGstRate : 0,
    withholdingMode: "NONE" as const,
    adjustmentLabel: b.roundOff ? "Round off" : "",
    adjustment: b.roundOff,
    sourceDocumentId: choice.poId ?? "",
    lines: b.lines.map((l, i) => ({
      itemId: choice.itemIds[i] ?? "",
      name: l.description.slice(0, 500),
      description: "",
      hsnCode: l.hsn && !ctx.unknownHsn.includes(i) ? l.hsn : "",
      unit: l.unit ?? "",
      quantity: l.quantity,
      unitPrice: l.rate,
      discountMode: "AMOUNT" as const,
      discountValue: Math.min(l.discount, l.quantity * l.rate),
      taxRatePercent: Math.min(100, l.gstRate),
    })),
  };
}

/** Words a line's description shares with a name — for matching it to a PO line or an item. */
export function nameOverlap(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size);
}
