/**
 * check:auto-plan — "Research & plan" by itself (owner, 18 Nov 2026 — phase 2; src/lib/research/auto-plan.ts).
 *
 *   · Off until an admin switches it on; then only leads made since, at most so many a day, each lead once.
 *   · Charged to the lead's owner where they may use Deskzo AI, else to whoever switched it on.
 *   · Credits run out: that lead is marked failed and the rest wait for the next heartbeat.
 *   · Hot and warm leads first on their owner's Today, hot first; closed and other people's left out.
 *   · Settings: only an admin, a sensible daily number, and Deskzo AI on first.
 *
 * Deskzo AI is a stand-in: nothing is sent or charged. Runs against the local workspace on its own records (Zz Auto …),
 * and puts the setting back as it found it.
 *
 *   npm run check:auto-plan
 */
import "dotenv/config";
import Module from "node:module";
import { randomUUID } from "node:crypto";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("no actor");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
class AiRefusal extends Error {}
const sent: { userId: string; prompt: string }[] = [];
let fitFor: (prompt: string) => "HOT" | "WARM" | "COLD" | Error = () => "WARM";
const gateway = {
  AiRefusal,
  aiService: async () => ({ model: "Zz Model", residency: "Zzland", noTraining: true }),
  aiTurn: async (turn: { userId: string; history: { role: string; text?: string }[] }) => {
    const prompt = turn.history.find((h) => h.role === "user")?.text ?? "";
    sent.push({ userId: turn.userId, prompt });
    const fit = fitFor(prompt);
    if (fit instanceof Error) throw fit;
    const input = {
      fit,
      fitReasons: ["A reason from the facts"],
      summary: "Where it stands.",
      steps: [{ kind: "CALL", title: "Call to qualify", why: "New lead", dueInDays: 0 }],
      questions: [],
      email: { subject: "Hello", body: "Hi {{firstName}},\n\nThanks.\n\n{{senderName}}" },
    };
    return { text: "", toolCalls: [{ id: "c", name: "propose_plan", input }], native: null, usage: { input: 1, output: 1 }, stop: "tools", model: "zz", family: "BEDROCK", modelKey: "zz", charge: { credits: 1 } };
  },
};
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("/lib/session")) return session;
  if (request === "@/lib/ai/gateway" || request.endsWith("/lib/ai/gateway")) return gateway;
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const auto = require("../src/lib/research/auto-plan") as typeof import("../src/lib/research/auto-plan");
  const actions = require("../src/actions/research-plan") as typeof import("../src/actions/research-plan");
  const copilotSettings = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  if (!admin) throw new Error("no super admin to run as");
  const people = await db.user.findMany({ where: { active: true, isSuperAdmin: false, kind: "MEMBER" }, take: 40, select: { id: true, name: true, email: true, role: true } });
  let noAi: (typeof people)[number] | null = null;
  for (const p of people) if (!(await can(p.id, "copilot.use"))) { noAi = p; break; }
  const asAdmin = () => (actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role });
  asAdmin();
  copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: null });

  const before = await db.autoPlanSettings.findUnique({ where: { id: "global" } });
  // Other leads already waiting in this workspace aren't this check's: the switch starts from now.
  await db.autoPlanSettings.deleteMany({});
  const tag = randomUUID().slice(0, 6);
  const NAME = `Zz Auto ${tag} Pvt Ltd`;
  const company = await db.company.create({ data: { name: NAME, normalizedName: NAME.toLowerCase(), createdById: admin.id }, select: { id: true } });
  const lead = (title: string, extra: Record<string, unknown> = {}) =>
    db.lead.create({ data: { companyId: company.id, title: `Zz ${tag} ${title}`, ownerUserId: admin.id, createdByUserId: admin.id, ...extra }, select: { id: true } });
  const runOf = (id: string) => db.autoPlanRun.findUnique({ where: { leadId: id }, select: { status: true, chargedToId: true, error: true } });
  const promptsFor = (title: string) => sent.filter((s) => s.prompt.includes(`Zz ${tag} ${title}`)).length;

  try {
    section("1. Off until switched on");
    const old = await lead("old", { createdAt: new Date(Date.now() - 60 * 60_000) });
    const off = await auto.runAutoPlans();
    ok("nothing planned while it's off", off.reason === "off" && sent.length === 0, off);

    section("2. Settings");
    const zero = await actions.saveAutoPlanSettings({ enabled: true, perDay: 0 });
    ok("a day's number that isn't from 1 to 200 is refused", !zero.ok);
    if (noAi) {
      actor = { id: noAi.id, name: noAi.name, email: noAi.email, role: noAi.role };
      const notAdmin = await actions.saveAutoPlanSettings({ enabled: true, perDay: 5 });
      ok("somebody who can't change the settings: refused", !notAdmin.ok && (await actions.getAutoPlanSettings()) === null);
      asAdmin();
    }
    copilotSettings.setTestSettings({ enabled: false, draftingEnabled: true, dailyCreditLimit: null });
    const aiOff = await actions.saveAutoPlanSettings({ enabled: true, perDay: 2 });
    ok("with Deskzo AI off: switch it on first", !aiOff.ok && /Deskzo AI on first/.test(aiOff.ok ? "" : aiOff.error));
    copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: null });
    const on = await actions.saveAutoPlanSettings({ enabled: true, perDay: 2 });
    ok("switched on at 2 a day, counting from now", on.ok && on.data.enabled && on.data.perDay === 2 && !!on.data.onSince && Date.now() - new Date(on.data.onSince).getTime() < 60_000, on);
    const audited = await db.auditLog.findFirst({ where: { entityType: "AutoPlanSettings" }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
    ok("  and audited in words", /at most 2 a day/.test(audited?.entityLabel ?? ""), audited?.entityLabel);

    section("3. New leads, planned by themselves");
    await new Promise((r) => setTimeout(r, 20));
    const hot = await lead("hot");
    const warm = await lead("warm");
    const third = await lead("third");
    fitFor = (p) => (p.includes(`Zz ${tag} hot`) ? "HOT" : "WARM");
    const first = await auto.runAutoPlans();
    ok("two planned — the day's limit — oldest first", first.planned === 2 && (await runOf(hot.id))?.status === "DONE" && (await runOf(warm.id))?.status === "DONE" && !(await runOf(third.id)), first);
    ok("  a lead made before it was switched on is left alone", !(await runOf(old.id)) && promptsFor("old") === 0);
    ok("  each charged to the lead's owner, who may use Deskzo AI", (await runOf(hot.id))?.chargedToId === admin.id && sent.every((s) => s.userId === admin.id));
    ok("  the plan kept on the lead, as the button keeps it", (await db.researchPlan.count({ where: { leadId: { in: [hot.id, warm.id] } } })) === 2);
    const capped = await auto.runAutoPlans();
    ok("the day's limit reached: nothing more today", capped.reason === "today's limit" && !(await runOf(third.id)), capped);

    await actions.saveAutoPlanSettings({ enabled: true, perDay: 50 });
    const after = await auto.runAutoPlans();
    ok("the limit raised: the one that waited is planned", (await runOf(third.id))?.status === "DONE", after);
    ok("  and none planned twice", promptsFor("hot") === 1 && promptsFor("warm") === 1 && promptsFor("third") === 1);

    if (noAi) {
      const theirs = await lead("theirs", { ownerUserId: noAi.id });
      await auto.runAutoPlans();
      ok("an owner who may not use Deskzo AI: charged to whoever switched it on", (await runOf(theirs.id))?.chargedToId === admin.id && (await runOf(theirs.id))?.status === "DONE");
    }

    section("4. Credits run out");
    const broke = await lead("broke");
    const waiting = await lead("waiting");
    fitFor = () => new AiRefusal("This workspace has used all its Deskzo AI credits.");
    const out = await auto.runAutoPlans();
    const brokeRun = await runOf(broke.id);
    ok("that lead is marked failed, saying why", brokeRun?.status === "FAILED" && /credits/.test(brokeRun.error ?? ""), brokeRun);
    ok("  and the rest wait for the next heartbeat, untouched", !(await runOf(waiting.id)) && out.failed === 1, out);
    fitFor = () => "COLD";
    await auto.runAutoPlans();
    ok("  a failed lead isn't tried again by itself; the next one is", (await runOf(broke.id))?.status === "FAILED" && (await runOf(waiting.id))?.status === "DONE");

    section("5. Today: leads to work first");
    const closed = await lead("closed", { status: "WON" });
    await db.researchPlan.create({ data: { key: `lead:${closed.id}`, companyId: company.id, leadId: closed.id, createdById: admin.id, plan: { fit: "HOT", fitReasons: ["x"], summary: "x", steps: [], questions: [], email: null, tasks: {}, model: "zz", credits: 0 } } });
    const list = (await auto.hotLeadsFor(admin.id, 40)).filter((l) => l.title.includes(`Zz ${tag}`));
    ok("their own hot and warm leads, hot first", list[0]?.title === `Zz ${tag} hot` && list[0]?.fit === "HOT" && list.slice(1).every((l) => l.fit === "WARM"), list.map((l) => `${l.fit} ${l.title}`));
    ok("  the cold one and the won one left out", !list.some((l) => l.title.endsWith("waiting") || l.title.endsWith("closed")));
    ok("  each with its next step and a readable link", list[0]?.nextStep === "Call to qualify" && /^\/leads\/LEAD-\d+$/.test(list[0]?.href ?? ""), list[0]?.href);
    if (noAi) ok("  somebody else's lead isn't on their Today", !list.some((l) => l.title.endsWith("theirs")));

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createElement } = require("react") as typeof import("react");
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const { TodayView } = require("../src/components/today/today-view") as typeof import("../src/components/today/today-view");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const empty = { date: "2026-11-18", attendance: null, approvals_waiting: 0, approvals_more: false, approvals_by_kind: {}, tasks: null, leave: null } as unknown as import("../src/components/today/today-view").TodayData;
    const html = renderToStaticMarkup(createElement(TodayView, { today: empty, greeting: "Hi", zone: "Asia/Kolkata", approvals: false, newLead: false, hotLeads: list }));
    ok("Today shows them first, with Hot and the next step", html.includes("Leads to work first") && html.includes(`Zz ${tag} hot`) && html.includes("next: Call to qualify"));
    const none = renderToStaticMarkup(createElement(TodayView, { today: empty, greeting: "Hi", zone: "Asia/Kolkata", approvals: false, newLead: false }));
    ok("  and nothing of it with none", !none.includes("Leads to work first"));

    section("6. Switched off");
    await actions.saveAutoPlanSettings({ enabled: false, perDay: 50 });
    const late = await lead("late");
    const stopped = await auto.runAutoPlans();
    ok("off again: nothing planned", stopped.reason === "off" && !(await runOf(late.id)));
  } finally {
    copilotSettings.setTestSettings(null);
    await db.autoPlanSettings.deleteMany({});
    if (before) await db.autoPlanSettings.create({ data: before });
    const leads = await db.lead.findMany({ where: { companyId: company.id }, select: { id: true } });
    await db.task.deleteMany({ where: { leadId: { in: leads.map((l) => l.id) } } }).catch(() => undefined);
    await db.researchPlan.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.lead.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: company.id } }).catch(() => undefined);
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? `All ${passes} auto research & plan checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
