/**
 * check:hr-desk — Priya, the HR desk (owner, 20 Nov 2026 — src/lib/hr-desk).
 *
 *   · The words: their facts as the model reads them (never an amount — payslips only "ready"), the guides and the
 *     conversation in the prompt, an answer's link only one of the fixed few, a made-up sum caught.
 *   · On a workspace, with its own guides (Zz …): off until switched on; asked by somebody with My HR who doesn't manage
 *     people — answered from their records and only the HR guides chosen for her, charged to them, seen working; a sum of
 *     money in an answer not shown and passed to HR; what she can't answer, or Deskzo AI saying no, passed to HR — told
 *     in her voice; "Ask a person instead" on their own question only; HR answering, and the person told; the day's
 *     limit; the settings (only people who manage people records; only files that are there); the screens.
 *
 * Nothing leaves: Deskzo AI is a stand-in.
 *
 *   npm run check:hr-desk
 */
import "dotenv/config";
import Module from "node:module";
import { randomUUID } from "node:crypto";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
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
const prompts: { userId: string; system: string; text: string }[] = [];
const answers: Record<string, unknown>[] = [];
let refuseNext = false;
const gateway = {
  AiRefusal,
  aiService: async () => ({ model: "Zz Model", residency: "Zzland", noTraining: true }),
  aiUnavailable: async () => null,
  aiTurn: async (turn: { userId: string; system: string; history: { role: string; text?: string }[] }) => {
    if (refuseNext) {
      refuseNext = false;
      throw new AiRefusal("You've used today's Deskzo AI credits. They reset at midnight.");
    }
    prompts.push({ userId: turn.userId, system: turn.system, text: turn.history.find((h) => h.role === "user")?.text ?? "" });
    const input = answers.shift() ?? { answer: "I don't know.", handToHr: false, topic: "other" };
    return { text: "", toolCalls: [{ id: randomUUID(), name: "propose_answer", input }], native: null, usage: { input: 1, output: 1 }, stop: "tools", model: "zz", family: "BEDROCK", modelKey: "zz", charge: { credits: 1 } };
  },
};
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/people/me",
      useSearchParams: () => new URLSearchParams(),
      notFound: () => {
        throw new Error("NOT_FOUND (notFound() was called)");
      },
      redirect: (to: string) => {
        throw new Error(`REDIRECT to ${to}`);
      },
    };
  }
  if (request === "@/lib/session" || request.endsWith("/lib/session")) return session;
  if (request === "@/lib/ai/gateway" || request.endsWith("/lib/ai/gateway")) return gateway;
  if (request === "@/lib/modules-access" || request.endsWith("/lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => session.requireUser(), requireModuleAccess: async () => session.requireUser() };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const r = require("../src/lib/hr-desk/rules") as typeof import("../src/lib/hr-desk/rules");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("1. The words");
  const facts = r.factsText({
    today: "Thursday, 20 Nov 2026",
    leave: [
      { name: "Casual leave", code: "CL", available: 4.5, pending: 1, paid: true },
      { name: "Leave without pay", code: "LWP", available: 0, pending: 0, paid: false },
    ],
    requests: [{ type: "Casual leave", from: "5 Dec 2026", to: "6 Dec 2026", days: 2, status: "PENDING" }],
    holidays: [{ name: "Christmas", on: "Friday, 25 Dec 2026", optional: false }],
    shortLeave: { used: 1, perMonth: 2, maxMinutes: 120 },
    attendance: { counts: { present: 12, "week off": 4 }, unrecorded: ["17 Nov 2026"] },
    payslips: { latest: "October 2026", count: 7 },
  });
  ok("their facts: leave left and waiting, the request, the holiday, short leave, attendance gaps", facts.includes("Casual leave (CL): 4.5 days available, 1 day waiting for approval") && facts.includes("— unpaid leave") && facts.includes("5 Dec 2026 to 6 Dec 2026 (2 days): pending") && facts.includes("Christmas — Friday, 25 Dec 2026") && facts.includes("1 of 2 used this month, up to 2 hours each") && facts.includes("nothing recorded: 17 Nov 2026"), facts);
  ok("  payslips only 'ready' — the amounts are on the payslip, never here", facts.includes("7 ready on My HR, the latest for October 2026") && facts.includes("Amounts are on the payslip itself") && !/₹|\d{1,3}(,\d{2,3})+/.test(facts));
  const missing = r.factsText({ today: "x", leave: null, requests: [], holidays: [], shortLeave: null, attendance: null, payslips: null });
  ok("  and what isn't there, said plainly", missing.includes("Leave: not available here.") && missing.includes("Holidays: none in the calendar") && missing.includes("Payslips: none ready"));
  const prompt = r.askPrompt({ facts: "F", guides: [{ file: "leave.md", heading: "Casual leave", text: "12 a year." }], earlier: [{ question: "Q1", answer: "A1" }], question: "And sick leave?" });
  ok("the prompt: facts, the guide passage with where it's from, the conversation, the question", prompt.includes("[leave.md › Casual leave]\n12 a year.") && prompt.includes("They asked: Q1\nYou answered: A1") && prompt.endsWith("Their question: And sick leave?"));
  const sys = r.hrSystem("Priya", "Acme Pvt Ltd");
  ok("what she's told: only the facts and guides, HR for the rest, no money, no AI talk", sys.startsWith("You are Priya, the HR desk at Acme Pvt Ltd") && sys.includes("set handToHr true") && sys.includes("can't see salaries") && sys.includes("Never mention AI"));
  const parsed = r.answerSchema.parse({ answer: "Ok", handToHr: "yes", topic: "salary", link: "https://evil.example" });
  ok("an answer's link only one of the fixed few; anything else none — and a stray topic 'other'", parsed.link === null && parsed.topic === "other" && parsed.handToHr === false && r.answerSchema.parse({ answer: "Ok", handToHr: true, topic: "leave", link: "LEAVE" }).link === "LEAVE");
  ok("a sum of money in an answer is caught; days and dates aren't", r.namesMoney("Your net pay is ₹45,000.") && r.namesMoney("about 1.5 lakh") && r.namesMoney("Rs. 1200") && !r.namesMoney("You have 12 days left, till 31 Dec 2026."));
  ok("what HR is told: the first name and the question", r.handedNote("Ravi Kumar", "Can I  carry over leave?") === "Ravi asked: “Can I carry over leave?”");

  section("2. On a workspace");
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const server = require("../src/lib/hr-desk/server") as typeof import("../src/lib/hr-desk/server");
  const actions = require("../src/actions/hr-desk") as typeof import("../src/actions/hr-desk");
  const store = require("../src/lib/ai-knowledge/store") as typeof import("../src/lib/ai-knowledge/store");
  const copilotSettings = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
  /* eslint-enable @typescript-eslint/no-require-imports */
  copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: null });

  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  if (!admin) throw new Error("no super admin");
  const members = await db.user.findMany({ where: { active: true, kind: "MEMBER", isSuperAdmin: false, id: { not: admin.id } }, select: { id: true, name: true, email: true, role: true }, take: 40 });
  let asker: (typeof members)[number] | null = null;
  for (const m of members) if (!(await can(m.id, "hr.manage"))) { asker = m; break; }
  if (!asker) throw new Error("nobody without hr.manage to ask");
  const asAdmin = () => (actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role });
  const asAsker = () => (actor = { id: asker!.id, name: asker!.name, email: asker!.email, role: asker!.role });

  const tag = randomUUID().slice(0, 6);
  const t0 = new Date();
  const before = await db.hrDeskSettings.findUnique({ where: { id: "global" } });
  const beforeFiles = (await db.hrDeskFile.findMany({ select: { fileId: true } })).map((f) => f.fileId);
  await db.hrDeskSettings.deleteMany({});
  const policyName = `zz-leave-policy-${tag}.md`;
  const secretName = `zz-sales-playbook-${tag}.md`;
  await store.saveKnowledgeTexts(admin.id, [
    { name: policyName, content: `# Zzleave policy ${tag}\n\n## Casual leave\n\nEvery employee gets twelve casual leaves a year, credited monthly. Zzquokka carry over is not allowed.\n` },
    { name: secretName, content: `# Sales playbook ${tag}\n\n## Discounts\n\nZzquokka casual discount ladder: up to 20% for enterprise deals.\n` },
  ]);
  const files = await db.aiKnowledgeFile.findMany({ where: { name: { in: [policyName, secretName] } }, select: { id: true, name: true } });
  const policyId = files.find((f) => f.name === policyName)!.id;

  try {
    asAsker();
    const closed = await actions.askHrDesk("How many casual leaves do I get?");
    ok("off until an admin switches it on", !closed.ok && /isn't switched on/.test(closed.ok ? "" : closed.error));
    ok("  and My HR shows no card", (await actions.myHrDesk()) === null);
    const notMine = await actions.saveHrDeskSettings({ enabled: true, handTo: [], fileIds: [] });
    ok("  only somebody who can change the settings switches it on", !notMine.ok);

    asAdmin();
    const saved = await actions.saveHrDeskSettings({ enabled: true, handTo: [admin.id, asker.id, "nobody"], fileIds: [policyId, "not-a-file"] });
    ok("switched on: only people who manage people records named; only files that are there", saved.ok && saved.data.handTo.join() === admin.id && saved.data.files?.filter((f) => f.chosen).map((f) => f.id).join() === policyId, saved.ok ? saved.data.handTo : saved.error);

    // Answered from her guides and their records.
    asAsker();
    prompts.length = 0;
    answers.push({ answer: "You get twelve casual leaves a year, credited monthly — and you have some left this year.", handToHr: false, topic: "policy", link: "LEAVE" });
    const a1 = await actions.askHrDesk(`Zzquokka: how many casual leaves do I get a year?`);
    const p1 = prompts[0];
    ok("asked by somebody with My HR: answered, pointing to Apply for leave", a1.ok && a1.data.status === "ANSWERED" && a1.data.link?.href === "/people/leave" && a1.data.answer?.startsWith("You get twelve"), a1.ok ? a1.data : a1.error);
    ok("  charged to the person asking, who needs no 'Use Deskzo AI'", p1?.userId === asker.id);
    ok("  from the guide chosen for her — not the team's other files", !!p1 && p1.text.includes(`Zzleave policy ${tag}`) && !p1.text.includes("discount ladder"), p1?.text.slice(0, 400));
    ok("  their own records in it, never their address or a sum of money", !!p1 && p1.text.includes("Facts about the person asking") && p1.text.includes("Today is ") && !p1.text.includes(asker.email) && !/₹\s?\d/.test(p1.text));
    const work = await db.aiTeammateWork.findFirst({ where: { userId: asker.id, teammate: "priya", kind: "hr.answer", startedAt: { gte: t0 } }, select: { status: true } });
    ok("  seen working, as Priya", work?.status === "DONE");

    // A follow-up reads the conversation.
    answers.push({ answer: "No — carry over isn't allowed.", handToHr: false, topic: "policy" });
    await actions.askHrDesk("Can I carry them over?");
    ok("a follow-up carries the conversation", (prompts[1]?.text ?? "").includes("They asked: Zzquokka: how many casual leaves"));

    // A sum of money she was never given.
    answers.push({ answer: "Your net pay in October was ₹48,500.", handToHr: false, topic: "payslip" });
    const money = await actions.askHrDesk("What was my net pay in October?");
    ok("an answer naming a sum of money isn't shown — it goes to HR instead", money.ok && money.data.status === "WITH_HR" && !money.data.answer?.includes("48,500") && /passed this to HR/.test(money.data.answer ?? ""), money.ok ? money.data : money.error);

    // What she can't answer.
    answers.push({ answer: "That's one for HR — I've passed it on; they'll reply here.", handToHr: true, topic: "other" });
    const hand = await actions.askHrDesk("Can I work from Pune for two months?");
    const told = await db.notification.findFirst({ where: { userId: admin.id, type: "HR_DESK_QUESTION", createdAt: { gte: t0 }, message: { contains: "Pune" } }, select: { title: true, message: true, link: true } });
    const asksBefore = await db.hrDeskQuestion.count({ where: { askerId: asker.id } });
    const doubled = await actions.askHrDesk("Can I work from Pune for two months?");
    ok("the same question again within a minute — a double click — is the one already asked, not a second", doubled.ok && hand.ok && doubled.data.id === hand.data.id && (await db.hrDeskQuestion.count({ where: { askerId: asker.id } })) === asksBefore);
    ok("what she can't answer goes to HR at once — told in her voice, with who asked", hand.ok && hand.data.status === "WITH_HR" && told?.title === "Priya: a question for you — I couldn't answer it" && told.message.startsWith(`${asker.name.split(/\s+/)[0]} asked:`) && told.link === "/people/hr-desk", told);

    refuseNext = true;
    const refused = await actions.askHrDesk("How many sick leaves do I have?");
    ok("Deskzo AI saying no: the question still reaches HR, saying why", refused.ok && refused.data.status === "WITH_HR" && /used today's Deskzo AI credits/.test(refused.data.answer ?? ""), refused.ok ? refused.data : refused.error);

    // A person instead.
    const instead = await actions.askHrInstead(a1.ok ? a1.data.id : "");
    const twice = await actions.askHrInstead(a1.ok ? a1.data.id : "");
    ok("'Ask a person instead' passes her answered question to HR — once", instead.ok && instead.data.status === "WITH_HR" && !twice.ok);
    asAdmin();
    const othersQuestion = await actions.askHrInstead(money.ok ? money.data.id : "");
    ok("  only on their own question", !othersQuestion.ok);

    // HR's side.
    const inbox = await server.hrInbox();
    const mineInInbox = inbox.filter((i) => i.askerName === asker.name && i.askedAt >= t0.toISOString());
    ok("HR's inbox: the passed ones, waiting, with what she told them — not the ones she answered", mineInInbox.length === 4 && mineInInbox.every((i) => i.status === "WITH_HR") && !mineInInbox.some((i) => i.question === "Can I carry them over?"), mineInInbox.map((i) => i.question));
    asAsker();
    const notHr = await actions.answerHrDeskQuestion({ id: hand.ok ? hand.data.id : "", answer: "Sure" });
    ok("  answered only by somebody who manages people records", !notHr.ok && /Manage people records/.test(notHr.ok ? "" : notHr.error));
    asAdmin();
    const answered = await actions.answerHrDeskQuestion({ id: hand.ok ? hand.data.id : "", answer: "Yes, for up to two months — tell your manager first." });
    const toAsker = await db.notification.findFirst({ where: { userId: asker.id, type: "HR_DESK_ANSWERED", createdAt: { gte: t0 } }, select: { title: true, link: true } });
    asAsker();
    const mine = await server.myQuestions(asker.id);
    const back = mine.find((q) => q.id === (hand.ok ? hand.data.id : ""));
    ok("HR answers: the person told, and the answer under their question", answered.ok && toAsker?.title === `${admin.name} from HR answered your question` && toAsker.link === "/people/me#ask" && back?.status === "HR_ANSWERED" && back.hrAnsweredBy === admin.name, { toAsker, back });
    asAdmin();
    const again = await actions.answerHrDeskQuestion({ id: hand.ok ? hand.data.id : "", answer: "Again" });
    ok("  and can't be answered twice", !again.ok);

    // The day's limit.
    asAsker();
    await db.hrDeskQuestion.createMany({ data: Array.from({ length: 30 }, () => ({ askerId: asker.id, question: `zz limit ${tag}`, status: "ANSWERED", answer: "x" })) });
    const limited = await actions.askHrDesk("One more?");
    ok("thirty questions a day each, then tomorrow", !limited.ok && /30 questions today/.test(limited.ok ? "" : limited.error));
    await db.hrDeskQuestion.deleteMany({ where: { askerId: asker.id, question: `zz limit ${tag}` } });

    section("3. The screens");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
    const { createElement } = require("react") as typeof import("react");
    const { AskPriya } = require("../src/components/hr/ask-priya") as typeof import("../src/components/hr/ask-priya");
    const { HrDeskSettings } = require("../src/components/settings/hr-desk-settings") as typeof import("../src/components/settings/hr-desk-settings");
    const HrDeskPage = (require("../src/app/(dashboard)/people/hr-desk/page") as { default: () => Promise<unknown> }).default;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const desk = await actions.myHrDesk();
    const card = await renderHtml(createElement(AskPriya, { data: desk! }));
    // Since 23 Nov 2026 each question is a line, only the newest open; the last three in view, the rest behind "Show earlier".
    ok("My HR: Ask Priya, their questions as lines, the newest open", card.includes("Ask Priya") && card.includes("Can I work from Pune") && (card.match(/aria-expanded="true"/g) ?? []).length === 1, card.slice(0, 300));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { foldQuestions } = require("../src/components/hr/ask-priya") as typeof import("../src/components/hr/ask-priya");
    const asked = (id: string, question: string, status = "ANSWERED") => ({ id, question, answer: "a", link: null, status, hrAnswer: null, hrAnsweredBy: null, askedAt: "2026-11-23T10:00:00.000Z" });
    const folded = foldQuestions([asked("3", "Upcoming holidays?"), asked("2", "upcoming holidays"), asked("1", "Upcoming  holidays?"), asked("0", "Upcoming holidays?", "WITH_HR")]);
    ok("  the same question answered again is one row, asked 3 times, the newest kept — one still with HR stays its own", folded.length === 2 && folded[0]!.q.id === "3" && folded[0]!.times === 3 && folded[1]!.times === 1);
    const six = await renderHtml(createElement(AskPriya, { data: { closed: null, questions: ["Six?", "Five?", "Four?", "Three?", "Two?", "One?"].map((t, i) => asked(String(i), t, i === 4 ? "WITH_HR" : "ANSWERED")) } }));
    ok("  six asked: the last three, the rest behind a button that says one is still with HR", ["Six?", "Five?", "Four?"].every((t) => six.includes(t)) && !six.includes("Two?") && six.includes("Show 3 earlier questions · 1 still with HR"));
    const refusedPage = await renderHtml(HrDeskPage()).then(
      () => "rendered",
      (e: Error) => e.message,
    );
    ok("  the HR desk page refuses somebody who doesn't manage people — a 404", /NOT_FOUND/.test(refusedPage), refusedPage);
    asAdmin();
    const page = await renderHtml(HrDeskPage());
    ok("the HR desk page: what's waiting, with her answer, and a box to answer", page.includes("Waiting for an answer") && page.includes("What was my net pay in October?") && page.includes("Send answer"), page.slice(0, 300));
    const settingsView = await actions.getHrDeskSettings();
    const settingsCard = await renderHtml(createElement(HrDeskSettings, { settings: settingsView! }));
    ok("the settings card: the switch, the guides ticked, who it goes to, the last 30 days", settingsCard.includes("Priya, the HR desk") && settingsCard.includes(`Zzleave policy ${tag}`) && settingsCard.includes("Questions for HR go to") && settingsView!.report.passed >= 4, settingsView?.report);
  } finally {
    copilotSettings.setTestSettings(null);
    await db.hrDeskQuestion.deleteMany({ where: { askerId: asker.id, createdAt: { gte: t0 } } }).catch(() => undefined);
    await db.notification.deleteMany({ where: { createdAt: { gte: t0 }, type: { in: ["HR_DESK_QUESTION", "HR_DESK_ANSWERED"] } } }).catch(() => undefined);
    await db.aiTeammateWork.deleteMany({ where: { teammate: "priya", startedAt: { gte: t0 } } }).catch(() => undefined);
    await db.hrDeskSettings.deleteMany({});
    if (before) await db.hrDeskSettings.create({ data: before });
    await db.hrDeskFile.deleteMany({ where: { fileId: { notIn: beforeFiles } } }).catch(() => undefined);
    await db.aiKnowledgeFile.deleteMany({ where: { name: { in: [policyName, secretName] } } }).catch(() => undefined);
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? `All ${passes} HR desk checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
