import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveAccounts, writeEntry } from "@/lib/ledger/journal";
import { refreshSettledStatus, settlementOf } from "@/lib/migration/documents";
import { MigrationRefused, type MigrationRow } from "@/lib/migration/state";

/**
 * Advances from before the year, carried into it (owner, 17 Nov 2026 — "why payments not settled? still shows
 * unpaid"). A customer paid ahead before the year began; Zoho later set that money against this year's invoices. The
 * switch brings only payments dated inside the year, so those invoices came across owing though they were paid.
 *
 * Each such payment — kept in the earlier years' archive, with what it paid and, from Zoho's pull, the day it was
 * applied — is brought in as an **opening advance**: a payment on its own day, set against the invoices Zoho set it
 * against on or after the year's first day (with any TDS withheld from them), and what is still unused on account.
 *
 * The money was received before the year, so it is already in the opening balances one way or the other:
 *   · the customer's balance is in the opening trial balance (Accounting › Journal › Import opening balances) — then
 *     nothing is posted, as the credit is already in Receivables;
 *   · the customer was left out of it, as one whose open invoices were imported is — then what is carried is posted on
 *     the year's first day, Receivables against Opening Balance Equity, as an open credit note is.
 * Never twice. A payment in another currency, or of a customer not in Deskzo, is named and left.
 */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const BATCH = 100;

type Line = { number: string; amount: number; withheld?: number; on?: string };
export type AdvanceRow = {
  number: string;
  party: string;
  date: string;
  applied: { number: string; amount: number; on: string | null }[];
  unused: number;
  carried: number;
  /** "post": posted against Opening Balance Equity; "opening": already in the opening trial balance. */
  books: "post" | "opening";
  left: string | null;
};
export type Advances = { rows: AdvanceRow[]; toCarry: number; carried: number; left: number };
type Planned = AdvanceRow & { archivedId: string; companyId: string | null; allocations: { documentId: string; amount: number; on: Date }[] };

const keyOf = (archivedKey: string) => `ADVANCE:${archivedKey}`;

async function plan(m: MigrationRow): Promise<Planned[]> {
  const archived = await db.archivedDocument.findMany({
    where: { migrationId: m.id, kind: "CUSTOMER_PAYMENT" },
    select: { id: true, key: true, number: true, date: true, partyName: true, companyId: true, currency: true, balance: true, lines: true },
  });
  const done = new Set((await db.migrationRecord.findMany({ where: { migrationId: m.id, kind: "payment", key: { startsWith: "ADVANCE:" } }, select: { key: true } })).map((r) => r.key));
  const candidates = archived.filter((a) => !done.has(keyOf(a.key)));
  const linesOf = (a: (typeof archived)[number]) => (Array.isArray(a.lines) ? (a.lines as Line[]) : []).filter((l) => l && typeof l.number === "string" && l.number);
  const numbers = [...new Set(candidates.flatMap((a) => linesOf(a).map((l) => l.number)))];
  const invoices: { id: string; docNumber: string | null; companyId: string; issueDate: Date }[] = [];
  for (let i = 0; i < numbers.length; i += 1000) {
    invoices.push(...(await db.tradeDocument.findMany({ where: { docType: "INVOICE", docNumber: { in: numbers.slice(i, i + 1000) }, status: { notIn: ["DRAFT", "CANCELLED"] } }, select: { id: true, docNumber: true, companyId: true, issueDate: true } })));
  }
  // Customers already carried by the opening trial balance: a balance of theirs on Receivables from it.
  const companies = [...new Set(candidates.flatMap((a) => (a.companyId ? [a.companyId] : [])))];
  const inOpening = new Set(
    (
      await db.journalLine.groupBy({
        by: ["companyId"],
        where: { companyId: { in: companies }, account: { systemKey: "AR" }, entry: { source: "OPENING" } },
        _sum: { debit: true, credit: true },
      })
    )
      .filter((g) => Math.abs(Number(g._sum.debit ?? 0) - Number(g._sum.credit ?? 0)) >= 0.01)
      .map((g) => g.companyId!),
  );

  const out: Planned[] = [];
  const owing = new Map<string, number>();
  for (const a of candidates) {
    const allocations: Planned["allocations"] = [];
    const applied: AdvanceRow["applied"] = [];
    for (const l of linesOf(a)) {
      const inv = invoices.find((d) => d.docNumber === l.number && (!a.companyId || d.companyId === a.companyId));
      if (!inv) continue;
      // Set against it on or after the year's first day — said by the pull; for an older archive, an invoice of the year.
      const on = l.on ?? (inv.issueDate.toISOString().slice(0, 10) >= m.yearStart ? inv.issueDate.toISOString().slice(0, 10) : null);
      if (!on || on < m.yearStart) continue;
      const want = round2((Number(l.amount) || 0) + (Number(l.withheld) || 0));
      if (want <= 0) continue;
      if (!owing.has(inv.id)) owing.set(inv.id, (await settlementOf(db, inv.id))?.settlement.balance ?? 0);
      const amount = round2(Math.min(want, owing.get(inv.id)!));
      if (amount <= 0) continue;
      owing.set(inv.id, round2(owing.get(inv.id)! - amount));
      allocations.push({ documentId: inv.id, amount, on: new Date(`${on}T00:00:00Z`) });
      applied.push({ number: l.number, amount, on });
    }
    const unused = round2(Math.max(0, Number(a.balance ?? 0)));
    if (allocations.length === 0) continue; // nothing of this year's settled by it: the opening balances already hold it
    const carried = round2(allocations.reduce((n, x) => n + x.amount, 0) + unused);
    const left = !a.companyId ? "The customer isn't in Deskzo" : a.currency && a.currency.toUpperCase() !== "INR" ? `In ${a.currency} — bring this one by hand` : null;
    out.push({
      archivedId: a.id,
      companyId: a.companyId,
      allocations,
      number: a.number,
      party: a.partyName,
      date: a.date.toISOString().slice(0, 10),
      applied,
      unused,
      carried,
      books: a.companyId && inOpening.has(a.companyId) ? "opening" : "post",
      left,
    });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

/** The list a person checks before anything goes. Changes nothing. */
export async function advancesToCarry(m: MigrationRow): Promise<Advances> {
  const planned = await plan(m);
  const ready = planned.filter((p) => !p.left);
  return {
    rows: planned.map((p) => ({ number: p.number, party: p.party, date: p.date, applied: p.applied, unused: p.unused, carried: p.carried, books: p.books, left: p.left })),
    toCarry: ready.length,
    carried: round2(ready.reduce((n, p) => n + p.carried, 0)),
    left: planned.length - ready.length,
  };
}

/** Carries up to a hundred in: found again here, never from what the page sent. */
export async function carryAdvances(m: MigrationRow, userId: string): Promise<{ carried: number; amount: number; more: number }> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const ready = (await plan(m)).filter((p) => !p.left);
  const batch = ready.slice(0, BATCH);
  const yearStart = new Date(`${m.yearStart}T00:00:00Z`);
  let amount = 0;
  for (const p of batch) {
    const archived = await db.archivedDocument.findUniqueOrThrow({ where: { id: p.archivedId }, select: { key: true } });
    await db.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          companyId: p.companyId!,
          direction: "RECEIVED",
          amount: new Prisma.Decimal(p.carried),
          paidOn: new Date(`${p.date}T00:00:00Z`),
          method: "OTHER",
          reference: p.number,
          notes: `Advance received before the year (payment ${p.number} in the old system), carried into it`,
          bankAccountId: null,
          recordedByUserId: userId,
        },
        select: { id: true },
      });
      for (const a of p.allocations) {
        await tx.paymentAllocation.create({ data: { paymentId: payment.id, documentId: a.documentId, amount: new Prisma.Decimal(a.amount), allocatedByUserId: userId, createdAt: a.on } });
      }
      const key = keyOf(archived.key);
      await tx.migrationRecord.create({ data: { migrationId: m.id, kind: "payment", recordId: payment.id, key } });
      if (p.books === "post") {
        const accounts = await resolveAccounts(tx, ["AR", "OPENING_BALANCE_EQUITY"]);
        const entry = await writeEntry(tx, {
          date: yearStart,
          narration: `Opening balance — advance from ${p.party}, payment ${p.number} in the old system`,
          source: "PAYMENT",
          userId,
          paymentId: payment.id,
          companyId: p.companyId!,
          lines: [
            { accountId: accounts.get("OPENING_BALANCE_EQUITY")!, debit: p.carried, credit: 0 },
            { accountId: accounts.get("AR")!, debit: 0, credit: p.carried, companyId: p.companyId! },
          ],
        });
        await tx.migrationRecord.create({ data: { migrationId: m.id, kind: "journal", recordId: entry.id, key: `${key}:entry` } });
      }
      for (const id of new Set(p.allocations.map((a) => a.documentId))) await refreshSettledStatus(tx, id);
    });
    amount += p.carried;
  }
  return { carried: batch.length, amount: round2(amount), more: Math.max(0, ready.length - batch.length) };
}
