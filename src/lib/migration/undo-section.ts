import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { DEPENDENTS, sectionOfRecord } from "./sections";
import { MigrationRefused, takeBack, type MigrationRow } from "./state";
import { STEPS, type StepKey } from "./steps";

/**
 * Undoing one section of an open switch (owner, 28 Oct 2026), not the whole of it. What the section brought goes, in
 * the order the whole undo takes things back (`takeBack`, ./state.ts), with what is set against it first: undoing
 * invoices first takes back the credit notes applied to them and the receipts that paid them; undoing bills, the vendor
 * credits and payments set against them. The page shows exactly that before it happens (`planSectionUndo`).
 *
 * Refused when something made in Deskzo itself — not by the switch — is set against what would go: a payment recorded
 * here against a migrated invoice, a credit note raised here, an order converted from a migrated quote. Taking those back
 * is somebody's decision about real records, not the switch's.
 *
 * Afterwards the sections' files are as if not yet imported: importing again brings them back.
 */

type Record = { id: string; kind: string; key: string; recordId: string };

/** A record's own key and the keys of what was made with it — its entry, a receipt's TDS and its entry. */
const familyOf = (kind: string, key: string): string[] =>
  kind === "payment" ? [key, `${key}:TDS`, `PAYMENT:${key}:entry`, `PAYMENT:${key}:TDS:entry`] : [key, `${key}:entry`];

export type SectionUndoPlan = {
  step: StepKey;
  /** What the section itself brought: documents, payments, credits or vouchers. */
  own: number;
  /** What goes with it, by section. */
  dependents: { step: StepKey; count: number }[];
  /** Why it can't be undone, when it can't. */
  refusal: string | null;
  /** MigrationRecord ids to take back — the server's, never sent to the page. */
  scope: Set<string>;
};

/** A unit's own record — not an entry, not a receipt's TDS — which is what the section's count counts. */
const isOwn = (r: Record) => !r.key.endsWith(":entry") && !r.key.endsWith(":TDS");

export async function planSectionUndo(m: MigrationRow, step: StepKey): Promise<SectionUndoPlan> {
  const records: Record[] = await db.migrationRecord.findMany({ where: { migrationId: m.id }, select: { id: true, kind: true, key: true, recordId: true } });
  const byKey = new Map(records.map((r) => [r.key, r]));
  const own = records.filter((r) => sectionOfRecord(r.kind, r.key) === step);
  const scope = new Set(own.map((r) => r.id));
  const dependents: SectionUndoPlan["dependents"] = [];
  let refusal: string | null = null;

  const docIds = own.filter((r) => r.kind === "document").map((r) => r.recordId);
  const migratedPayments = new Set(records.filter((r) => r.kind === "payment").map((r) => r.recordId));
  const migratedDocs = new Set(records.filter((r) => r.kind === "document").map((r) => r.recordId));
  const migratedCredits = new Set(records.filter((r) => r.kind === "vendor-credit").map((r) => r.recordId));
  /** Adds the records of these made things — and what was made with each — to what goes, counted under `dep`. */
  const take = (dep: StepKey, kind: string, ids: string[]) => {
    const wanted = new Set(ids);
    const roots = records.filter((r) => r.kind === kind && wanted.has(r.recordId) && sectionOfRecord(r.kind, r.key) === dep && isOwn(r));
    for (const root of roots) for (const key of familyOf(root.kind, root.key)) {
      const r = byKey.get(key);
      if (r) scope.add(r.id);
    }
    if (roots.length) dependents.push({ step: dep, count: roots.length });
  };

  if (docIds.length && DEPENDENTS[step]) {
    const [allocations, notes, credits, converted] = await Promise.all([
      db.paymentAllocation.findMany({ where: { documentId: { in: docIds } }, select: { paymentId: true } }),
      db.creditNoteApplication.findMany({ where: { invoiceId: { in: docIds } }, select: { creditNoteId: true } }),
      db.vendorCreditApplication.findMany({ where: { billId: { in: docIds } }, select: { vendorCreditId: true } }),
      db.tradeDocument.count({ where: { sourceDocumentId: { in: docIds } } }),
    ]);
    const outside = [
      allocations.some((a) => !migratedPayments.has(a.paymentId)) ? "payments recorded in Deskzo" : "",
      notes.some((n) => !migratedDocs.has(n.creditNoteId)) ? "credit notes raised in Deskzo" : "",
      credits.some((c) => !migratedCredits.has(c.vendorCreditId)) ? "vendor credits entered in Deskzo" : "",
      converted ? "documents converted from them" : "",
    ].filter(Boolean);
    if (outside.length) refusal = `Some of these have ${outside.join(" and ")} set against them. Take those off first — the switch only undoes what it brought.`;
    if (step === "invoices") {
      take("credit-notes", "document", notes.map((n) => n.creditNoteId));
      take("receipts", "payment", allocations.map((a) => a.paymentId));
    } else if (step === "bills") {
      take("vendor-credits", "vendor-credit", credits.map((c) => c.vendorCreditId));
      take("vendor-payments", "payment", allocations.map((a) => a.paymentId));
    }
  } else if (docIds.length) {
    // An open quote, order or PO brought live: one converted since is in use.
    const converted = await db.tradeDocument.count({ where: { sourceDocumentId: { in: docIds } } });
    if (converted) refusal = `${converted.toLocaleString("en-IN")} ${converted === 1 ? "document was" : "documents were"} converted from these in Deskzo. Undo can't take them back from under it.`;
  }
  return { step, own: own.filter(isOwn).length, dependents, refusal, scope };
}

/** Undoes the section and what depends on it; their files go back to not imported. */
export async function undoSection(m: MigrationRow, step: StepKey, userId: string) {
  if (m.status !== "OPEN") throw new MigrationRefused(m.status === "FINISHED" ? "A finished migration can't be undone — its months are locked." : "It has been undone already.");
  const plan = await planSectionUndo(m, step);
  if (plan.refusal) throw new MigrationRefused(plan.refusal);
  if (plan.scope.size === 0) throw new MigrationRefused("This section hasn't brought anything across yet.");
  const taken = await takeBack(m.id, plan.scope);
  const steps = [step, ...plan.dependents.map((d) => d.step)];
  // Its files as if not yet imported, and the counts without what went.
  await db.migrationFile.updateMany({ where: { migrationId: m.id, step: { in: steps } }, data: { done: 0, failures: [] as unknown as Prisma.InputJsonValue } });
  const less = { [step]: plan.own, ...Object.fromEntries(plan.dependents.map((d) => [d.step, d.count])) };
  await db.$transaction(async (tx) => {
    const row = await tx.migration.findUniqueOrThrow({ where: { id: m.id }, select: { counts: true } });
    const counts = { ...((row.counts as globalThis.Record<string, number> | null) ?? {}) };
    for (const [k, n] of Object.entries(less)) counts[k] = Math.max(0, (counts[k] ?? 0) - n);
    await tx.migration.update({ where: { id: m.id }, data: { counts } });
  });
  const label = (k: StepKey) => STEPS.find((s) => s.key === k)!.units;
  const what = [`${plan.own} ${label(step)}`, ...plan.dependents.map((d) => `${d.count} ${label(d.step)}`)].join(", ");
  await recordAudit({ userId, action: "DELETE", entityType: "Migration", entityId: m.id, entityLabel: `Undid one section of the switch: ${what} taken back, with ${taken.entries} journal entries` });
  return { taken, own: plan.own, dependents: plan.dependents };
}
