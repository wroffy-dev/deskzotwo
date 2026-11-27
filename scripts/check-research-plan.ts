/**
 * check:research-plan — Deskzo AI's "Research & plan" on a lead or company (owner, 18 Nov 2026; src/lib/research/plan.ts).
 *
 *   · What leaves: the shape of the lead and the public research — never a contact's name, email or phone, an amount,
 *     the lead's description or an activity's notes. Read off a real lead made here with all of those on it.
 *   · What comes back: a plan is checked, clipped and refused when it isn't one; the model is asked once more.
 *   · The actions: a plan made and kept (the latest one, written over), its ticked steps added as the person's tasks,
 *     each step once; somebody without "Use Deskzo AI", or with it switched off, refused.
 *
 * Deskzo AI itself is a stand-in here: nothing is sent and nothing is charged. Runs against the local workspace on records
 * of its own (Zz Plan …), removed at the end.
 *
 *   npm run check:research-plan
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

// ─── Stand-ins: who is signed in, the cache, and Deskzo AI's gateway ────────────────────────────────────────────────
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
const sent: { system: string; prompt: string; tools: string[] }[] = [];
let replies: (() => { text: string; toolCalls: { id: string; name: string; input: unknown }[] } | Error)[] = [];
const gateway = {
  AiRefusal,
  aiService: async () => ({ model: "Zz Model", residency: "Zzland", noTraining: true }),
  aiTurn: async (turn: { system: string; history: { role: string; text?: string }[]; tools: { name: string }[] }) => {
    const first = turn.history.find((h) => h.role === "user");
    sent.push({ system: turn.system, prompt: first?.text ?? "", tools: turn.tools.map((t) => t.name) });
    const next = replies.shift();
    const r = next ? next() : new AiRefusal("no reply scripted");
    if (r instanceof Error) throw r;
    return { ...r, native: null, usage: { input: 1000, output: 200 }, stop: r.toolCalls.length ? "tools" : "done", model: "zz", family: "BEDROCK", modelKey: "zz-model", charge: { credits: 2 } };
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

const GOOD = {
  fit: "HOT",
  fitReasons: ["Asked for 50 seats on the website a week ago", "IT manager on file", "Called twice this month"],
  summary: "Interested and recently in touch; no quote sent yet.",
  steps: [
    { kind: "CALL", title: "Confirm seat count and timeline", why: "No quote yet after two calls", dueInDays: 1 },
    { kind: "EMAIL", title: "Send a short follow-up", why: "Keep it moving after the call", dueInDays: 2 },
    { kind: "TASK", title: "Prepare a quote", why: "Ready once seats are confirmed", dueInDays: 3 },
    { kind: "MEETING", title: "Book a demo", why: "Decision maker not yet met", dueInDays: 7 },
    { kind: "CALL", title: "A fifth step", why: "Too many", dueInDays: 99 },
  ],
  questions: ["Who signs off the purchase?", "When does the current licence end?"],
  email: { subject: "Your Microsoft 365 enquiry", body: "Hi {{firstName}},\n\nThanks for asking about Microsoft 365.\n\n{{senderName}}" },
};

async function main() {
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const plan = require("../src/lib/research/plan") as typeof import("../src/lib/research/plan");

  section("1. What a plan may be");
  const read = plan.planFromCall(GOOD);
  ok("a plan is read: four steps at most, a due day clipped to 30", read.ok && read.plan.steps.length === 4 && read.plan.fit === "HOT", read.ok ? read.plan.steps.length : read);
  const late = plan.planFromCall({ ...GOOD, steps: [{ ...GOOD.steps[0], dueInDays: 99 }] });
  ok("  a step due in 99 days is due in 30", late.ok && late.plan.steps[0]!.dueInDays === 30);
  ok("  a fit that isn't hot, warm or cold is refused, saying where", (() => {
    const r = plan.planFromCall({ ...GOOD, fit: "BOILING" });
    return !r.ok && r.problems.some((p) => p.startsWith("fit"));
  })());
  ok("  no steps at all is refused", !plan.planFromCall({ ...GOOD, steps: [] }).ok);
  ok("the email's first name and sender filled; none known reads 'there'", plan.fillEmail(GOOD.email.body, { firstName: "Asha", senderName: "Ravi" }).startsWith("Hi Asha,") && plan.fillEmail(GOOD.email.body, { firstName: null, senderName: "Ravi" }).startsWith("Hi there,") && plan.fillEmail(GOOD.email.body, { firstName: "Asha", senderName: "Ravi" }).endsWith("Ravi"));
  ok("a due day counted in calendar days, across a month end", plan.addDays("2026-11-28", 3) === "2026-12-01" && plan.addDays("2026-11-18", 0) === "2026-11-18");
  ok("the model is told: these facts only, no prices or promises, one call", /Use ONLY the facts given/.test(plan.PLAN_SYSTEM) && /No prices, discounts/.test(plan.PLAN_SYSTEM) && /Call propose_plan exactly once/.test(plan.PLAN_SYSTEM));

  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const server = require("../src/lib/research/plan-server") as typeof import("../src/lib/research/plan-server");
  const actions = require("../src/actions/research-plan") as typeof import("../src/actions/research-plan");
  const copilotSettings = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
  const catalogue = require("../src/lib/ai/catalogue") as typeof import("../src/lib/ai/catalogue");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const feature = catalogue.AI_FEATURES.find((f) => f.key === "research.plan");
  ok("a Deskzo AI feature of its own, saying what it sends and what it never does", !!feature && feature.fallback === "copilot.chat" && /No names, phone numbers, email addresses, amounts, notes or documents/.test(feature.sends));

  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  if (!admin) throw new Error("no super admin to run as");
  actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
  copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: null });

  const tag = randomUUID().slice(0, 6);
  const NAME = `Zz Plan ${tag} Pvt Ltd`;
  const company = await db.company.create({ data: { name: NAME, normalizedName: NAME.toLowerCase(), createdById: admin.id }, select: { id: true } });
  const contact = await db.contact.create({
    data: { companyId: company.id, name: "Priyasecret Sharma", email: `priyasecret.${tag}@zzplan.invalid`, phone: "+91 99999 12345", designation: "IT_MANAGER", isPrimary: true, createdByUserId: admin.id },
    select: { id: true },
  });
  const item = await db.item.findFirst({ select: { id: true, name: true } });
  const lead = await db.lead.create({
    data: {
      companyId: company.id,
      contactId: contact.id,
      title: `Zz ${tag} 50 Microsoft 365 seats`,
      description: "SECRET-DESCRIPTION do not send",
      status: "QUALIFYING",
      source: "WEBSITE",
      estimatedValue: 987654,
      ownerUserId: admin.id,
      createdByUserId: admin.id,
      ...(item ? { requirements: { create: [{ itemId: item.id, quantity: 50 }] } } : {}),
    },
    select: { id: true },
  });
  await db.activity.create({ data: { leadId: lead.id, userId: admin.id, type: "CALL", notes: "SECRET-CALL-NOTES confidential", occurredAt: new Date(Date.now() - 3 * 86_400_000) } });

  try {
    section("2. What leaves");
    const gathered = await server.gatherPlanInput({ kind: "lead", id: lead.id }, admin.id);
    const prompt = gathered ? plan.planPrompt(gathered.input) : "";
    ok("the lead's shape: its title, stage, source, a call this month, three days since the last touch", prompt.includes(`Zz ${tag} 50 Microsoft 365 seats`) && /Source: Website/.test(prompt) && /calls: 1, emails: 0/.test(prompt) && /3 days ago/.test(prompt), prompt);
    ok("  the contact's job title, not who they are", /IT Manager/.test(prompt) && !prompt.includes("Priyasecret") && !prompt.includes(`priyasecret.${tag}`) && !prompt.includes("12345"));
    ok("  no amount, no description, no call notes", !prompt.includes("987654") && !prompt.includes("9,87,654") && !prompt.includes("SECRET-DESCRIPTION") && !prompt.includes("SECRET-CALL-NOTES"));
    if (item) ok("  the products asked about, by name", prompt.includes(item.name.slice(0, 40)));

    section("3. Making a plan");
    actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
    replies = [
      () => ({ text: "Here you go", toolCalls: [{ id: "c1", name: "propose_plan", input: { ...GOOD, fit: "BOILING" } }] }),
      () => ({ text: "", toolCalls: [{ id: "c2", name: "propose_plan", input: GOOD }] }),
    ];
    sent.length = 0;
    const made = await actions.makeResearchPlan({ kind: "lead", id: lead.id });
    ok("a plan that comes back wrong is asked for again, and the second kept", made.ok && sent.length === 2 && made.data.plan.fit === "HOT" && made.data.plan.steps.length === 4, made.ok ? sent.length : made);
    ok("  the model was offered propose_plan only, and sent the same facts as above", sent[0]?.tools.join() === "propose_plan" && sent[0]?.prompt === prompt);
    ok("  what it cost is kept with it", made.ok && made.data.plan.credits === 4 && made.data.plan.model === "zz-model");

    replies = [() => ({ text: "", toolCalls: [{ id: "c3", name: "propose_plan", input: { ...GOOD, fit: "WARM" } }] })];
    const again = await actions.makeResearchPlan({ kind: "lead", id: lead.id });
    const rows = await db.researchPlan.count({ where: { leadId: lead.id } });
    ok("planning again writes over it: one plan a lead, the latest", again.ok && again.data.plan.fit === "WARM" && rows === 1);

    replies = [() => ({ text: "No.", toolCalls: [] }), () => ({ text: "Still no.", toolCalls: [] })];
    const none = await actions.makeResearchPlan({ kind: "lead", id: lead.id });
    ok("a model that never calls propose_plan: refused, saying so", !none.ok && /didn't come back with a plan/.test(none.ok ? "" : none.error));

    section("4. Its steps as tasks");
    const view = again.ok ? again.data : null;
    const added = view ? await actions.addResearchPlanTasks({ planId: view.id, steps: [0, 2] }) : null;
    const tasks = await db.task.findMany({ where: { leadId: lead.id }, select: { title: true, assignedToUserId: true, dueDate: true, description: true, priority: true } });
    ok("two ticked steps become two tasks for the person, on the lead", added?.ok === true && added.data.added === 2 && tasks.length === 2 && tasks.every((t) => t.assignedToUserId === admin.id), added);
    ok("  titled with what kind of step, saying why and that Deskzo AI suggested it", tasks.some((t) => t.title === "Call: Confirm seat count and timeline") && tasks.every((t) => /Suggested by Deskzo AI/.test(t.description ?? "")));
    ok("  a warm lead's tasks are medium priority", tasks.every((t) => t.priority === "MEDIUM"));
    const twice = view ? await actions.addResearchPlanTasks({ planId: view.id, steps: [0] }) : null;
    ok("a step already a task isn't added again", twice?.ok === false && (await db.task.count({ where: { leadId: lead.id } })) === 2);
    const kept = await server.latestPlan({ kind: "lead", id: lead.id });
    ok("  the plan remembers which steps became which tasks", !!kept && Object.keys(kept.plan.tasks).sort().join() === "0,2");

    section("5. Who may");
    copilotSettings.setTestSettings({ enabled: false, draftingEnabled: true, dailyCreditLimit: null });
    const off = await actions.makeResearchPlan({ kind: "lead", id: lead.id });
    ok("Deskzo AI switched off: refused, saying so, nothing sent", !off.ok && /switched off/.test(off.ok ? "" : off.error));
    copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: null });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
    const people = await db.user.findMany({ where: { active: true, isSuperAdmin: false, kind: "MEMBER" }, take: 40, select: { id: true, name: true, email: true, role: true } });
    let nobody: (typeof people)[number] | null = null;
    for (const p of people) if (!(await can(p.id, "copilot.use"))) { nobody = p; break; }
    ok("somebody here without “Use Deskzo AI” to try it as", !!nobody);
    if (nobody) {
      actor = { id: nobody.id, name: nobody.name, email: nobody.email, role: nobody.role };
      sent.length = 0;
      const refused = await actions.makeResearchPlan({ kind: "lead", id: lead.id });
      ok("  refused, saying so, and nothing sent", !refused.ok && /Use Deskzo AI/.test(refused.ok ? "" : refused.error) && sent.length === 0, refused.ok ? "made one" : refused.error);
      actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
    }
    const company2 = await actions.makeResearchPlan({ kind: "company", id: "zz-not-there" });
    ok("a company that isn't there: refused", !company2.ok);

    section("6. The card");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createElement } = require("react") as typeof import("react");
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const { ResearchPlanCard } = require("../src/components/research/research-plan-card") as typeof import("../src/components/research/research-plan-card");
    const { planCardData } = require("../src/lib/research/plan-view") as typeof import("../src/lib/research/plan-view");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const data = await planCardData({ kind: "lead", id: lead.id }, admin.id);
    const html = renderToStaticMarkup(createElement(ResearchPlanCard, { data }));
    ok("with a plan: how warm, the steps, the ones already tasks ticked off, the questions, the email with the contact's first name", /Warm/.test(html) && html.includes("Confirm seat count and timeline") && html.includes("a task now") && html.includes("Who signs off the purchase?") && html.includes("Hi Priyasecret,"), data.firstName);
    ok("  and 'Plan again' for whoever may", data.mayPlan && html.includes("Plan again"));
    const fresh = renderToStaticMarkup(createElement(ResearchPlanCard, { data: { ...data, plan: null } }));
    ok("without one: the button and what it does, and where it runs", fresh.includes("Research &amp; plan") && /nothing is sent/.test(fresh) && fresh.includes("Zz Model"));
    const barred = renderToStaticMarkup(createElement(ResearchPlanCard, { data: { ...data, plan: null, mayPlan: false } }));
    ok("for somebody who may not: no button, and why", !barred.includes("<button") && /Use Deskzo AI/.test(barred));
  } finally {
    copilotSettings.setTestSettings(null);
    await db.task.deleteMany({ where: { leadId: lead.id } }).catch(() => undefined);
    await db.activity.deleteMany({ where: { leadId: lead.id } }).catch(() => undefined);
    await db.leadRequirement.deleteMany({ where: { leadId: lead.id } }).catch(() => undefined);
    await db.researchPlan.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.lead.deleteMany({ where: { id: lead.id } }).catch(() => undefined);
    await db.contact.deleteMany({ where: { id: contact.id } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: company.id } }).catch(() => undefined);
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? `All ${passes} research & plan checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
