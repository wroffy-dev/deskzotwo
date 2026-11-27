import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { notMigratedYet } from "@/lib/not-migrated";

type Client = typeof db | Prisma.TransactionClient;

/**
 * Security audit round three, 14 Nov 2026 (R3-17): billing a stage was read-check-create, so a double click
 * raised two invoices for one stage, or two shares that together passed 100%. Raising a stage's invoice now
 * ends in a transaction holding this lock on the quote, which reads the billing again and keeps the new
 * invoice only if it still fits — two raises at once are checked one after the other.
 */
export async function lockQuoteBilling(tx: Prisma.TransactionClient, quoteId: string): Promise<void> {
  const key = `deskzo:progress-billing:${quoteId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/**
 * The quote's invoices: converted from it, or (R3-17) from a proforma converted from it — the proforma route
 * used to be invisible here, so a quote could be billed in full through it and again in stages.
 */
export const quoteInvoicesWhere = (quoteId: string): Prisma.TradeDocumentWhereInput => ({
  docType: "INVOICE",
  OR: [{ sourceDocumentId: quoteId }, { sourceDocument: { docType: "PROFORMA", sourceDocumentId: quoteId } }],
});

/**
 * Progress invoicing (owner, 3 Nov 2026 — "I like this in Zoho": bill a quote in stages). A quote's stages — "Advance
 * 30% · On delivery 50% · On sign-off 20%" — are each invoiced on their own, every line of the quote at that share.
 *
 * What is billed is read from the quote's own invoices (`sourceDocumentId`), not kept: a stage's invoice cancelled is
 * a stage unbilled again, a plain "Convert to invoice" counts in full, and nothing can bill past 100% of the quote.
 */

export type StageStatus = "NOT_BILLED" | "DRAFT" | "INVOICED" | "PAID";
export type BillingStageView = {
  id: string;
  label: string;
  percent: number;
  amount: number;
  status: StageStatus;
  invoice: { id: string; docNumber: string | null } | null;
};
export type BillingProgress = {
  total: number;
  currency: string;
  /** What the quote's invoices (not cancelled) come to, and that as a share of the quote. */
  billed: number;
  billedPercent: number;
  /** Share left to bill, never below nothing. */
  leftPercent: number;
  stages: BillingStageView[];
  /** The first stage not billed yet — what "What's next?" points at. */
  next: BillingStageView | null;
};

/** Quotes are the documents billed in stages. */
export const STAGED_TYPES = ["PROPOSAL"] as const;

/** A share kept to three places, as the column is: 33.333. */
export const roundPercent = (p: number) => Math.round(p * 1000) / 1000;
/** Billed past 100% by no more than rounding. */
const TOLERANCE = 0.01;

export async function billingProgress(quoteId: string, client: Client = db): Promise<BillingProgress | null> {
  const quote = await client.tradeDocument.findUnique({ where: { id: quoteId }, select: { docType: true, total: true, currency: true } });
  if (!quote || quote.docType !== "PROPOSAL") return null;
  const total = Number(quote.total);
  const invoices = await client.tradeDocument.findMany({
    where: quoteInvoicesWhere(quoteId),
    select: { id: true, docNumber: true, status: true, total: true },
  });
  const live = invoices.filter((i) => i.status !== "CANCELLED");
  const billed = live.reduce((t, i) => t + Number(i.total), 0);
  const billedPercent = total > 0 ? roundPercent((billed / total) * 100) : 0;
  const rows = await client.quoteBillingStage
    .findMany({ where: { documentId: quoteId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, label: true, percent: true, invoiceId: true } })
    .catch((err) => {
      if (notMigratedYet(err)) return [];
      throw err;
    });
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const stages = rows.map((r) => {
    const inv = r.invoiceId ? byId.get(r.invoiceId) : undefined;
    const status: StageStatus = !inv || inv.status === "CANCELLED" ? "NOT_BILLED" : inv.status === "PAID" ? "PAID" : inv.status === "DRAFT" ? "DRAFT" : "INVOICED";
    const percent = Number(r.percent);
    return {
      id: r.id,
      label: r.label,
      percent,
      amount: Math.round(total * percent) / 100,
      status,
      invoice: inv && inv.status !== "CANCELLED" ? { id: inv.id, docNumber: inv.docNumber } : null,
    };
  });
  return {
    total,
    currency: quote.currency,
    billed,
    billedPercent,
    leftPercent: Math.max(0, roundPercent(100 - billedPercent)),
    stages,
    next: stages.find((s) => s.status === "NOT_BILLED") ?? null,
  };
}

/** Why billing this share now would go past the whole quote, or null. */
export function overBilled(progress: Pick<BillingProgress, "billedPercent" | "leftPercent">, percent: number): string | null {
  if (!(percent > 0)) return "Bill a share greater than nothing.";
  if (progress.billedPercent + percent > 100 + TOLERANCE) {
    return progress.leftPercent > 0
      ? `That's more than is left to bill — ${progress.leftPercent}% of the quote.`
      : "The whole quote is billed already.";
  }
  return null;
}
