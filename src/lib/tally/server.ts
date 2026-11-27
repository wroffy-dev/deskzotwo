import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { mastersFile, vouchersFile } from "@/lib/tally/xml";
import { decodeTallyFile, parseTallyMasters } from "@/lib/tally/masters";
import { accountKey, accountName, nameBook, planExport, type ExportPlan, type ExportSummary } from "@/lib/tally/build";

/**
 * The Tally export's state (owner, 23 Nov 2026 — src/lib/tally): its settings, Tally's masters, the name mappings, the
 * exports and what is locked by them. Who may: src/actions/tally.ts.
 */

export type TallyConfig = { migrated: boolean; booksIn: "DESKZO" | "TALLY"; companyName: string | null; itemLines: boolean; startDate: string | null; mastersFile: string | null; mastersAt: Date | null; masters: number };

export async function tallyConfig(): Promise<TallyConfig> {
  try {
    const [row, masters] = await Promise.all([db.tallySettings.findUnique({ where: { id: "global" } }), db.tallyMaster.count()]);
    return {
      migrated: true,
      booksIn: row?.booksIn === "TALLY" ? "TALLY" : "DESKZO",
      companyName: row?.companyName ?? null,
      itemLines: row?.itemLines ?? true,
      startDate: row?.startDate ? row.startDate.toISOString().slice(0, 10) : null,
      mastersFile: row?.mastersFile ?? null,
      mastersAt: row?.mastersAt ?? null,
      masters,
    };
  } catch (err) {
    if (notMigratedYet(err)) return { migrated: false, booksIn: "DESKZO", companyName: null, itemLines: true, startDate: null, mastersFile: null, mastersAt: null, masters: 0 };
    throw err;
  }
}

/** Whether Tally keeps this workspace's books — Deskzo's ledger pages then say "Kept in Tally". */
export async function booksInTally(): Promise<boolean> {
  return (await tallyConfig()).booksIn === "TALLY";
}

export async function saveTallyConfig(input: { booksIn: "DESKZO" | "TALLY"; companyName: string | null; itemLines: boolean; startDate: string | null }, userId: string): Promise<void> {
  const data = { booksIn: input.booksIn, companyName: input.companyName, itemLines: input.itemLines, startDate: input.startDate ? new Date(`${input.startDate}T00:00:00Z`) : null, updatedById: userId };
  await db.tallySettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data, select: { id: true } });
}

/** Tally's masters, from the file the accountant exported: replaces what was there. */
export async function saveTallyMasters(fileName: string, bytes: Uint8Array, userId: string): Promise<{ ledgers: number; items: number }> {
  const parsed = parseTallyMasters(decodeTallyFile(bytes));
  await db.$transaction(async (tx) => {
    await tx.tallyMaster.deleteMany({});
    for (let i = 0; i < parsed.length; i += 1000) await tx.tallyMaster.createMany({ data: parsed.slice(i, i + 1000), skipDuplicates: true });
    await tx.tallySettings.upsert({ where: { id: "global" }, create: { id: "global", mastersFile: fileName.slice(0, 200), mastersAt: new Date(), updatedById: userId }, update: { mastersFile: fileName.slice(0, 200), mastersAt: new Date(), updatedById: userId }, select: { id: true } });
  }, { timeout: 60_000 });
  return { ledgers: parsed.filter((m) => m.kind === "LEDGER").length, items: parsed.filter((m) => m.kind === "STOCKITEM").length };
}

export async function setTallyMapping(key: string, tallyName: string | null, userId: string): Promise<void> {
  if (!tallyName) await db.tallyMapping.deleteMany({ where: { key } });
  else await db.tallyMapping.upsert({ where: { key }, create: { key, tallyName, source: "MATCHED", updatedById: userId }, update: { tallyName, source: "MATCHED", updatedById: userId }, select: { id: true } });
}

// ─── The mapping screen ───────────────────────────────────────────────────────────────────────────────────────────

export type AccountRow = { id: string; code: string; name: string; tallyName: string | null; how: "MAPPED" | "SAME NAME" | "MISSING"; rates: { rate: number; tallyName: string | null }[] };

/** Every account the sales side posts to (but receivables, which is each customer's own ledger), and its Tally name. */
export async function accountsToMap(): Promise<AccountRow[]> {
  const used = await db.journalLine.groupBy({ by: ["accountId"], where: { entry: { source: { in: ["INVOICE", "CREDIT_NOTE", "DEBIT_NOTE", "PAYMENT"] } } }, _count: { _all: true } });
  const accounts = await db.ledgerAccount.findMany({ // Not NOT: a NOT over a null column drops the row (an account with no system key is most of them).
    where: { id: { in: used.map((u) => u.accountId) }, OR: [{ systemKey: null }, { systemKey: { not: "AR" } }] }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, systemKey: true, type: true } });
  // Per-rate names, where an income or output tax account is split by GST rate in Tally.
  const rates = (await db.tradeDocumentLine.groupBy({ by: ["taxRatePercent"], where: { document: { direction: "SALES", docType: { in: ["INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"] } } } })).map((r) => Number(r.taxRatePercent)).sort((a, b) => a - b);
  const book = await nameBook();
  return accounts.map((a) => {
    const mapped = book.mapping.get(accountKey(a.id));
    const same = accountName(book, a);
    const splittable = a.type === "INCOME" || ["OUTPUT_CGST", "OUTPUT_SGST", "OUTPUT_IGST"].includes(a.systemKey ?? "");
    return {
      id: a.id,
      code: a.code,
      name: a.name,
      tallyName: same,
      how: mapped ? "MAPPED" : same ? "SAME NAME" : "MISSING",
      rates: splittable ? rates.map((rate) => ({ rate, tallyName: book.mapping.get(accountKey(a.id, rate)) ?? null })) : [],
    };
  });
}

/** The ledger and item names Tally has, for the pickers. */
export async function tallyNames(): Promise<{ ledgers: string[]; items: string[] }> {
  const rows = await db.tallyMaster.findMany({ orderBy: { name: "asc" }, select: { kind: true, name: true } });
  return { ledgers: rows.filter((r) => r.kind === "LEDGER").map((r) => r.name), items: rows.filter((r) => r.kind === "STOCKITEM").map((r) => r.name) };
}

// ─── Exports ──────────────────────────────────────────────────────────────────────────────────────────────────────

export class TallyRefusal extends Error {}

/** What an export of the period would hold — nothing written. */
export async function previewExport(from: string, to: string): Promise<ExportPlan> {
  const config = await tallyConfig();
  return planExport(from, to, { itemLines: config.itemLines, startDate: config.startDate });
}

/** Makes the export: both files, its records (each locked from now on) and the new masters remembered. */
export async function runExport(from: string, to: string, userId: string): Promise<{ id: string; exportSeq: number; vouchers: number }> {
  const config = await tallyConfig();
  if (!config.companyName) throw new TallyRefusal("Say which Tally company the files are for first — its name exactly as Tally shows it.");
  const plan = await planExport(from, to, { itemLines: config.itemLines, startDate: config.startDate });
  if (plan.unmatched.length) throw new TallyRefusal(`Match ${plan.unmatched.length === 1 ? "this account" : `these ${plan.unmatched.length} accounts`} to Tally ledgers first: ${plan.unmatched.map((u) => u.label).join(", ")}.`);
  if (!plan.vouchers.length) throw new TallyRefusal("Nothing to send for that period — everything in it went in an earlier export, or there's nothing yet.");
  const company = config.companyName;
  const made = await db.$transaction(
    async (tx) => {
      const exp = await tx.tallyExport.create({
        data: {
          fromDate: new Date(`${plan.summary.from}T00:00:00Z`),
          toDate: new Date(`${to}T00:00:00Z`),
          companyName: company,
          mastersXml: mastersFile(company, plan.masters),
          vouchersXml: vouchersFile(company, plan.vouchers),
          summary: { ...plan.summary, skipped: plan.skipped } as unknown as Prisma.InputJsonValue,
          createdById: userId,
        },
        select: { id: true, exportSeq: true },
      });
      // Once each: a record already in another export makes the whole export fail rather than send it twice.
      await tx.tallyExportRecord.createMany({ data: plan.records.map((r) => ({ ...r, exportId: exp.id })) });
      for (const c of plan.created) await tx.tallyMapping.upsert({ where: { key: c.key }, create: { key: c.key, tallyName: c.name, source: "CREATED", updatedById: userId }, update: {}, select: { id: true } });
      return exp;
    },
    { timeout: 60_000 },
  );
  return { ...made, vouchers: plan.vouchers.length };
}

export type ExportRow = { id: string; exportSeq: number; from: string; to: string; companyName: string; status: string; createdAt: string; importedAt: string | null;
  /** Waiting for Tally more than a week — flagged on the page. */
  stale: boolean; summary: ExportSummary & { skipped?: { label: string; why: string }[] }; vouchers: number };

export async function listExports(take = 30, now = new Date()): Promise<ExportRow[]> {
  const rows = await db.tallyExport.findMany({ orderBy: { createdAt: "desc" }, take, select: { id: true, exportSeq: true, fromDate: true, toDate: true, companyName: true, status: true, createdAt: true, importedAt: true, summary: true, _count: { select: { records: true } } } });
  return rows.map((r) => ({
    id: r.id,
    exportSeq: r.exportSeq,
    from: r.fromDate.toISOString().slice(0, 10),
    to: r.toDate.toISOString().slice(0, 10),
    companyName: r.companyName,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    importedAt: r.importedAt?.toISOString() ?? null,
    stale: r.status === "WAITING" && r.createdAt.getTime() < now.getTime() - 7 * 86_400_000,
    summary: r.summary as unknown as ExportRow["summary"],
    vouchers: r._count.records,
  }));
}

export async function markImported(id: string, userId: string): Promise<void> {
  const done = await db.tallyExport.updateMany({ where: { id, status: "WAITING" }, data: { status: "IMPORTED", importedAt: new Date(), importedById: userId } });
  if (!done.count) throw new TallyRefusal("That export is marked already, or isn't there any more.");
}

export async function exportFile(id: string, file: "masters" | "vouchers"): Promise<{ name: string; xml: string } | null> {
  const row = await db.tallyExport.findUnique({ where: { id }, select: { exportSeq: true, mastersXml: true, vouchersXml: true } });
  if (!row) return null;
  return { name: `deskzo-tally-${row.exportSeq}-${file}.xml`, xml: file === "masters" ? row.mastersXml : row.vouchersXml };
}

// ─── The lock ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Why these records can't be changed: they've gone to Tally (decision 4 — a mistake is corrected with a credit or debit
 * note, which goes in the next export). Null when none has.
 */
export async function tallyLockRefusal(kind: "DOCUMENT" | "PAYMENT", ids: string[]): Promise<string | null> {
  if (!ids.length) return null;
  try {
    const hit = await db.tallyExportRecord.findFirst({ where: { kind, recordId: { in: ids } }, select: { voucherNumber: true, export: { select: { exportSeq: true } } } });
    if (!hit) return null;
    return kind === "DOCUMENT"
      ? `${hit.voucherNumber} has gone to Tally (export ${hit.export.exportSeq}), so it can't be changed or cancelled here — correct it with a credit or debit note, which goes in the next export.`
      : `${hit.voucherNumber} has gone to Tally (export ${hit.export.exportSeq}), so it can't be changed or deleted here — correct it in Tally.`;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}
