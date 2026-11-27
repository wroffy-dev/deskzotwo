"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { requireModuleUser } from "@/lib/modules-access";
import { mayAccess } from "@/lib/authz/access";
import { can } from "@/lib/authz/resolve";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { createTradeDocument } from "@/actions/trade-document";
import { acceptQuote } from "@/lib/orders/from-quote";
import { billingProgress, lockQuoteBilling, overBilled, roundPercent, type BillingProgress } from "@/lib/documents/progress-billing";
import type { ActionResult } from "@/actions/company";

/**
 * Progress invoicing's writes (owner, 3 Nov 2026 — src/lib/documents/progress-billing.ts): a quote's stages set, a
 * stage invoiced, a one-off share invoiced, what's left invoiced. Whoever may raise sales documents and edit the quote.
 * Each invoice is a draft made the way any is (createTradeDocument), every line of the quote at the stage's share,
 * linked back to the quote as converted from it.
 */

const NOT_YET = "This workspace can't bill quotes in stages until its next update.";

async function gate(quoteId: string) {
  const user = await requireModuleUser("sales_documents");
  if (!(await can(user.id, "docs.createInvoice"))) return { user, error: "You don't have permission to create a tax invoice." };
  const quote = await db.tradeDocument.findUnique({ where: { id: String(quoteId ?? "") }, select: { id: true, docType: true, status: true, docNumber: true } });
  if (!quote || quote.docType !== "PROPOSAL" || !(await mayAccess(user.id, "documents", "edit", quote.id))) return { user, error: "That quote no longer exists." };
  if (quote.status !== "ISSUED" && quote.status !== "ACCEPTED") return { user, error: "Only a quote that has been sent or accepted is billed in stages." };
  return { user, error: null as string | null, quote };
}

const stagesSchema = z
  .array(
    z.object({
      id: z.string().max(40).optional(),
      label: z.string().trim().min(1, "Name each stage — Advance, On delivery…").max(80),
      percent: z.coerce.number().gt(0, "Each stage is more than 0%.").max(100, "A stage can't be more than 100%."),
    }),
  )
  .max(20, "Twenty stages at most.");

/** Sets a quote's stages. Those already invoiced stay as they are; the rest are replaced. */
export async function saveBillingStages(quoteId: string, input: unknown): Promise<ActionResult<null>> {
  const g = await gate(quoteId);
  if (g.error || !g.quote) return { ok: false, error: g.error ?? "That quote no longer exists." };
  const parsed = stagesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the stages." };
  const progress = await billingProgress(g.quote.id);
  if (!progress) return { ok: false, error: "That quote no longer exists." };
  const billedStages = progress.stages.filter((s) => s.status !== "NOT_BILLED");
  for (const b of billedStages) {
    const sent = parsed.data.find((s) => s.id === b.id);
    if (!sent || roundPercent(sent.percent) !== b.percent) return { ok: false, error: `"${b.label}" is invoiced already (${b.invoice?.docNumber ?? "a draft"}), so it stays as it is.` };
  }
  const sum = parsed.data.reduce((t, s) => t + roundPercent(s.percent), 0);
  if (sum > 100.01) return { ok: false, error: `The stages come to ${roundPercent(sum)}% — no more than 100%.` };
  const keep = new Set(billedStages.map((b) => b.id));
  try {
    await db.$transaction(async (tx) => {
      await tx.quoteBillingStage.deleteMany({ where: { documentId: g.quote!.id, id: { notIn: [...keep] } } });
      for (const [n, s] of parsed.data.entries()) {
        if (s.id && keep.has(s.id)) await tx.quoteBillingStage.update({ where: { id: s.id }, data: { label: s.label, sortOrder: n } });
        else await tx.quoteBillingStage.create({ data: { documentId: g.quote!.id, label: s.label, percent: roundPercent(s.percent), sortOrder: n } });
      }
    });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  await recordAudit({ userId: g.user.id, action: "UPDATE", entityType: "TradeDocument", entityId: g.quote.id, entityLabel: `${g.quote.docNumber}: billed in stages — ${parsed.data.map((s) => `${s.label} ${roundPercent(s.percent)}%`).join(", ")}`.slice(0, 500) });
  revalidatePath(`/documents/${g.quote.id}`, "layout");
  return { ok: true, data: null };
}

/** Invoices one stage. */
export async function invoiceBillingStage(stageId: string): Promise<ActionResult<{ id: string }>> {
  const stage = await db.quoteBillingStage.findUnique({ where: { id: String(stageId ?? "") }, select: { id: true, documentId: true, label: true, percent: true } }).catch((err) => {
    if (notMigratedYet(err)) return null;
    throw err;
  });
  if (!stage) return { ok: false, error: "That stage no longer exists." };
  const g = await gate(stage.documentId);
  if (g.error || !g.quote) return { ok: false, error: g.error ?? "That quote no longer exists." };
  const progress = (await billingProgress(g.quote.id))!;
  const view = progress.stages.find((s) => s.id === stage.id);
  if (view && view.status !== "NOT_BILLED") return { ok: false, error: `"${stage.label}" is invoiced already, on ${view.invoice?.docNumber ?? "a draft"}.` };
  return raise(g.user.id, g.quote.id, g.quote.docNumber, stage.id, stage.label, Number(stage.percent), progress);
}

/** Invoices a share of the quote not set as a stage — a percentage, or an amount turned into one. */
export async function invoiceQuoteShare(quoteId: string, input: { percent?: number; amount?: number; label?: string }): Promise<ActionResult<{ id: string }>> {
  const g = await gate(quoteId);
  if (g.error || !g.quote) return { ok: false, error: g.error ?? "That quote no longer exists." };
  const progress = (await billingProgress(g.quote.id))!;
  const percent = input.amount !== undefined ? (progress.total > 0 ? (Number(input.amount) / progress.total) * 100 : 0) : Number(input.percent);
  const share = roundPercent(percent);
  const label = String(input.label ?? "").trim().slice(0, 80) || `${share}% of ${g.quote.docNumber ?? "the quote"}`;
  return oneOff(g.user.id, g.quote.id, g.quote.docNumber, label, share, progress);
}

/** Invoices whatever of the quote isn't billed yet. */
export async function invoiceQuoteRemainder(quoteId: string): Promise<ActionResult<{ id: string }>> {
  const g = await gate(quoteId);
  if (g.error || !g.quote) return { ok: false, error: g.error ?? "That quote no longer exists." };
  const progress = (await billingProgress(g.quote.id))!;
  if (progress.leftPercent <= 0) return { ok: false, error: "The whole quote is billed already." };
  return oneOff(g.user.id, g.quote.id, g.quote.docNumber, "Balance", progress.leftPercent, progress);
}

async function oneOff(userId: string, quoteId: string, docNumber: string | null, label: string, percent: number, progress: BillingProgress): Promise<ActionResult<{ id: string }>> {
  const refused = overBilled(progress, percent);
  if (refused) return { ok: false, error: refused };
  const stage = await db.quoteBillingStage
    .create({ data: { documentId: quoteId, label, percent, sortOrder: 1000 + progress.stages.length }, select: { id: true } })
    .catch((err) => {
      if (notMigratedYet(err)) return null;
      throw err;
    });
  if (!stage) return { ok: false, error: NOT_YET };
  const made = await raise(userId, quoteId, docNumber, stage.id, label, percent, progress);
  if (!made.ok) await db.quoteBillingStage.delete({ where: { id: stage.id } }).catch(() => {});
  return made;
}

/** The invoice: every line of the quote at `percent`, its parties and terms, converted from it. */
async function raise(userId: string, quoteId: string, docNumber: string | null, stageId: string, label: string, percent: number, progress: BillingProgress): Promise<ActionResult<{ id: string }>> {
  const refused = overBilled(progress, percent);
  if (refused) return { ok: false, error: refused };
  const q = await db.tradeDocument.findUnique({ where: { id: quoteId }, include: { lines: { orderBy: { sortOrder: "asc" } } } });
  if (!q || q.lines.length === 0) return { ok: false, error: "The quote has no lines to bill." };
  const share = percent / 100;
  const money = (v: unknown) => Math.round(Number(v ?? 0) * share * 100) / 100;
  const stageNote = `${label} — ${roundPercent(percent)}% of ${docNumber ?? "the quote"}`;
  const address = (p: "billing" | "shipping") => ({
    attention: q[`${p}Attention`] ?? "",
    line1: q[`${p}Line1`] ?? "",
    line2: q[`${p}Line2`] ?? "",
    city: q[`${p}City`] ?? "",
    state: q[`${p}State`] ?? "",
    stateCode: q[`${p}StateCode`] ?? "",
    pincode: q[`${p}Pincode`] ?? "",
    country: q[`${p}Country`] ?? "",
    phone: q[`${p}Phone`] ?? "",
  });
  const created = await createTradeDocument(
    {
      docType: "INVOICE",
      companyId: q.companyId,
      locationId: q.locationId,
      docNumber: "",
      placeOfSupplyCode: q.placeOfSupplyCode,
      gstTreatment: q.gstTreatment,
      buyerGstin: q.buyerGstin ?? "",
      reverseCharge: q.reverseCharge,
      currency: q.currency,
      exchangeRate: Number(q.exchangeRate),
      issueDate: (await workspaceClock()).today(),
      dueDate: "",
      validUntil: "",
      reference: q.reference ?? "",
      salespersonId: q.salespersonId ?? "",
      notes: [stageNote, q.notes].filter(Boolean).join("\n\n"),
      terms: q.terms ?? "",
      dispatchFromAddress: q.dispatchFromAddress ?? "",
      billing: address("billing"),
      shippingSameAsBilling: q.shippingSameAsBilling,
      shipping: address("shipping"),
      shippingGstin: q.shippingGstin ?? "",
      shippingCharge: money(q.shippingCharge),
      shippingTaxRatePercent: Number(q.shippingTaxRatePercent ?? 0),
      withholdingMode: q.withholdingMode,
      withholdingSection: q.withholdingSection ?? "",
      withholdingRatePercent: Number(q.withholdingRatePercent ?? 0),
      adjustmentLabel: q.adjustmentLabel ?? "",
      adjustment: money(q.adjustment),
      sourceDocumentId: q.id,
      leadId: q.leadId ?? "",
      againstDocumentId: "",
      lines: q.lines.map((l) => ({
        itemId: l.itemId ?? "",
        companyProductId: l.companyProductId ?? "",
        name: l.name,
        description: [stageNote, l.description].filter(Boolean).join(" · "),
        hsnCode: l.hsnCode ?? "",
        unit: l.unit ?? "",
        // The quantity as quoted, each at its share of the price — "10 licences at 30%" reads as the quote did.
        quantity: Number(l.quantity),
        unitPrice: Math.round(Number(l.unitPrice) * share * 10000) / 10000,
        discountMode: l.discountMode,
        discountValue: l.discountMode === "AMOUNT" ? money(l.discountValue) : Number(l.discountValue),
        taxRatePercent: Number(l.taxRatePercent),
      })),
    },
    "CONVERSION",
  );
  if (!created.ok) return created;
  // Security audit round three, 14 Nov 2026 (R3-17): read again under the quote's lock, with this invoice in
  // it. If another raise got there first — the same stage, or a share that leaves too little — this draft is
  // cancelled and the click refused, so the quote is never billed past 100% or a stage twice.
  const invoiceId = created.data.id;
  const refusal = await db.$transaction(async (tx) => {
    await lockQuoteBilling(tx, quoteId);
    const now = await billingProgress(quoteId, tx);
    const mine = await tx.tradeDocument.findUnique({ where: { id: invoiceId }, select: { total: true } });
    const total = now?.total ?? 0;
    const others = (now?.billed ?? 0) - Number(mine?.total ?? 0);
    const othersPercent = total > 0 ? roundPercent((others / total) * 100) : 0;
    const stageNow = now?.stages.find((s) => s.id === stageId);
    const why = !now
      ? "That quote no longer exists."
      : stageNow && stageNow.status !== "NOT_BILLED"
        ? `"${label}" is invoiced already, on ${stageNow.invoice?.docNumber ?? "a draft"}.`
        : overBilled({ billedPercent: othersPercent, leftPercent: Math.max(0, roundPercent(100 - othersPercent)) }, percent);
    if (why) {
      await tx.tradeDocument.update({
        where: { id: invoiceId },
        data: { status: "CANCELLED", cancelReason: "Raised twice at once — the other invoice was kept.", cancelledAt: new Date(), cancelledById: userId },
      });
      return why;
    }
    await tx.quoteBillingStage.update({ where: { id: stageId }, data: { invoiceId } });
    return null;
  });
  if (refusal) return { ok: false, error: refusal };
  await acceptQuote(quoteId, userId, `invoiced in stages, ${label}`);
  await recordAudit({ userId, action: "CREATE", entityType: "TradeDocument", entityId: created.data.id, entityLabel: `Invoice for ${stageNote}`.slice(0, 500) });
  revalidatePath(`/documents/${quoteId}`, "layout");
  return created;
}
