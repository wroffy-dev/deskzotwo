/**
 * check:ai-waiting — "Waiting for you" and the AI team's morning note (owner, 20 Nov 2026 — upgrading the agents, step 1;
 * src/lib/ai/waiting.ts, src/lib/ai/team-daily.ts).
 *
 *   1. Waiting for you: a follow-up Tara drafted and an answer she drafted to a reply, a chase email Arjun drafted and a
 *      customer's reply he read, a question Priya passed to HR, a chat Kabir handed over that the customer waits on —
 *      each counted for the person it is for, and for nobody else; a chat whose last word is ours isn't waiting.
 *   2. The morning note: its window (Friday's on a Monday), its words, what went and what came, and when it doesn't go.
 *   3. Today and the card draw it.
 *
 * Counted against the local workspace's own data before and after, so other records don't matter. Records: Zz Waiting….
 *
 *   npm run check:ai-waiting
 */
import "dotenv/config";
import Module from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const waitingLib = require("../src/lib/ai/waiting") as typeof import("../src/lib/ai/waiting");
  const daily = require("../src/lib/ai/team-daily") as typeof import("../src/lib/ai/team-daily");
  const { workspaceTeammates } = require("../src/lib/ai/teammates-server") as typeof import("../src/lib/ai/teammates-server");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true } });
  const other = await db.user.findFirst({ where: { active: true, isSuperAdmin: false, kind: "MEMBER" }, select: { id: true, name: true } });
  if (!admin || !other) throw new Error("need a super admin and one other person");
  const tag = randomUUID().slice(0, 6);
  const NAME = `Zz Waiting ${tag} Pvt Ltd`;
  const teammates = await workspaceTeammates();

  const before = await waitingLib.waitingForYou(admin.id, 200);
  const beforeOther = await waitingLib.waitingForYou(other.id, 200);

  const company = await db.company.create({ data: { name: NAME, normalizedName: NAME.toLowerCase(), createdById: admin.id }, select: { id: true } });
  const contact = await db.contact.create({ data: { companyId: company.id, name: "Ravi Zzwait", email: `ravi.${tag}@zzwaiting.example.com`, isPrimary: true, createdByUserId: admin.id }, select: { id: true } });
  const lead = await db.lead.create({ data: { companyId: company.id, contactId: contact.id, title: `Zz ${tag} seats`, ownerUserId: admin.id, createdByUserId: admin.id, status: "QUALIFYING" }, select: { id: true } });
  let channelId: string | null = null;
  try {
    section("1. Waiting for you");
    const enrolment = await db.nurtureEnrolment.create({
      data: { leadId: lead.id, contactId: contact.id, ownerId: admin.id, enrolledById: admin.id, replyToken: randomBytes(12).toString("hex"), touchesSent: 1, touches: { create: [{ step: 1, status: "WAITING", subject: `Zz ${tag} follow-up`, body: "Hi {{firstName}}, just checking in. {{senderName}}" }] } },
      select: { id: true },
    });
    await db.nurtureReply.create({ data: { enrolmentId: enrolment.id, fromName: "Ravi Zzwait", fromEmail: `ravi.${tag}@zzwaiting.example.com`, subject: "Re: seats", kind: "INTERESTED", answerSubject: "Re: seats", answerBody: "Hi {{firstName}}, great — I'll call you. {{senderName}}" } });
    await db.collectionChase.create({ data: { companyId: company.id, createdById: admin.id, tone: "gentle", subject: `Zz ${tag} payment`, body: "Hi {{firstName}}", replyToken: randomBytes(12).toString("hex"), status: "WAITING" } });
    const sentChase = await db.collectionChase.create({ data: { companyId: company.id, createdById: admin.id, sentById: admin.id, tone: "gentle", subject: `Zz ${tag} sent`, body: "x", replyToken: randomBytes(12).toString("hex"), status: "SENT", sentAt: new Date() }, select: { id: true } });
    await db.collectionReply.create({ data: { chaseId: sentChase.id, fromName: "Ravi Zzwait", subject: "Re: payment", text: "Paying Friday.", reading: "{}", summary: "Promises to pay on Friday.", status: "OPEN" } });
    await db.hrDeskQuestion.create({ data: { askerId: other.id, question: `Zz ${tag} how many leaves do I have?`, status: "WITH_HR", handedAt: new Date() } });
    const channel = await db.inboxChannel.create({ data: { kind: "WEB", name: `Zz ${tag} site` }, select: { id: true } });
    channelId = channel.id;
    const waitingChat = await db.conversation.create({ data: { channelId: channel.id, kind: "WEB", status: "OPEN", assignedToUserId: admin.id, botActive: false, customerName: `Zz ${tag} Visitor` }, select: { id: true } });
    await db.conversationMessage.create({ data: { conversationId: waitingChat.id, author: "AGENT", userId: admin.id, body: "Hello!", createdAt: new Date(Date.now() - 60_000) } });
    await db.conversationMessage.create({ data: { conversationId: waitingChat.id, author: "CUSTOMER", body: "Price for 50 seats?" } });
    const answeredChat = await db.conversation.create({ data: { channelId: channel.id, kind: "WEB", status: "OPEN", assignedToUserId: admin.id, botActive: false, customerName: `Zz ${tag} Answered` }, select: { id: true } });
    await db.conversationMessage.create({ data: { conversationId: answeredChat.id, author: "CUSTOMER", body: "Hi", createdAt: new Date(Date.now() - 60_000) } });
    await db.conversationMessage.create({ data: { conversationId: answeredChat.id, author: "AGENT", userId: admin.id, body: "Hello, how can I help?" } });

    const after = await waitingLib.waitingForYou(admin.id, 200);
    const delta = (k: "tara" | "arjun" | "priya" | "kabir") => (after.byTeammate[k] ?? 0) - (before.byTeammate[k] ?? 0);
    ok("Tara: the follow-up to check and the answer she drafted", delta("tara") === 2 && after.items.some((i) => i.teammate === "tara" && i.title.includes(NAME)) && after.items.some((i) => i.title === "Ravi Zzwait replied — an answer is drafted"), after.byTeammate);
    ok("Arjun: the chase to send and the reply he read", delta("arjun") === 2 && after.items.some((i) => i.title === `Chase email to ${NAME} — check and send`) && after.items.some((i) => i.title === `${NAME} replied about payment` && i.detail === "Promises to pay on Friday."));
    const hr = await can(admin.id, "hr.manage");
    ok(`Priya: the question passed to HR — for whoever answers them (${hr ? "this admin does" : "this admin doesn't"})`, delta("priya") === (hr ? 1 : 0));
    ok("Kabir: the chat waiting on a reply; not the one we answered last", delta("kabir") === 1 && after.items.some((i) => i.title === `Zz ${tag} Visitor is waiting for your reply` && i.href === `/inbox?c=${waitingChat.id}`) && !after.items.some((i) => i.title.includes(`Zz ${tag} Answered`)));
    ok("  the total is every one counted", after.total - before.total === 2 + 2 + (hr ? 1 : 0) + 1, { before: before.total, after: after.total });
    ok("  oldest first", after.items.every((i, n) => n === 0 || after.items[n - 1]!.at <= i.at));
    const afterOther = await waitingLib.waitingForYou(other.id, 200);
    const otherDelta = (k: "tara" | "arjun" | "kabir") => (afterOther.byTeammate[k] ?? 0) - (beforeOther.byTeammate[k] ?? 0);
    ok("somebody else sees none of it — not theirs", otherDelta("tara") === 0 && otherDelta("arjun") === 0 && otherDelta("kabir") === 0 && !afterOther.items.some((i) => i.title.includes(tag) || i.title.includes(NAME)));
    ok("  a short list still counts them all", (await waitingLib.waitingForYou(admin.id, 2)).items.length === 2 && (await waitingLib.waitingForYou(admin.id, 2)).total === after.total);

    section("2. The morning note");
    ok("its window: yesterday on a working day, Friday on a Monday", daily.windowStart("2026-11-20", 5) === "2026-11-19" && daily.windowStart("2026-11-23", 1) === "2026-11-20");
    const words = daily.morningInWords(
      { done: new Map([["ved|research.plan", 4], ["arjun|collections.chase", 3]]), taraSent: 6, taraReplies: 2, arjunSent: 0, waiting: { items: [], total: 4, byTeammate: { tara: 1, arjun: 3 } } },
      teammates,
      "Yesterday",
    );
    ok(
      "in words: what went, what came, what each finished, what waits",
      !!words && words.startsWith(`Yesterday: ${teammates.tara.name}: sent 6 follow-ups, 2 replies came in`) && words.includes(`${teammates.ved.name} researched and planned 4 leads`) && words.includes(`Waiting for you: 4 (${teammates.tara.name} 1 · ${teammates.arjun.name} 3).`),
      words,
    );
    ok("  nothing done and nothing waiting: no note", daily.morningInWords({ done: new Map(), taraSent: 0, taraReplies: 0, arjunSent: 0, waiting: { items: [], total: 0, byTeammate: {} } }, teammates, "Yesterday") === null);
    ok("  only waiting: just that", daily.morningInWords({ done: new Map(), taraSent: 0, taraReplies: 0, arjunSent: 0, waiting: { items: [], total: 1, byTeammate: { kabir: 1 } } }, teammates, "Yesterday") === "Waiting for you: 1.");
    // What went and came in the window, counted from the rows.
    const from = new Date(Date.now() - 60 * 60_000);
    await db.nurtureTouch.create({ data: { enrolmentId: enrolment.id, step: 0, status: "SENT", subject: "Sent", body: "x".repeat(30), sentAt: new Date() } });
    const facts = await daily.dayFactsFor(admin.id, from, new Date(Date.now() + 60_000));
    ok("the facts: Tara's follow-up that went, the reply that came, Arjun's chase that went", facts.taraSent >= 1 && facts.taraReplies >= 1 && facts.arjunSent >= 1, { taraSent: facts.taraSent, taraReplies: facts.taraReplies, arjunSent: facts.arjunSent });
    ok("  on Saturday, and before nine: no note", (await daily.runTeamDaily(new Date("2026-11-21T06:00:00Z"))).reason === "weekend" && (await daily.runTeamDaily(new Date("2026-11-19T01:00:00Z"))).reason === "before nine");

    section("3. Where it shows");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createElement } = require("react") as typeof import("react");
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const { TeammatesProvider } = require("../src/components/ai/teammate-avatar") as typeof import("../src/components/ai/teammate-avatar");
    const { WaitingForYouCard } = require("../src/components/ai/waiting-for-you") as typeof import("../src/components/ai/waiting-for-you");
    const { TodayView } = require("../src/components/today/today-view") as typeof import("../src/components/today/today-view");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const card = renderToStaticMarkup(createElement(TeammatesProvider, { teammates }, createElement(WaitingForYouCard, { waiting: after })));
    ok("the card: Waiting for you, each teammate's count, the items opening where they're decided", card.includes("Waiting for you") && card.includes(`${teammates.kabir.name} · `) && card.includes(`/inbox?c=${waitingChat.id}`));
    ok("  nothing waiting: no card", renderToStaticMarkup(createElement(TeammatesProvider, { teammates }, createElement(WaitingForYouCard, { waiting: { items: [], total: 0, byTeammate: {} } }))) === "");
    const empty = { date: "2026-11-20", attendance: null, approvals_waiting: 0, approvals_more: false, approvals_by_kind: {}, tasks: null, leave: null } as unknown as import("../src/components/today/today-view").TodayData;
    const today = renderToStaticMarkup(
      createElement(TeammatesProvider, { teammates }, createElement(TodayView, { today: empty, greeting: "Hi", zone: "Asia/Kolkata", approvals: false, newLead: false, toCheck: [{ touchId: "t", leadTitle: "x", company: "y", href: "/leads/x", step: 0, subject: "s" }], waiting: after })),
    );
    ok("Today: Waiting for you in place of “Emails to check”", today.includes("Waiting for you") && !today.includes("Emails to check"));
  } finally {
    await db.collectionReply.deleteMany({ where: { chase: { companyId: company.id } } }).catch(() => undefined);
    await db.collectionChase.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.hrDeskQuestion.deleteMany({ where: { question: { startsWith: `Zz ${tag}` } } }).catch(() => undefined);
    if (channelId) await db.inboxChannel.deleteMany({ where: { id: channelId } }).catch(() => undefined);
    await db.lead.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.contact.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: company.id } }).catch(() => undefined);
    await db.$disconnect();
  }
  console.log(`\n${failures === 0 ? `All ${passes} waiting & morning-note checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
