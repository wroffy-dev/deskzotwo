"use server";

import { Prisma, type TradeDocumentType } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { mayAccess } from "@/lib/authz/access";
import { can } from "@/lib/authz/resolve";
import { ensureHeadOffice } from "@/lib/branches/identity";
import { challanWords } from "@/lib/country-pack";
import { documentWriteKey, documentWriteRefusal } from "@/lib/documents/write-permission";
import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { workspaceClock } from "@/lib/time/workspace";
import { documentListPath, tradeDocumentLabels } from "@/lib/trade-documents";
import { nextDocumentNumber } from "@/lib/trade-number";
import type { ActionResult } from "@/actions/company";

/**
 * A delivery challan from a proposal, a proforma or a tax invoice (owner, 16 Nov 2026: "create delivery challan button
 * from proposal, proforma invoice and tax invoice"). The goods go in parts as often as not, so the person says how
 * many of each line go this time — what is left after earlier challans from the same document is offered — and the
 * challan is issued there and then, numbered from its branch's series, as a consignment's is (src/actions/consignment.ts).
 *
 * It carries what Rule 55 asks: the parties and their GSTINs, the place of supply, each line's HSN, quantity, taxable
 * value and tax — the source's own, in proportion to the quantity sent. It is a paper for the goods, not a sale: it
 * never posts to the books or moves stock (an invoice does that), and an e-way bill can be raised from it.
 */

/** The documents a challan can be made from. */
const FROM: readonly TradeDocumentType[] = ["PROPOSAL", "PROFORMA", "INVOICE"];

export type ChallanLine = { sortOrder: number; name: string; description: string | null; hsnCode: string | null; unit: string | null; ordered: number; sent: number; left: number };
export type ChallanSource = { documentId: string; label: string; number: string | null; customer: string; lines: ChallanLine[]; challans: { id: string; number: string | null }[] };

const n = (v: Prisma.Decimal | number | null | undefined) => Number(v ?? 0);
const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

/** The source, if this person may make a challan from it; a refusal in words otherwise. */
async function sourceFor(documentId: unknown, userId: string) {
  if (typeof documentId !== "string" || !documentId || documentId.length > 100) return { error: "That document isn't there." } as const;
  const source = await db.tradeDocument.findUnique({
    where: { id: documentId },
    include: { lines: { orderBy: { sortOrder: "asc" } }, company: { select: { name: true } } },
  });
  if (!source || !(await mayAccess(userId, "documents", "edit", documentId))) return { error: "That document isn't there." } as const;
  if (!FROM.includes(source.docType)) return { error: `A ${challanWords().one} is made from a proposal, a proforma invoice or a tax invoice.` } as const;
  if (source.status === "DRAFT") return { error: `Issue the ${tradeDocumentLabels[source.docType].toLowerCase()} first.` } as const;
  if (source.status === "CANCELLED" || source.status === "REJECTED") return { error: `A cancelled or rejected document can't have a ${challanWords().one}.` } as const;
  return { source } as const;
}

/** How much of each source line earlier challans from it (not cancelled) have carried, by the line's place. */
async function alreadySent(sourceId: string): Promise<{ sent: Map<number, number>; challans: { id: string; number: string | null }[] }> {
  const challans = await db.tradeDocument.findMany({
    where: { sourceDocumentId: sourceId, docType: "DELIVERY_CHALLAN", status: { not: "CANCELLED" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, docNumber: true, lines: { select: { sortOrder: true, quantity: true } } },
  });
  const sent = new Map<number, number>();
  for (const c of challans) for (const l of c.lines) sent.set(l.sortOrder, (sent.get(l.sortOrder) ?? 0) + n(l.quantity));
  return { sent, challans: challans.map((c) => ({ id: c.id, number: c.docNumber })) };
}

async function gate(): Promise<{ user: { id: string }; error: null } | { user: null; error: string }> {
  const user = await requireModuleUser(["sales_documents"]);
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { user: null, error: viewing };
  for (const action of ["create", "issue"] as const) {
    if (!(await can(user.id, documentWriteKey("DELIVERY_CHALLAN", action)))) return { user: null, error: documentWriteRefusal("DELIVERY_CHALLAN", action) };
  }
  return { user, error: null };
}

/** What the dialog shows: each line with what was ordered, what earlier challans carried and what is left. */
export async function deliveryChallanSource(documentId: string): Promise<ActionResult<ChallanSource>> {
  const g = await gate();
  if (g.error !== null) return { ok: false, error: g.error };
  const found = await sourceFor(documentId, g.user.id);
  if ("error" in found) return { ok: false, error: found.error! };
  const { source } = found;
  const { sent, challans } = await alreadySent(source.id);
  return {
    ok: true,
    data: {
      documentId: source.id,
      label: tradeDocumentLabels[source.docType],
      number: source.docNumber,
      customer: source.company.name,
      challans,
      lines: source.lines.map((l) => {
        const ordered = n(l.quantity);
        const carried = sent.get(l.sortOrder) ?? 0;
        return { sortOrder: l.sortOrder, name: l.name, description: l.description, hsnCode: l.hsnCode, unit: l.unit, ordered, sent: carried, left: Math.max(0, round(ordered - carried, 3)) };
      }),
    },
  };
}

/** Makes the challan, issued, for the quantities given (by each source line's place); nothing over what is left. */
export async function createDeliveryChallan(input: { documentId: string; lines: { sortOrder: number; quantity: number }[]; notes?: string }): Promise<ActionResult<{ id: string; docNumber: string | null }>> {
  const g = await gate();
  if (g.error !== null) return { ok: false, error: g.error };
  const found = await sourceFor(input?.documentId, g.user.id);
  if ("error" in found) return { ok: false, error: found.error! };
  const { source } = found;
  if (!Array.isArray(input.lines) || input.lines.length > 500) return { ok: false, error: "Those lines aren't valid." };

  const wanted = new Map<number, number>();
  for (const l of input.lines) {
    const q = Number(l?.quantity);
    if (!Number.isFinite(q) || q < 0) return { ok: false, error: "A quantity has to be a number, nought or more." };
    if (q > 0) wanted.set(Number(l.sortOrder), round(q, 3));
  }
  if (wanted.size === 0) return { ok: false, error: "Enter how many of at least one line go on this challan." };

  const { sent } = await alreadySent(source.id);
  const chosen: { line: (typeof source.lines)[number]; qty: number }[] = [];
  for (const [sortOrder, qty] of wanted) {
    const line = source.lines.find((l) => l.sortOrder === sortOrder);
    if (!line) return { ok: false, error: "One of those lines isn't on the document." };
    const left = round(n(line.quantity) - (sent.get(sortOrder) ?? 0), 3);
    if (qty > left + 1e-9) return { ok: false, error: `${line.name}: ${left} left to send, not ${qty}.` };
    chosen.push({ line, qty });
  }
  chosen.sort((a, b) => a.line.sortOrder - b.line.sortOrder);

  // Each line's value and tax in proportion to what goes: the source worked them out, and a challan shows the same.
  const lines = chosen.map(({ line, qty }) => {
    const share = n(line.quantity) > 0 ? qty / n(line.quantity) : 0;
    const scale = (v: Prisma.Decimal | null) => new Prisma.Decimal(round(n(v) * share));
    return {
      itemId: line.itemId,
      name: line.name,
      description: line.description,
      hsnCode: line.hsnCode,
      unit: line.unit,
      quantity: new Prisma.Decimal(qty),
      unitPrice: line.unitPrice,
      discountMode: line.discountMode,
      discountValue: line.discountMode === "PERCENT" ? line.discountValue : scale(line.discountValue),
      discountAmount: scale(line.discountAmount),
      taxRatePercent: line.taxRatePercent,
      taxableValue: scale(line.taxableValue),
      cgstAmount: scale(line.cgstAmount),
      sgstAmount: scale(line.sgstAmount),
      igstAmount: scale(line.igstAmount),
      lineTotal: scale(line.lineTotal),
      // The source line's place: how later challans know what this one carried.
      sortOrder: line.sortOrder,
    };
  });
  const sum = (key: "taxableValue" | "cgstAmount" | "sgstAmount" | "igstAmount" | "discountAmount") => round(lines.reduce((t, l) => t + n(l[key]), 0));
  const subtotal = round(lines.reduce((t, l) => t + n(l.quantity) * n(l.unitPrice), 0));
  const taxableValue = sum("taxableValue");
  const total = round(taxableValue + sum("cgstAmount") + sum("sgstAmount") + sum("igstAmount"));

  const { branchId, gstRegistrationId } = source.branchId
    ? { branchId: source.branchId, gstRegistrationId: source.gstRegistrationId }
    : await ensureHeadOffice().then((ho) => ({ branchId: ho.id, gstRegistrationId: ho.gstRegistrationId }));
  const issueDate = (await workspaceClock()).calendarDate(new Date());
  const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 2000) : "";

  const created = await db.$transaction(async (tx) =>
    tx.tradeDocument.create({
      data: {
        docNumber: await nextDocumentNumber(tx, "DELIVERY_CHALLAN", issueDate, branchId),
        docType: "DELIVERY_CHALLAN",
        direction: "SALES",
        status: "ISSUED",
        origin: "CONVERSION",
        companyId: source.companyId,
        locationId: source.locationId,
        branchId,
        gstRegistrationId,
        placeOfSupplyCode: source.placeOfSupplyCode,
        sellerGstin: source.sellerGstin,
        buyerGstin: source.buyerGstin,
        gstTreatment: source.gstTreatment,
        reverseCharge: source.reverseCharge,
        currency: source.currency,
        exchangeRate: source.exchangeRate,
        dispatchFromAddress: source.dispatchFromAddress,
        billingAttention: source.billingAttention,
        billingLine1: source.billingLine1,
        billingLine2: source.billingLine2,
        billingCity: source.billingCity,
        billingState: source.billingState,
        billingStateCode: source.billingStateCode,
        billingPincode: source.billingPincode,
        billingCountry: source.billingCountry,
        billingPhone: source.billingPhone,
        shippingSameAsBilling: source.shippingSameAsBilling,
        shippingAttention: source.shippingAttention,
        shippingLine1: source.shippingLine1,
        shippingLine2: source.shippingLine2,
        shippingCity: source.shippingCity,
        shippingState: source.shippingState,
        shippingStateCode: source.shippingStateCode,
        shippingPincode: source.shippingPincode,
        shippingCountry: source.shippingCountry,
        shippingPhone: source.shippingPhone,
        shippingGstin: source.shippingGstin,
        issueDate,
        reference: source.docNumber ? `${tradeDocumentLabels[source.docType]} ${source.docNumber}` : source.reference,
        notes: notes || null,
        subtotal: new Prisma.Decimal(subtotal),
        discountTotal: new Prisma.Decimal(sum("discountAmount")),
        taxableValue: new Prisma.Decimal(taxableValue),
        cgstAmount: new Prisma.Decimal(sum("cgstAmount")),
        sgstAmount: new Prisma.Decimal(sum("sgstAmount")),
        igstAmount: new Prisma.Decimal(sum("igstAmount")),
        roundOff: new Prisma.Decimal(0),
        total: new Prisma.Decimal(total),
        einvoiceStatus: "NOT_APPLICABLE",
        sourceDocumentId: source.id,
        leadId: source.leadId,
        createdById: g.user.id,
        salespersonId: source.salespersonId,
        lines: { create: lines },
      },
      select: { id: true, docNumber: true },
    }),
  );

  await recordAudit({
    userId: g.user.id,
    action: "CREATE",
    entityType: "TradeDocument",
    entityId: created.id,
    entityLabel: `${challanWords().One} ${created.docNumber ?? ""} from ${tradeDocumentLabels[source.docType].toLowerCase()} ${source.docNumber ?? ""} — ${chosen.map((c) => `${c.qty} × ${c.line.name}`).join(", ")}`.slice(0, 500),
  });
  revalidatePath(documentListPath.DELIVERY_CHALLAN);
  revalidatePath(`/documents/${source.id}`, "layout");
  return { ok: true, data: created };
}
