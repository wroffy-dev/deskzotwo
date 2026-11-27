/**
 * demo:service-cycles — sample service cycles on the local database, to try the screens with (owner, 9 Nov 2026).
 *
 * Four plans (a managed IT AMC, Microsoft 365 customer success, a firewall subscription, ISO 27001 certification), the
 * matching items pointed at them, and a dozen cycles for real customers started between eight months ago and next
 * month: older jobs done, a few left overdue, one skipped, one cycle stopped, one ended. Jobs near enough are tasks for
 * the customer's account manager, as on any workspace.
 *
 * Everything it makes is marked "[sample]" in the plan's description, and only that is touched again.
 *
 *   npm run demo:service-cycles            make it (again: what was there first is taken away)
 *   npm run demo:service-cycles -- --reset  only take it away
 *
 * Refuses a database that isn't on this computer.
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { addDays, addMonths } from "../src/lib/service-cycles/rules";
import { defaultEnd, openDueJobs, syncCycle } from "../src/lib/service-cycles/server";
import { storedDay } from "../src/lib/tasks/server";
import { workspaceClock } from "../src/lib/time/workspace";

const MARK = "[sample]";

type StepSeed = { name: string; first: number; every: number | null; ahead: number; checklist?: string[] };
type PlanSeed = { name: string; about: string; months: number; steps: StepSeed[]; items: RegExp[] };

const PLANS: PlanSeed[] = [
  {
    name: "Managed IT – AMC",
    about: "On-site care for a customer's IT, a year at a time.",
    months: 12,
    items: [/^Quarterly Health Check Visit$/i],
    steps: [
      { name: "Quarterly health check visit", first: 0, every: 3, ahead: 14, checklist: ["Server room temperature and UPS", "Backups ran and restore tested", "Firewall rules and firmware", "Endpoint antivirus up to date", "Note anything to quote for"] },
      { name: "Monthly patch report", first: 1, every: 1, ahead: 5, checklist: ["Windows and Office patches", "Failed updates followed up", "Report sent to the customer"] },
      { name: "Yearly security review", first: 11, every: null, ahead: 21, checklist: ["Access review", "Password policy", "Recommendations deck"] },
    ],
  },
  {
    name: "Microsoft 365 customer success",
    about: "Getting a Microsoft 365 customer settled, keeping licences right, and renewing.",
    months: 12,
    items: [/^Microsoft 365 (Business Premium|E3|E5) \(Annual\)$/i],
    steps: [
      { name: "Onboarding check", first: 1, every: null, ahead: 7, checklist: ["Every user signed in", "MFA on for everyone", "Mail migrated and DNS checked"] },
      { name: "Quarterly usage review", first: 3, every: 3, ahead: 10, checklist: ["Unused licences", "Teams and SharePoint adoption", "Upgrade or add-on to suggest"] },
      { name: "Renewal call", first: 10, every: null, ahead: 30 },
    ],
  },
  {
    name: "Firewall subscription",
    about: "A managed firewall: logs read every month, firmware twice a year.",
    months: 12,
    items: [/Firewall/i],
    steps: [
      { name: "Monthly log review", first: 1, every: 1, ahead: 5, checklist: ["Blocked threats", "VPN users", "Bandwidth peaks"] },
      { name: "Firmware update", first: 6, every: 6, ahead: 14, checklist: ["Backup the config", "Update in the agreed window", "Test VPN and rules after"] },
    ],
  },
  {
    name: "ISO 27001 certification",
    about: "A three-year certificate: the two certification audits, a surveillance audit each year, then recertification.",
    months: 36,
    items: [],
    steps: [
      { name: "Stage 1 audit (documents)", first: 0, every: null, ahead: 21, checklist: ["Scope and statement of applicability", "Risk assessment", "Audit plan sent"] },
      { name: "Stage 2 audit (on site)", first: 1, every: null, ahead: 21, checklist: ["Opening meeting", "Evidence sampled", "Findings and closing meeting"] },
      { name: "Surveillance audit", first: 12, every: 12, ahead: 30 },
      { name: "Recertification audit", first: 33, every: null, ahead: 45 },
    ],
  },
];

/** Which plan, how many months ago it started (negative: still to come), and how it stands. */
const CYCLES: { plan: number; startedMonthsAgo: number; leaveOverdue?: number; stop?: boolean; ended?: boolean; skip?: boolean }[] = [
  { plan: 0, startedMonthsAgo: 8, leaveOverdue: 1, skip: true },
  { plan: 0, startedMonthsAgo: 5 },
  { plan: 0, startedMonthsAgo: 2, leaveOverdue: 1 },
  { plan: 0, startedMonthsAgo: 0 },
  { plan: 1, startedMonthsAgo: 9, leaveOverdue: 1 },
  { plan: 1, startedMonthsAgo: 4 },
  { plan: 1, startedMonthsAgo: 1 },
  { plan: 2, startedMonthsAgo: 7, leaveOverdue: 2 },
  { plan: 2, startedMonthsAgo: 3, stop: true },
  { plan: 2, startedMonthsAgo: 14, ended: true },
  { plan: 3, startedMonthsAgo: 13 },
  { plan: 3, startedMonthsAgo: -1 },
];

async function takeAway() {
  const templates = await db.serviceCycleTemplate.findMany({ where: { description: { contains: MARK } }, select: { id: true } });
  const ids = templates.map((t) => t.id);
  if (!ids.length) return 0;
  const tasks = (await db.serviceJob.findMany({ where: { cycle: { templateId: { in: ids } } }, select: { taskId: true } })).flatMap((j) => (j.taskId ? [j.taskId] : []));
  await db.serviceCycle.deleteMany({ where: { templateId: { in: ids } } });
  if (tasks.length) await db.task.deleteMany({ where: { id: { in: tasks } } });
  await db.itemServicePlan.deleteMany({ where: { templateId: { in: ids } } });
  await db.serviceCycleTemplate.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error("This only writes to a database on this computer.");
  const removed = await takeAway();
  console.log(removed ? `Took away ${removed} sample plan(s) and what came with them.` : "No sample data there yet.");
  if (process.argv.includes("--reset")) return;

  const today = (await workspaceClock()).today();
  const admin = await db.user.findFirstOrThrow({ where: { active: true, kind: "MEMBER", role: "ADMIN" }, select: { id: true } });
  const plans: { id: string; months: number; name: string }[] = [];
  for (const p of PLANS) {
    const t = await db.serviceCycleTemplate.create({
      data: {
        name: p.name,
        description: `${p.about} ${MARK}`,
        months: p.months,
        createdById: admin.id,
        steps: { create: p.steps.map((s, i) => ({ name: s.name, firstAfterMonths: s.first, everyMonths: s.every, showDaysBefore: s.ahead, checklist: s.checklist ?? [], sortOrder: i })) },
      },
      select: { id: true, months: true, name: true },
    });
    plans.push(t);
    // The items this plan is sold as start it when their orders are approved.
    if (p.items.length) {
      const items = (await db.item.findMany({ select: { id: true, name: true } })).filter((i) => p.items.some((re) => re.test(i.name)));
      for (const item of items) await db.itemServicePlan.upsert({ where: { itemId: item.id }, create: { itemId: item.id, templateId: t.id }, update: { templateId: t.id } });
      console.log(`${p.name}: ${items.length} item(s) start it — ${items.map((i) => i.name).join(", ") || "none"}`);
    }
  }

  // Real customers with an account manager, each in one cycle.
  const customers = await db.company.findMany({ where: { relationshipType: "CLIENT", ownerUserId: { not: null } }, orderBy: { name: "asc" }, take: CYCLES.length, select: { id: true, name: true, ownerUserId: true } });
  for (const [i, c] of CYCLES.entries()) {
    const customer = customers[i];
    if (!customer) break;
    const plan = plans[c.plan]!;
    const start = addMonths(today, -c.startedMonthsAgo);
    const end = c.ended ? addDays(today, -20) : defaultEnd(start, plan.months);
    const cycle = await db.serviceCycle.create({
      data: { templateId: plan.id, companyId: customer.id, startDate: storedDay(start), endDate: storedDay(c.ended ? (end < start ? start : end) : end), ownerUserId: customer.ownerUserId, createdById: admin.id },
      select: { id: true, seq: true },
    });
    await syncCycle(cycle.id);
    while ((await openDueJobs({ cycleId: cycle.id })) > 0);
    // What's past: done on its day — except the last few left overdue, and one skipped.
    const past = await db.serviceJob.findMany({ where: { cycleId: cycle.id, dueDate: { lt: storedDay(today) } }, orderBy: { dueDate: "asc" }, select: { id: true, dueDate: true, taskId: true } });
    const keepOpen = new Set(past.slice(past.length - (c.leaveOverdue ?? 0)).map((j) => j.id));
    const skipOne = c.skip ? past[1]?.id : undefined;
    for (const job of past) {
      if (keepOpen.has(job.id)) continue;
      if (job.id === skipOne) {
        await db.serviceJob.update({ where: { id: job.id }, data: { skipped: true, skippedReason: "Customer's office closed for Diwali; moved to the next visit" } });
        if (job.taskId) await db.task.update({ where: { id: job.taskId }, data: { status: "CANCELLED", done: true, doneAt: job.dueDate } });
        continue;
      }
      if (job.taskId) await db.task.update({ where: { id: job.taskId }, data: { status: "DONE", done: true, doneAt: new Date(job.dueDate.getTime() + 10 * 3_600_000) } });
    }
    if (c.stop) await db.serviceCycle.update({ where: { id: cycle.id }, data: { status: "STOPPED", stoppedAt: new Date() } });
    const counts = await db.serviceJob.count({ where: { cycleId: cycle.id } });
    console.log(`#${cycle.seq} ${plan.name} for ${customer.name}: from ${start}, ${counts} jobs${c.stop ? ", stopped" : ""}${c.ended ? ", ended" : ""}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
