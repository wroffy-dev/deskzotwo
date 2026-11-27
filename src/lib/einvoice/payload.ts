/**
 * Builds the IRP (e-invoice) request body in the government's INV-01 schema.
 *
 * The field names are the portal's, not ours — they're terse and non-obvious (`AssAmt` is the
 * assessable/taxable value, `Pos` is place of supply, `Stcd` a state code), so the mapping lives
 * here alone and the rest of the app keeps its own vocabulary.
 */
import { gstNumberProblem } from "@/lib/document-numbering";
import { indiaClock } from "@/lib/time/zone";
import { uqcOfUnit } from "@/lib/uqc";

export type EInvoiceParty = {
  gstin: string | null;
  legalName: string;
  address1: string | null;
  address2?: string | null;
  city: string | null;
  pincode: string | null;
  stateCode: string | null;
  phone?: string | null;
  email?: string | null;
  /**
   * The seller's branch name, so a problem says which branch to fix — with several GSTINs, "your
   * organisation's GSTIN" no longer names one. For messages only; never sent to the IRP.
   */
  label?: string | null;
};

export type EInvoiceLine = {
  description: string;
  isService: boolean;
  hsnCode: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  grossAmount: number;
  discountAmount: number;
  taxableValue: number;
  taxRatePercent: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  lineTotal: number;
};

export type EInvoiceDocument = {
  docType: "INVOICE" | "CREDIT_NOTE" | "DEBIT_NOTE";
  docNumber: string;
  issueDate: Date;
  reverseCharge: boolean;
  placeOfSupplyCode: string | null;
  seller: EInvoiceParty;
  buyer: EInvoiceParty;
  lines: EInvoiceLine[];
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  roundOff: number;
  total: number;
  /** Set for a credit note — the invoice it reduces. */
  againstDocNumber?: string | null;
  againstDocDate?: Date | null;
  /**
   * The amounts above are in the document's own currency; `exchangeRate` brings them into rupees, which is what the IRP
   * takes (R3-02). Left out, the document is in rupees.
   */
  currency?: string;
  exchangeRate?: number;
  /** The buyer's GST treatment — an export, an SEZ unit, a deemed export — for the supply type (R3-10). */
  gstTreatment?: string | null;
  /** An export's destination as an ISO 3166 two-letter code (`ExpDtls.CntCode`), when known. */
  buyerCountryCode?: string | null;
  /** Freight, at its own rate, and its tax as the document's heads hold it over the lines' (R3-05). */
  shippingCharge?: number;
  shippingTaxRatePercent?: number;
  /** The document's withholding as stored: TCS positive, TDS negative. */
  withholdingAmount?: number;
  /** The free plus-or-minus on the total. */
  adjustment?: number;
};

/**
 * The portal wants DD/MM/YYYY, not ISO — and the Indian day, whatever zone the workspace keeps. Read
 * from the host's calendar, an invoice issued before 05:30 IST went to the IRP dated the day before on
 * a UTC server (X6).
 */
function irpDate(date: Date) {
  const { year, month, day } = indiaClock.parts(date);
  return `${String(day).padStart(2, "0")}/${String(month + 1).padStart(2, "0")}/${year}`;
}

/**
 * A phone as the IRP takes it — six to twelve digits, nothing else — or nothing, rather than a refusal
 * over an optional field. Numbers are kept with their country code ("+91 98765 43210",
 * src/lib/phone.ts); an Indian one goes as its ten digits, as the portal's own form writes it.
 */
function irpPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  return /^\d{6,12}$/.test(digits) ? digits : null;
}

const DOC_TYPE: Record<EInvoiceDocument["docType"], string> = { INVOICE: "INV", CREDIT_NOTE: "CRN", DEBIT_NOTE: "DBN" };

/**
 * The IRP's supply type. A GSTIN-less buyer can't be reported as B2B; the portal treats those as B2C.
 *
 * Security audit round three, 14 Nov 2026 (R3-10): an SEZ unit, an export and a deemed export were all sent as B2B
 * (or B2C), so the IRP had them as ordinary domestic supplies. They are SEZWP / SEZWOP and EXPWP / EXPWOP — with
 * IGST paid, or without under a LUT, told apart by whether IGST was charged — and DEXP. Standard treatment, read from
 * the document's GST treatment (the only flag Deskzo keeps; there is no separate LUT switch) — confirm with your CA.
 */
export function supplyCategory(doc: Pick<EInvoiceDocument, "buyer" | "gstTreatment" | "igstAmount">) {
  const paid = doc.igstAmount > 0;
  if (doc.gstTreatment === "OVERSEAS") return paid ? "EXPWP" : "EXPWOP";
  if (doc.gstTreatment === "SEZ") return paid ? "SEZWP" : "SEZWOP";
  if (doc.gstTreatment === "DEEMED_EXPORT") return "DEXP";
  return doc.buyer.gstin ? "B2B" : "B2C";
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

/** The SAC freight is reported under, as the returns report it (src/lib/ledger/gst-returns.ts). */
const FREIGHT_SAC = "996511";

/**
 * The document as the IRP takes it — in rupees, with its freight as an item and its other charges and round-off
 * apart, so the totals add up the way the portal checks them.
 *
 *   · R3-02: every amount at the document's own rate (the ledger's `bookingRate`). A USD 10,000 invoice went to the
 *     IRP as ₹10,000. The foreign total goes as `TotInvValFc`, and an export carries its currency and country.
 *   · R3-05: freight is an item of its own (SAC 996511, at its own rate); TCS and a positive adjustment are "other
 *     charges", a negative adjustment a discount on the invoice, and TDS — which isn't part of what was supplied — is
 *     added back, so `TotInvVal` = assessable value + tax + other charges − discount + round-off, exactly.
 */
function inRupees(doc: EInvoiceDocument) {
  const rate = doc.exchangeRate && doc.exchangeRate > 0 ? doc.exchangeRate : 1;
  const inr = (v: number) => (rate === 1 ? r2(v) : r2(v * rate));
  const items = doc.lines.map((line) => {
    const gross = inr(line.grossAmount);
    const discount = inr(line.discountAmount);
    // Converted as a pair, so gross less discount is still exactly the assessable value.
    const assessable = rate === 1 ? r2(line.taxableValue) : r2(gross - discount);
    const cgst = inr(line.cgstAmount);
    const sgst = inr(line.sgstAmount);
    const igst = inr(line.igstAmount);
    const total = rate === 1 ? line.lineTotal : r2(assessable + cgst + sgst + igst);
    return { line, unitPrice: rate === 1 ? line.unitPrice : r3(line.unitPrice * rate), gross, discount, assessable, cgst, sgst, igst, total };
  });
  const freight = doc.shippingCharge ?? 0;
  if (freight > 0) {
    const head = (pick: (l: EInvoiceLine) => number, docValue: number) => Math.max(0, r2(docValue - doc.lines.reduce((t, l) => t + pick(l), 0)));
    const cgst = inr(head((l) => l.cgstAmount, doc.cgstAmount));
    const sgst = inr(head((l) => l.sgstAmount, doc.sgstAmount));
    const igst = inr(head((l) => l.igstAmount, doc.igstAmount));
    const value = inr(freight);
    items.push({
      line: {
        description: "Freight",
        isService: true,
        hsnCode: FREIGHT_SAC,
        quantity: 1,
        unit: null,
        unitPrice: freight,
        grossAmount: freight,
        discountAmount: 0,
        taxableValue: freight,
        taxRatePercent: doc.shippingTaxRatePercent ?? 0,
        cgstAmount: cgst,
        sgstAmount: sgst,
        igstAmount: igst,
        lineTotal: 0,
      },
      unitPrice: value,
      gross: value,
      discount: 0,
      assessable: value,
      cgst,
      sgst,
      igst,
      total: r2(value + cgst + sgst + igst),
    });
  }
  const sum = (pick: (i: (typeof items)[number]) => number) => r2(items.reduce((t, i) => t + pick(i), 0));
  const withholding = doc.withholdingAmount ?? 0;
  const adjustment = doc.adjustment ?? 0;
  const otherCharges = inr(Math.max(0, withholding) + Math.max(0, adjustment));
  const invoiceDiscount = inr(Math.max(0, -adjustment));
  const roundOff = inr(doc.roundOff);
  const assessable = sum((i) => i.assessable);
  const cgst = sum((i) => i.cgst);
  const sgst = sum((i) => i.sgst);
  const igst = sum((i) => i.igst);
  const total = r2(assessable + cgst + sgst + igst + otherCharges - invoiceDiscount + roundOff);
  // The foreign figure as the document states it, TDS added back as it is above.
  const foreignTotal = r2(doc.total - Math.min(0, withholding));
  return { rate, items, assessable, cgst, sgst, igst, otherCharges, invoiceDiscount, roundOff, total, foreignTotal };
}

/** The payload's total in rupees — what the IRP will hold as `TotInvVal`. */
export function eInvoiceValue(doc: EInvoiceDocument): number {
  return inRupees(doc).total;
}

export function buildEInvoicePayload(doc: EInvoiceDocument) {
  const v = inRupees(doc);
  const supply = supplyCategory(doc);
  const exporting = supply === "EXPWP" || supply === "EXPWOP";
  const foreign = !!doc.currency && doc.currency !== "INR" && v.rate !== 1;
  return {
    Version: "1.1",
    TranDtls: {
      TaxSch: "GST",
      SupTyp: supply,
      RegRev: doc.reverseCharge ? "Y" : "N",
      IgstOnIntra: "N",
    },
    DocDtls: {
      Typ: DOC_TYPE[doc.docType],
      No: doc.docNumber,
      Dt: irpDate(doc.issueDate),
    },
    // No DispDtls: the goods leave from the seller's own address — CA question C10.
    SellerDtls: {
      Gstin: doc.seller.gstin ?? "",
      LglNm: doc.seller.legalName,
      Addr1: doc.seller.address1 ?? "",
      ...(doc.seller.address2 ? { Addr2: doc.seller.address2 } : {}),
      Loc: doc.seller.city ?? "",
      Pin: Number(doc.seller.pincode ?? 0),
      Stcd: doc.seller.stateCode ?? "",
      ...(irpPhone(doc.seller.phone) ? { Ph: irpPhone(doc.seller.phone) } : {}),
      ...(doc.seller.email ? { Em: doc.seller.email } : {}),
    },
    // An export's buyer is URP, in state 96 ("Other Country"), PIN 999999 — as NIC's schema asks of a buyer abroad.
    BuyerDtls: {
      // The portal expects the literal "URP" (unregistered person) rather than a blank GSTIN.
      Gstin: exporting ? "URP" : (doc.buyer.gstin ?? "URP"),
      LglNm: doc.buyer.legalName,
      Pos: exporting ? "96" : (doc.placeOfSupplyCode ?? doc.buyer.stateCode ?? ""),
      Addr1: doc.buyer.address1 ?? "",
      ...(doc.buyer.address2 ? { Addr2: doc.buyer.address2 } : {}),
      Loc: doc.buyer.city ?? "",
      Pin: exporting ? 999999 : Number(doc.buyer.pincode ?? 0),
      Stcd: exporting ? "96" : (doc.buyer.stateCode ?? ""),
    },
    ...(doc.againstDocNumber
      ? {
          RefDtls: {
            PrecDocDtls: [
              {
                InvNo: doc.againstDocNumber,
                InvDt: irpDate(doc.againstDocDate ?? doc.issueDate),
              },
            ],
          },
        }
      : {}),
    ItemList: v.items.map((item, index) => ({
      SlNo: String(index + 1),
      PrdDesc: item.line.description.slice(0, 300),
      IsServc: item.line.isService ? "Y" : "N",
      HsnCd: item.line.hsnCode ?? "",
      Qty: item.line.quantity,
      // A portal unit code: "Piece" is PCS, not its first three letters; a unit naming none is OTH.
      Unit: uqcOfUnit(item.line.unit) ?? "OTH",
      UnitPrice: item.unitPrice,
      TotAmt: item.gross,
      Discount: item.discount,
      AssAmt: item.assessable,
      GstRt: item.line.taxRatePercent,
      IgstAmt: item.igst,
      CgstAmt: item.cgst,
      SgstAmt: item.sgst,
      TotItemVal: item.total,
    })),
    ValDtls: {
      AssVal: v.assessable,
      CgstVal: v.cgst,
      SgstVal: v.sgst,
      IgstVal: v.igst,
      ...(v.invoiceDiscount ? { Discount: v.invoiceDiscount } : {}),
      ...(v.otherCharges ? { OthChrg: v.otherCharges } : {}),
      RndOffAmt: v.roundOff,
      TotInvVal: v.total,
      ...(foreign ? { TotInvValFc: v.foreignTotal } : {}),
    },
    // An export's details: its currency and destination. The shipping bill and port aren't kept in Deskzo, so they
    // are left for the person filing to add on the portal (it takes them later, as the shipping bill is often later).
    ...(exporting
      ? {
          ExpDtls: {
            ...(doc.currency ? { ForCur: doc.currency } : {}),
            ...(doc.buyerCountryCode ? { CntCode: doc.buyerCountryCode.toUpperCase() } : {}),
          },
        }
      : {}),
  };
}

/**
 * Checks the document carries everything the portal will insist on, so a user sees one clear list
 * of what's missing instead of a cryptic rejection code from the IRP.
 */
export function validateForEInvoice(doc: EInvoiceDocument): string[] {
  const problems: string[] = [];
  // Named by branch when the caller says which one — each has its own GSTIN, state and address.
  const branch = doc.seller.label?.trim();
  if (!doc.seller.gstin) {
    problems.push(
      branch
        ? `The GSTIN of branch ${branch} isn't set (Settings → Branches & GST registrations).`
        : "Your organisation's GSTIN isn't set (Settings → Organisation).",
    );
  }
  if (!doc.seller.stateCode) {
    problems.push(
      branch
        ? `The state code of branch ${branch} isn't set (Settings → Branches & GST registrations).`
        : "Your organisation's state code isn't set.",
    );
  }
  if (!doc.seller.address1 || !doc.seller.city || !doc.seller.pincode) {
    problems.push(
      branch
        ? `The address of branch ${branch} is incomplete (address, city and PIN are required).`
        : "Your organisation's registered address is incomplete.",
    );
  }
  // The IRP refuses a number over 16 characters or of the wrong shape, and says so only as a code.
  const numberProblem = gstNumberProblem(doc.docType, doc.docNumber);
  if (numberProblem) problems.push(numberProblem);
  if (!doc.buyer.legalName) problems.push("The customer has no legal name.");
  if (!doc.buyer.address1 || !doc.buyer.city || !doc.buyer.pincode) {
    problems.push("The customer's billing address is incomplete (address, city and PIN are required).");
  }
  if (!doc.buyer.stateCode) problems.push("The customer's state code is missing — set a GSTIN or state on their location.");
  if (doc.lines.length === 0) problems.push("The document has no line items.");
  const missingHsn = doc.lines.filter((l) => !l.hsnCode).length;
  if (missingHsn > 0) problems.push(`${missingHsn} line(s) have no HSN/SAC code.`);
  if (doc.total <= 0) problems.push("The document total must be greater than zero.");
  return problems;
}
