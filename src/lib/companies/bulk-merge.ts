/**
 * Which duplicate pairs may be merged in bulk (owner, 13 Nov 2026: "records which has no orders, invoice documents can
 * be bulk merged and records which has orders and invoice documents gets merged by hand"). No database in here.
 *
 * A pair goes in bulk only when it shares a GSTIN or PAN (the same name alone no longer counts — R3-24 below) and
 * neither company has any business on it: no order, subscription, quote, invoice, payment,
 * ledger entry, voucher, stock document, vendor credit or statement, expense, schedule, TDS certificate, and no
 * document kept from an old system. Everything else — a likely match, or one with any of that — is for a person.
 *
 * Each company is in at most one bulk merge a run: A–B and B–C can't both go at once, as B is gone after the first. The
 * next run finds B–C again as A–C, with A holding what B had.
 */

import { zohoInvoicesFirst } from "@/lib/companies/duplicate-groups";

export type BulkSubject = {
  id: string;
  companySeq: number;
  /** What a person weighs before merging: any of these, and the pair is theirs. */
  business: number;
  /** Everything else under it — people, leads, tickets — for which one to keep. */
  records: number;
  /** Zoho Books invoices under it: the one with them is kept, before `records` (owner, 14 Nov 2026). */
  zohoInvoices?: number;
};

/** `reasons` as src/lib/companies/duplicates.ts words them: "Same GSTIN …", "Same PAN …", "Same name …". */
export type BulkPair = { aId: string; bId: string; strength: "strong" | "likely"; reasons?: readonly string[] };

/**
 * Security audit round three, 14 Nov 2026 (R3-24): whether a pair shares a GSTIN or PAN — what identifies a business.
 * The same name once Pvt and Ltd are set aside is still a strong match on the list, but two "Sharma Traders" in two
 * cities are two customers; merged in bulk they'd be one, for good. A name-only pair is for a person, one by one.
 */
export function sharesTaxId(pair: BulkPair): boolean {
  return (pair.reasons ?? []).some((r) => r.startsWith("Same GSTIN") || r.startsWith("Same PAN"));
}

/** Whether a pair is for the bulk merge, and why not when it isn't — a name-only match is "likely" here. */
export function bulkVerdict(pair: BulkPair, a: BulkSubject, b: BulkSubject): { ok: true } | { ok: false; why: "likely" | "business" } {
  if (pair.strength !== "strong") return { ok: false, why: "likely" };
  if (a.business > 0 || b.business > 0) return { ok: false, why: "business" };
  if (!sharesTaxId(pair)) return { ok: false, why: "likely" };
  return { ok: true };
}

/**
 * The one kept: the one with Zoho Books invoices, else the older record. Never by `records` (security review, 15 Nov
 * 2026 — ADV-01): contacts, leads and tickets are what anybody who reaches a company can add, so a padded count chose
 * which company survived. A bulk pair has no business on either side, so the older record is the original.
 */
export function keeperOf(a: BulkSubject, b: BulkSubject): { keep: BulkSubject; drop: BulkSubject } {
  const zoho = zohoInvoicesFirst(a, b);
  const aFirst = zoho !== 0 ? zoho < 0 : a.companySeq < b.companySeq;
  return aFirst ? { keep: a, drop: b } : { keep: b, drop: a };
}

/** The pairs to merge this run, each company in one at most, the order kept. */
export function bulkBatch(pairs: BulkPair[], byId: Map<string, BulkSubject>, limit: number): { keepId: string; dropId: string }[] {
  const used = new Set<string>();
  const out: { keepId: string; dropId: string }[] = [];
  for (const p of pairs) {
    if (out.length >= limit) break;
    const a = byId.get(p.aId);
    const b = byId.get(p.bId);
    if (!a || !b || used.has(a.id) || used.has(b.id)) continue;
    if (!bulkVerdict(p, a, b).ok) continue;
    const { keep, drop } = keeperOf(a, b);
    used.add(keep.id);
    used.add(drop.id);
    out.push({ keepId: keep.id, dropId: drop.id });
  }
  return out;
}

/**
 * Security audit round three, 14 Nov 2026 (R3-24): how many pairs one press merges, and one workspace in a day — a
 * mistake in bulk stays bounded, and there is time to notice it. The day's count is read from the audit log.
 */
export const BULK_PER_CALL = 25;
export const BULK_PER_DAY = 200;

/** What the person types to confirm a bulk merge — the workspace's name — compared without case or extra spaces. */
export function bulkConfirmMatches(typed: unknown, workspaceName: string): boolean {
  const norm = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();
  return typeof typed === "string" && norm(typed) !== "" && norm(typed) === norm(workspaceName);
}

/** Choices a bulk merge may take from the duplicate: blanks filled, never a decision somebody made on purpose. */
export const BULK_NEVER_FROM_DUPLICATE = new Set(["ownerUserId", "assignedToUserId", "creditLimit", "paymentTerms", "name"]);
