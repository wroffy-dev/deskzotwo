import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { canSeeCompany, companyScope } from "@/lib/authz/company-scope";
import { can } from "@/lib/authz/resolve";
import { isFreeMailbox } from "@/lib/email-verification";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { companyFamily, domainOf, duplicatePairs, pairKey, phoneKey, type DuplicateCandidate, type DuplicatePair } from "@/lib/companies/duplicates";
import { executeMerge, MergeRefused, planMerge } from "@/lib/companies/merge";
import { BULK_NEVER_FROM_DUPLICATE } from "@/lib/companies/bulk-merge";
import { groupCounts, gstinMergePlan, type ClusterSubject, type DuplicateGroup } from "@/lib/companies/duplicate-groups";
import { companyOrigins } from "@/lib/companies/origins";

/**
 * The duplicates sharing a GSTIN, merged in the background (owner, 14 Nov 2026: "10000+ merges by hand? too tough"),
 * with the rest of the list sorted into groups for a person (src/lib/companies/duplicate-groups.ts).
 *
 * One job a workspace at a time, kept in `company_merge_jobs`: the merges planned when it starts, worked through in
 * order by whichever process holds its lock — started from the button, picked up again by the page while somebody watches
 * it and by the heartbeat after a restart. Each merge is the one the merge screen makes with its suggestions (blanks filled
 * from the duplicate, the people both have combined, the account manager, caller, terms and name the kept one's), audited
 * one by one. One a merge refuses — a reseller's customer and ours, say — is left, with why, for a person.
 *
 * Only companies the person starting it can see are in it, and they type the workspace's name to start it.
 */

const LOCK_STALE_MS = 90_000;
const NOTES_KEPT = 200;

export type MergeJobView = {
  id: string;
  status: "RUNNING" | "PAUSED" | "STOPPED" | "DONE" | "FAILED";
  total: number;
  done: number;
  merged: number;
  skipped: number;
  notes: { name: string; why: string }[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

/** The companies this person can see, with the pairs among them — as the duplicates list reads them. */
export async function loadDuplicateBook(userId: string) {
  const [companies, dismissals] = await Promise.all([
    db.company.findMany({
      where: await companyScope(userId),
      select: {
        id: true,
        companySeq: true,
        name: true,
        relationshipType: true,
        managedByResellerId: true,
        panNumber: true,
        website: true,
        locations: { select: { gstNumber: true } },
        contacts: { select: { email: true, phone: true } },
        _count: { select: { contacts: true, leads: true, products: true, tradeDocuments: true, payments: true, tickets: true } },
      },
    }),
    db.companyDuplicateDismissal.findMany({ select: { companyAId: true, companyBId: true } }),
  ]);
  const gstins = new Map<string, string[]>();
  const candidates: DuplicateCandidate[] = companies.map((c) => {
    const domains = new Set<string>();
    const site = c.website ? domainOf(c.website) : null;
    if (site) domains.add(site);
    for (const x of c.contacts) {
      const d = x.email ? domainOf(x.email) : null;
      if (d && !isFreeMailbox(d)) domains.add(d);
    }
    const own = [...new Set(c.locations.map((l) => l.gstNumber?.trim().toUpperCase()).filter((g): g is string => !!g))];
    gstins.set(c.id, own);
    return {
      id: c.id,
      name: c.name,
      family: companyFamily(c.relationshipType),
      managedByResellerId: c.managedByResellerId,
      gstins: own,
      pan: c.panNumber?.trim().toUpperCase() || null,
      domains: [...domains],
      phones: [...new Set(c.contacts.map((x) => (x.phone ? phoneKey(x.phone) : null)).filter((p): p is string => !!p))],
    };
  });
  const pairs: DuplicatePair[] = duplicatePairs(candidates, new Set(dismissals.map((d) => pairKey(d.companyAId, d.companyBId))));
  // The one with Zoho Books invoices is kept (owner, 14 Nov 2026 — src/lib/companies/origins.ts).
  const origins = await companyOrigins();
  const subjects = new Map<string, ClusterSubject & { name: string }>(
    companies.map((c) => [
      c.id,
      {
        id: c.id,
        companySeq: c.companySeq,
        name: c.name,
        records: Object.values(c._count).reduce((t, n) => t + n, 0),
        zohoInvoices: origins.of(c.id).zohoInvoices,
        business: c._count.products + c._count.tradeDocuments + c._count.payments,
      },
    ]),
  );
  return { scanned: companies.length, pairs, subjects, gstinsOf: (id: string) => gstins.get(id) ?? [] };
}

export type DuplicateBreakdown = {
  scanned: number;
  total: number;
  groups: Record<DuplicateGroup, number>;
  /** Group A as it would be merged: how many merges, into how many kept companies. */
  gstinMerges: number;
  gstinKept: number;
};

export async function duplicateBreakdown(userId: string): Promise<DuplicateBreakdown> {
  const book = await loadDuplicateBook(userId);
  const plan = gstinMergePlan(book.pairs, book.subjects);
  return {
    scanned: book.scanned,
    total: book.pairs.length,
    groups: groupCounts(book.pairs, book.gstinsOf),
    gstinMerges: plan.length,
    gstinKept: new Set(plan.map((p) => p.keepId)).size,
  };
}

type JobRow = Prisma.CompanyMergeJobGetPayload<object>;

function view(job: JobRow): MergeJobView {
  return {
    id: job.id,
    status: job.status as MergeJobView["status"],
    total: Array.isArray(job.plan) ? job.plan.length : 0,
    done: job.done,
    merged: job.merged,
    skipped: job.skipped,
    notes: (Array.isArray(job.notes) ? job.notes : []) as { name: string; why: string }[],
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    error: job.error,
  };
}

/** The latest job, if any; null before 20261214100000_company_merge_jobs. */
export async function latestMergeJob(): Promise<MergeJobView | null> {
  try {
    const job = await db.companyMergeJob.findFirst({ orderBy: { startedAt: "desc" } });
    return job ? view(job) : null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** Plans the GSTIN merges among what this person can see and starts the job. Refused while another is running or paused. */
export async function startGstinMergeJob(userId: string): Promise<{ ok: true; job: MergeJobView } | { ok: false; error: string }> {
  const open = await db.companyMergeJob.findFirst({ where: { status: { in: ["RUNNING", "PAUSED"] } }, select: { id: true } });
  if (open) return { ok: false, error: "A merge is already under way — let it finish, or stop it first." };
  const book = await loadDuplicateBook(userId);
  const plan = gstinMergePlan(book.pairs, book.subjects);
  if (plan.length === 0) return { ok: false, error: "No duplicates share a GSTIN — there's nothing to merge in the background." };
  const job = await db.companyMergeJob.create({ data: { status: "RUNNING", plan: plan as unknown as Prisma.InputJsonValue, startedById: userId } });
  await recordAudit({ userId, action: "CREATE", entityType: "CompanyMergeJob", entityId: job.id, entityLabel: `Started merging ${plan.length.toLocaleString("en-IN")} companies that share a GSTIN, in the background` });
  return { ok: true, job: view(job) };
}

/** Pause, carry on, or stop for good. */
export async function setMergeJobStatus(jobId: string, status: "RUNNING" | "PAUSED" | "STOPPED", userId: string): Promise<MergeJobView | null> {
  const job = await db.companyMergeJob.findUnique({ where: { id: jobId } });
  if (!job || job.status === "DONE" || job.status === "STOPPED") return job ? view(job) : null;
  const updated = await db.companyMergeJob.update({
    where: { id: jobId },
    data: { status, ...(status === "STOPPED" ? { finishedAt: new Date(), lockedAt: null, lockedBy: null } : {}), ...(status === "RUNNING" ? { lockedAt: null, lockedBy: null } : {}) },
  });
  const said = status === "PAUSED" ? "Paused" : status === "STOPPED" ? "Stopped" : "Carried on with";
  await recordAudit({ userId, action: "UPDATE", entityType: "CompanyMergeJob", entityId: jobId, entityLabel: `${said} the GSTIN merge at ${updated.done} of ${Array.isArray(updated.plan) ? updated.plan.length : 0}` });
  return view(updated);
}

/** Whether a running job has nobody working on it — a process that stopped, or none started yet. */
export function needsWorker(job: Pick<MergeJobView, "status"> & { lockedAt?: Date | null }, now = Date.now()): boolean {
  return job.status === "RUNNING" && (!job.lockedAt || now - job.lockedAt.getTime() > LOCK_STALE_MS);
}

/**
 * Works the running job for up to `budgetMs`, if nobody else is: claims its lock, merges one pair after another, and
 * saves where it got to after each. Returns how many it did. Safe to call from anywhere, as often as liked.
 */
export async function workMergeJob(budgetMs: number): Promise<number> {
  let job: JobRow | null;
  try {
    job = await db.companyMergeJob.findFirst({ where: { status: "RUNNING" }, orderBy: { startedAt: "asc" } });
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
  if (!job) return 0;
  const me = randomUUID();
  const stale = new Date(Date.now() - LOCK_STALE_MS);
  const claimed = await db.companyMergeJob.updateMany({
    where: { id: job.id, status: "RUNNING", OR: [{ lockedAt: null }, { lockedAt: { lt: stale } }] },
    data: { lockedAt: new Date(), lockedBy: me },
  });
  if (claimed.count === 0) return 0;

  const plan = (Array.isArray(job.plan) ? job.plan : []) as { keepId: string; dropId: string }[];
  const notes = (Array.isArray(job.notes) ? job.notes : []) as { name: string; why: string }[];
  const started = Date.now();
  let { done, merged, skipped } = job;
  let worked = 0;
  try {
    while (done < plan.length && Date.now() - started < budgetMs) {
      // Paused or stopped from the page, or the lock taken by another: stop here.
      const now = await db.companyMergeJob.findUnique({ where: { id: job.id }, select: { status: true, lockedBy: true } });
      if (!now || now.status !== "RUNNING" || now.lockedBy !== me) return worked;
      const step = plan[done]!;
      const outcome = await mergeOne(step.keepId, step.dropId, job.startedById);
      if (outcome === "merged") merged += 1;
      else if (outcome !== "gone") {
        skipped += 1;
        if (notes.length < NOTES_KEPT) notes.push(outcome);
      }
      done += 1;
      worked += 1;
      const finished = done >= plan.length;
      await db.companyMergeJob.update({
        where: { id: job.id },
        data: {
          done,
          merged,
          skipped,
          notes: notes as unknown as Prisma.InputJsonValue,
          lockedAt: finished ? null : new Date(),
          ...(finished ? { status: "DONE", finishedAt: new Date(), lockedBy: null } : {}),
        },
      });
      if (finished) {
        await recordAudit({
          userId: job.startedById,
          action: "UPDATE",
          entityType: "CompanyMergeJob",
          entityId: job.id,
          entityLabel: `The GSTIN merge finished: ${merged.toLocaleString("en-IN")} merged, ${skipped.toLocaleString("en-IN")} left for a person`,
        });
      }
    }
  } catch (err) {
    await db.companyMergeJob.update({ where: { id: job.id }, data: { status: "FAILED", error: err instanceof Error ? err.message.slice(0, 500) : String(err), lockedAt: null, lockedBy: null } });
    throw err;
  }
  // Out of time with more to do: let the next caller take it up straight away.
  if (done < plan.length) await db.companyMergeJob.updateMany({ where: { id: job.id, lockedBy: me }, data: { lockedAt: null, lockedBy: null } });
  return worked;
}

/** One merge of the plan: "merged", "gone" (one of the two isn't there any more), or why it was left. */
async function mergeOne(keepId: string, dropId: string, userId: string): Promise<"merged" | "gone" | { name: string; why: string }> {
  const plan = await planMerge(keepId, dropId);
  if (!plan) return "gone";
  const dropName = plan.drop.name;
  if (plan.blockers.length) return { name: dropName, why: plan.blockers[0]! };
  // Security review, 15 Nov 2026 (ADV-02): the plan was made when the job started, maybe hours ago. Each pair is checked
  // again as it is now — or a pair corrected, dismissed or taken out of the starter's reach since was merged anyway.
  const still = await stillMergeable(keepId, dropId, userId);
  if (still) return { name: dropName, why: still };
  const choices = Object.fromEntries(plan.fields.map((f) => [f.key, BULK_NEVER_FROM_DUPLICATE.has(f.key) ? "keep" : f.suggested])) as Record<string, "keep" | "drop">;
  try {
    const outcome = await executeMerge({ keepId, dropId, choices, combine: plan.contactPairs.map((p) => p.id), userId });
    const keepRef = plan.keep.ref;
    const dropRef = plan.drop.ref;
    const movedCount = outcome.moved.reduce((t, m) => t + m.count, 0);
    await recordAudit({ userId, action: "DELETE", entityType: "Company", entityId: dropId, entityLabel: `${dropRef} ${dropName} — merged into ${keepRef} in the GSTIN merge` });
    await recordAudit({ userId, action: "UPDATE", entityType: "Company", entityId: keepId, entityLabel: `${plan.keep.name} — ${dropRef} ${dropName} merged into it in the GSTIN merge, ${movedCount} records moved` });
    return "merged";
  } catch (err) {
    if (err instanceof MergeRefused) return { name: dropName, why: err.message };
    throw err;
  }
}

/** Why a planned pair isn't merged now — or null. Inside the job, as the person who started it. */
async function stillMergeable(keepId: string, dropId: string, userId: string): Promise<string | null> {
  const starter = await db.user.findUnique({ where: { id: userId }, select: { active: true } });
  if (!starter?.active || !(await can(userId, "companies.merge"))) return "Whoever started the merge can't merge companies any more.";
  const [keep, drop] = await Promise.all(
    [keepId, dropId].map((id) => db.company.findUnique({ where: { id }, select: { id: true, ownerUserId: true, relationshipType: true, locations: { select: { gstNumber: true } } } })),
  );
  if (!keep || !drop) return "One of the two isn't there any more.";
  if (!(await canSeeCompany(userId, keep)) || !(await canSeeCompany(userId, drop))) return "One of the two is no longer within reach of whoever started the merge.";
  const gstins = (c: typeof keep) => new Set(c.locations.map((l) => l.gstNumber?.trim().toUpperCase()).filter((g): g is string => !!g));
  const kept = gstins(keep);
  if (![...gstins(drop)].some((g) => kept.has(g))) return "They no longer share a GSTIN.";
  const [a, b] = keepId < dropId ? [keepId, dropId] : [dropId, keepId];
  if (await db.companyDuplicateDismissal.findUnique({ where: { companyAId_companyBId: { companyAId: a, companyBId: b } }, select: { companyAId: true } })) {
    return "Marked as not duplicates since the merge was planned.";
  }
  return null;
}

/** For the heartbeat: a running job nobody's working on gets a minute. */
export async function resumeMergeJobs(): Promise<void> {
  await workMergeJob(55_000);
}
