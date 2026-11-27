import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { runBackup } from "@/lib/backup/run";
import { getOrganisation } from "@/lib/organisation";
import { applyRow } from "./apply";
import type { Analysis } from "./analyse";
import { buildLookups, companyKey, ensureCustomFields, RecordCache, type Ctx, type Decisions, type Lookups } from "./context";
import { DECIDED_KINDS, isStrategy, kindDef, STEPS, type KindKey, type StrategyKey } from "./formats";
import { countOf, ImportRefused, rowsSlice } from "./store";
import { undoPart, type UndoProgress } from "./undo";
import { rematchArchive } from "@/lib/migration/archive";
import { openMigration } from "@/lib/migration/state";

/**
 * Running an import (src/lib/legacy-import). Starting it checks the preview's choices, takes a full backup — no
 * backup, no import — reads the reference tables once, and, to replace, first undoes the earlier imports. Then the
 * page calls `importStep` until it says it's done: each call works for a few seconds, a hundred or so rows at a time,
 * each row its own transaction; where it got to is kept on the run, so a closed tab or a failed call carries on.
 */

export type Counts = { created: number; updated: number; linked: number; unchanged: number; skipped: number; failed: number };
export type Progress = {
  phase: "undo-earlier" | "import" | "done";
  step: number;
  offset: number;
  counts: Partial<Record<string, Counts>>;
  /** Earlier imports a Replace undid, and what each kept. */
  replaced?: { importId: string; taken: number; kept: number }[];
  failure?: string | null;
};

/** The steps a run walks: the tables in order, the orders' links after the orders. */
export const RUN_STEPS: (KindKey | "customer_product_links")[] = STEPS.flatMap((k) => (k === "customer_product" ? [k, "customer_product_links" as const] : [k]));

export const stepLabel = (step: KindKey | "customer_product_links") => (step === "customer_product_links" ? "Order add-ons and renewals" : (kindDef(step)?.label ?? step));

const BATCH = 100;
const zero = (): Counts => ({ created: 0, updated: 0, linked: 0, unchanged: 0, skipped: 0, failed: 0 });

/** The columns a batch reads the old-id log for, by table — so a batch asks once, not once a row. */
const PRELOAD: Partial<Record<KindKey | "customer_product_links", [string, string][]>> = {
  billing_addresses: [["customer_id", "customers"]],
  shipping_addresses: [["customer_id", "customers"]],
  employees: [["customer_id", "customers"]],
  zoho_contact_persons: [["Customer ID", "zoho_contacts"]],
  zoho_vendor_contact_persons: [["Vendor ID", "zoho_vendors"]],
  customer_product: [["customer_id", "customers"], ["product_id", "products"], ["billing_address_id", "billing_addresses"]],
  customer_product_links: [["id", "customer_product"], ["parent_id", "customer_product"], ["renewal_id", "customer_product"]],
  leads: [["product_id", "products"]],
  lead_product: [["lead_id", "leads"], ["product_id", "products"]],
  product_tickets: [["customer_id", "customers"], ["customer_product_id", "customer_product"], ["contact_person_id", "employees"]],
  anonymous_tickets: [["customer_id", "customers"], ["contact_person_id", "employees"]],
  field_visits: [["customer_id", "customers"], ["lead_id", "leads"]],
};
const USER_COLUMNS = ["created_by", "assigned_to", "replier_id", "called_by"];

export const ZOHO_KINDS = ["zoho_contacts", "zoho_vendors", "zoho_items", "zoho_contact_persons", "zoho_vendor_contact_persons"] as const;
const hasZohoFiles = async (importId: string) => (await db.legacyImportFile.count({ where: { importId, kind: { in: [...ZOHO_KINDS] } } })) > 0;

export type StartInput = { strategy: string; decisions: Decisions; confirmed: boolean };

/** Starts the draft's import: the choices checked, the backup taken, the reference tables read. */
export async function startImport(importId: string, input: StartInput, userId: string) {
  const run = await db.legacyImport.findUnique({ where: { id: importId }, select: { status: true, analysis: true } });
  if (!run || run.status !== "DRAFT") throw new ImportRefused("That import has started already, or isn't there.");
  if (await db.legacyImport.findFirst({ where: { status: "IMPORTING" }, select: { id: true } })) throw new ImportRefused("Another import is running. Let it finish first.");
  // With Zoho's files, every company, item and person comes in once through the master lists: built, and every
  // suggestion settled, first.
  if (await hasZohoFiles(importId)) {
    if ((await db.legacyMatch.count({ where: { importId } })) === 0) throw new ImportRefused("This upload has Zoho Books files: build the master lists first, so each company comes in once.");
    const open = await db.legacyMatch.count({ where: { importId, status: "SUGGESTED" } });
    if (open) throw new ImportRefused(`The master lists still have ${open} suggestion${open === 1 ? "" : "s"} to settle — say Same or Not the same on each first.`);
  }
  const analysis = run.analysis as unknown as Analysis | null;
  if (!analysis) throw new ImportRefused("Preview the files first — the files or their columns changed since.");
  if (!input?.confirmed) throw new ImportRefused("Confirm the import after reading what it will do.");
  if (!isStrategy(input.strategy)) throw new ImportRefused("Choose how the files meet what's already there.");
  const strategy: StrategyKey = input.strategy;
  const matches = input.decisions?.matches ?? {};
  for (const kind of analysis.needsDecision) {
    if (matches[kind] !== "link" && matches[kind] !== "skip") throw new ImportRefused(`Choose what to do with the ${kindDef(kind)!.label.toLowerCase()} Deskzo already has.`);
  }
  const users: Record<string, string> = {};
  const deskzo = new Set(analysis.deskzoUsers.map((u) => u.id));
  for (const u of analysis.users) {
    const chosen = input.decisions?.users?.[u.oldId] ?? (u.match ? u.match.id : "create");
    if (chosen !== "create" && !deskzo.has(chosen)) throw new ImportRefused(`Choose who ${u.name} is in Deskzo.`);
    users[u.oldId] = chosen;
  }
  const decisions: Decisions = { matches: Object.fromEntries(DECIDED_KINDS.map((k) => [k, matches[k]]).filter(([, v]) => v)), users };

  // No backup, no import.
  const keepUntil = new Date(Date.now() + 30 * 86_400_000);
  const backup = await runBackup({ kind: "FULL", triggeredById: userId, reason: "Before importing the old CRM's data", keepUntil });
  if (!backup.ok) throw new ImportRefused(`The safety backup couldn't be taken, so nothing was imported: ${backup.error ?? "unknown error"}`);

  const lookups = await buildLookups(importId);
  const progress: Progress = { phase: strategy === "REPLACE" ? "undo-earlier" : "import", step: 0, offset: 0, counts: {}, failure: null };
  await db.legacyImport.update({
    where: { id: importId },
    data: { status: "IMPORTING", strategy, decisions: decisions as Prisma.InputJsonValue, lookups: lookups as unknown as Prisma.InputJsonValue, progress: progress as unknown as Prisma.InputJsonValue, backupId: backup.id, startedAt: new Date() },
  });
  await recordAudit({ userId, action: "CREATE", entityType: "LegacyImport", entityId: importId, entityLabel: `Started importing the old CRM's data (${strategy.toLowerCase()}); backup taken first` });
  return { backupId: backup.id };
}

export type StepResult = { status: "IMPORTING" | "DONE" | "FAILED"; progress: Progress; label: string; done: number; total: number };

/** Works the import forward for up to `budgetMs`. */
export async function importStep(importId: string, userId: string, budgetMs = 8000): Promise<StepResult> {
  const run = await db.legacyImport.findUnique({ where: { id: importId }, select: { status: true, strategy: true, decisions: true, lookups: true, progress: true } });
  if (!run) throw new ImportRefused("That import isn't there.");
  const progress = run.progress as unknown as Progress;
  if (run.status !== "IMPORTING") return { status: run.status === "DONE" ? "DONE" : "FAILED", progress, label: "", done: 0, total: 0 };
  const startedAt = Date.now();
  try {
    if (progress.phase === "undo-earlier") {
      const earlier = await db.legacyImport.findMany({ where: { id: { not: importId }, status: { in: ["DONE", "FAILED"] } }, orderBy: { createdAt: "desc" }, select: { id: true } });
      for (const e of earlier) {
        const part = await undoPart(e.id, budgetMs - (Date.now() - startedAt));
        const entry = (progress.replaced ??= []).find((r) => r.importId === e.id) ?? (progress.replaced.push({ importId: e.id, taken: 0, kept: 0 }), progress.replaced.at(-1)!);
        entry.taken += part.taken;
        entry.kept += part.kept.length;
        if (!part.done) return await save(importId, progress, "Undoing earlier imports", 0, 0);
        await finishUndo(e.id, userId, part);
      }
      progress.phase = "import";
    }

    const ctx: Ctx = {
      importId,
      actorId: userId,
      strategy: (run.strategy as StrategyKey) ?? "NEW",
      decisions: (run.decisions ?? {}) as Decisions,
      lookups: (run.lookups ?? {}) as unknown as Lookups,
      records: new RecordCache(),
      ownName: companyKey((await getOrganisation()).legalName || ""),
      withZoho: await hasZohoFiles(importId),
    };
    if (progress.step === 0 && progress.offset === 0) await ensureCustomFields(ctx);

    while (progress.step < RUN_STEPS.length) {
      const step = RUN_STEPS[progress.step]!;
      const kind: KindKey = step === "customer_product_links" ? "customer_product" : step;
      const total = await countOf(importId, kind);
      if (progress.offset >= total) {
        progress.step += 1;
        progress.offset = 0;
        continue;
      }
      if (Date.now() - startedAt > budgetMs) return await save(importId, progress, stepLabel(step), progress.offset, total);
      const rows = await rowsSlice(importId, kind, progress.offset, BATCH);
      // The old-id log this batch reads, in a few queries.
      await ctx.records.load(kind, rows.map((r) => r.row.id ?? ""));
      for (const [column, target] of PRELOAD[step] ?? []) await ctx.records.load(target, rows.map((r) => r.row[column] ?? ""));
      await ctx.records.load("users", rows.flatMap((r) => USER_COLUMNS.map((c) => r.row[c] ?? "")));
      const counts = (progress.counts[step] ??= zero());
      const errors: Prisma.LegacyImportErrorCreateManyInput[] = [];
      for (const src of rows) {
        const outcome = await applyRow(step, src, ctx);
        if (outcome.kind === "error") {
          counts.failed += 1;
          errors.push({ importId, kind: step, file: src.file, line: src.line, oldId: src.row.id || null, message: outcome.message });
        } else if (outcome.kind === "skipped") {
          counts.skipped += 1;
        } else {
          counts[outcome.kind] += 1;
          if (outcome.warning) errors.push({ importId, kind: step, file: src.file, line: src.line, oldId: src.row.id || null, message: `Came in, but: ${outcome.warning}` });
        }
      }
      if (errors.length) await db.legacyImportError.createMany({ data: errors });
      progress.offset += rows.length;
      if (rows.length === 0) progress.offset = total;
    }

    progress.phase = "done";
    await db.legacyImport.update({ where: { id: importId }, data: { status: "DONE", finishedAt: new Date(), progress: progress as unknown as Prisma.InputJsonValue } });
    const sum = Object.values(progress.counts).reduce((t, c) => t + (c?.created ?? 0), 0);
    await recordAudit({ userId, action: "CREATE", entityType: "LegacyImport", entityId: importId, entityLabel: `Imported the old CRM's data: ${sum} records made` });
    // The switch's earlier years that came before these companies did now find them (src/lib/migration/archive.ts).
    const switching = await openMigration().catch(() => null);
    if (switching) await rematchArchive(switching.id).catch(() => undefined);
    return { status: "DONE", progress, label: "Done", done: 0, total: 0 };
  } catch (err) {
    // Not a row's problem — the run stops here, and can carry on or be undone.
    progress.failure = err instanceof Error ? err.message.slice(0, 500) : String(err);
    await db.legacyImport.update({ where: { id: importId }, data: { status: "FAILED", progress: progress as unknown as Prisma.InputJsonValue } });
    return { status: "FAILED", progress, label: "Stopped", done: 0, total: 0 };
  }
}

async function save(importId: string, progress: Progress, label: string, done: number, total: number): Promise<StepResult> {
  await db.legacyImport.update({ where: { id: importId }, data: { progress: progress as unknown as Prisma.InputJsonValue } });
  return { status: "IMPORTING", progress, label, done, total };
}

/** Carries a stopped import on from where it stopped. */
export async function resumeImport(importId: string, userId: string) {
  const run = await db.legacyImport.findUnique({ where: { id: importId }, select: { status: true, progress: true } });
  if (!run || run.status !== "FAILED") throw new ImportRefused("Only a stopped import carries on.");
  if (await db.legacyImport.findFirst({ where: { status: "IMPORTING" }, select: { id: true } })) throw new ImportRefused("Another import is running.");
  const progress = { ...(run.progress as unknown as Progress), failure: null };
  await db.legacyImport.update({ where: { id: importId }, data: { status: "IMPORTING", progress: progress as unknown as Prisma.InputJsonValue } });
  await recordAudit({ userId, action: "UPDATE", entityType: "LegacyImport", entityId: importId, entityLabel: "Carried on a stopped import of the old CRM's data" });
}

async function finishUndo(importId: string, userId: string, last: UndoProgress) {
  await db.legacyImport.update({ where: { id: importId }, data: { status: "UNDONE", undoneAt: new Date(), undoneById: userId } });
  await db.legacyImportFile.deleteMany({ where: { importId } });
  await recordAudit({ userId, action: "DELETE", entityType: "LegacyImport", entityId: importId, entityLabel: `Undid an import of the old CRM's data${last.kept.length ? `; ${last.kept.length} record(s) kept because Deskzo uses them since` : ""}` });
}

/** Undoes a finished or stopped import, a part at a time; the page calls it until it's done. */
export async function undoStep(importId: string, userId: string, budgetMs = 8000) {
  const run = await db.legacyImport.findUnique({ where: { id: importId }, select: { status: true } });
  if (!run || (run.status !== "DONE" && run.status !== "FAILED")) throw new ImportRefused("Only a finished or stopped import can be undone.");
  if (await db.legacyImport.findFirst({ where: { status: "IMPORTING" }, select: { id: true } })) throw new ImportRefused("An import is running. Let it finish first.");
  const part = await undoPart(importId, budgetMs);
  if (part.done) await finishUndo(importId, userId, part);
  const left = await db.legacyImportRecord.count({ where: { importId, action: { not: "KEPT" } } });
  const kept = await db.legacyImportRecord.count({ where: { importId, action: "KEPT" } });
  return { done: part.done, left, kept, taken: part.taken };
}
