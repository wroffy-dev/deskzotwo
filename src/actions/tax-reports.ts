"use server";

import { NoAccessError } from "@/lib/no-access";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { hasEffectivePermission } from "@/actions/permission";
import { can } from "@/lib/authz/resolve";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { buildCashFlow, type AccountMovement } from "@/lib/ledger/cashflow";
import { buildGstr1, buildGstr3b, buildTdsSummary, returnFigures, type ReturnDocument } from "@/lib/ledger/gst-returns";
import { bookingRate } from "@/lib/ledger/posting";
import { gstr1Json, gstr3bJson, returnPeriod } from "@/lib/ledger/gstn-json";
import { profitAndLoss } from "@/actions/ledger-reports";
import { indiaClock } from "@/lib/time/zone";
import { listRegistrationChoices } from "@/lib/branches/identity";
import { knownHsnCodes } from "@/lib/platform/hsn-directory";
import { normaliseHsn } from "@/lib/items/catalogue-import";
import { RAISED_IN_DESKZO } from "@/lib/documents/imported";
import type { RegistrationChoice } from "@/lib/branches/format";
import { docTypeIn } from "@/lib/trade-documents";

/**
 * The statutory returns and the cash flow statement.
 *
 * All read-only, all built from documents and the ledger that are already there — nothing here
 * stores a return. A filed return is a statement made to the government on a day; re-deriving it
 * from the same documents gives the same answer, and storing a copy would only create a second
 * version to disagree with.
 */

async function requireAccounts() {
  const user = await requireModuleAccess("accounting");
  const allowed = await hasEffectivePermission(user.id, "payments.manage");
  return { user, allowed };
}

/**
 * A return month, in India: from midnight IST on the 1st up to — not including — midnight IST on the
 * 1st of the next month. Queries use `gte: from, lt: before`. India's in every workspace: the law fixes
 * a return's month to India time.
 *
 * It used to be the UTC month, inclusive, so a document issued between 00:00 and 05:30 IST on the 1st
 * landed in the previous month's return (X4). Past months' figures change with the fix, because those
 * were the wrong ones. `to` — the month's last millisecond — is only for the pages' labels.
 */
function monthBounds(month: number, year: number) {
  const from = indiaClock.midnight(year, month - 1, 1);
  // `month` is 1-based and midnight's is 0-based, so this is the next month; December carries into January.
  const before = indiaClock.midnight(year, month, 1);
  return { from, before, to: new Date(before.getTime() - 1) };
}

/** The GSTIN a return is filed for, as the pages show it. */
type ReturnRegistration = { id: string; gstin: string; stateCode: string; code: string };

/**
 * Which registration's return to build: the one asked for, else the head office's, else the first
 * there is. Null only when there is no registration to file for — then the return is unfiltered, as it
 * was before registrations existed.
 *
 * Reads through `listRegistrationChoices`, so an inactive registration still has its returns while
 * anything names it: a return for a GSTIN surrendered last month is still due.
 */
async function returnRegistration(requested: string | undefined): Promise<ReturnRegistration | null> {
  const choices = await listRegistrationChoices();
  const chosen =
    (requested ? choices.find((c) => c.id === requested) : undefined) ?? choices.find((c) => c.isHeadOffice) ?? choices[0];
  return chosen ? { id: chosen.id, gstin: chosen.gstin, stateCode: chosen.stateCode, code: chosen.code } : null;
}

/** The registrations there are returns for, for the page's picker: the active ones, and any still referenced. */
export async function listReturnRegistrations(): Promise<RegistrationChoice[]> {
  const { allowed } = await requireAccounts();
  if (!allowed) return [];
  return listRegistrationChoices();
}

const documentSelect = {
  docNumber: true,
  docType: true,
  issueDate: true,
  status: true,
  placeOfSupplyCode: true,
  gstTreatment: true,
  reverseCharge: true,
  taxableValue: true,
  cgstAmount: true,
  sgstAmount: true,
  igstAmount: true,
  withholdingAmount: true,
  total: true,
  // R3-02 and R3-05: the rate a foreign document is converted at, and its freight.
  currency: true,
  exchangeRate: true,
  shippingCharge: true,
  shippingTaxRatePercent: true,
  /**
   * The party's GSTIN as it was on the document, not as the company record reads today.
   *
   * A return is a statement about what was supplied on a date, and the customer's registration can
   * change afterwards — filing this month's return with next year's GSTIN would break the match
   * against the buyer's own credit. On a sale the party is the buyer; on a purchase it is the seller,
   * and `buyerGstin` is ours (X1 — see `toReturnDocument`).
   */
  direction: true,
  buyerGstin: true,
  sellerGstin: true,
  company: { select: { name: true, panNumber: true } },
  lines: {
    select: {
      hsnCode: true,
      name: true,
      unit: true,
      quantity: true,
      taxableValue: true,
      taxRatePercent: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
    },
  },
} satisfies Prisma.TradeDocumentSelect;

type RawDoc = {
  docNumber: string;
  docType: string;
  issueDate: Date;
  status: string;
  placeOfSupplyCode: string | null;
  gstTreatment?: string;
  reverseCharge?: boolean;
  direction: string;
  buyerGstin: string | null;
  sellerGstin: string | null;
  taxableValue: unknown;
  cgstAmount: unknown;
  sgstAmount: unknown;
  igstAmount: unknown;
  total: unknown;
  currency: string;
  exchangeRate: unknown;
  shippingCharge: unknown;
  shippingTaxRatePercent: unknown;
  company: { name: string; panNumber: string | null };
  lines: {
    hsnCode: string | null;
    name: string;
    unit: string | null;
    quantity: unknown;
    taxableValue: unknown;
    taxRatePercent: unknown;
    cgstAmount: unknown;
    sgstAmount: unknown;
    igstAmount: unknown;
  }[];
};

/**
 * A stored document as the returns read it — in rupees at its own rate, its freight as a line (security audit round
 * three, 14 Nov 2026, R3-02 and R3-05: `returnFigures` in src/lib/ledger/gst-returns.ts).
 */
function toReturnDocument(d: RawDoc): ReturnDocument {
  return returnFigures(asStated(d), bookingRate(d));
}

function asStated(d: RawDoc) {
  return {
    docNumber: d.docNumber,
    docType: d.docType as ReturnDocument["docType"],
    issueDate: d.issueDate,
    status: d.status,
    partyName: d.company.name,
    // A purchase records the vendor as the seller and us as the buyer; before branches it kept the
    // vendor's GSTIN in `buyerGstin`, and the migration moved it (X1).
    partyGstin: d.direction === "PURCHASE" ? d.sellerGstin : d.buyerGstin,
    placeOfSupplyCode: d.placeOfSupplyCode,
    gstTreatment: d.gstTreatment,
    reverseCharge: d.reverseCharge,
    taxableValue: Number(d.taxableValue),
    cgstAmount: Number(d.cgstAmount),
    sgstAmount: Number(d.sgstAmount),
    igstAmount: Number(d.igstAmount),
    total: Number(d.total),
    shippingCharge: Number(d.shippingCharge ?? 0),
    shippingTaxRatePercent: Number(d.shippingTaxRatePercent ?? 0),
    lines: d.lines.map((l) => ({
      hsnCode: l.hsnCode,
      name: l.name,
      unit: l.unit,
      quantity: Number(l.quantity),
      taxableValue: Number(l.taxableValue),
      taxRatePercent: Number(l.taxRatePercent),
      cgstAmount: Number(l.cgstAmount),
      sgstAmount: Number(l.sgstAmount),
      igstAmount: Number(l.igstAmount),
    })),
  };
}

// ─── GSTR-1 ───────────────────────────────────────────────────────────────────

/**
 * GSTR-1 for one registration — a return is filed per GSTIN, never for the company (spec §8.4).
 * `gstRegistrationId` defaults to the head office's; see `returnRegistration`.
 */
export async function gstr1(params: { month: number; year: number; gstRegistrationId?: string }) {
  const { allowed } = await requireAccounts();
  if (!allowed) return null;

  const { from, to } = monthBounds(params.month, params.year);
  const { registration, docs, options } = await gstr1Documents(params);
  return toPlain({
    month: params.month,
    year: params.year,
    from,
    to,
    registration,
    ...buildGstr1(docs, options),
  });
}

/** GSTR-1's month of documents for one registration, cancelled ones too, and the HSN directory's names for its codes. */
async function gstr1Documents(params: { month: number; year: number; gstRegistrationId?: string }) {
  const { from, before } = monthBounds(params.month, params.year);
  const registration = await returnRegistration(params.gstRegistrationId);
  const docs = await db.tradeDocument.findMany({
    where: {
      docType: docTypeIn(["INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"]),
      issueDate: { gte: from, lt: before },
      // A document brought from the old system was reported from there (src/lib/documents/imported.ts).
      ...RAISED_IN_DESKZO,
      ...(registration ? { gstRegistrationId: registration.id } : {}),
    },
    orderBy: { issueDate: "asc" },
    select: documentSelect,
  });

  // The directory names each HSN row and catches a code the portal won't take; without one, neither.
  const codes = docs.flatMap((d) => d.lines.map((l) => normaliseHsn(l.hsnCode))).filter(Boolean);
  const directory = await knownHsnCodes(codes);
  // Many eight-digit leaves are just "OTHER"; their heading is what says what they are.
  const named = new Map(
    [...directory.found].map(([code, o]) => [code, { description: /^others?\W*$/i.test(o.description) && o.heading ? `Other — ${o.heading}` : o.description }]),
  );

  return {
    registration,
    docs: docs.map((d) => toReturnDocument(d as unknown as RawDoc)),
    options: directory.checked ? { directory: named } : {},
  };
}

/** A return's JSON for the GST portal's "Upload JSON" (src/lib/ledger/gstn-json.ts), with the name the offline tool gives it. */
export type PortalFile = { ok: true; filename: string; json: string } | { ok: false; error: string };

const NO_REGISTRATION = "Add your GSTIN under Settings → Organisation or Settings → Branches & GST registrations — the file is made for one.";

export async function gstr1PortalFile(params: { month: number; year: number; gstRegistrationId?: string }): Promise<PortalFile> {
  const { allowed } = await requireAccounts();
  if (!allowed) return { ok: false, error: "GST returns need the right to manage finance records." };
  const { registration, docs, options } = await gstr1Documents(params);
  if (!registration) return { ok: false, error: NO_REGISTRATION };
  const file = gstr1Json(docs, registration, params.month, params.year, buildGstr1(docs, options).hsn);
  return { ok: true, filename: `GSTR1_${registration.gstin}_${returnPeriod(params.month, params.year)}.json`, json: JSON.stringify(file) };
}

export async function gstr3bPortalFile(params: { month: number; year: number; gstRegistrationId?: string }): Promise<PortalFile> {
  const { allowed } = await requireAccounts();
  if (!allowed) return { ok: false, error: "GST returns need the right to manage finance records." };
  const { registration, outward, inward, ledger } = await gstr3bDocuments(params);
  if (!registration) return { ok: false, error: NO_REGISTRATION };
  const g = buildGstr3b({ outwardDocs: outward, inwardDocs: inward, ledger });
  const file = gstr3bJson(g, outward, inward, registration, params.month, params.year);
  return { ok: true, filename: `GSTR3B_${registration.gstin}_${returnPeriod(params.month, params.year)}.json`, json: JSON.stringify(file) };
}

// ─── GSTR-3B ──────────────────────────────────────────────────────────────────

/**
 * GSTR-3B for one registration: its outward supplies, the credit on bills raised to it, and its own
 * GST lines in the ledger to check both against. Defaults as `gstr1` does.
 */
export async function gstr3b(params: { month: number; year: number; gstRegistrationId?: string }) {
  const { allowed } = await requireAccounts();
  if (!allowed) return null;

  const { from, to } = monthBounds(params.month, params.year);
  const { registration, outward, inward, ledger } = await gstr3bDocuments(params);
  return toPlain({
    month: params.month,
    year: params.year,
    from,
    to,
    registration,
    ...buildGstr3b({ outwardDocs: outward, inwardDocs: inward, ledger }),
  });
}

/** GSTR-3B's month for one registration: sales documents, bills and vendor credits with tax, and the ledger's GST. */
async function gstr3bDocuments(params: { month: number; year: number; gstRegistrationId?: string }) {
  const { from, before } = monthBounds(params.month, params.year);
  const registration = await returnRegistration(params.gstRegistrationId);
  const ofRegistration = registration ? { gstRegistrationId: registration.id } : {};
  const [outward, inward, ledger] = await Promise.all([
    db.tradeDocument.findMany({
      where: { docType: docTypeIn(["INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"]), issueDate: { gte: from, lt: before }, ...RAISED_IN_DESKZO, ...ofRegistration },
      select: documentSelect,
    }),
    db.tradeDocument.findMany({
      where: { docType: "BILL", issueDate: { gte: from, lt: before }, ...RAISED_IN_DESKZO, ...ofRegistration },
      select: documentSelect,
    }),
    ledgerTaxTotals(from, before, registration?.id ?? null),
  ]);
  const vendorCredits = await vendorCreditNotesWithTax(from, before, registration?.id ?? null);

  return {
    registration,
    outward: outward.map((d) => toReturnDocument(d as unknown as RawDoc)),
    inward: [...inward.map((d) => toReturnDocument(d as unknown as RawDoc)), ...vendorCredits] as ReturnDocument[],
    ledger,
  };
}

/**
 * A distributor's or an OEM's credits that carry GST (src/actions/vendor-credit.ts), as inward credit
 * notes: each reverses input tax taken on the purchase, so the credit claimed goes down by it. Without
 * them the bills alone set the credit and the reversal in the ledger was ignored. A payout with GST
 * reverses it as a credit note does — its posting credits the same input-tax accounts — so both forms
 * count. Their posting is the head office's, so they count in its registration's return only.
 */
async function vendorCreditNotesWithTax(from: Date, before: Date, registrationId: string | null) {
  if (registrationId) {
    const head = await db.branch.findFirst({ where: { isHeadOffice: true }, select: { gstRegistrationId: true } });
    if (head?.gstRegistrationId && head.gstRegistrationId !== registrationId) return [];
  }
  const credits = await db.vendorCredit.findMany({
    where: {
      cancelledAt: null,
      date: { gte: from, lt: before },
      OR: [{ cgstAmount: { gt: 0 } }, { sgstAmount: { gt: 0 } }, { igstAmount: { gt: 0 } }],
    },
    select: { reference: true, date: true, taxableAmount: true, cgstAmount: true, sgstAmount: true, igstAmount: true, total: true, vendor: { select: { name: true } } },
  });
  return credits.map((c) => ({
    docNumber: c.reference,
    docType: "CREDIT_NOTE" as const,
    issueDate: c.date,
    status: "ISSUED",
    partyName: c.vendor.name,
    partyGstin: null,
    placeOfSupplyCode: null,
    taxableValue: Number(c.taxableAmount),
    cgstAmount: Number(c.cgstAmount),
    sgstAmount: Number(c.sgstAmount),
    igstAmount: Number(c.igstAmount),
    total: Number(c.total),
    lines: [],
  }));
}

/**
 * What the ledger's own GST accounts moved by over the period.
 *
 * This is what makes the 3B checkable. A return built only from documents can be internally perfect
 * and still disagree with the books — an expense claim carrying input tax, a manual journal on a GST
 * account, an invoice that never posted. Filing a figure the ledger cannot support is precisely what
 * an audit looks for.
 *
 * With a registration, only the lines tagged with it: the GST accounts are shared by every GSTIN of the
 * company (one set of books), and the tag is what says whose return a line belongs to. `before` is
 * exclusive, as in `monthBounds`.
 */
async function ledgerTaxTotals(from: Date, before: Date, gstRegistrationId: string | null) {
  const accounts = await db.ledgerAccount.findMany({
    where: {
      systemKey: {
        in: [
          SYSTEM_ACCOUNTS.OUTPUT_CGST,
          SYSTEM_ACCOUNTS.OUTPUT_SGST,
          SYSTEM_ACCOUNTS.OUTPUT_IGST,
          SYSTEM_ACCOUNTS.INPUT_CGST,
          SYSTEM_ACCOUNTS.INPUT_SGST,
          SYSTEM_ACCOUNTS.INPUT_IGST,
        ],
      },
    },
    select: { id: true, systemKey: true },
  });
  if (accounts.length === 0) return null;

  const sums = await db.journalLine.groupBy({
    by: ["accountId"],
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      entry: { date: { gte: from, lt: before } },
      ...(gstRegistrationId ? { gstRegistrationId } : {}),
    },
    _sum: { debit: true, credit: true },
  });

  const value = (key: string, natural: "debit" | "credit") => {
    const account = accounts.find((a) => a.systemKey === key);
    if (!account) return 0;
    const row = sums.find((s) => s.accountId === account.id);
    const debit = Number(row?._sum.debit ?? 0);
    const credit = Number(row?._sum.credit ?? 0);
    return Math.round((natural === "credit" ? credit - debit : debit - credit) * 100) / 100;
  };

  return {
    // Output tax is collected, so it sits on the credit side; input tax is reclaimable, so debit.
    outputCgst: value(SYSTEM_ACCOUNTS.OUTPUT_CGST, "credit"),
    outputSgst: value(SYSTEM_ACCOUNTS.OUTPUT_SGST, "credit"),
    outputIgst: value(SYSTEM_ACCOUNTS.OUTPUT_IGST, "credit"),
    inputCgst: value(SYSTEM_ACCOUNTS.INPUT_CGST, "debit"),
    inputSgst: value(SYSTEM_ACCOUNTS.INPUT_SGST, "debit"),
    inputIgst: value(SYSTEM_ACCOUNTS.INPUT_IGST, "debit"),
  };
}

// ─── TDS ──────────────────────────────────────────────────────────────────────

export async function tdsSummary(params: { month: number; year: number }) {
  const { allowed } = await requireAccounts();
  if (!allowed) return null;

  // Not a GST return: TDS is accounted for under a TAN, not per GSTIN, so this stays company-wide.
  const { from, before, to } = monthBounds(params.month, params.year);
  const docs = await db.tradeDocument.findMany({
    where: {
      docType: docTypeIn(["INVOICE", "DEBIT_NOTE", "BILL"]),
      issueDate: { gte: from, lt: before },
      ...RAISED_IN_DESKZO,
      withholdingAmount: { not: 0 },
    },
    select: { ...documentSelect, withholdingAmount: true, withholdingSection: true },
  });

  const withholdings = docs
    .filter((d) => d.status !== "DRAFT" && d.status !== "CANCELLED")
    .map((d) => ({
      docNumber: d.docNumber,
      issueDate: d.issueDate,
      partyName: d.company.name,
      partyPan: d.company.panNumber,
      section: d.withholdingSection,
      // In rupees, as the returns are (R3-02).
      taxableValue: Math.round(Number(d.taxableValue) * bookingRate(d) * 100) / 100,
      withholdingAmount: Math.round(Number(d.withholdingAmount) * bookingRate(d) * 100) / 100,
      isPurchase: d.docType === "BILL",
    }));

  return toPlain({
    month: params.month,
    year: params.year,
    from,
    to,
    ...buildTdsSummary({
      docs: docs.map((d) => toReturnDocument(d as unknown as RawDoc)),
      withholdings,
      month: params.month,
      year: params.year,
    }),
  });
}

// ─── Cash flow ────────────────────────────────────────────────────────────────

/**
 * The cash flow statement for a period.
 *
 * Movements are read per account rather than per section, so the classification lives in one pure
 * function that can be checked — see src/lib/ledger/cashflow.ts.
 */
export async function cashFlow(params: { from: string; to: string }) {
  const user = await requireModuleAccess("accounting");
  // The page checks this too, but a server action can be called without its page: the books are
  // `ledger.viewReports`, as everywhere else in src/actions/ledger-reports.ts.
  if (!(await can(user.id, "ledger.viewReports"))) throw new NoAccessError("You don't have permission to see the books.");
  // Indian days, as the returns' months are — not UTC days, which began and ended at 05:30 IST, nor the
  // workspace's: the books keep India's calendar.
  const from = indiaClock.startOfDay(params.from) ?? new Date(NaN);
  const toNext = indiaClock.endOfDay(params.to);
  const to = toNext ? new Date(toNext.getTime() - 1) : new Date(NaN);

  const accounts = await db.ledgerAccount.findMany({
    where: { isGroup: false },
    select: { id: true, code: true, name: true, type: true, systemKey: true },
  });

  const [openingSums, periodSums, pl, depreciation] = await Promise.all([
    db.journalLine.groupBy({
      by: ["accountId"],
      where: { entry: { date: { lt: from } } },
      _sum: { debit: true, credit: true },
    }),
    db.journalLine.groupBy({
      by: ["accountId"],
      where: { entry: { date: { gte: from, lte: to } } },
      _sum: { debit: true, credit: true },
    }),
    profitAndLoss({ from: params.from, to: params.to }),
    // `toDate` is a `@db.Date`, which compares by the bound's UTC date — and India's midnight on the
    // first day is the previous day in UTC, so the instants above pulled in the charge for the month
    // before the window. Compared as the calendar days asked for instead.
    db.depreciationCharge.aggregate({
      where: { toDate: { gte: new Date(`${params.from}T00:00:00.000Z`), lte: new Date(`${params.to}T00:00:00.000Z`) } },
      _sum: { amount: true },
    }),
  ]);

  const movements: AccountMovement[] = accounts.map((a) => {
    const natural = a.type === "ASSET" || a.type === "EXPENSE" ? 1 : -1;
    const at = (rows: typeof openingSums) => {
      const row = rows.find((r) => r.accountId === a.id);
      const debit = Number(row?._sum.debit ?? 0);
      const credit = Number(row?._sum.credit ?? 0);
      return Math.round((debit - credit) * natural * 100) / 100;
    };
    const opening = at(openingSums);
    const movement = at(periodSums);
    return {
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      systemKey: a.systemKey,
      opening,
      movement,
      closing: Math.round((opening + movement) * 100) / 100,
    };
  });

  return toPlain(
    buildCashFlow({
      from,
      to,
      netProfit: pl.netProfit,
      movements,
      depreciationCharged: Number(depreciation._sum.amount ?? 0),
    }),
  );
}
