"use server";

import { notMigratedYet } from "@/lib/not-migrated";
import type { Prisma, TradeDocumentStatus, TradeDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { workspacePack } from "@/lib/country-pack";
import { RAISED_IN_DESKZO } from "@/lib/documents/imported";
import { docTypeIn } from "@/lib/trade-documents";
import { bookingRate } from "@/lib/ledger/posting";
import { buildVatReturn, vatPeriod, vatReturnRows, type VatRelief, type VatReturn, type VatReturnDocument } from "@/lib/vat/return";
import { emirateOf, type Emirate } from "@/lib/vat/rules";
import { lineTaxCategories } from "@/lib/vat/lines";
import type { ActionResult } from "@/actions/company";

/**
 * Accounting › VAT Return (owner, 31 Oct 2026 — src/lib/vat/return.ts): the UAE's VAT 201 for a quarter or a month,
 * from the issued invoices, credit and debit notes and bills raised in Deskzo, and the vendor credits that carry VAT.
 * Whoever manages payments reads it, as they read India's GST returns. Nothing is stored: the return is derived from
 * the documents each time, as GST's are.
 *
 * Amounts are in the workspace's currency (AED), each document converted at its own rate, as its entry booked it.
 * A sale's emirate is its branch's (or, without an address of its own, the organisation's).
 */

const RETURN_TYPES: TradeDocumentType[] = ["INVOICE", "CREDIT_NOTE", "DEBIT_NOTE", "BILL"];
const NOT_COUNTED: TradeDocumentStatus[] = ["DRAFT", "CANCELLED", "EXPIRED", "REJECTED"];
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type VatReturnView = { period: { key: string; from: string; to: string; label: string }; vat: VatReturn; csv: string };

export async function getVatReturn(periodKey: string): Promise<ActionResult<VatReturnView>> {
  const user = await requireModuleAccess("accounting");
  if (!(await hasEffectivePermission(user.id, "payments.manage"))) return { ok: false, error: "The VAT return needs the right to manage payments." };
  if (workspacePack().country !== "AE") return { ok: false, error: "The VAT 201 return is for a UAE workspace." };
  const period = vatPeriod(periodKey);
  if (!period) return { ok: false, error: "Pick a quarter or a month." };
  const from = new Date(`${period.from}T00:00:00Z`);
  const before = new Date(new Date(`${period.to}T00:00:00Z`).getTime() + 86_400_000);

  const docSelect = {
    id: true,
    docNumber: true,
    docType: true,
    reverseCharge: true,
    currency: true,
    company: { select: { locations: { where: { isPrimary: true }, take: 1, select: { country: true } } } },
    exchangeRate: true,
    branchId: true,
    shippingCharge: true,
    shippingTaxRatePercent: true,
    lines: { select: { id: true, taxRatePercent: true, taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true, item: { select: { type: true } } } },
  } satisfies Prisma.TradeDocumentSelect;
  const [documents, credits, branches, org] = await Promise.all([
    db.tradeDocument.findMany({
      where: { docType: docTypeIn(RETURN_TYPES), status: { notIn: NOT_COUNTED }, issueDate: { gte: from, lt: before }, ...RAISED_IN_DESKZO },
      select: docSelect,
      orderBy: { issueDate: "asc" },
    }),
    db.vendorCredit.findMany({
      where: { cancelledAt: null, date: { gte: from, lt: before }, OR: [{ igstAmount: { gt: 0 } }, { cgstAmount: { gt: 0 } }, { sgstAmount: { gt: 0 } }] },
      select: { id: true, reference: true, taxableAmount: true, cgstAmount: true, sgstAmount: true, igstAmount: true },
    }),
    db.branch.findMany({ select: { id: true, state: true, addressLine1: true, isHeadOffice: true } }),
    db.organisationSettings.findUnique({ where: { id: "global" }, select: { state: true } }),
  ]);
  const categories = await lineTaxCategories(documents.map((d) => d.id));

  // The emirate a branch reports under: its own address's, else the organisation's.
  const orgEmirate = emirateOf(org?.state);
  const emirateByBranch = new Map<string, Emirate | null>(branches.map((b) => [b.id, b.addressLine1?.trim() ? emirateOf(b.state) : orgEmirate]));
  const headOffice = branches.find((b) => b.isHeadOffice);

  const rows: VatReturnDocument[] = documents.map((d) => {
    const rate = bookingRate(d);
    const aed = (v: unknown) => round2(Number(v) * rate);
    const sales = d.docType !== "BILL";
    const lines = d.lines.map((l) => ({
      category: categories.get(l.id) ?? null,
      rate: Number(l.taxRatePercent),
      taxable: aed(l.taxableValue),
      vat: aed(Number(l.cgstAmount) + Number(l.sgstAmount) + Number(l.igstAmount)),
      goods: l.item?.type === "GOOD",
    }));
    // Freight billed on is a supply at its own rate.
    const shipping = Number(d.shippingCharge);
    if (shipping > 0) {
      const shippingRate = Number(d.shippingTaxRatePercent);
      lines.push({ category: null, rate: shippingRate, taxable: aed(shipping), vat: aed(round2((shipping * shippingRate) / 100)), goods: false });
    }
    return {
      id: d.id,
      number: d.docNumber,
      direction: sales ? "SALES" : "PURCHASE",
      sign: d.docType === "CREDIT_NOTE" ? -1 : 1,
      reverseCharge: !sales && d.reverseCharge,
      // Bought from abroad: the vendor's main address is outside the UAE (a blank country reads as the UAE's).
      fromAbroad: !sales && !!(d.company?.locations[0]?.country ?? "").trim() && !/^(united arab emirates|uae|ae)$/i.test((d.company?.locations[0]?.country ?? "").trim()),
      emirate: sales ? (emirateByBranch.get(d.branchId ?? headOffice?.id ?? "") ?? orgEmirate) : null,
      lines,
    };
  });
  // A vendor's credit note takes back VAT recovered on a bill: box 9, down. In AED, as vendor credits always are.
  for (const c of credits) {
    rows.push({
      id: c.id,
      number: c.reference,
      direction: "PURCHASE",
      sign: -1,
      reverseCharge: false,
      emirate: null,
      lines: [{ category: "STANDARD", rate: 1, taxable: Number(c.taxableAmount), vat: round2(Number(c.cgstAmount) + Number(c.sgstAmount) + Number(c.igstAmount)) }],
    });
  }

  // Bad-debt relief (src/lib/receivables/write-off.ts): the VAT on invoices written off in the period, under the emirate
  // of the branch that raised each, in AED as posted.
  let reliefs: VatRelief[] = [];
  try {
    const written = await db.invoiceWriteOff.findMany({ where: { writtenOffOn: { gte: from, lt: before }, reliefVat: { gt: 0 } }, select: { invoiceId: true, reliefVat: true, amount: true, baseAmount: true } });
    const invoices = new Map((await db.tradeDocument.findMany({ where: { id: { in: written.map((w) => w.invoiceId) } }, select: { id: true, branchId: true } })).map((d) => [d.id, d]));
    reliefs = written.map((w) => {
      const branchId = invoices.get(w.invoiceId)?.branchId ?? headOffice?.id ?? "";
      // reliefVat is in the invoice's currency; to AED at the rate its write-off was posted at.
      const rate = Number(w.amount) > 0 ? Number(w.baseAmount) / Number(w.amount) : 1;
      return { emirate: emirateByBranch.get(branchId) ?? orgEmirate, vat: round2(Number(w.reliefVat) * rate) };
    });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const vat = buildVatReturn(rows, reliefs);
  const csv = vatReturnRows(vat)
    .map((r) => r.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","))
    .join("\n");
  return { ok: true, data: { period: { key: periodKey, ...period }, vat, csv } };
}
