import { z } from "zod";
import type { TradeDocumentType } from "@prisma/client";
import { documentDirection, isEInvoiceEligible } from "@/lib/trade-documents";
import { paysByUpi } from "@/lib/documents/print-extras";
import { workspacePack } from "@/lib/country-pack";

/**
 * How a document looks on paper (owner, 30 Oct 2026: "jitne bhi invoice h un sabhi ke template edit or new create
 * krne ke option daal do") — a print template's options, the way Zoho Books keeps them: a layout, a colour, a font
 * and a paper size, the page's wording, and a switch for each part it prints. Several templates a document type, one
 * the default (DocumentPrintTemplate; src/lib/documents/print-template-server.ts picks one), and none at all is the
 * built-in Standard — these defaults, which print exactly the page every document printed before templates.
 *
 * Pure, so the print page, the settings screen's editor and check:print-templates read the same rules. What the law
 * makes a type carry is never a template's to hide: `optionsFor` doesn't offer those switches on that type, and
 * `effectivePrintOptions` forces them back on whatever a stored template or a preview says.
 */

export const PRINT_LAYOUTS = ["standard", "modern", "compact"] as const;
export type PrintLayout = (typeof PRINT_LAYOUTS)[number];

export const printLayoutInfo: Record<PrintLayout, { label: string; description: string }> = {
  standard: { label: "Standard", description: "The page as it has always printed: black on white, ruled boxes." },
  modern: { label: "Modern", description: "A band of your colour behind the letterhead, the title in white, and a coloured table header." },
  compact: { label: "Compact", description: "Tighter spacing and smaller type, so more lines fit a page." },
};

export const PRINT_FONTS = ["sans", "serif"] as const;
export const printFontLabels: Record<(typeof PRINT_FONTS)[number], string> = { sans: "Sans serif (the app's)", serif: "Serif" };

export const PRINT_PAPERS = ["A4", "Letter"] as const;
export type PrintPaper = (typeof PRINT_PAPERS)[number];

/** The page's own ink — Tailwind's neutral-900, what the printed page is written in. As the accent, it changes nothing. */
export const DEFAULT_ACCENT = "#171717";
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** The labels a template may reword, and the page's own words for each — what a blank one prints. */
export const PRINT_LABEL_KEYS = ["billTo", "shipTo", "details", "amountInWords", "bankDetails", "terms", "signatory"] as const;
export type PrintLabelKey = (typeof PRINT_LABEL_KEYS)[number];
export const PRINT_LABEL_DEFAULTS: Record<PrintLabelKey, string> = {
  billTo: "Bill to",
  shipTo: "Ship to",
  details: "Details",
  amountInWords: "Amount in words",
  bankDetails: "Bank details",
  terms: "Terms",
  signatory: "Authorised signatory",
};

/** What the counterparty box is called when a template leaves it blank: "Bill to" on a sale; on a purchase, the vendor (the print page asks Settings › Wording for a purchase order's). */
export function partyLabelDefault(docType: TradeDocumentType): string {
  return documentDirection[docType] === "SALES" ? PRINT_LABEL_DEFAULTS.billTo : "Vendor";
}

/** Every part of the page a template can switch off. All on is today's page. */
export const PRINT_SHOW_KEYS = [
  "logo",
  "companyAddress",
  "ourGstin",
  "phone",
  "branchLine",
  "placeOfSupply",
  "gstTreatment",
  "reverseCharge",
  "hsnColumn",
  "quantityUnit",
  "lineDescriptions",
  "lineTaxPercent",
  "discountNote",
  "amountInWords",
  "einvoiceQr",
  "contact",
  "bankDetails",
  "upiQr",
  "terms",
  "notes",
  "signature",
  "forCompany",
  "footer",
  "fullTaxInvoice",
] as const;
export type PrintShowKey = (typeof PRINT_SHOW_KEYS)[number];

export const PRINT_SHOW_GROUPS = ["Letterhead", "Details", "Lines", "Below the lines", "Signature and footer"] as const;
export type PrintShowGroup = (typeof PRINT_SHOW_GROUPS)[number];

const SHOW_INFO: Record<PrintShowKey, { label: string; group: PrintShowGroup; hint?: string }> = {
  logo: { label: "Logo", group: "Letterhead" },
  companyAddress: { label: "Our address", group: "Letterhead" },
  ourGstin: { label: "Our GSTIN", group: "Letterhead" },
  phone: { label: "Our phone number", group: "Letterhead" },
  branchLine: { label: "Which branch it's from", group: "Letterhead", hint: "Printed only where there are several branches." },
  placeOfSupply: { label: "Place of supply", group: "Details" },
  gstTreatment: { label: "GST treatment", group: "Details" },
  reverseCharge: { label: "Reverse charge", group: "Details" },
  hsnColumn: { label: "HSN/SAC column", group: "Lines" },
  quantityUnit: { label: "Unit after the quantity", group: "Lines" },
  lineDescriptions: { label: "Line descriptions", group: "Lines", hint: "The text under each item's name." },
  lineTaxPercent: { label: "Tax rate under each tax amount", group: "Lines" },
  discountNote: { label: "Discount under the taxable value", group: "Lines" },
  amountInWords: { label: "Amount in words", group: "Below the lines" },
  einvoiceQr: { label: "e-Invoice QR code and IRN", group: "Below the lines" },
  contact: { label: "Your contact", group: "Below the lines", hint: "Who the customer rings: the salesperson, else the account owner." },
  bankDetails: { label: "Bank details", group: "Below the lines" },
  upiQr: { label: "UPI code to pay", group: "Below the lines" },
  terms: { label: "Terms", group: "Below the lines" },
  notes: { label: "Notes", group: "Below the lines", hint: "The document's notes and the footer note from Settings › Profile." },
  signature: { label: "Signature image", group: "Signature and footer" },
  forCompany: { label: "“For <company>” line", group: "Signature and footer" },
  footer: { label: "Footer line", group: "Signature and footer", hint: "“This is a computer-generated …”, or your own footer text." },
  // The UAE's (owner, 14 Nov 2026): off, an invoice to a buyer without a TRN, or of AED 10,000 or less, prints as a
  // simplified tax invoice — the FTA allows one in those cases. On, every invoice is a full one, as before.
  fullTaxInvoice: { label: "Full tax invoice", group: "Details", hint: "Off: a buyer without a TRN, or a sale of AED 10,000 or less, gets a simplified tax invoice." },
};

// ─── The options ─────────────────────────────────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max, `Keep it to ${max} characters.`);

const labelShape = Object.fromEntries(PRINT_LABEL_KEYS.map((k) => [k, text(40).default("")])) as Record<PrintLabelKey, z.ZodDefault<z.ZodString>>;
const showShape = Object.fromEntries(PRINT_SHOW_KEYS.map((k) => [k, z.boolean().default(true)])) as Record<PrintShowKey, z.ZodDefault<z.ZodBoolean>>;

/**
 * A template's options, as saved and as previewed — every value checked, every one missing filled with today's.
 *
 * The colour goes into an inline style and the layout and font pick class names, so each is a pattern or a choice
 * from a list, never free text: nothing a template holds reaches the page except as a checked value or as text.
 */
export const printOptionsSchema = z.object({
  layout: z.enum(PRINT_LAYOUTS).default("standard"),
  accentColor: z
    .string()
    .trim()
    .regex(HEX_COLOUR, "Give the colour as #RRGGBB.")
    .transform((v) => v.toLowerCase())
    .default(DEFAULT_ACCENT),
  font: z.enum(PRINT_FONTS).default("sans"),
  paper: z.enum(PRINT_PAPERS).default("A4"),
  /** Blank: the document's own title (printedTitle — "Tax invoice", or "Bill of supply" when nothing on it is taxed). */
  title: text(60).default(""),
  /** A line under the letterhead. */
  headerNote: text(200).default(""),
  /** In place of "This is a computer-generated …". */
  footerText: text(300).default(""),
  /** Printed when the document has no terms of its own. Kept short enough to travel in a preview's address. */
  defaultTerms: text(2000).default(""),
  labels: z.object(labelShape).prefault({}),
  show: z.object(showShape).prefault({}),
});

export type PrintOptions = z.output<typeof printOptionsSchema>;

/** The built-in Standard: today's page. */
export const DEFAULT_PRINT_OPTIONS: PrintOptions = printOptionsSchema.parse({});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Stored options as the page uses them — never throws. A template written by an older version, or one value that no
 * longer passes, costs only that value: the rest of the template still prints as it was set.
 */
export function resolvePrintOptions(raw: unknown): PrintOptions {
  try {
    const src = isRecord(raw) ? raw : {};
    const whole = printOptionsSchema.safeParse(src);
    if (whole.success) return whole.data;
    const field = <K extends Exclude<keyof PrintOptions, "labels" | "show">>(key: K): PrintOptions[K] => {
      const parsed = printOptionsSchema.shape[key].safeParse(src[key]);
      return (parsed.success ? parsed.data : DEFAULT_PRINT_OPTIONS[key]) as PrintOptions[K];
    };
    const labels = isRecord(src.labels) ? src.labels : {};
    const show = isRecord(src.show) ? src.show : {};
    return {
      layout: field("layout"),
      accentColor: field("accentColor"),
      font: field("font"),
      paper: field("paper"),
      title: field("title"),
      headerNote: field("headerNote"),
      footerText: field("footerText"),
      defaultTerms: field("defaultTerms"),
      labels: Object.fromEntries(PRINT_LABEL_KEYS.map((k) => {
        const parsed = labelShape[k].safeParse(labels[k]);
        return [k, parsed.success ? parsed.data : ""];
      })) as PrintOptions["labels"],
      show: Object.fromEntries(PRINT_SHOW_KEYS.map((k) => [k, typeof show[k] === "boolean" ? show[k] : true])) as PrintOptions["show"],
    };
  } catch {
    return structuredClone(DEFAULT_PRINT_OPTIONS);
  }
}

/** A saved template's options: its layout column with the rest of what it stored. */
export function templateOptions(row: { layout: string; options: unknown }): PrintOptions {
  return resolvePrintOptions({ ...(isRecord(row.options) ? row.options : {}), layout: row.layout });
}

/** What a type prints with when none of its templates is the default — or it has none. */
export const BUILT_IN_TEMPLATE_NAME = "Standard (built in)";

// ─── What the law keeps on the page ──────────────────────────────────────────────────────────────

/** GST's own papers: a tax invoice or bill of supply (Rules 46, 49), a credit or debit note (Rule 53), a delivery challan (Rule 55). */
const GST_PAPER: readonly TradeDocumentType[] = ["INVOICE", "CREDIT_NOTE", "DEBIT_NOTE", "DELIVERY_CHALLAN"];

/**
 * The switches a type may not have, and the rule that says so. Each is something the CGST Rules require that paper
 * to carry — a tax invoice (and a bill of supply, which is the same INVOICE untaxed) under Rules 46 and 49, a credit
 * or debit note under Rule 53(1A), a delivery challan under Rule 55. Everything else on those papers (the bank, the
 * contact, the words, the logo) is the business's own choice; on a proposal, proforma, purchase order or vendor bill
 * — none of them a GST document — every switch is.
 *
 * Not switches at all, and so never hideable on any type: the tax breakup (the CGST/SGST/IGST columns and totals),
 * the counterparty's GSTIN, the watermark on a document awaiting sign-off, Rule 48's copy labels, "Draft — not
 * issued", and the bill-of-supply declaration.
 */
const STATUTORY: Partial<Record<PrintShowKey, { applies: (t: TradeDocumentType) => boolean; why: string }>> = {
  companyAddress: { applies: (t) => GST_PAPER.includes(t), why: "GST requires the supplier's name, address and GSTIN on it (Rules 46(a), 53(1A)(a), 55(1)(b))." },
  ourGstin: { applies: (t) => GST_PAPER.includes(t), why: "GST requires the supplier's name, address and GSTIN on it (Rules 46(a), 53(1A)(a), 55(1)(b))." },
  hsnColumn: { applies: (t) => t === "INVOICE" || t === "DELIVERY_CHALLAN", why: "GST requires each line's HSN or SAC code on it (Rules 46(g), 49, 55(1)(e))." },
  quantityUnit: { applies: (t) => t === "INVOICE", why: "GST requires the quantity of goods with its unit (Rule 46(h))." },
  lineTaxPercent: { applies: (t) => GST_PAPER.includes(t), why: "GST requires the rate of each tax on it (Rules 46(j), 53(1A)(h), 55(1)(g))." },
  placeOfSupply: { applies: (t) => t === "INVOICE" || t === "DELIVERY_CHALLAN", why: "GST requires the place of supply on it (Rules 46(m), 55(1)(h))." },
  reverseCharge: { applies: (t) => t === "INVOICE", why: "GST requires it to say whether tax is payable on reverse charge (Rule 46(p))." },
  /**
   * Forced on wherever an IRN can exist: an e-invoice must carry the QR code the IRP signed (Rule 48(4)), and a
   * printed invoice without it isn't the e-invoice the portal registered. A type that can't have an IRN never prints
   * the block, so the switch isn't offered there either.
   */
  einvoiceQr: { applies: (t) => isEInvoiceEligible(t), why: "An e-invoice must carry the QR code the IRP signed (Rule 48(4)) — it prints whenever the document has an IRN." },
  forCompany: { applies: (t) => GST_PAPER.includes(t), why: "GST requires it signed by the supplier or its authorised signatory (Rules 46(q), 53(1A)(i), 55(1)(i))." },
};

/** Switches for what a type never prints: no bank account on a purchase (it would invite the vendor to pay us), no UPI code on what nobody pays from, no e-invoice block where there's no IRN. */
function printsOn(key: PrintShowKey, docType: TradeDocumentType): boolean {
  if (key === "bankDetails") return documentDirection[docType] === "SALES";
  if (key === "upiQr") return paysByUpi(docType);
  if (key === "einvoiceQr") return isEInvoiceEligible(docType);
  if (key === "fullTaxInvoice") return docType === "INVOICE" && workspacePack().country === "AE";
  return true;
}

/** A GST paper's title says what it is — a tax invoice, or a bill of supply when nothing on it is taxed (s.31(3)(c), Rule 49); a note its nature (Rule 53(1A)(b)). */
const TITLE_FIXED: Partial<Record<TradeDocumentType, string>> = {
  INVOICE: "A tax invoice says it is one, and one with nothing taxed says it is a bill of supply (s.31, Rule 49) — the title follows the document.",
  CREDIT_NOTE: "A credit note says what it is (Rule 53(1A)(b)).",
  DEBIT_NOTE: "A debit note says what it is (Rule 53(1A)(b)).",
  DELIVERY_CHALLAN: "A delivery challan says what it is (Rule 55).",
};

export type PrintSwitch = { key: PrintShowKey; label: string; group: PrintShowGroup; hint: string | null; locked: string | null };

/**
 * The switches a template of this type offers, each with why it is locked on (null when it isn't), and whether its
 * title can be changed. What the type never prints is left off the list.
 */
export function optionsFor(docType: TradeDocumentType): { switches: PrintSwitch[]; titleLocked: string | null } {
  // Outside India (owner, 14 Nov 2026): no GST-only switches — place of supply, GST treatment, HSN, the e-invoice QR, a
  // UPI code — none of them printed there; the tax number named for the country; and no CGST Rules quoted.
  const pack = workspacePack();
  if (!pack.india) {
    const taxNumber = pack.country === "AE" ? "Our TRN" : "Our tax number";
    return {
      switches: PRINT_SHOW_KEYS.filter((key) => printsOn(key, docType) && !INDIA_ONLY_SWITCHES.has(key)).map((key) => ({
        key,
        ...SHOW_INFO[key],
        ...(key === "ourGstin" ? { label: taxNumber } : {}),
        hint: SHOW_INFO[key].hint ?? null,
        locked: null,
      })),
      titleLocked: docType === "INVOICE" || docType === "CREDIT_NOTE" ? "A tax invoice or credit note says what it is — the title follows the document." : null,
    };
  }
  return {
    switches: PRINT_SHOW_KEYS.filter((key) => printsOn(key, docType)).map((key) => {
      const rule = STATUTORY[key];
      return { key, ...SHOW_INFO[key], hint: SHOW_INFO[key].hint ?? null, locked: rule?.applies(docType) ? rule.why : null };
    }),
    titleLocked: TITLE_FIXED[docType] ?? null,
  };
}

/** What only an Indian document prints. */
const INDIA_ONLY_SWITCHES = new Set<PrintShowKey>(["placeOfSupply", "gstTreatment", "hsnColumn", "einvoiceQr", "upiQr"]);

/** The options as a document of this type prints them: whatever the law keeps on that paper is on, whatever a template or a preview said. */
export function effectivePrintOptions(options: PrintOptions, docType: TradeDocumentType): PrintOptions {
  const show = { ...options.show };
  for (const key of PRINT_SHOW_KEYS) if (STATUTORY[key]?.applies(docType)) show[key] = true;
  return { ...options, title: TITLE_FIXED[docType] ? "" : options.title, labels: { ...options.labels }, show };
}

// ─── The look of each layout ─────────────────────────────────────────────────────────────────────

/**
 * The class names each layout prints with, whole, so the stylesheet has every one. Standard's are exactly the print
 * page's own — a document with no template renders the HTML it always did. The accent colour is never a class: it
 * goes into an inline style, checked as #RRGGBB.
 */
export type PrintSkin = {
  /** The page's type size. */
  base: string;
  /** Inside each ruled box. */
  pad: string;
  /** Inside each table cell. */
  cell: string;
  /** The lines' type size. */
  lines: string;
  thead: string;
  /** Above the signature. */
  sign: string;
  /** The notes box, and the header note. */
  notePad: string;
  /** The bill-of-supply declaration. */
  declPad: string;
  logo: string;
  /** Inside the letterhead: on Modern's coloured band, white. */
  ink: { muted: string; faint: string; number: string; rule: string };
  /** Whether the letterhead and table header sit on the accent colour. */
  band: boolean;
};

const PLAIN_INK = { muted: "text-neutral-600", faint: "text-neutral-500", number: "text-neutral-700", rule: "border-neutral-400" };

export const PRINT_SKINS: Record<PrintLayout, PrintSkin> = {
  standard: {
    base: "text-[13px]",
    pad: "p-5",
    cell: "px-2 py-2",
    lines: "text-[12px]",
    thead: "border-b border-neutral-300 bg-neutral-100 text-left text-[10px] uppercase tracking-wide text-neutral-600",
    sign: "mt-10",
    notePad: "px-5 py-3",
    declPad: "px-5 py-2",
    logo: "h-12 w-auto object-contain",
    ink: PLAIN_INK,
    band: false,
  },
  modern: {
    base: "text-[13px]",
    pad: "p-5",
    cell: "px-2 py-2",
    lines: "text-[12px]",
    thead: "border-b border-neutral-300 text-left text-[10px] uppercase tracking-wide text-white",
    sign: "mt-10",
    notePad: "px-5 py-3",
    declPad: "px-5 py-2",
    logo: "h-12 w-auto rounded bg-white p-1 object-contain",
    ink: { muted: "text-white/85", faint: "text-white/75", number: "text-white/90", rule: "border-white/70" },
    band: true,
  },
  compact: {
    base: "text-[12px]",
    pad: "p-3",
    cell: "px-1.5 py-1",
    lines: "text-[11px]",
    thead: "border-b border-neutral-300 bg-neutral-100 text-left text-[9px] uppercase tracking-wide text-neutral-600",
    sign: "mt-6",
    notePad: "px-3 py-2",
    declPad: "px-3 py-1.5",
    logo: "h-10 w-auto object-contain",
    ink: PLAIN_INK,
    band: false,
  },
};

/** The page's paper, where it isn't the print layout's A4 (src/app/(print)/layout.tsx). */
export const PAPER_RULES: Record<PrintPaper, string | null> = { A4: null, Letter: "@page { size: letter; margin: 10mm; }" };

// ─── A preview's options, in its address ─────────────────────────────────────────────────────────

/** An unsaved template's options as the print page's `?draft=`: base64url of their JSON. */
export function encodePrintDraft(options: PrintOptions): string {
  const bytes = new TextEncoder().encode(JSON.stringify(options));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The longest `?draft=` the print page reads — far more than the longest options, far less than a request line may be. */
export const PRINT_DRAFT_MAX = 16_000;

/** `?draft=` back into options, checked by the same schema a save is — or null for anything else. */
export function decodePrintDraft(raw: string | undefined): PrintOptions | null {
  if (!raw || raw.length > PRINT_DRAFT_MAX || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const binary = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    const parsed = printOptionsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
