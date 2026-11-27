/**
 * Duplicate companies sorted into groups, and the ones sharing a GSTIN merged in the background (owner, 14 Nov 2026 —
 * src/lib/companies/duplicate-groups.ts, src/lib/companies/gstin-merge.ts).
 *
 * The rules are tried on their own; the job runs against the local workspace, on companies of its own (ZZGM) and a
 * plan naming only them, so nothing else in the book is merged.
 *
 *   npm run check:gstin-merge
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { groupCounts, groupOf, gstinMergePlan, type GroupPair } from "../src/lib/companies/duplicate-groups";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

async function main() {
  section("1. Which group a pair is in");
  const gstins: Record<string, string[]> = { a: ["27AAAAA0000A1Z5"], b: ["27AAAAA0000A1Z5"], c: ["29AAAAA0000A1Z5"], d: [], e: [], f: [] };
  const of = (id: string) => gstins[id] ?? [];
  const pair = (aId: string, bId: string, reasons: string[], strength: "strong" | "likely" = "strong"): GroupPair => ({ aId, bId, strength, reasons });
  ok("the same GSTIN: A, merged in the background", groupOf(pair("a", "b", ["Same GSTIN 27AAAAA0000A1Z5", "Same name once Pvt, Ltd and the like are set aside"]), of) === "gstin");
  ok("the same PAN, each with its own GSTIN: B, two registrations, never merged in bulk", groupOf(pair("a", "c", ["Same PAN AAAAA0000A"]), of) === "pan");
  ok("the same PAN where one has no GSTIN: C, very likely one company", groupOf(pair("a", "d", ["Same PAN AAAAA0000A"]), of) === "corroborated");
  ok("the same name and a phone: C", groupOf(pair("d", "e", ["Same name once Pvt, Ltd and the like are set aside", "Same phone number …1234"]), of) === "corroborated");
  ok("the same name alone: D — two Sharma Traders may be two customers", groupOf(pair("d", "e", ["Same name once Pvt, Ltd and the like are set aside"]), of) === "weak");
  ok("only a shared email domain: D", groupOf(pair("e", "f", ["Same email domain zz.example"], "likely"), of) === "weak");
  const counts = groupCounts([pair("a", "b", ["Same GSTIN x"]), pair("a", "c", ["Same PAN y"]), pair("d", "e", ["Same name once"])], of);
  ok("counted by group", counts.gstin === 1 && counts.pan === 1 && counts.corroborated === 0 && counts.weak === 1, counts);

  section("2. The plan: companies sharing a GSTIN gathered, each into the one with business, else the older");
  const subjects = new Map([
    ["p", { id: "p", companySeq: 10, records: 2 }],
    ["q", { id: "q", companySeq: 11, records: 9, business: 3 }],
    ["r", { id: "r", companySeq: 12, records: 0 }],
    ["s", { id: "s", companySeq: 5, records: 1 }],
    ["t", { id: "t", companySeq: 4, records: 1 }],
  ]);
  const plan = gstinMergePlan(
    [pair("p", "q", ["Same GSTIN 1"]), pair("q", "r", ["Same GSTIN 1"]), pair("s", "t", ["Same GSTIN 2"]), pair("p", "s", ["Same name once"])],
    subjects,
  );
  const into = (id: string) => plan.find((x) => x.dropId === id)?.keepId;
  ok("A–B and B–C are one group of three, kept as the one with business on it", into("p") === "q" && into("r") === "q" && !plan.some((x) => x.dropId === "q"), plan);
  // Security review, 15 Nov 2026 (ADV-01): padding contacts or leads onto a company doesn't make it the one kept.
  const padded = gstinMergePlan([pair("old", "new", ["Same GSTIN 9"])], new Map([["old", { id: "old", companySeq: 1, records: 0 }], ["new", { id: "new", companySeq: 99, records: 500 }]]));
  ok("  without business on either, the older is kept, however much was added to the newer", padded[0]?.keepId === "old", padded);
  ok("  a tie on records keeps the older", into("s") === "t");
  ok("  a pair that shares only a name isn't followed", plan.length === 3);
  ok("  each company is merged once at most", new Set(plan.map((x) => x.dropId)).size === plan.length);
  // Owner, 14 Nov 2026: "any record which has invoice done in Zoho wins".
  const zohoKept = gstinMergePlan([pair("u", "v", ["Same GSTIN 3"])], new Map([["u", { id: "u", companySeq: 1, records: 40 }], ["v", { id: "v", companySeq: 9, records: 2, zohoInvoices: 5 }]]));
  ok("  the one with Zoho Books invoices is kept, however little else is under it", zohoKept.length === 1 && zohoKept[0]!.keepId === "v", zohoKept);

  section("3. The background job, on companies of its own");
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const job = require("../src/lib/companies/gstin-merge") as typeof import("../src/lib/companies/gstin-merge");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const TAG = `ZZGM ${randomUUID().slice(0, 6)}`;
  // The super admin: the job checks each pair again as whoever started it, who must hold companies.merge (ADV-02).
  const boss = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true } });
  const plain = await db.user.findFirst({ where: { active: true, isSuperAdmin: false, role: { in: ["SALES", "CALLING", "PROFILE"] } }, select: { id: true } });
  if (!boss) throw new Error("no user to run as");
  const already = await db.companyMergeJob.findFirst({ where: { status: { in: ["RUNNING", "PAUSED"] } }, select: { id: true } });
  if (already) throw new Error("a merge job is already running or paused in this workspace — let it finish before running this check");
  const made: string[] = [];
  const company = async (name: string, gstin: string) => {
    const c = await db.company.create({ data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: boss.id }, select: { id: true, companySeq: true } });
    await db.companyLocation.create({ data: { companyId: c.id, label: "HO", city: "Pune", gstNumber: gstin, isPrimary: true } });
    made.push(c.id);
    return c;
  };
  const jobIds: string[] = [];
  try {
    const keep = await company("Alpha Pvt Ltd", "27ZZGMA0000Z1Z5");
    const dup1 = await company("Alpha Private Limited", "27ZZGMA0000Z1Z5");
    const dup2 = await company("ALPHA", "27ZZGMA0000Z1Z5");
    await db.contact.create({ data: { companyId: dup1.id, name: `${TAG} Ravi`, email: `ravi.${TAG.slice(5)}@zzgm.invalid`, createdByUserId: boss.id } });
    await db.lead.create({ data: { title: `${TAG} lead`, companyId: dup2.id, ownerUserId: boss.id, createdById: boss.id } }).catch(() => null);
    const plan3 = [
      { keepId: keep.id, dropId: dup1.id },
      { keepId: keep.id, dropId: dup2.id },
      { keepId: keep.id, dropId: "zz-not-there" },
    ];
    const row = await db.companyMergeJob.create({ data: { status: "RUNNING", plan: plan3, startedById: boss.id } });
    jobIds.push(row.id);
    const worked = await job.workMergeJob(120_000);
    const after = await db.companyMergeJob.findUniqueOrThrow({ where: { id: row.id } });
    ok("the job works through its plan", worked === 3 && after.done === 3, { worked, done: after.done });
    ok("  two merged, and one already gone isn't counted against it", after.merged === 2 && after.skipped === 0, after);
    ok("  finished: DONE, its lock let go", after.status === "DONE" && !!after.finishedAt && after.lockedAt === null);
    const left = await db.company.findMany({ where: { id: { in: [keep.id, dup1.id, dup2.id] } }, select: { id: true } });
    ok("  the duplicates are gone, the kept one stays", left.length === 1 && left[0]!.id === keep.id, left);
    ok("  what was under them is under the kept one", (await db.contact.count({ where: { companyId: keep.id, name: `${TAG} Ravi` } })) === 1);
    const audited = await db.auditLog.count({ where: { entityId: { in: [dup1.id, dup2.id] }, action: "DELETE", entityLabel: { contains: "in the GSTIN merge" } } });
    ok("  each merge audited", audited === 2, audited);
    ok("  and nothing more to do: another call works nothing", (await job.workMergeJob(5_000)) === 0);

    const k2 = await company("Beta Pvt Ltd", "27ZZGMB0000Z1Z5");
    const d2 = await company("Beta Private Ltd", "27ZZGMB0000Z1Z5");
    const paused = await db.companyMergeJob.create({ data: { status: "PAUSED", plan: [{ keepId: k2.id, dropId: d2.id }], startedById: boss.id } });
    jobIds.push(paused.id);
    ok("a paused job isn't worked", (await job.workMergeJob(5_000)) === 0 && (await db.company.count({ where: { id: d2.id } })) === 1);
    const locked = await db.companyMergeJob.update({ where: { id: paused.id }, data: { status: "RUNNING", lockedAt: new Date(), lockedBy: "somebody else" } });
    ok("  nor one another process is working on", (await job.workMergeJob(5_000)) === 0 && locked.status === "RUNNING");
    await db.companyMergeJob.update({ where: { id: paused.id }, data: { lockedAt: new Date(Date.now() - 5 * 60_000) } });
    ok("  but one whose process stopped is taken up again", (await job.workMergeJob(60_000)) === 1 && (await db.company.count({ where: { id: d2.id } })) === 0);
    // Security review, 15 Nov 2026 (ADV-02): each pair checked again as it is now.
    const k3 = await company("Gamma Pvt Ltd", "27ZZGMC0000Z1Z5");
    const d3 = await company("Gamma Private Ltd", "27ZZGMC0000Z1Z5");
    const [a3, b3] = k3.id < d3.id ? [k3.id, d3.id] : [d3.id, k3.id];
    await db.companyDuplicateDismissal.create({ data: { companyAId: a3, companyBId: b3, dismissedById: boss.id } });
    const k4 = await company("Delta Pvt Ltd", "27ZZGMD0000Z1Z5");
    const d4 = await company("Delta Private Ltd", "27ZZGMD0000Z1Z5");
    await db.companyLocation.updateMany({ where: { companyId: d4.id }, data: { gstNumber: "27ZZGME0000Z1Z5" } });
    const recheck = await db.companyMergeJob.create({ data: { status: "RUNNING", plan: [{ keepId: k3.id, dropId: d3.id }, { keepId: k4.id, dropId: d4.id }], startedById: boss.id } });
    jobIds.push(recheck.id);
    await job.workMergeJob(60_000);
    const rechecked = await db.companyMergeJob.findUniqueOrThrow({ where: { id: recheck.id } });
    const whys = ((rechecked.notes ?? []) as { why: string }[]).map((n) => n.why);
    ok("a pair marked not duplicates since the plan is left", (await db.company.count({ where: { id: d3.id } })) === 1 && whys.some((w) => w.includes("not duplicates")), whys);
    ok("  so is one whose GSTIN was corrected since", (await db.company.count({ where: { id: d4.id } })) === 1 && whys.some((w) => w.includes("no longer share")), whys);
    if (plain && !(await can(plain.id, "companies.merge"))) {
      const k5 = await company("Epsilon Pvt Ltd", "27ZZGMF0000Z1Z5");
      const d5 = await company("Epsilon Private Ltd", "27ZZGMF0000Z1Z5");
      const theirs = await db.companyMergeJob.create({ data: { status: "RUNNING", plan: [{ keepId: k5.id, dropId: d5.id }], startedById: plain.id } });
      jobIds.push(theirs.id);
      await job.workMergeJob(60_000);
      ok("  and nothing is merged for somebody who can't merge companies", (await db.company.count({ where: { id: d5.id } })) === 1);
    }
    await db.companyDuplicateDismissal.deleteMany({ where: { companyAId: a3, companyBId: b3 } });
    const stopped = await job.setMergeJobStatus(paused.id, "STOPPED", boss.id);
    ok("a finished job can't be stopped or restarted", stopped?.status === "DONE");
    ok("needsWorker: a running job with an old lock or none", job.needsWorker({ status: "RUNNING", lockedAt: null }) && job.needsWorker({ status: "RUNNING", lockedAt: new Date(Date.now() - 120_000) }) && !job.needsWorker({ status: "RUNNING", lockedAt: new Date() }) && !job.needsWorker({ status: "PAUSED", lockedAt: null }));
  } finally {
    await db.companyMergeJob.deleteMany({ where: { id: { in: jobIds } } });
    await db.auditLog.deleteMany({ where: { entityId: { in: [...made, ...jobIds] } } }).catch(() => undefined);
    await db.lead.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await db.contact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await db.companyLocation.deleteMany({ where: { companyId: { in: made } } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: { in: made } } }).catch(() => undefined);
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? `All ${passes} GSTIN merge checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
