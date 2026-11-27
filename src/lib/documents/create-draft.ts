import { Prisma, type TradeDocumentType, type DocumentOrigin } from "@prisma/client";
import { db } from "@/lib/db";
import { countryFeatureAvailable } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { computeDocument, computeLine, GST_STATE_CODES, OTHER_COUNTRY_CODE, resolveSupplyType, stateCodeFromGstin, supplyTypeFor, type SupplyType } from "@/lib/gst-engine";
import { gstNumberProblem } from "@/lib/document-numbering";
import { workspaceClock } from "@/lib/time/workspace";
import { advanceSerialPast, nextDocumentNumber, typedSerialProblem } from "@/lib/trade-number";
import { branchIdentity, defaultBranchIdFor, ensureHeadOffice, type BranchWithRegistration } from "@/lib/branches/identity";
import type { BranchIdentity } from "@/lib/branches/format";
import { documentDirection, isEInvoiceEligible, tradeDocumentLabels } from "@/lib/trade-documents";
import type { TradeDocumentInput } from "@/lib/validation/trade-document";
import type { ActionResult } from "@/actions/company";
import { isIndia } from "@/lib/geo/countries";
import { periodDay } from "@/lib/documents/service-period";
import { normaliseHsn } from "@/lib/items/catalogue-import";
import { workspacePack } from "@/lib/country-pack";
import { settleLineTax } from "@/lib/vat/rules";

/**
 * Building and raising trade documents — the parts of src/actions/trade-document.ts that decide what a
 * document holds rather than who may write it. Not a "use server" module: nothing here checks a
 * permission, so nothing here may be an endpoint.
 */

export function parseDate(value: string | undefined | null, fallback?: Date): Date | null {
  if (!value) return fallback ?? null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (fallback ?? null) : date;
}

/** A state name typed on a location, mapped back to its GST code — a fallback when there's no GSTIN. */
export function stateCodeFromName(name?: string | null) {
  if (!name) return null;
  const target = name.trim().toLowerCase();
  const found = Object.entries(GST_STATE_CODES).find(([, label]) => label.toLowerCase() === target);
  return found?.[0] ?? null;
}

/**
 * Both sides of a document, as GSTINs and states. "Ours" is the branch's registration whichever way the
 * goods go: the seller on a sale, the buyer on a purchase. `partyGstin` is the location's on file — the
 * form's own GSTIN field overrides it in `buildDocumentData`.
 */
type PartyContext = {
  ourGstin: string | null;
  partyGstin: string | null;
  placeOfSupplyCode: string | null;
  /** The two state codes whose match decides CGST+SGST vs IGST. */
  supplyStates: { seller: string | null; destination: string | null };
};

/**
 * Who's selling to whom. On a sales document that's our branch to the customer; on a purchase document
 * the vendor is the seller and our branch is the destination — the tax split is the same comparison
 * either way, which is why both cases funnel into one pair of state codes. "Our" state is the branch's
 * GST state, not the registered office's: a Bengaluru branch billing a Bengaluru customer is intra-state
 * whatever state the company is registered in.
 */
export async function resolveParties(
  docType: TradeDocumentType,
  companyId: string,
  locationId: string | null,
  placeOfSupplyOverride: string | null,
  identity: BranchIdentity,
): Promise<PartyContext> {
  const location = locationId
    ? await db.companyLocation.findUnique({ where: { id: locationId } })
    : await db.companyLocation.findFirst({
        where: { companyId },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      });

  const ourState = identity.stateCode;
  const partyGstin = location?.gstNumber?.trim() || null;
  // A location abroad is "Other Country" (96) — and its state must never reach the Indian lookup,
  // where Pakistan's Punjab would come back as India's code 03.
  const partyState =
    stateCodeFromGstin(partyGstin) ?? (location && !isIndia(location.country) ? OTHER_COUNTRY_CODE : stateCodeFromName(location?.state));

  if (documentDirection[docType] === "SALES") {
    const destination = placeOfSupplyOverride || partyState;
    return {
      ourGstin: identity.gstin,
      partyGstin,
      placeOfSupplyCode: destination,
      supplyStates: { seller: ourState, destination },
    };
  }
  // Purchase: the vendor supplies our branch, so the place of supply is the buying branch's state.
  const destination = placeOfSupplyOverride || ourState;
  return {
    ourGstin: identity.gstin,
    partyGstin,
    placeOfSupplyCode: destination,
    supplyStates: { seller: partyState, destination },
  };
}

export function branchWithRegistration(id: string): Promise<BranchWithRegistration | null> {
  return db.branch.findUnique({ where: { id }, include: { gstRegistration: true } });
}

/**
 * The branch a document is raised from (on a purchase, bought by) — spec §5.1:
 *
 *   1. A credit note: always its invoice's, since it must go out under the GSTIN the invoice did. Any
 *      other branch asked for is refused. Allowed on a branch deactivated since, while its GSTIN is live.
 *   2. An update: the branch asked for, else the draft's own.
 *   3. A create: the branch asked for, else the user's home branch, else the head office.
 *   4. It must exist and be active — except (1), and a draft keeping the branch it already had (it can
 *      be saved there, not issued).
 *
 * A document written before branches (null) is the head office's. Runs before any transaction: the
 * helpers here use their own connection and may write (`ensureHeadOffice` adopts unassigned rows).
 */
export async function resolveDocumentBranch(input: {
  userId: string;
  docType: TradeDocumentType;
  requestedBranchId: string | null | undefined;
  againstDocumentId: string | null | undefined;
  existing?: { branchId: string | null };
}): Promise<{ branch: BranchWithRegistration } | { error: string }> {
  const requested = input.requestedBranchId?.trim() || null;

  if ((input.docType === "CREDIT_NOTE" || input.docType === "DEBIT_NOTE") && input.againstDocumentId) {
    const invoice = await db.tradeDocument.findUnique({ where: { id: input.againstDocumentId }, select: { branchId: true } });
    const branch = (invoice?.branchId ? await branchWithRegistration(invoice.branchId) : null) ?? (await ensureHeadOffice());
    const noteName = input.docType === "CREDIT_NOTE" ? "credit note" : "debit note";
    if (requested && requested !== branch.id) return { error: `A ${noteName} is raised by the branch that issued the invoice.` };
    if (!branch.active && branch.gstRegistration && !branch.gstRegistration.active) {
      return {
        error: `Branch ${branch.name} is inactive, and so is its GSTIN ${branch.gstRegistration.gstin}. Reactivate the GSTIN under Settings → Branches & GST registrations to raise a ${noteName} against this invoice.`,
      };
    }
    return { branch };
  }

  const draft = input.existing;
  const targetId = requested ?? (draft ? draft.branchId : await defaultBranchIdFor(input.userId));
  // A draft written before branches has none: it is the head office's.
  const branch = targetId ? await branchWithRegistration(targetId) : await ensureHeadOffice();
  if (!branch) return { error: "That branch no longer exists. Choose another one." };
  const keepsDraftBranch = draft !== undefined && (draft.branchId ? branch.id === draft.branchId : branch.isHeadOffice);
  if (!branch.active && !keepsDraftBranch) return { error: `Branch ${branch.name} is inactive. Choose another branch.` };
  return { branch };
}

/**
 * The links a save may write on its lines, checked rather than trusted — the form is not the only
 * thing that can post here.
 *
 *   · `companyProductId` must be one of this party's own orders (or, on a purchase, one it supplies):
 *     a line pointing at another customer's order would bill their subscription on this invoice.
 *   · `billingMilestoneId` is "Raise invoice"'s to set (src/actions/project.ts). A new document never
 *     carries one; an edited draft keeps a line's only while the stage still points at this document,
 *     so the form can round-trip it and nothing else can attach a stage to a document.
 *
 * And a line that names a product but arrives with no HSN/SAC gets the product's — its item's, or the
 * item of the order it bills. The form fills it when the product is picked; this is what makes that
 * hold for every other way a line is written.
 */
export async function checkLineLinks(
  lines: TradeDocumentInput["lines"],
  companyId: string,
  documentId: string | null,
): Promise<{ error: string } | { lines: TradeDocumentInput["lines"] }> {
  const orderIds = [...new Set(lines.map((l) => l.companyProductId).filter((v): v is string => !!v))];
  const orders = orderIds.length
    ? await db.companyProduct.findMany({ where: { id: { in: orderIds } }, select: { id: true, companyId: true, vendorId: true, item: { select: { hsnCode: true } } } })
    : [];
  const blankItemIds = [...new Set(lines.filter((l) => !normaliseHsn(l.hsnCode ?? "") && l.itemId).map((l) => l.itemId!))];
  const itemCodes = new Map(
    (blankItemIds.length ? await db.item.findMany({ where: { id: { in: blankItemIds } }, select: { id: true, hsnCode: true } }) : []).map((i) => [i.id, i.hsnCode]),
  );
  for (const [index, line] of lines.entries()) {
    if (!line.companyProductId) continue;
    const order = orders.find((o) => o.id === line.companyProductId);
    if (!order) return { error: `Line ${index + 1} bills an order that no longer exists.` };
    if (order.companyId !== companyId && order.vendorId !== companyId) {
      return { error: `Line ${index + 1} bills an order that belongs to another party.` };
    }
  }

  /**
   * Security audit round three, 14 Nov 2026 (R3-09): an edited draft is held to the same line rules as a new one — a
   * rate that differs from its item's needs its reason, and a credit note can't take off more at a rate than its
   * invoice charged at it. A new document is checked in `createDraftDocument`, which knows where it came from.
   */
  if (documentId) {
    const draft = await db.tradeDocument.findUnique({ where: { id: documentId }, select: { docType: true, origin: true, againstDocumentId: true } });
    if (draft && draft.origin !== "IMPORTED" && draft.origin !== "MIGRATED") {
      const override = await rateOverrides(lines, draft.docType);
      if ("error" in override) return override;
      if (draft.docType === "CREDIT_NOTE" && draft.againstDocumentId) {
        const over = await creditNoteLimitRefusal(draft.againstDocumentId, { lines }, documentId);
        if (over) return { error: over };
      }
    }
  }

  const stageIds = documentId ? [...new Set(lines.map((l) => l.billingMilestoneId).filter((v): v is string => !!v))] : [];
  const linked = stageIds.length
    ? await db.projectBillingMilestone.findMany({ where: { id: { in: stageIds }, documentId }, select: { id: true } })
    : [];
  const keep = new Set(linked.map((s) => s.id));
  // One line per stage: the first that carries it. A second would bill the same stage twice over.
  const taken = new Set<string>();
  return {
    lines: lines.map((l) => {
      const stage = l.billingMilestoneId && keep.has(l.billingMilestoneId) && !taken.has(l.billingMilestoneId) ? l.billingMilestoneId : "";
      if (stage) taken.add(stage);
      const typed = normaliseHsn(l.hsnCode ?? "");
      const hsnCode =
        typed ||
        (l.itemId ? itemCodes.get(l.itemId) : null) ||
        (l.companyProductId ? orders.find((o) => o.id === l.companyProductId)?.item.hsnCode : null) ||
        "";
      return { ...l, billingMilestoneId: stage, hsnCode };
    }),
  };
}

export function lineData(input: TradeDocumentInput["lines"][number], computed: ReturnType<typeof computeDocument>["lines"][number], index: number) {
  return {
    itemId: input.itemId || null,
    companyProductId: input.companyProductId || null,
    // Calendar days, stored as a @db.Date holds them; both or neither (the schema checked).
    servicePeriodFrom: periodDay(input.servicePeriodFrom),
    servicePeriodTo: periodDay(input.servicePeriodTo),
    billingMilestoneId: input.billingMilestoneId || null,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    // Without the spaces people copy it with ("8471 30 10"), as an item stores it.
    hsnCode: normaliseHsn(input.hsnCode ?? "") || null,
    unit: input.unit || null,
    quantity: new Prisma.Decimal(input.quantity),
    unitPrice: new Prisma.Decimal(input.unitPrice),
    discountMode: input.discountMode,
    discountValue: new Prisma.Decimal(input.discountValue),
    discountAmount: new Prisma.Decimal(computed.discountAmount),
    taxRatePercent: new Prisma.Decimal(input.taxRatePercent),
    // Outside India only, written by name (the column may not be there yet where nothing sets it).
    ...(input.taxCategory ? { taxCategory: input.taxCategory } : {}),
    taxableValue: new Prisma.Decimal(computed.taxableValue),
    cgstAmount: new Prisma.Decimal(computed.cgstAmount),
    sgstAmount: new Prisma.Decimal(computed.sgstAmount),
    igstAmount: new Prisma.Decimal(computed.igstAmount),
    lineTotal: new Prisma.Decimal(computed.lineTotal),
    sortOrder: index,
  };
}

/** The bank account a document names must be one of the organisation's. A retired one is allowed: it is
 *  offered only to the document that already names it. */
export async function bankAccountRefusal(bankAccountId: string | undefined): Promise<string | null> {
  if (!bankAccountId) return null;
  const account = await db.organisationBankAccount.findUnique({ where: { id: bankAccountId }, select: { id: true } });
  return account ? null : "That bank account isn't there any more — pick another.";
}

/**
 * Everything a create or an update writes, with the tax engine run over the submitted lines — as
 * raised from (or, on a purchase, bought by) `branch`. Resolve the branch first: this reads through
 * `db` and must not run inside a transaction.
 */
export async function buildDocumentData(data: TradeDocumentInput, branch: { id: string }) {
  // Outside India each line is settled to its VAT category and rate (src/lib/vat/rules.ts) — zero-rated, exempt and out
  // of scope at 0, standard at its rate; India's lines are taxed by rate alone and never carry a category.
  const pack = workspacePack();
  data = {
    ...data,
    lines: data.lines.map((l) => {
      if (pack.india) return { ...l, taxCategory: undefined };
      const settled = settleLineTax(l.taxCategory, l.taxRatePercent, pack.tax.defaultRate);
      return { ...l, taxRatePercent: settled.rate, taxCategory: settled.category };
    }),
  };
  const identity = await branchIdentity(branch.id);
  // A note follows its invoice's place of supply and treatment (R3-09, `invoiceTaxFrame`).
  const frame =
    (data.docType === "CREDIT_NOTE" || data.docType === "DEBIT_NOTE") && data.againstDocumentId ? await invoiceTaxFrame(data.againstDocumentId) : null;
  if (frame) data = { ...data, placeOfSupplyCode: frame.placeOfSupplyCode ?? "", gstTreatment: frame.gstTreatment };
  const parties = await resolveParties(
    data.docType,
    data.companyId,
    data.locationId || null,
    data.placeOfSupplyCode || null,
    identity,
  );
  const isSales = documentDirection[data.docType] === "SALES";
  // The form's one GSTIN field is the *party's*, whichever side of the document they are on, and it wins
  // over the location's: it's what was actually agreed for this document. Ours is the branch's
  // registration — on a purchase that is the buyer, which is where the previous build put the vendor (X1).
  const partyGstin = data.buyerGstin || parties.partyGstin || null;
  // An export or an SEZ supply is inter-state whatever the states (R3-10, `supplyTypeFor`) — on a sale only: what a
  // vendor's bill charges is the vendor's. A note is taxed as its invoice was.
  const supplyType =
    frame?.supplyType ??
    (isSales
      ? supplyTypeFor(parties.supplyStates.seller, parties.supplyStates.destination, data.gstTreatment)
      : resolveSupplyType(parties.supplyStates.seller, parties.supplyStates.destination));
  const totals = computeDocument(
    data.lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountMode: l.discountMode,
      discountValue: l.discountValue,
      taxRatePercent: l.taxRatePercent,
    })),
    supplyType,
    {
      shippingCharge: data.shippingCharge,
      shippingTaxRatePercent: data.shippingTaxRatePercent,
      withholdingMode: data.withholdingMode,
      withholdingRatePercent: data.withholdingRatePercent,
      adjustment: data.adjustment,
      roundOff: identity.roundOffTotals,
      // A UAE bill for an imported service: the VAT is ours to account for, not the vendor's to be paid.
      taxSelfAssessed: !pack.india && data.reverseCharge && documentDirection[data.docType] === "PURCHASE",
    },
  );
  // A document's dates are typed days, kept as their midnight UTC; left blank, it is dated today on
  // the workspace's calendar, held the same way — not the moment, whose UTC date is yesterday's
  // before 05:30 in India.
  const issueDate = parseDate(data.issueDate, (await workspaceClock()).calendarDate(new Date())) as Date;
  // "Same as billing" is stored resolved rather than as a flag alone, so a printed document and the
  // e-invoice payload don't each have to re-derive where the goods went.
  const shipping = data.shippingSameAsBilling ? data.billing : data.shipping;

  return {
    totals,
    parties,
    issueDate,
    scalars: {
      docType: data.docType,
      direction: documentDirection[data.docType],
      companyId: data.companyId,
      locationId: data.locationId || null,
      branchId: branch.id,
      // The branch's registration as of this save; issuing re-reads it (spec §3.5, §5.5).
      gstRegistrationId: identity.gstRegistrationId,
      placeOfSupplyCode: parties.placeOfSupplyCode,
      sellerGstin: isSales ? parties.ourGstin : partyGstin,
      buyerGstin: isSales ? partyGstin : parties.ourGstin,
      gstTreatment: data.gstTreatment,
      reverseCharge: data.reverseCharge,
      currency: data.currency,
      // Stored beside the amounts, not looked up later: the rate that matters is the one agreed
      // on the day, and a document reopened next year must still post at that rate.
      exchangeRate: data.exchangeRate,
      issueDate,
      dueDate: parseDate(data.dueDate),
      validUntil: parseDate(data.validUntil),
      reference: data.reference || null,
      salespersonId: data.salespersonId || null,
      notes: data.notes || null,
      terms: data.terms || null,
      // Only when sent, and only on a sale: written by name, as the column may not be there yet.
      ...(isSales && data.bankAccountId !== undefined ? { bankAccountId: data.bankAccountId || null } : {}),

      dispatchFromAddress: data.dispatchFromAddress || null,
      billingAttention: data.billing.attention || null,
      billingLine1: data.billing.line1 || null,
      billingLine2: data.billing.line2 || null,
      billingCity: data.billing.city || null,
      billingState: data.billing.state || null,
      billingStateCode: data.billing.stateCode || null,
      billingPincode: data.billing.pincode || null,
      billingCountry: data.billing.country || "India",
      billingPhone: data.billing.phone || null,

      shippingSameAsBilling: data.shippingSameAsBilling,
      shippingAttention: shipping.attention || null,
      shippingLine1: shipping.line1 || null,
      shippingLine2: shipping.line2 || null,
      shippingCity: shipping.city || null,
      shippingState: shipping.state || null,
      shippingStateCode: shipping.stateCode || null,
      shippingPincode: shipping.pincode || null,
      shippingCountry: shipping.country || "India",
      shippingPhone: shipping.phone || null,
      shippingGstin: data.shippingGstin || null,

      subtotal: new Prisma.Decimal(totals.subtotal),
      discountTotal: new Prisma.Decimal(totals.discountTotal),
      taxableValue: new Prisma.Decimal(totals.taxableValue),
      cgstAmount: new Prisma.Decimal(totals.cgstAmount),
      sgstAmount: new Prisma.Decimal(totals.sgstAmount),
      igstAmount: new Prisma.Decimal(totals.igstAmount),
      shippingCharge: new Prisma.Decimal(totals.shippingCharge),
      shippingTaxRatePercent: new Prisma.Decimal(data.shippingTaxRatePercent),
      withholdingMode: data.withholdingMode,
      withholdingSection: data.withholdingSection || null,
      withholdingRatePercent: new Prisma.Decimal(data.withholdingRatePercent),
      withholdingAmount: new Prisma.Decimal(totals.withholdingAmount),
      adjustmentLabel: data.adjustmentLabel || null,
      adjustment: new Prisma.Decimal(totals.adjustment),
      roundOff: new Prisma.Decimal(totals.roundOff),
      total: new Prisma.Decimal(totals.total),
    },
    lines: data.lines.map((line, index) => lineData(line, totals.lines[index], index)),
  };
}

/** A reference to the document a conversion or credit note came from, checked to belong to the same party. */
export async function validateLinkedDocument(
  linkedId: string,
  companyId: string,
  expected: TradeDocumentType[],
): Promise<string | null> {
  const linked = await db.tradeDocument.findUnique({
    where: { id: linkedId },
    select: { companyId: true, docType: true, status: true },
  });
  if (!linked) return "The linked document no longer exists.";
  if (linked.companyId !== companyId) return "The linked document belongs to a different party.";
  if (!expected.includes(linked.docType)) return "That document can't be linked to this one.";
  return null;
}

/**
 * The same vendor bill entered twice (security audit, 11 Nov 2026 — SEC-70). A vendor's bill number is the number on
 * their invoice, typed by whoever enters it, so "BILL/0095" and "bill / 0095" are the same bill — and booked twice it is
 * a second payable, a second input-tax credit and a vendor paid twice. Compared without case or spaces, for the same
 * vendor, ignoring cancelled ones.
 */
export async function duplicateVendorBillRefusal(companyId: string, docNumber: string, exceptId?: string): Promise<string | null> {
  const key = docNumber.replace(/\s+/g, "").toLowerCase();
  if (!key) return null;
  const bills = await db.tradeDocument.findMany({
    where: { companyId, docType: "BILL", status: { not: "CANCELLED" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { docNumber: true },
  });
  const same = bills.find((b) => b.docNumber.replace(/\s+/g, "").toLowerCase() === key);
  return same ? `This vendor's bill ${same.docNumber} is already entered — the same bill can't be booked twice.` : null;
}

/**
 * A credit or debit note corrects an invoice that went out (security audit, 11 Nov 2026 — SEC-10): one raised against
 * a draft or a cancelled invoice corrects nothing, and was a way to put credit on an account.
 */
export async function againstInvoiceRefusal(invoiceId: string): Promise<string | null> {
  const invoice = await db.tradeDocument.findUnique({ where: { id: invoiceId }, select: { status: true } });
  if (!invoice) return "The linked document no longer exists.";
  if (invoice.status === "DRAFT") return "Issue the invoice before raising a note against it.";
  if (invoice.status === "CANCELLED") return "That invoice is cancelled — there is nothing left to correct.";
  return null;
}

/**
 * How much more may be credited against an invoice (SEC-10): its total, less every other credit note raised against it
 * that isn't cancelled. A credit note bigger than that took off more than was ever billed.
 */
export async function creditRoomOn(invoiceId: string, exceptNoteId: string): Promise<{ total: number; credited: number; room: number } | null> {
  const invoice = await db.tradeDocument.findUnique({ where: { id: invoiceId }, select: { total: true } });
  if (!invoice) return null;
  const others = await db.tradeDocument.aggregate({
    where: { againstDocumentId: invoiceId, docType: "CREDIT_NOTE", id: { not: exceptNoteId }, status: { notIn: ["DRAFT", "CANCELLED"] } },
    _sum: { total: true },
  });
  const total = Number(invoice.total);
  const credited = Number(others._sum.total ?? 0);
  return { total, credited, room: Math.round((total - credited) * 100) / 100 };
}

/**
 * The reason a line gives for a rate other than its item's: a line of its description starting "Rate:" — "Rate:
 * concessional rate, notification 41/2017". The description prints on the document, so the reason does too.
 */
const RATE_REASON = /^\s*(?:gst\s+)?rate\s*(?:reason)?\s*:\s*(\S.{2,})$/im;

export function rateReasonOf(description: string | null | undefined): string | null {
  return RATE_REASON.exec(description ?? "")?.[1]?.trim() ?? null;
}

export type RateOverride = { line: number; name: string; itemRate: number; rate: number; reason: string };

/**
 * Security audit round three, 14 Nov 2026 (R3-09): a sale's line taxed at a rate other than its catalogue item's must
 * say why — an item at 18% billed at 5% is the quietest way to under-charge GST. India's sales only (a vendor's bill
 * carries the vendor's rate), and only where the item has a rate. Returns the overrides, to be written to the audit
 * log, or the refusal naming the line.
 */
export async function rateOverrides(lines: TradeDocumentInput["lines"], docType: TradeDocumentType): Promise<{ overrides: RateOverride[] } | { error: string }> {
  if (!workspacePack().india || documentDirection[docType] !== "SALES") return { overrides: [] };
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is string => !!v))];
  if (itemIds.length === 0) return { overrides: [] };
  const items = new Map((await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, taxRatePercent: true } })).map((i) => [i.id, i.taxRatePercent]));
  const overrides: RateOverride[] = [];
  for (const [index, line] of lines.entries()) {
    const stored = line.itemId ? items.get(line.itemId) : null;
    if (stored === null || stored === undefined) continue;
    const itemRate = Number(stored);
    const rate = Number(line.taxRatePercent) || 0;
    if (Math.abs(itemRate - rate) < 0.0001) continue;
    const reason = rateReasonOf(line.description);
    if (!reason) {
      return {
        error: `Line ${index + 1} ("${line.name}") is taxed at ${rate}%, but its item is ${itemRate}%. Say why in the line's description, on a line starting "Rate:" — for example "Rate: concessional rate, notification 41/2017".`,
      };
    }
    overrides.push({ line: index + 1, name: line.name, itemRate, rate, reason: reason.slice(0, 200) });
  }
  return { overrides };
}

type TaxBucket = { taxable: number; cgst: number; sgst: number; igst: number };
const bucketKey = (rate: number) => String(Math.round(rate * 100) / 100);

/**
 * Security audit round three, 14 Nov 2026 (R3-09): a credit note takes off, at each rate and in each tax head, at most
 * what its invoice charged there, less the other credit notes against it. The cap on the total alone let a note credit
 * 28% tax against an invoice that charged 5%, or IGST against one that charged CGST + SGST, and the return took it.
 * In the invoice's currency: a note in another one is refused, since the two can't be compared.
 *
 * `note.shipping` is the note's freight, when known (a new note); an edited draft is checked on its lines.
 */
export async function creditNoteLimitRefusal(
  invoiceId: string,
  note: { lines: TradeDocumentInput["lines"]; currency?: string; shippingCharge?: number; shippingTaxRatePercent?: number },
  exceptNoteId: string | null,
): Promise<string | null> {
  const lineSelect = { taxRatePercent: true, taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true } as const;
  const docSelect = {
    currency: true,
    shippingCharge: true,
    shippingTaxRatePercent: true,
    cgstAmount: true,
    sgstAmount: true,
    igstAmount: true,
    lines: { select: lineSelect },
  } as const;
  const [invoice, others] = await Promise.all([
    db.tradeDocument.findUnique({ where: { id: invoiceId }, select: docSelect }),
    db.tradeDocument.findMany({
      where: { againstDocumentId: invoiceId, docType: "CREDIT_NOTE", status: { notIn: ["DRAFT", "CANCELLED"] }, ...(exceptNoteId ? { id: { not: exceptNoteId } } : {}) },
      select: docSelect,
    }),
  ]);
  if (!invoice) return "The linked document no longer exists.";
  if (note.currency && note.currency !== invoice.currency) return `A credit note is in its invoice's currency, ${invoice.currency}.`;

  // A stored document's buckets: its lines by rate, and its freight at the freight's rate, the freight's tax being
  // what the document's heads hold over its lines'.
  const stored = (d: NonNullable<typeof invoice>, into: Map<string, TaxBucket>, sign: 1 | -1) => {
    const lineHeads = { cgst: 0, sgst: 0, igst: 0 };
    for (const l of d.lines) {
      const b = into.get(bucketKey(Number(l.taxRatePercent))) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      b.taxable += sign * Number(l.taxableValue);
      b.cgst += sign * Number(l.cgstAmount);
      b.sgst += sign * Number(l.sgstAmount);
      b.igst += sign * Number(l.igstAmount);
      lineHeads.cgst += Number(l.cgstAmount);
      lineHeads.sgst += Number(l.sgstAmount);
      lineHeads.igst += Number(l.igstAmount);
      into.set(bucketKey(Number(l.taxRatePercent)), b);
    }
    const freight = Number(d.shippingCharge);
    if (freight > 0) {
      const key = bucketKey(Number(d.shippingTaxRatePercent));
      const b = into.get(key) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      b.taxable += sign * freight;
      b.cgst += sign * Math.max(0, Number(d.cgstAmount) - lineHeads.cgst);
      b.sgst += sign * Math.max(0, Number(d.sgstAmount) - lineHeads.sgst);
      b.igst += sign * Math.max(0, Number(d.igstAmount) - lineHeads.igst);
      into.set(key, b);
    }
  };
  const room = new Map<string, TaxBucket>();
  stored(invoice, room, 1);
  for (const o of others) stored(o, room, -1);

  // The note's own, taxed the way the invoice was (its supply type is forced to the invoice's in `buildDocumentData`).
  const invoiceInter = Number(invoice.igstAmount) > 0 || (Number(invoice.cgstAmount) === 0 && Number(invoice.sgstAmount) === 0);
  const supply: SupplyType = invoiceInter ? "INTER_STATE" : "INTRA_STATE";
  const asked = new Map<string, TaxBucket>();
  const add = (rate: number, taxable: number, tax: { cgst: number; sgst: number; igst: number }) => {
    const b = asked.get(bucketKey(rate)) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    b.taxable += taxable;
    b.cgst += tax.cgst;
    b.sgst += tax.sgst;
    b.igst += tax.igst;
    asked.set(bucketKey(rate), b);
  };
  for (const l of note.lines) {
    const c = computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, discountMode: l.discountMode, discountValue: l.discountValue, taxRatePercent: l.taxRatePercent }, supply);
    add(Number(l.taxRatePercent) || 0, c.taxableValue, { cgst: c.cgstAmount, sgst: c.sgstAmount, igst: c.igstAmount });
  }
  if ((note.shippingCharge ?? 0) > 0) {
    const c = computeLine({ quantity: 1, unitPrice: note.shippingCharge!, taxRatePercent: note.shippingTaxRatePercent ?? 0 }, supply);
    add(note.shippingTaxRatePercent ?? 0, c.taxableValue, { cgst: c.cgstAmount, sgst: c.sgstAmount, igst: c.igstAmount });
  }

  const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
  for (const [rate, want] of asked) {
    const left = room.get(rate) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    if (want.taxable > left.taxable + 0.005) {
      return `This credit note takes off ${money(want.taxable)} taxable at ${rate}%, but its invoice has only ${money(Math.max(0, left.taxable))} left at that rate${others.length ? " after its other credit notes" : ""}.`;
    }
    for (const head of ["cgst", "sgst", "igst"] as const) {
      // A paisa of rounding either way is not over-crediting.
      if (want[head] > left[head] + 0.02) {
        return `This credit note takes off ${money(want[head])} of ${head.toUpperCase()} at ${rate}%, but its invoice has only ${money(Math.max(0, left[head]))} of it left at that rate.`;
      }
    }
  }
  return null;
}

/**
 * Security audit round three, 14 Nov 2026 (R3-09): a credit or debit note corrects the invoice's supply, so it carries
 * the invoice's place of supply, GST treatment and supply type — not whatever the form says. A note against a
 * Karnataka CGST + SGST invoice raised with place of supply Delhi credited IGST nobody was ever charged.
 */
async function invoiceTaxFrame(invoiceId: string) {
  const invoice = await db.tradeDocument.findUnique({
    where: { id: invoiceId },
    select: { docType: true, placeOfSupplyCode: true, gstTreatment: true, cgstAmount: true, sgstAmount: true, igstAmount: true },
  });
  if (!invoice || invoice.docType !== "INVOICE") return null;
  const intra = Number(invoice.cgstAmount) > 0 || Number(invoice.sgstAmount) > 0;
  const inter = Number(invoice.igstAmount) > 0;
  return {
    placeOfSupplyCode: invoice.placeOfSupplyCode,
    gstTreatment: invoice.gstTreatment,
    // An untaxed invoice says neither; the states decide, as they did for it.
    supplyType: (intra ? "INTRA_STATE" : inter ? "INTER_STATE" : null) as SupplyType | null,
  };
}

/**
 * A document may only be attributed to a lead belonging to the same party.
 *
 * Worth checking rather than trusting, because the link decides which deal a quotation counts
 * towards — and the company on the form can be changed after it was opened from a lead, which
 * would otherwise file the proposal under someone else's pipeline.
 */
export async function validateLinkedLead(leadId: string | undefined, companyId: string): Promise<string | null> {
  if (!leadId) return null;
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { companyId: true } });
  if (!lead) return "That lead no longer exists.";
  if (lead.companyId !== companyId) return "That lead belongs to a different company.";
  return null;
}

/**
 * Raises a draft document: everything `createTradeDocument` does once it has decided the caller may —
 * the party's site, linked documents and lead checked, the branch resolved, lines priced and taxed,
 * the number allocated with the document, the audit written.
 *
 * Here rather than in the action so a job with no session can raise a draft the same way, as the
 * Automation account: recurring billing (src/lib/recurring-billing/run.ts). Whoever calls it has
 * already answered *may they*; nothing here asks. `branchFor` is whose home branch the document
 * defaults to when it names none — the actor's, unless the caller acts for somebody else.
 */
export async function createDraftDocument(
  actor: { id: string; branchFor?: string },
  data: TradeDocumentInput,
  origin: DocumentOrigin,
): Promise<ActionResult<{ id: string }>> {
  const company = await db.company.findUnique({
    where: { id: data.companyId },
    select: { id: true, name: true, ownerUserId: true },
  });
  if (!company) return { ok: false, error: "That party no longer exists." };

  if (data.locationId) {
    const location = await db.companyLocation.findUnique({ where: { id: data.locationId }, select: { companyId: true } });
    if (!location || location.companyId !== data.companyId) {
      return { ok: false, error: "That location doesn't belong to this party." };
    }
  }
  if (data.againstDocumentId) {
    if (data.docType !== "CREDIT_NOTE" && data.docType !== "DEBIT_NOTE") return { ok: false, error: "Only a credit or debit note is raised against an invoice." };
    const error = await validateLinkedDocument(data.againstDocumentId, data.companyId, ["INVOICE"]);
    if (error) return { ok: false, error };
    const notOpen = await againstInvoiceRefusal(data.againstDocumentId);
    if (notOpen) return { ok: false, error: notOpen };
  }
  if (data.docType === "CREDIT_NOTE" && !data.againstDocumentId) {
    return { ok: false, error: "A credit note must name the invoice it reduces." };
  }
  if (data.docType === "DEBIT_NOTE" && !data.againstDocumentId) {
    return { ok: false, error: "A debit note must name the invoice it adds to." };
  }
  if (data.sourceDocumentId) {
    const error = await validateLinkedDocument(data.sourceDocumentId, data.companyId, [
      "PROPOSAL",
      "PROFORMA",
      "PURCHASE_ORDER",
    ]);
    if (error) return { ok: false, error };
  }
  const leadError = await validateLinkedLead(data.leadId, data.companyId);
  if (leadError) return { ok: false, error: leadError };
  const bankError = await bankAccountRefusal(data.bankAccountId);
  if (bankError) return { ok: false, error: bankError };
  const links = await checkLineLinks(data.lines, data.companyId, null);
  if ("error" in links) return { ok: false, error: links.error };
  // R3-09: a rate other than the item's says why, and a credit note stays within its invoice at each rate. A
  // document brought from the old system is kept as it was issued there.
  const broughtIn = origin === "IMPORTED" || origin === "MIGRATED";
  const override = broughtIn ? { overrides: [] as RateOverride[] } : await rateOverrides(links.lines, data.docType);
  if ("error" in override) return { ok: false, error: override.error };
  if (!broughtIn && data.docType === "CREDIT_NOTE" && data.againstDocumentId) {
    const over = await creditNoteLimitRefusal(
      data.againstDocumentId,
      { lines: links.lines, currency: data.currency, shippingCharge: data.shippingCharge, shippingTaxRatePercent: data.shippingTaxRatePercent },
      null,
    );
    if (over) return { ok: false, error: over };
  }

  const typedNumber = data.docNumber?.trim() || null;
  // A number brought from the old system is the one it was issued under there, whatever its shape.
  const numberProblem = typedNumber && origin !== "IMPORTED" && origin !== "MIGRATED" ? gstNumberProblem(data.docType, typedNumber) : null;
  if (numberProblem) return { ok: false, error: numberProblem };
  // Trailing digits no series can hold (security audit SEC-16) — refused rather than crashing the save.
  const serialProblem = typedNumber ? typedSerialProblem(data.docType, typedNumber) : null;
  if (serialProblem) return { ok: false, error: serialProblem };

  // Before the transaction: these read through `db`, and resolving may create the head office.
  const picked = await resolveDocumentBranch({
    userId: actor.branchFor ?? actor.id,
    docType: data.docType,
    requestedBranchId: data.branchId,
    againstDocumentId: data.againstDocumentId,
  });
  if ("error" in picked) return { ok: false, error: picked.error };
  const { branch } = picked;
  const built = await buildDocumentData({ ...data, lines: links.lines }, branch);
  // Only India has the government's e-invoice system; elsewhere it never applies.
  const einvoiceStatus = isEInvoiceEligible(data.docType) && (await countryFeatureAvailable("einvoice")) ? "PENDING" : "NOT_APPLICABLE";

  /**
   * Zoho assigns the number when the document is created, not when it's issued, so it's visible and
   * editable on the form. A typed-in number is kept as-is and its branch's series is pushed past it.
   *
   * Allocated in the transaction that creates the document (X12): a create that fails takes its number
   * back with it rather than leaving a gap. The one exception is an allocated number some other
   * document already holds — that transaction commits, so the series moves past a number nobody can
   * have anyway and the next attempt takes the one after it.
   */
  if (data.docType === "BILL" && typedNumber) {
    const duplicate = await duplicateVendorBillRefusal(data.companyId, typedNumber);
    if (duplicate) return { ok: false, error: duplicate };
  }
  const outcome = await db.$transaction(async (tx) => {
    const docNumber = typedNumber ?? (await nextDocumentNumber(tx, data.docType, built.issueDate, branch.id));
    const clash = await tx.tradeDocument.findUnique({ where: { docNumber }, select: { id: true } });
    if (clash) return { clash: docNumber };
    // A typed number moves the series on by a short step at most (SEC-16); one brought from the old system, as far as it goes.
    if (typedNumber) {
      await advanceSerialPast(tx, data.docType, typedNumber, branch.id, built.issueDate, { anyStep: origin === "IMPORTED" || origin === "MIGRATED" });
    }

    const created = await tx.tradeDocument.create({
      data: {
        ...built.scalars,
        docNumber,
        status: "DRAFT",
        origin,
        einvoiceStatus,
        sourceDocumentId: data.sourceDocumentId || null,
        againstDocumentId: data.againstDocumentId || null,
        leadId: data.leadId || null,
        createdById: actor.id,
        salespersonId: data.salespersonId || company.ownerUserId || actor.id,
        lines: { create: built.lines },
      },
      select: { id: true },
    });
    return { created };
  });
  if ("clash" in outcome) return { ok: false, error: `${outcome.clash} is already used by another document.` };
  const { created } = outcome;

  await recordAudit({
    userId: actor.id,
    action: "CREATE",
    entityType: "TradeDocument",
    entityId: created.id,
    entityLabel: `${tradeDocumentLabels[data.docType]} for ${company.name}`,
  });
  // R3-09: each rate set apart from its item's, and why, on the record.
  for (const o of override.overrides) {
    await recordAudit({
      userId: actor.id,
      action: "UPDATE",
      entityType: "TradeDocument",
      entityId: created.id,
      entityLabel: `Line ${o.line} "${o.name}" taxed at ${o.rate}% instead of its item's ${o.itemRate}%: ${o.reason}`,
    });
  }
  return { ok: true, data: { id: created.id } };
}
