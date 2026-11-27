import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { openMigration, type MigrationRow } from "@/lib/migration/state";
import { importPart, retryWaitingPart, STEPS } from "@/lib/migration/steps";
import { startPull, type PullProgress } from "./pull";

/**
 * The night's top-up (owner, 29 Oct 2026: "get all the data from Zoho … we keep invoicing from Zoho for the next few
 * months as Deskzo will be on testing mode"): while the switch is open and Zoho is still the books, every night what
 * Zoho created or changed since the last pull is fetched — the "Top up since" pull — and, once it is done, each
 * section it touched is imported again in the page's order (what came already is passed over), then what was waiting
 * is tried again. One way: Zoho to Deskzo, never back.
 *
 * Between 01:00 and 05:00 the workspace's time, once a night, as whoever turned it on. What it can't do by itself is
 * what the page can't either: a customer or vendor new in Zoho goes to the old-CRM import (for the super admin) or
 * Import & export, and the invoices waiting for them come across the night after.
 */

const NIGHT = { from: 1, to: 5 };
const ACTIVE = ["FETCHING", "STORING", "PDFS", "WAITING"];

export type NightlySetting = { on: boolean; byId: string | null };

/** Whether it's on, and as whom. Off where the workspace hasn't the columns yet, or isn't connected. */
export async function nightlySetting(): Promise<NightlySetting> {
  const row = await db.zohoConnection
    .findUnique({ where: { id: "default" }, select: { nightlyTopUp: true, nightlyTopUpById: true } })
    .catch((err) => {
      if (notMigratedYet(err)) return null;
      throw err;
    });
  return { on: !!row?.nightlyTopUp, byId: row?.nightlyTopUpById ?? null };
}

export async function setNightly(on: boolean, userId: string): Promise<void> {
  await db.zohoConnection.update({ where: { id: "default" }, data: { nightlyTopUp: on, nightlyTopUpById: on ? userId : null }, select: { id: true } });
}

/**
 * The day the next top-up is "since": the day the last finished pull of everything started — Zoho's "changed since" is by
 * day, so the same day again misses nothing — else the day the switch's files last came in. A pull of one section, or of
 * the PDFs, says nothing of the rest: counting from it left out what changed in the rest before it (25 Nov 2026).
 */
async function sinceDay(m: MigrationRow): Promise<string | null> {
  const clock = await workspaceClock();
  const done = await db.zohoPull.findMany({ where: { migrationId: m.id, status: "DONE" }, orderBy: { startedAt: "desc" }, take: 50, select: { startedAt: true, progress: true } });
  const last = done.find((p) => {
    const g = (p.progress ?? {}) as Partial<PullProgress>;
    return !g.only?.length && g.mode !== "pdfs";
  });
  if (last) return clock.dateKey(last.startedAt);
  const file = await db.migrationFile.findFirst({ where: { migrationId: m.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  return file ? clock.dateKey(file.createdAt) : null;
}

/** Each section's file brought in again — the page's order, so invoices land before the receipts against them. */
async function importAll(m: MigrationRow, userId: string, deadline: number): Promise<boolean> {
  const order = new Map(STEPS.map((s, i) => [s.key as string, i]));
  const files = (await db.migrationFile.findMany({ where: { migrationId: m.id }, select: { id: true, step: true, units: true, done: true } })).sort(
    (a, b) => (order.get(a.step) ?? 99) - (order.get(b.step) ?? 99),
  );
  for (const f of files) {
    let done = f.done;
    while (done < f.units) {
      if (Date.now() > deadline) return false;
      const r = await importPart(m, f.id, userId);
      if (r.done === done) break;
      done = r.done;
    }
  }
  // What waits for something that came tonight — a receipt for tonight's invoice — tried once more.
  for (const f of files) {
    const waiting = await db.migrationFile.findUnique({ where: { id: f.id }, select: { failures: true } });
    if (!((waiting?.failures as { waitFor?: string }[] | null) ?? []).some((x) => x.waitFor)) continue;
    let after = -1;
    for (;;) {
      if (Date.now() > deadline) return false;
      const r = await retryWaitingPart(m, f.id, userId, null, after);
      if (r.restart) break; // Kept before rows were numbered: the next night's import goes through the file again.
      if (r.left === 0) break;
      after = r.after;
    }
  }
  return true;
}

/**
 * The heartbeat's part, after the pull's own (`zohoChores`): imports what a finished night's pull brought, and starts
 * the next night's when it's time. Null where it's off or there's nothing to do.
 */
export async function nightlyChores({ budgetMs, now = new Date() }: { budgetMs: number; now?: Date }): Promise<{ started?: string; imported?: boolean } | null> {
  const setting = await nightlySetting();
  if (!setting.on || !setting.byId) return null;
  const m = await openMigration();
  if (!m || m.source !== "zoho-books") return null;
  const user = await db.user.findUnique({ where: { id: setting.byId }, select: { id: true, active: true } });
  if (!user?.active) return null;

  const latest = await db.zohoPull.findFirst({ where: { migrationId: m.id }, orderBy: { startedAt: "desc" }, select: { id: true, status: true, progress: true, startedAt: true } });
  if (latest && ACTIVE.includes(latest.status)) return null;

  // A night's pull done and not imported yet: import it, a heartbeat at a time.
  const progress = (latest?.progress ?? {}) as PullProgress;
  if (latest?.status === "DONE" && progress.nightly && !progress.imported) {
    const finished = await importAll(m, user.id, Date.now() + budgetMs);
    if (finished) await db.$executeRaw`update "zoho_pulls" set "progress" = jsonb_set("progress", '{imported}', 'true'::jsonb) where "id" = ${latest.id}`;
    return { imported: finished };
  }

  // Once a night, in the small hours: not when a pull already started today.
  const clock = await workspaceClock();
  const hour = clock.parts(now).hour;
  if (hour < NIGHT.from || hour >= NIGHT.to) return null;
  if (latest && clock.dateKey(latest.startedAt) === clock.today(now)) return null;
  const since = await sinceDay(m);
  if (!since) return null;
  await startPull(m, user.id, {}, { mode: "topup", since, nightly: true });
  return { started: since };
}
