/**
 * check:automate-actions — Deskzo Automate, Phase 2: the Deskzo triggers, the daily date checks and the
 * Deskzo actions (src/lib/automate/emit-*.ts, dates.ts, actions/*).
 *
 * Builds a scratch workspace from the migrations and a scratch control plane beside the real database,
 * runs everything through the real engine, and drops both at the end, pass or fail. The real workspace
 * is never written to. Mail goes to a stand-in provider this script registers, the PDF comes from a
 * stand-in renderer, and nothing reaches a real mailbox, calendar or mail server.
 *
 *   · what publishing refuses of the new actions' input, and which trigger fields exist;
 *   · a lead made by a workflow: through the website door's rules, its event caused by the run, a
 *     workflow on lead.created set off one level deeper, and a retried step making no second lead;
 *   · assigning (to a person, by rules, refused without the right), moving (a stage's meaning, a lost
 *     lead's reason, a win that makes a customer and sets off a workflow on the win), notes;
 *   · a workflow that moves the lead it started from doesn't start itself again;
 *   · tickets: made, assigned to support only, once however often the step is tried;
 *   · email: refused without a way to send, to a contact who has left, to a bounced address; sent
 *     through the company's mail server and logged; at most once, and a send cut off part way waits
 *     for a person;
 *   · a document emailed with its PDF and logged; a draft refused;
 *   · a meeting without a calendar connected: in Deskzo's own calendar, the contact invited through the
 *     company's mail server with the meeting attached — booking one in a real calendar isn't exercised here;
 *   · a report emailed to colleagues, each seeing only their own reach;
 *   · the date checks: overdue invoices, renewals, quiet leads — once a day, and only when listened for.
 *
 *   npm run check:automate-actions
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { directClient } from "../src/lib/tenancy/direct-client";
import type { Definition } from "../src/lib/automate/definition";
import { clockFor } from "../src/lib/time/zone";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
delete process.env.TRUST_PROXY;

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const DAY = 86_400_000;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function main() {
  const india = clockFor("Asia/Kolkata");

  // ─── Scratch databases ──────────────────────────────────────────────────────────────────────
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const real = new URL(url).pathname.slice(1);
  section("A scratch workspace and control plane");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so scratch databases may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const names = { a: `${real}_autoact_a`, control: `${real}_autoact_ctl` };
  const admin = directClient(withDatabase(url, "postgres"));
  let close: (() => Promise<void>) | null = null;
  try {
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    const started = Date.now();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.a}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, names.a) }, timeout: 10 * 60_000 });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.control}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: withDatabase(url, names.control) }, timeout: 5 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.TENANT_DB_ZZACT_A = withDatabase(url, names.a);
    process.env.CONTROL_DATABASE_URL = withDatabase(url, names.control);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const { closeAllClients } = require("../src/lib/tenancy/clients") as typeof import("../src/lib/tenancy/clients");
    const { closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    close = async () => {
      await closeAllClients();
      await closeControlDb();
    };
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const engine = require("../src/lib/automate/engine") as typeof import("../src/lib/automate/engine");
    const store = require("../src/lib/automate/store") as typeof import("../src/lib/automate/store");
    const { validateDefinition } = require("../src/lib/automate/validate") as typeof import("../src/lib/automate/validate");
    const { actionByKey } = require("../src/lib/automate/registry") as typeof import("../src/lib/automate/registry");
    const { emitDateEvents } = require("../src/lib/automate/dates") as typeof import("../src/lib/automate/dates");
    const { providerByKey } = require("../src/lib/marketing/providers") as typeof import("../src/lib/marketing/providers");
    const pdf = require("../src/lib/documents/pdf") as typeof import("../src/lib/documents/pdf");
    type Outbound = import("../src/lib/marketing/providers/types").OutboundMessage;

    const A = (await registry.tenantBySlug("zzact-a"))!;
    ok("the registry knows the workspace", !!A);
    const inA = <T,>(work: () => Promise<T>) => runAsTenant(A, work);

    // ─── Pure: the report periods ────────────────────────────────────────────────────────────────
    section("Report periods on the workspace's clock");
    const { periodDays } = require("../src/lib/automate/actions/report-email") as typeof import("../src/lib/automate/actions/report-email");
    const at = new Date("2026-10-17T10:00:00Z");
    const p = (period: Parameters<typeof periodDays>[1], when = at) => {
      const d = periodDays(india, period, when);
      return `${d.from}..${d.to}`;
    };
    ok("yesterday, and the last 7 days before today", p("yesterday") === "2026-10-16..2026-10-16" && p("last_7_days") === "2026-10-10..2026-10-16", p("last_7_days"));
    ok("  last month, and this quarter so far", p("last_month") === "2026-09-01..2026-09-30" && p("this_quarter") === "2026-10-01..2026-10-17", `${p("last_month")} ${p("this_quarter")}`);
    ok("  last quarter", p("last_quarter") === "2026-07-01..2026-09-30", p("last_quarter"));
    const january = new Date("2027-01-05T04:00:00Z");
    ok("  across a new year: last month is December, last quarter October to December", p("last_month", january) === "2026-12-01..2026-12-31" && p("last_quarter", january) === "2026-10-01..2026-12-31", `${p("last_month", january)} ${p("last_quarter", january)}`);
    // 18:00 UTC on the 31st is 23:30 in India, still October there; an hour later it is November.
    ok("  'this month' is India's month, not the server's", p("this_month", new Date("2026-10-31T18:00:00Z")) === "2026-10-01..2026-10-31" && p("this_month", new Date("2026-10-31T19:00:00Z")) === "2026-11-01..2026-11-01");


    // The stand-in mail provider: what the company's mail server would have sent.
    const sent: Outbound[] = [];
    providerByKey.zztest = {
      key: "zztest",
      label: "ZZ stand-in",
      kind: "EMAIL",
      needs: [],
      send: async (message) => {
        sent.push(message);
        return { ok: true, providerMessageId: `zz-${sent.length}` };
      },
      verify: async () => ({ ok: true, detail: "stand-in" }),
    };
    pdf.setTestPdfRenderer(async () => Buffer.from("%PDF-1.4\n% zzact stand-in\n%%EOF\n"));

    // ─── Fixtures ───────────────────────────────────────────────────────────────────────────────
    const person = (email: string, role: string, extra: Record<string, unknown> = {}) =>
      inA(() => db.user.create({ data: { name: email.split("@")[0]!, email, passwordHash: "!", role, ...extra }, select: { id: true } }).then((u) => u.id));
    const owner = await person("zzowner@zzact.invalid", "ADMIN");
    const colleague = await person("zzcolleague@zzact.invalid", "SALES");
    const seller = await person("zzseller@zzact.invalid", "SALES");
    const support = await inA(() => db.department.create({ data: { name: "ZZ Support", isSupportTeam: true }, select: { id: true } }));
    const agent = await person("zzagent@zzact.invalid", "SUPPORT", { departmentId: support.id });

    const company = (name: string, ownerUserId: string) =>
      inA(() =>
        db.company.create({
          data: { name, normalizedName: name.toLowerCase(), createdById: owner, ownerUserId, locations: { create: { label: "Head Office", isPrimary: true, isBilling: true, isShipping: true } } },
          select: { id: true, locations: { select: { id: true } } },
        }),
      );
    const acme = await company("ZZ Acme", owner);
    const gamma = await company("ZZ Gamma", colleague);
    const contact = (companyId: string, name: string, email: string, extra: Record<string, unknown> = {}) =>
      inA(() => db.contact.create({ data: { companyId, name, email, ...extra }, select: { id: true } }).then((c) => c.id));
    const asha = await contact(acme.id, "Asha ZZ", "asha@zzact.invalid", { receivesDocuments: true, isPrimary: true });
    const gone = await contact(acme.id, "Gone ZZ", "gone@zzact.invalid", { leftAt: new Date() });
    const bounced = await contact(acme.id, "Bounced ZZ", "bounced@zzact.invalid");
    await inA(() => db.suppression.create({ data: { scope: "EMAIL", value: "bounced@zzact.invalid", reason: "HARD_BOUNCE" } }));
    // Customers' own choices (owner, 18 Oct 2026): one unsubscribed from everything, one who unticked renewal
    // reminders on the preference page, one who did that on the page before it showed reminders honestly.
    const leaver = await contact(acme.id, "Unsubscribed ZZ", "unsub@zzact.invalid");
    await inA(() => db.suppression.create({ data: { scope: "EMAIL", value: "unsub@zzact.invalid", reason: "UNSUBSCRIBED" } }));
    const noRenewals = await contact(acme.id, "No renewals ZZ", "norenew@zzact.invalid");
    await inA(() => db.contactConsent.create({ data: { contactId: noRenewals, topic: "RENEWALS", status: "UNSUBSCRIBED", source: "PREFERENCE_CENTRE", withdrawnAt: new Date() } }));
    const oldPage = await contact(acme.id, "Old page ZZ", "oldpage@zzact.invalid");
    await inA(() => db.contactConsent.create({ data: { contactId: oldPage, topic: "RENEWALS", status: "UNSUBSCRIBED", source: "PREFERENCE_CENTRE", withdrawnAt: new Date("2026-10-01T00:00:00Z") } }));
    const lead = (companyId: string, title: string, ownerUserId: string | null, extra: Record<string, unknown> = {}) =>
      inA(() => db.lead.create({ data: { companyId, title, ownerUserId, createdByUserId: owner, source: "OTHER", ...extra }, select: { id: true } }).then((l) => l.id));
    const deal = await lead(acme.id, "ZZ deal", owner, { contactId: asha });
    const loop = await lead(acme.id, "ZZ loop", owner);

    const publish = (ownerId: string, name: string, d: unknown) =>
      inA(async () => {
        const w = await store.createWorkflow({ name, ownerUserId: ownerId, createdById: ownerId, draft: d as Definition });
        const published = await store.publishWorkflow(w.id, ownerId);
        if (!published.ok) throw new Error(`${name}: ${published.error} ${JSON.stringify(published.problems ?? [])}`);
        return w.id;
      });
    const drain = () =>
      inA(async () => {
        for (let i = 0; i < 40; i++) {
          await engine.workTenant({ budgetMs: 15_000 });
          const due = (await db.automationRun.count({ where: { status: "QUEUED", runAfter: { lte: new Date() } } })) + (await db.automationEvent.count({ where: { matchedAt: null } }));
          if (!due) break;
        }
      });
    const manual = (steps: unknown[]) => ({ schema: 1, trigger: { type: "manual" }, steps });
    /** Publishes a one-off manual workflow, runs it to the end, and says how it went. */
    const runOnce = async (name: string, steps: unknown[], by = owner) => {
      const id = await publish(by, name, manual(steps));
      const started = await inA(() => store.startManualRun(id, by));
      if (!started.ok) throw new Error(`${name}: ${started.error}`);
      await drain();
      const run = await inA(() => db.automationRun.findUnique({ where: { id: started.data.runId }, select: { id: true, status: true, error: true } }));
      const steps2 = await inA(() => db.automationRunStep.findMany({ where: { runId: started.data.runId }, orderBy: { startedAt: "asc" }, select: { stepId: true, status: true, outputSummary: true, error: true } }));
      return { workflowId: id, runId: run!.id, status: run!.status, error: run!.error ?? "", steps: steps2 };
    };
    const runsOf = (workflowId: string) => inA(() => db.automationRun.findMany({ where: { workflowId }, select: { id: true, status: true, depth: true, error: true } }));
    const notes = (userId: string, type: string) => inA(() => db.notification.findMany({ where: { userId, type: type as never }, select: { title: true, message: true } }));

    // ─── Publishing ─────────────────────────────────────────────────────────────────────────────
    section("What publishing refuses of the new actions");
    const problems = (d: unknown) => {
      const v = validateDefinition(d);
      return v.ok ? [] : v.problems.map((x) => x.message);
    };
    const onLead = (steps: unknown[]) => ({ schema: 1, trigger: { type: "lead.created" }, steps });
    ok("a lead step fed by the trigger passes", problems(onLead([{ id: "a", type: "action", action: "lead.assign", input: { leadId: "{{trigger.lead.id}}", to: "rules" } }])).length === 0);
    ok("  the trigger's own fields: lead, company, contact, via — not 'ticket'", problems(onLead([{ id: "n", type: "action", action: "notify.person", input: { title: "{{trigger.ticket.title}}" } }])).some((m) => m.includes('no field "ticket"')));
    ok("a move needs a stage or a meaning, not both", problems(manual([{ id: "m", type: "action", action: "lead.move", input: { leadId: "x", stageId: "s", status: "WON" } }])).length === 1);
    ok("an email to a contact needs the contact", problems(manual([{ id: "e", type: "action", action: "email.send", input: { to: "contact", subject: "Hi", body: "Hello" } }])).some((m) => m.includes("which contact")));
    ok("  and a two-line subject is refused", problems(manual([{ id: "e", type: "action", action: "email.send", input: { to: "person", userId: "owner", subject: "One\nTwo", body: "Hello" } }])).some((m) => m.includes("one line")));
    ok("a lead needs an email or a phone", problems(manual([{ id: "c", type: "action", action: "lead.create", input: { name: "Somebody" } }])).some((m) => m.includes("email or a phone")));
    ok("a meeting's time is HH:MM", problems(manual([{ id: "c", type: "action", action: "meeting.schedule", input: { recordId: "x", at: "9am" } }])).some((m) => m.includes("HH:MM")));
    ok("a report's period is one of the list", problems(manual([{ id: "r", type: "action", action: "report.email", input: { source: "leads", measure: "count", dimension: "owner", period: "forever" } }])).length === 1);

    // ─── Leads ──────────────────────────────────────────────────────────────────────────────────
    section("A lead made by a workflow");
    const onNew = await publish(owner, "ZZ on new lead", {
      schema: 1,
      trigger: { type: "lead.created", filter: { all: [{ ref: "trigger.via", op: "eq", value: "workflow" }] } },
      steps: [{ id: "tell", type: "action", action: "notify.person", input: { title: "ZZ new: {{trigger.lead.title}} ({{trigger.lead.ref}})" } }],
    });
    const made = await runOnce("ZZ make lead", [{ id: "make", type: "action", action: "lead.create", input: { name: "Ravi ZZ", email: "ravi@zzact.invalid", company: "ZZ Beta", interest: "Laptops", owner: colleague, value: 50000 } }]);
    const madeLead = await inA(() => db.lead.findFirst({ where: { company: { name: "ZZ Beta" } }, select: { id: true, ownerUserId: true, sourceDetail: true, estimatedValue: true, title: true, contact: { select: { email: true } } } }));
    ok("the run makes the company, the contact and the lead", made.status === "SUCCEEDED" && !!madeLead, `${made.status} ${made.error}`);
    ok("  the lead is the named person's, with its value, and says it came from the workflow", madeLead?.ownerUserId === colleague && Number(madeLead.estimatedValue) === 50000 && !!madeLead.sourceDetail?.includes("ZZ make lead"), madeLead?.sourceDetail);
    ok("  they are told it is theirs", (await notes(colleague, "LEAD_ASSIGNED")).some((n) => n.title.includes("workflow")));
    const createdEvent = await inA(() => db.automationEvent.findFirst({ where: { type: "lead.created", recordId: madeLead?.id }, select: { causedByRunId: true, depth: true, payload: true } }));
    ok("its lead.created event is caused by the run, one level deeper", createdEvent?.causedByRunId === made.runId && createdEvent.depth === 1);
    ok("  and carries no email address", !!createdEvent && !JSON.stringify(createdEvent.payload).includes("ravi@"), JSON.stringify(createdEvent?.payload).slice(0, 120));
    const onNewRuns = await runsOf(onNew);
    ok("a workflow on lead.created runs once, a level deeper, with the lead's title written in", onNewRuns.length === 1 && onNewRuns[0]!.depth === 1 && (await notes(owner, "WORKFLOW_MESSAGE")).some((n) => n.title.startsWith("ZZ new: Laptops — ZZ Beta (")), JSON.stringify(onNewRuns));
    const again = await runOnce("ZZ make lead again", [{ id: "make", type: "action", action: "lead.create", input: { name: "Ravi ZZ", email: "ravi@zzact.invalid", company: "ZZ Beta" } }]);
    ok("the same person again: no second company or contact, a second lead", again.status === "SUCCEEDED" && (await inA(() => db.company.count({ where: { name: "ZZ Beta" } }))) === 1 && (await inA(() => db.contact.count({ where: { email: "ravi@zzact.invalid" } }))) === 1 && (await inA(() => db.lead.count({ where: { company: { name: "ZZ Beta" } } }))) === 2);

    // A step tried twice — the worker died after the first try made the lead.
    const direct = await publish(owner, "ZZ direct", manual([{ id: "end", type: "stop", outcome: "succeeded" }]));
    const directRun = await inA(() => store.startManualRun(direct, owner));
    if (!directRun.ok) throw new Error(directRun.error);
    const ctxFor = (stepId: string) => ({ actorId: owner, workflowId: direct, workflowName: "ZZ direct", runId: directRun.data.runId, stepId, key: `${directRun.data.runId}:${stepId}`, depth: 0, clock: india });
    const createLead = actionByKey("lead.create")!;
    const leadInput = createLead.input.parse({ name: "Twice ZZ", phone: "+919800000001", company: "ZZ Twice" });
    const firstTry = (await inA(() => createLead.run(ctxFor("twice"), leadInput))) as { leadId?: string };
    const secondTry = (await inA(() => createLead.run(ctxFor("twice"), leadInput))) as { leadId?: string };
    ok("a lead step tried twice makes one lead, and both tries name it", !!firstTry.leadId && firstTry.leadId === secondTry.leadId && (await inA(() => db.lead.count({ where: { company: { name: "ZZ Twice" } } }))) === 1);

    section("Assigning, moving and noting a lead");
    const assigned = await runOnce("ZZ assign", [{ id: "give", type: "action", action: "lead.assign", input: { leadId: deal, to: colleague } }]);
    const dealNow = await inA(() => db.lead.findUnique({ where: { id: deal }, select: { ownerUserId: true, assignmentNote: true } }));
    ok("assigning gives the lead to the person, and says how", assigned.status === "SUCCEEDED" && dealNow?.ownerUserId === colleague && !!dealNow.assignmentNote?.includes("ZZ assign"), `${assigned.error} ${dealNow?.assignmentNote}`);
    ok("  the step's output says who has it, for the steps after", JSON.stringify(assigned.steps[0]?.outputSummary).includes(colleague));
    const byRules = await runOnce("ZZ assign by rules", [{ id: "give", type: "action", action: "lead.assign", input: { leadId: deal, to: "rules" } }]);
    ok("by the rules, with none set up: refused, and the lead stays", byRules.status === "FAILED" && byRules.error.includes("No assignment rule") && (await inA(() => db.lead.findUnique({ where: { id: deal }, select: { ownerUserId: true } })))?.ownerUserId === colleague, byRules.error);
    const notTheirs = await runOnce("ZZ seller assigns", [{ id: "give", type: "action", action: "lead.assign", input: { leadId: loop, to: seller } }], seller);
    ok("a salesperson's workflow can't hand on a lead that isn't theirs to give", notTheirs.status === "FAILED" && (await inA(() => db.lead.findUnique({ where: { id: loop }, select: { ownerUserId: true } })))?.ownerUserId === owner, notTheirs.error);

    const qualified = await runOnce("ZZ qualify", [{ id: "move", type: "action", action: "lead.move", input: { leadId: deal, status: "QUALIFIED" } }]);
    const movedEvent = await inA(() => db.automationEvent.findFirst({ where: { type: "lead.stage_changed", causedByRunId: qualified.runId }, select: { payload: true, depth: true } }));
    ok("moving by meaning puts it in that stage, with the stage-change note", qualified.status === "SUCCEEDED" && (await inA(() => db.lead.findUnique({ where: { id: deal }, select: { status: true } })))?.status === "QUALIFIED" && (await inA(() => db.activity.count({ where: { leadId: deal, type: "STAGE_CHANGE" } }))) === 1, qualified.error);
    ok("  and records lead.stage_changed, from and to, caused by the run", movedEvent?.depth === 1 && (movedEvent.payload as { to?: { status?: string } }).to?.status === "QUALIFIED");
    const lostNoReason = await runOnce("ZZ lose", [{ id: "move", type: "action", action: "lead.move", input: { leadId: deal, status: "LOST" } }]);
    ok("lost without a reason is refused, as on the board", lostNoReason.status === "FAILED" && lostNoReason.error.includes("reason is required"), lostNoReason.error);

    const onWin = await publish(owner, "ZZ on win", {
      schema: 1,
      trigger: { type: "lead.won" },
      steps: [{ id: "note", type: "action", action: "lead.note", input: { leadId: "{{trigger.lead.id}}", note: "ZZ won, kick-off next", type: "NOTE" } }],
    });
    const won = await runOnce("ZZ win", [{ id: "move", type: "action", action: "lead.move", input: { leadId: deal, status: "WON" } }]);
    ok("a win in the sales pipeline makes the company a customer", won.status === "SUCCEEDED" && (await inA(() => db.company.findUnique({ where: { id: acme.id }, select: { stage: true } })))?.stage === "CUSTOMER", won.error);
    const winRuns = await runsOf(onWin);
    const winNote = await inA(() => db.activity.findFirst({ where: { leadId: deal, type: "NOTE", notes: "ZZ won, kick-off next" }, select: { userId: true } }));
    ok("  a workflow on lead.won runs once and notes it on the lead, as its owner", winRuns.length === 1 && winRuns[0]!.status === "SUCCEEDED" && winNote?.userId === owner, JSON.stringify(winRuns));
    ok("  and the lead's owner is told of the note", (await notes(colleague, "LEAD_ACTIVITY")).some((n) => n.message?.includes("ZZ won")));

    const selfMover = await publish(owner, "ZZ self mover", {
      schema: 1,
      trigger: { type: "lead.stage_changed", filter: { all: [{ ref: "trigger.lead.title", op: "eq", value: "ZZ loop" }] } },
      steps: [{ id: "move", type: "action", action: "lead.move", input: { leadId: "{{trigger.lead.id}}", status: "CONTACTED" } }],
    });
    await runOnce("ZZ start the loop", [{ id: "move", type: "action", action: "lead.move", input: { leadId: loop, status: "QUALIFIED" } }]);
    const loopRuns = await runsOf(selfMover);
    const ownMove = await inA(() => db.automationEvent.findFirst({ where: { type: "lead.stage_changed", recordId: { startsWith: `${loop}>` }, payload: { path: ["to", "status"], equals: "CONTACTED" } }, select: { causedByRunId: true, depth: true } }));
    ok("a workflow's own move is recorded as caused by its run, a level deeper", !!ownMove && ownMove.causedByRunId === loopRuns[0]?.id && ownMove.depth === 2, JSON.stringify(ownMove));
    ok("  so a workflow that moves the lead it started from doesn't start itself again", loopRuns.length === 1 && (await inA(() => db.lead.findUnique({ where: { id: loop }, select: { status: true } })))?.status === "CONTACTED", JSON.stringify(loopRuns));
    await inA(() => db.automationWorkflow.updateMany({ where: { id: { in: [onNew, onWin, selfMover] } }, data: { status: "PAUSED" } }));

    // ─── Tickets ────────────────────────────────────────────────────────────────────────────────
    section("Tickets");
    const ticketed = await runOnce("ZZ ticket", [{ id: "open", type: "action", action: "ticket.create", input: { companyId: acme.id, contactId: asha, title: "ZZ printer jammed", priority: "HIGH", assignTo: agent } }]);
    const ticket = await inA(() => db.ticket.findFirst({ where: { title: "ZZ printer jammed" }, select: { id: true, createdByUserId: true, assignedToUserId: true, priority: true } }));
    ok("a ticket is opened as the owner, assigned to support", ticketed.status === "SUCCEEDED" && ticket?.createdByUserId === owner && ticket.assignedToUserId === agent && ticket.priority === "HIGH", ticketed.error);
    ok("  the agent is told, and ticket.created is recorded from the workflow", (await notes(agent, "TICKET_ASSIGNED")).length === 1 && (await inA(() => db.automationEvent.count({ where: { type: "ticket.created", recordId: ticket?.id, causedByRunId: ticketed.runId } }))) === 1);
    const wrongAgent = await runOnce("ZZ ticket to sales", [{ id: "open", type: "action", action: "ticket.create", input: { companyId: acme.id, title: "ZZ for sales", assignTo: colleague } }]);
    ok("assigning a ticket outside support is refused", wrongAgent.status === "FAILED" && wrongAgent.error.includes("Tech Support"), wrongAgent.error);
    const openTicket = actionByKey("ticket.create")!;
    const ticketInput = openTicket.input.parse({ companyId: acme.id, title: "ZZ twice ticket" });
    await inA(() => openTicket.run(ctxFor("ticket"), ticketInput));
    await inA(() => openTicket.run(ctxFor("ticket"), ticketInput));
    ok("a ticket step tried twice opens one ticket", (await inA(() => db.ticket.count({ where: { title: "ZZ twice ticket" } }))) === 1);

    // ─── Email ──────────────────────────────────────────────────────────────────────────────────
    section("Email");
    const fromCompany = (input: Record<string, unknown>) => [{ id: "send", type: "action", action: "email.send", input: { from: "company", subject: "ZZ hello", body: "Hello there.\n\nRegards", ...input } }];
    const noServer = await runOnce("ZZ mail, no server", fromCompany({ to: "lead_contact", leadId: deal }));
    ok("through the company's mail server, with none set up: refused, saying where to set one up", noServer.status === "FAILED" && noServer.error.includes("Mail & messaging"), noServer.error);
    const noMailbox = await runOnce("ZZ mail, no mailbox", [{ id: "send", type: "action", action: "email.send", input: { to: "lead_contact", leadId: deal, from: "owner", subject: "ZZ hi", body: "Hi" } }]);
    ok("from the owner's mailbox, with none connected: refused", noMailbox.status === "FAILED" && noMailbox.error.includes("mailbox"), noMailbox.error);

    await inA(() => db.messagingProvider.create({ data: { key: "zztest", label: "ZZ stand-in", kind: "EMAIL", enabled: true, priority: 1, classes: ["TRANSACTIONAL"], fromEmail: "crm@zzact.invalid" } }));
    const mailed = await runOnce("ZZ mail the contact", fromCompany({ to: "lead_contact", leadId: deal }));
    const toAsha = sent.find((m) => m.to === "asha@zzact.invalid");
    ok("sent to the lead's contact through the company's mail server", mailed.status === "SUCCEEDED" && !!toAsha, mailed.error);
    ok("  in the owner's name, replies to them, the body as paragraphs", toAsha?.replyTo === "zzowner@zzact.invalid" && !!toAsha.fromName?.includes("zzowner") && (toAsha.html.match(/<p>/g) ?? []).length === 3);
    const ashaLog = await inA(() => db.marketingMessage.findFirst({ where: { contactId: asha, messageClass: "TRANSACTIONAL" }, orderBy: { createdAt: "desc" }, select: { token: true } }));
    ok("  ending with the link to choose what they're sent — its own logged email's", !!ashaLog && !!toAsha?.text?.includes(`/preferences/${ashaLog.token}`) && !!toAsha.text.includes("Manage what we send you"), toAsha?.text?.split("Regards")[1]);
    ok("  on the contact's mail log and the lead's timeline", (await inA(() => db.marketingMessage.count({ where: { contactId: asha, status: "SENT", messageClass: "TRANSACTIONAL" } }))) === 1 && (await inA(() => db.activity.count({ where: { leadId: deal, type: "EMAIL" } }))) === 1);
    const toGone = await runOnce("ZZ mail the leaver", fromCompany({ to: "contact", contactId: gone }));
    ok("not to somebody who has left the company", toGone.status === "FAILED" && toGone.error.includes("has left"), toGone.error);
    const toBounced = await runOnce("ZZ mail the bounced", fromCompany({ to: "contact", contactId: bounced }));
    ok("not to an address that bounced", toBounced.status === "FAILED" && toBounced.error.toLowerCase().includes("bounced"), toBounced.error);
    const sentBeforeChoices = sent.length;
    const toLeaver = await runOnce("ZZ mail the unsubscribed", fromCompany({ to: "contact", contactId: leaver }));
    const leaverStep = toLeaver.steps.find((s) => s.stepId === "send");
    ok("not to somebody who unsubscribed from everything — and the run goes on, nothing wrong", toLeaver.status === "SUCCEEDED" && leaverStep?.status === "SUCCEEDED" && JSON.stringify(leaverStep.outputSummary).includes('"sent":false') && sent.length === sentBeforeChoices, JSON.stringify(leaverStep?.outputSummary));
    const renewalNote = await runOnce("ZZ renewal to the opted out", fromCompany({ to: "contact", contactId: noRenewals, topic: "RENEWALS" }));
    ok("a renewal reminder not to somebody who unticked renewal reminders", renewalNote.status === "SUCCEEDED" && sent.length === sentBeforeChoices && JSON.stringify(renewalNote.steps[0]?.outputSummary).includes("opted out"), JSON.stringify(renewalNote.steps[0]?.outputSummary));
    const serviceNote = await runOnce("ZZ service note to them", fromCompany({ to: "contact", contactId: noRenewals }));
    ok("  a service notice still reaches them", serviceNote.status === "SUCCEEDED" && sent.some((m) => m.to === "norenew@zzact.invalid"), serviceNote.error);
    const oldPageNote = await runOnce("ZZ renewal to the old page", fromCompany({ to: "contact", contactId: oldPage, topic: "RENEWALS" }));
    ok("  and one unticked on the page before it showed reminders honestly isn't held against them", oldPageNote.status === "SUCCEEDED" && sent.some((m) => m.to === "oldpage@zzact.invalid"), oldPageNote.error);
    const toColleague = await runOnce("ZZ mail a colleague", fromCompany({ to: "person", userId: colleague }));
    ok("to a colleague: sent, and not on any customer's log", toColleague.status === "SUCCEEDED" && sent.some((m) => m.to === "zzcolleague@zzact.invalid") && (await inA(() => db.marketingMessage.count({ where: { toEmail: "zzcolleague@zzact.invalid" } }))) === 0, toColleague.error);

    const mail = actionByKey("email.send")!;
    const mailInput = mail.input.parse({ to: "contact", contactId: asha, from: "company", subject: "ZZ once", body: "Once" });
    const before = sent.length;
    await inA(() => mail.run(ctxFor("once"), mailInput));
    await inA(() => mail.run(ctxFor("once"), mailInput));
    ok("an email step tried twice sends once", sent.length === before + 1, sent.length - before);

    const cutOff = await publish(owner, "ZZ cut off", manual(fromCompany({ to: "contact", contactId: asha, subject: "ZZ cut off" })));
    const cutRun = await inA(() => store.startManualRun(cutOff, owner));
    if (cutRun.ok) {
      // A worker that stopped after sending and before saying so leaves the step marked.
      await inA(() => db.automationEffect.create({ data: { key: `${cutRun.data.runId}:send`, runId: cutRun.data.runId, output: { $sending: true } } }));
      const was = sent.length;
      await drain();
      const row = await inA(() => db.automationRun.findUnique({ where: { id: cutRun.data.runId }, select: { status: true, error: true } }));
      ok("a send cut off part way isn't sent again: the run waits for a person", row?.status === "NEEDS_ATTENTION" && sent.length === was, `${row?.status} ${row?.error}`);
    }

    // ─── Documents ──────────────────────────────────────────────────────────────────────────────
    section("Documents");
    await inA(() => db.documentMailSettings.upsert({ where: { id: "global" }, create: { id: "global", sendFrom: "COMPANY", updatedById: owner }, update: { sendFrom: "COMPANY" } }));
    const invoice = await inA(() =>
      db.tradeDocument.create({
        data: { docNumber: "ZZ-INV-1", docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: acme.id, createdById: owner, issueDate: new Date(Date.now() - 2 * DAY), dueDate: new Date(Date.now() + 20 * DAY) },
        select: { id: true },
      }),
    );
    const draft = await inA(() => db.tradeDocument.create({ data: { docNumber: "ZZ-DRAFT", docType: "INVOICE", direction: "SALES", status: "DRAFT", companyId: acme.id, createdById: owner }, select: { id: true } }));
    const docMailed = await runOnce("ZZ email invoice", [{ id: "send", type: "action", action: "document.email", input: { documentId: invoice.id } }]);
    const withPdf = sent.find((m) => m.to === "asha@zzact.invalid" && (m.attachments?.length ?? 0) === 1);
    ok("an issued invoice goes to the contact who receives documents, with its PDF", docMailed.status === "SUCCEEDED" && !!withPdf && withPdf.attachments![0]!.contentType === "application/pdf", docMailed.error);
    ok("  in the workspace's wording, logged on the document", !!withPdf?.subject.includes("ZZ-INV-1") && (await inA(() => db.marketingMessage.count({ where: { tradeDocumentId: invoice.id, status: "SENT" } }))) === 1 && !!(await inA(() => db.tradeDocument.findUnique({ where: { id: invoice.id }, select: { lastEmailedAt: true } })))?.lastEmailedAt, withPdf?.subject);
    const draftMailed = await runOnce("ZZ email draft", [{ id: "send", type: "action", action: "document.email", input: { documentId: draft.id } }]);
    ok("a draft is refused", draftMailed.status === "FAILED" && draftMailed.error.includes("Issue it first"), draftMailed.error);

    // ─── Meetings ───────────────────────────────────────────────────────────────────────────────
    section("Meetings");
    const invitesBefore = sent.length;
    const meeting = await runOnce("ZZ meeting", [{ id: "book", type: "action", action: "meeting.schedule", input: { record: "lead", recordId: deal, inDays: 1, at: "11:00" } }]);
    const invite = sent.slice(invitesBefore).find((m) => m.calendar?.method === "REQUEST");
    const booked = await inA(() => db.calendarEvent.findFirst({ where: { leadId: deal, fromDeskzo: true }, select: { id: true, provider: true, userId: true, startsAt: true } }));
    ok("with no calendar connected: booked in Deskzo's own calendar, in the owner's name, on the lead", meeting.status === "SUCCEEDED" && !!booked && booked.provider === null && booked.userId === owner, meeting.error);
    ok("  the lead's contact invited through the company's mail server, the meeting attached", invite?.to === "asha@zzact.invalid" && invite.calendar!.content.includes(`UID:${booked?.id}@deskzo.com`) && invite.replyTo === "zzowner@zzact.invalid");
    ok("  at 11:00 tomorrow on the workspace's clock", !!booked && india.dateKey(booked.startsAt) === india.dateKey(new Date(Date.now() + 86_400_000)) && india.time(booked.startsAt) === "11:00 am", booked && india.dateTime(booked.startsAt));
    console.log("  (booking in a real calendar isn't exercised here: it needs Outlook, Google or Zoho)");

    // ─── Reports ────────────────────────────────────────────────────────────────────────────────
    section("Reports");
    await lead(gamma.id, "ZZ gamma deal", colleague);
    const mailsBefore = sent.length;
    const report = await runOnce("ZZ weekly report", [{ id: "mail", type: "action", action: "report.email", input: { source: "leads", measure: "count", dimension: "owner", period: "this_month", to: ["owner", colleague] } }]);
    const reports = sent.slice(mailsBefore);
    const ownersCopy = reports.find((m) => m.to === "zzowner@zzact.invalid");
    const colleaguesCopy = reports.find((m) => m.to === "zzcolleague@zzact.invalid");
    ok("a report goes to each person named", report.status === "SUCCEEDED" && !!ownersCopy && !!colleaguesCopy, `${report.error} ${reports.map((m) => m.to).join(", ")}`);
    ok("  the owner's has every lead: theirs and the colleague's", !!ownersCopy?.html.includes(">zzowner</td>") && !!ownersCopy.html.includes(">zzcolleague</td>"));
    ok("  the colleague's has only what they could see on the Reports page", !!colleaguesCopy?.html.includes(">zzcolleague</td>") && !colleaguesCopy.html.includes(">zzowner</td>"));
    const reportLog = await inA(() => db.activityLog.findFirst({ where: { kind: "SEARCH", userId: colleague }, select: { summary: true } }));
    ok("  the security log names who it was run for, and that a workflow ran it", !!reportLog?.summary.includes("run for zzcolleague by workflow"), reportLog?.summary);

    // ─── Date checks ────────────────────────────────────────────────────────────────────────────
    section("The date checks");
    const nobody = await inA(() => emitDateEvents(india));
    ok("nobody listening: nothing done, and the day left unclaimed", nobody === null && (await inA(() => db.dailyJobRun.count({ where: { job: "automate-dates" } }))) === 0);
    const todayKey = india.dateKey(new Date());
    const [y, m, d] = todayKey.split("-").map(Number);
    const typedDay = (offset: number) => new Date(Date.UTC(y!, m! - 1, d! + offset));
    await inA(() => db.tradeDocument.create({ data: { docNumber: "ZZ-OVERDUE", docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: acme.id, createdById: owner, issueDate: typedDay(-33), dueDate: typedDay(-3) } }));
    await lead(acme.id, "ZZ quiet", owner, { stageChangedAt: new Date(Date.now() - 5 * DAY - 3_600_000) });
    const plan = await inA(() => db.item.create({ data: { name: "ZZ Cloud plan", sku: "ZZ-CLOUD", type: "SUBSCRIPTION", sellingPrice: 1000, createdById: owner }, select: { id: true } }));
    await inA(() => db.companyProduct.create({ data: { companyId: acme.id, locationId: acme.locations[0]!.id, itemId: plan.id, addedByUserId: owner, quantity: 5, endDate: typedDay(30) } }));
    const tell = (title: string) => [{ id: "tell", type: "action", action: "notify.person", input: { title } }];
    await publish(owner, "ZZ overdue", { schema: 1, trigger: { type: "invoice.overdue", filter: { all: [{ ref: "trigger.daysOverdue", op: "eq", value: 3 }] } }, steps: tell("ZZ overdue {{trigger.document.number}}") });
    await publish(owner, "ZZ renewal", { schema: 1, trigger: { type: "renewal.due", filter: { all: [{ ref: "trigger.daysLeft", op: "eq", value: 30 }] } }, steps: tell("ZZ renewal {{trigger.order.itemName}}") });
    await publish(owner, "ZZ quiet", { schema: 1, trigger: { type: "lead.quiet", filter: { all: [{ ref: "trigger.lead.title", op: "eq", value: "ZZ quiet" }] } }, steps: tell("ZZ quiet for {{trigger.daysQuiet}} days") });
    // Microsoft 365 renewal reminders (owner, 1 Nov 2026): the importable file, its template chosen.
    const m365 = await inA(() => db.item.create({ data: { name: "ZZ Microsoft 365 Business Basic", sku: "ZZ-M365-BB", type: "SUBSCRIPTION", sellingPrice: 145, createdById: owner }, select: { id: true } }));
    await inA(() => db.companyProduct.create({ data: { companyId: acme.id, locationId: acme.locations[0]!.id, itemId: m365.id, addedByUserId: owner, quantity: 12, endDate: typedDay(30), fullTermUnitPrice: 1740 } }));
    const reminder = await inA(() =>
      db.marketingTemplate.create({
        data: { name: "ZZ M365 reminder", channel: "EMAIL", subject: "{{productName}} renews in {{daysLeft}} days", body: "Hi {{firstName|there}},\n\n{{companyName}}'s {{productName}} ({{quantity}} seats) ends on {{expiryDate}}. {{daysLeftPhrase|}} Renewal: {{renewalValue|to confirm}}. Renew at https://zzact.invalid/renew.\n\nRegards", createdById: owner },
        select: { id: true },
      }),
    );
    const m365File = JSON.parse(readFileSync("automate-templates/microsoft-365-renewal-reminders.json", "utf8")) as { definition: { steps: { id: string; input?: Record<string, unknown> }[] } };
    // Copies (owner, 1 Nov 2026): the account manager, a colleague, an address, the customer's other document contacts.
    const billing = await contact(acme.id, "Billing ZZ", "billing@zzact.invalid", { receivesDocuments: true });
    Object.assign(m365File.definition.steps.find((s) => s.id === "email_customer")!.input!, { templateId: reminder.id, ccPeople: [colleague], ccEmails: ["Renewals@zzact.invalid", "asha@zzact.invalid"], ccContacts: true });
    await publish(owner, "ZZ M365 reminders", m365File.definition);
    // A template step that doesn't name the subscription (owner, 3 Nov 2026 — an email read "Your subscription · We'll
    // confirm"): filled from the one that started the run.
    const plain = await inA(() =>
      db.marketingTemplate.create({ data: { name: "ZZ no order named", channel: "EMAIL", subject: "ZZ filled: {{quantity|?}} seats, {{expiryDate|We'll confirm}}", body: "{{productName|Your subscription}} renews.", createdById: owner }, select: { id: true } }),
    );
    await publish(owner, "ZZ no order named", {
      schema: 1,
      trigger: { type: "renewal.due", filter: { all: [{ ref: "trigger.daysLeft", op: "eq", value: 30 }, { ref: "trigger.order.itemSku", op: "eq", value: "ZZ-M365-BB" }] } },
      steps: [{ id: "mail", type: "action", action: "email.send", input: { to: "company_contact", companyId: "{{trigger.company.id}}", from: "company", topic: "RENEWALS", templateId: plain.id } }],
    });

    // One email for a customer's subscriptions ending the same day (owner, 3 Nov 2026 — src/lib/subscriptions/same-day.ts).
    const delta = await company("ZZ Delta", owner);
    await contact(delta.id, "Dev ZZ", "dev@zzact.invalid", { receivesDocuments: true, isPrimary: true });
    const sub = async (name: string, sku: string, quantity: number, days: number, price = 1000) => {
      const made = await inA(() => db.item.create({ data: { name, sku, type: "SUBSCRIPTION", sellingPrice: price, createdById: owner }, select: { id: true } }));
      await inA(() => db.companyProduct.create({ data: { companyId: delta.id, locationId: delta.locations[0]!.id, itemId: made.id, addedByUserId: owner, quantity, endDate: typedDay(days), fullTermUnitPrice: price } }));
    };
    // Through the Microsoft 365 workflow, 15 days out: two of its products and one of another maker's, on one day.
    await sub("ZZ Microsoft 365 Standard", "ZZ-M365-S", 10, 15);
    await sub("ZZ Microsoft 365 Premium", "ZZ-M365-P", 5, 15, 2000);
    await sub("ZZ Other Maker", "ZZ-OTHER", 3, 15);
    // And one ending another day: its own email.
    await sub("ZZ Microsoft 365 Apps", "ZZ-M365-A", 2, 10);
    // A template that draws the table.
    const tableTemplate = await inA(() =>
      db.marketingTemplate.create({ data: { name: "ZZ table", channel: "EMAIL", subject: "ZZ table: {{subscriptionCount}} renewing", body: "{{subscriptions}}\n\nTotal seats {{quantity}}, {{renewalValue|?}}.", createdById: owner }, select: { id: true } }),
    );
    await sub("ZZ Table One", "ZZ-TBL-1", 4, 12);
    await sub("ZZ Table Two", "ZZ-TBL-2", 6, 12);
    const emailTo = (templateId: string, extra: Record<string, unknown> = {}) => [{ id: "mail", type: "action", action: "email.send", input: { to: "company_contact", companyId: "{{trigger.company.id}}", from: "company", topic: "RENEWALS", templateId, ...extra } }];
    await publish(owner, "ZZ table workflow", { schema: 1, trigger: { type: "renewal.due", filter: { all: [{ ref: "trigger.daysLeft", op: "eq", value: 12 }] } }, steps: emailTo(tableTemplate.id) });
    // The tick off: one each, as before.
    const eachTemplate = await inA(() => db.marketingTemplate.create({ data: { name: "ZZ each", channel: "EMAIL", subject: "ZZ each: {{productName}}", body: "{{productName}} renews.", createdById: owner }, select: { id: true } }));
    await sub("ZZ Each One", "ZZ-EACH-1", 1, 13);
    await sub("ZZ Each Two", "ZZ-EACH-2", 1, 13);
    await publish(owner, "ZZ each workflow", { schema: 1, trigger: { type: "renewal.due", filter: { all: [{ ref: "trigger.daysLeft", op: "eq", value: 13 }] } }, steps: emailTo(eachTemplate.id, { sameDay: false }) });

    // A custom date field coming up (owner, 7 Nov 2026 — src/lib/automate/custom-dates.ts).
    const dateField = (entity: string, key: string, label: string, extra: object = {}) =>
      inA(() => db.customFieldDefinition.create({ data: { entity: entity as never, key, label, type: "DATE", ...extra } }));
    await dateField("CONTACT", "visa_expiry", "Visa expiry");
    await dateField("COMPANY", "licence_expiry", "Trade licence expiry");
    await dateField("COMPANY", "zz_secret_date", "Restricted date", { restricted: true });
    await dateField("COMPANY", "zz_retired_date", "Retired date", { archivedAt: new Date() });
    const offsetDay = (offset: number) => typedDay(offset).toISOString().slice(0, 10);
    await inA(() => db.company.update({ where: { id: acme.id }, data: { customFields: { licence_expiry: offsetDay(60), zz_secret_date: offsetDay(60), zz_retired_date: offsetDay(60) } } }));
    const visaHolder = await inA(() => db.contact.create({ data: { companyId: acme.id, name: "ZZ Visa Holder", email: "visa@zzact.invalid", customFields: { visa_expiry: offsetDay(30) } }, select: { id: true } }));
    await inA(() => db.contact.create({ data: { companyId: acme.id, name: "ZZ Left", email: "left@zzact.invalid", leftAt: new Date(), customFields: { visa_expiry: offsetDay(30) } } }));
    await inA(() => db.contact.create({ data: { companyId: acme.id, name: "ZZ Far Off", email: "far@zzact.invalid", customFields: { visa_expiry: offsetDay(300) } } }));
    await inA(() => db.contact.create({ data: { companyId: acme.id, name: "ZZ Expired", email: "expired@zzact.invalid", customFields: { visa_expiry: offsetDay(-5) } } }));
    const { createFromTemplate } = store;
    ok("the template asks which date", !(await inA(() => createFromTemplate("custom-date-reminder", {}, owner))).ok);
    const reminderDraft = await inA(() => createFromTemplate("custom-date-reminder", { field: "visa_expiry", first: 60, second: 30, third: 7 }, owner));
    ok("  given one, a draft", reminderDraft.ok, reminderDraft.ok ? "" : reminderDraft.error);
    if (reminderDraft.ok) {
      const published = await inA(() => store.publishWorkflow(reminderDraft.data.ids[0]!, owner));
      ok("  which publishes", published.ok, published.ok ? "" : JSON.stringify(published));
    }
    await publish(colleague, "ZZ colleague's date", { schema: 1, trigger: { type: "custom_date.coming", filter: { all: [{ ref: "trigger.field.key", op: "eq", value: "visa_expiry" }, { ref: "trigger.daysLeft", op: "eq", value: 30 }] } }, steps: tell("ZZ colleague told") });

    const today = await inA(() => emitDateEvents(india));
    const dated = await inA(() => db.automationEvent.findMany({ where: { type: { in: ["invoice.overdue", "renewal.due", "lead.quiet"] } }, select: { type: true, recordId: true, payload: true } }));
    const overdue = dated.find((e) => e.type === "invoice.overdue" && (e.payload as { document?: { number?: string } }).document?.number === "ZZ-OVERDUE");
    ok("once listened for, the day's checks record their events", !!today && today.events >= 3 && !!overdue, JSON.stringify(today));
    ok("  each with how many days, and keyed by the day", (overdue?.payload as { daysOverdue?: number }).daysOverdue === 3 && !!overdue?.recordId?.endsWith(`@${todayKey}`), overdue?.recordId);
    ok("  run again the same day, nothing", (await inA(() => emitDateEvents(india))) === null);
    const customEvents = await inA(() => db.automationEvent.findMany({ where: { type: "custom_date.coming" }, select: { recordType: true, recordId: true, payload: true } }));
    const seen = customEvents.map((e) => e.payload as { field: { key: string; label: string }; date: string; daysLeft: number; record: { id: string; name: string }; company: { name: string } | null; contact: { id: string } | null });
    const visa = seen.find((p) => p.record.name === "ZZ Visa Holder");
    ok("a custom date: an event with its field, date, days and record", visa?.field.label === "Visa expiry" && visa.daysLeft === 30 && visa.date === offsetDay(30) && visa.contact?.id === visaHolder.id && visa.company?.name === "ZZ Acme", JSON.stringify(visa));
    ok("  on a company too", seen.find((p) => p.field.key === "licence_expiry")?.daysLeft === 60);
    ok("  past dates a while, negative", seen.find((p) => p.record.name === "ZZ Expired")?.daysLeft === -5);
    ok("  not a contact who has left, nor one too far off", !seen.some((p) => p.record.name === "ZZ Left" || p.record.name === "ZZ Far Off"));
    ok("  not a restricted or retired field", !seen.some((p) => p.field.key === "zz_secret_date" || p.field.key === "zz_retired_date"));
    ok("  keyed by record first, for the owner's access check", customEvents.every((e) => e.recordId!.endsWith(`:${todayKey}`) && !e.recordId!.split("@")[0]!.includes(":")));
    await drain();
    const told = (await notes(owner, "WORKFLOW_MESSAGE")).map((n) => n.title);
    ok("the template's reminder: told on the chosen day", told.includes("Visa expiry in 30 days"), told.join(" | "));
    const dateTasks = await inA(() => db.task.findMany({ where: { title: { startsWith: "Visa expiry: ZZ Visa Holder" } }, select: { assignedToUserId: true, title: true } }));
    ok("  and a task, for the account manager", dateTasks.length === 1 && dateTasks[0]!.assignedToUserId === owner, JSON.stringify(dateTasks));
    ok("  not on the other days", !told.some((t) => t.startsWith("Visa expiry in -5")));
    ok("a workflow whose owner can't see the record doesn't run", !(await notes(colleague, "WORKFLOW_MESSAGE")).some((n) => n.title === "ZZ colleague told"));
    const m365Mail = sent.filter((m) => m.subject.includes("Microsoft 365") && m.to === "asha@zzact.invalid");
    ok("Microsoft 365 reminders: the subscription's customer emailed once, from the template", m365Mail.length === 1 && m365Mail[0]!.to === "asha@zzact.invalid" && m365Mail[0]!.subject === "ZZ Microsoft 365 Business Basic renews in 30 days", sent.map((m) => m.subject));
    ok("  its fields filled: name, company, seats, the day counted, the renewal value", !!m365Mail[0]?.text?.includes("Hi Asha,") && m365Mail[0]!.text.includes("ZZ Acme's ZZ Microsoft 365 Business Basic (12 seats)") && m365Mail[0]!.text.includes("That's 30 days away.") && m365Mail[0]!.text.includes("20,880"), m365Mail[0]?.text);
    ok("  copied to the account manager, the colleague, the address and the other document contact — once each, never the contact it's to", JSON.stringify([...(m365Mail[0]?.cc ?? [])].sort()) === JSON.stringify(["billing@zzact.invalid", "renewals@zzact.invalid", "zzcolleague@zzact.invalid", "zzowner@zzact.invalid"]) && !!billing, m365Mail[0]?.cc);
    ok("  with the link to choose what they're sent, and not for the other subscription", !!m365Mail[0]?.text?.includes("/preferences/") && !sent.some((m) => m.subject.includes("ZZ Cloud plan")));
    const m365Event = dated.find((e) => e.type === "renewal.due" && (e.payload as { order?: { itemSku?: string } }).order?.itemSku === "ZZ-M365-BB");
    ok("  its link tagged as the workflow's and the template's (UTM)", !!m365Mail[0]?.text?.includes("https://zzact.invalid/renew?utm_source=deskzo&utm_medium=email&utm_campaign=zz-m365-reminders&utm_content=zz-m365-reminder."), m365Mail[0]?.text);
    const deltaMail = sent.filter((m) => m.to === "dev@zzact.invalid");
    const together = deltaMail.filter((m) => m.subject.includes("renews in 15 days"));
    ok("Three subscriptions ending one day, two of them the workflow's: one email, not two", together.length === 1, deltaMail.map((m) => m.subject));
    ok("  naming both, the other maker's left out by the workflow's own condition", ["ZZ Microsoft 365 Standard and ZZ Microsoft 365 Premium renews in 15 days", "ZZ Microsoft 365 Premium and ZZ Microsoft 365 Standard renews in 15 days"].includes(together[0]?.subject ?? ""), together[0]?.subject);
    ok("  the seats and the value added up", !!together[0]?.text?.includes("(15 seats)") && !!together[0]?.text?.includes("20,000"), together[0]?.text);
    ok("  one ending another day has its own email", deltaMail.filter((m) => m.subject === "ZZ Microsoft 365 Apps renews in 10 days").length === 1, deltaMail.map((m) => m.subject));
    const tabled = deltaMail.filter((m) => m.subject.startsWith("ZZ table:"));
    ok("  the table: one email, a row for each, the total, the fields added up", tabled.length === 1 && tabled[0]!.subject === "ZZ table: 2 renewing" && !!tabled[0]!.text?.includes("ZZ Table One") && tabled[0]!.text.includes("ZZ Table Two") && tabled[0]!.text.includes("Total") && tabled[0]!.text.includes("Total seats 10"), tabled[0]?.text);
    ok("  with the tick off, one each, as before", deltaMail.filter((m) => m.subject.startsWith("ZZ each:")).length === 2, deltaMail.map((m) => m.subject));
    const passedOver = await inA(() => db.automationRunStep.findMany({ where: { stepId: "email_customer", status: "SUCCEEDED" }, select: { outputSummary: true } }));
    ok("  the run that didn't send says it went with the others, and fails nothing", passedOver.some((r) => /Sent in one email/.test(JSON.stringify(r.outputSummary))), passedOver.length);
    const { StatusBadge } = await import("../src/components/automate/status-badge");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const badge = (problem?: string | null) => renderToStaticMarkup(createElement(StatusBadge, { status: "SUCCEEDED", problem }));
    ok("A run that carried on past a failed step says so, with the reason on hover; a clean one doesn't", badge("1 step failed and was passed over: tell_customer — no mail server").includes("Succeeded with problems") && badge("1 step failed and was passed over: tell_customer — no mail server").includes("no mail server") && badge(null).includes("Succeeded") && !badge(null).includes("problems"));
    const unnamed = sent.find((m) => m.subject.startsWith("ZZ filled:"));
    ok("a template step that names no subscription is filled from the one that started the run", !!unnamed?.subject.startsWith("ZZ filled: 12 seats, ") && !unnamed.subject.includes("confirm") && !!unnamed.text?.includes("ZZ Microsoft 365 Business Basic renews."), unnamed);
    ok("  the renewal event carries the item's SKU, category and brand", !!m365Event && "itemCategory" in ((m365Event.payload as { order: object }).order) && "brand" in ((m365Event.payload as { order: object }).order));
    ok("the workflows waiting on them run, with the day counts written in", told.includes("ZZ overdue ZZ-OVERDUE") && told.includes("ZZ renewal ZZ Cloud plan") && told.includes("ZZ quiet for 5 days"), told.filter((t) => t.startsWith("ZZ ") && !t.startsWith("ZZ new")).join(" | "));
  } finally {
    if (close) await close().catch(() => undefined);
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((err) => console.error(`could not drop ${name}`, err));
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM pg_database WHERE datname IN (${Object.values(names).map((n) => `'${n}'`).join(", ")})`);
    ok("every scratch database dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? "\nAll Automate action checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
