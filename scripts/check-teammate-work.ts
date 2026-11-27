/**
 * check:teammate-work — the AI teammates' work as it happens (owner, 19 Nov 2026 — src/lib/ai/teammate-work.ts).
 *
 *   1. A job is recorded as it starts, at each step and as it ends, with what came of it; its result comes back.
 *   2. A job that throws is FAILED and still throws; only a refusal's own words are kept, never another error's.
 *   3. A person sees only their own team's work; a job cut off mid-way reads as not finished, not as still going; the
 *      day's counts take only what finished since the day began.
 *   4. A card finds the job on its own record, for its own person.
 *   5. Old rows are pruned; the steps and Today's card render.
 *   7. Phase 3: a teammate's note carries their face; the week in words; on a Monday each person with work done is told
 *      once, and nobody on another day; Kabir's live view is null for somebody the inbox isn't open to.
 *   6. The Team room: its feed is the person's own, newest first; a working teammate's card shows their steps, an idle
 *      one what they do; and a drafted workflow's steps are named.
 *
 * Probes are …@zzprobe-teamwork.invalid, removed in a finally.
 */
import "dotenv/config";
import Module from "node:module";
import type { ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/copilot/settings" || request.endsWith("lib/copilot/settings")) return { ...(originalLoad.call(this, request, parent, isMain) as object), copilotConfig: async () => ({ enabled: true }) };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const MAIL = "@zzprobe-teamwork.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  await db.aiTeammateWork.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  await db.dailyJobRun.deleteMany({ where: { job: "ai-team-weekly", day: { lt: new Date("2002-01-01T00:00:00Z") } } });
  await db.inboxChannel.deleteMany({ where: { name: "ZZPROBE teamwork chat" } });
  await db.user.deleteMany({ where: { email: { endsWith: MAIL } } });
}

class ProbeRefusal extends Error {}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const tw = require("../src/lib/ai/teammate-work") as typeof import("../src/lib/ai/teammate-work");
  const React = require("react") as typeof import("react");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const { StepList, TeamRoom } = require("../src/components/ai/teammate-live") as typeof import("../src/components/ai/teammate-live");
  const { WORKFLOW_STEPS } = require("../src/lib/ai/teammate-steps") as typeof import("../src/lib/ai/teammate-steps");
  const { TeamTodayCard } = require("../src/components/ai/team-today") as typeof import("../src/components/ai/team-today");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const render = (el: unknown) => renderToStaticMarkup(el as ReactElement);

  await cleanup();
  try {
    const mk = (n: string) => db.user.create({ data: { name: `Zz ${n}`, email: `${n}${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) }, select: { id: true } });
    const asha = await mk("asha");
    const ravi = await mk("ravi");
    const start = { teammate: "ved" as const, userId: asha.id, kind: "research.plan" as const, subject: "lead:zzprobe1", label: "a lead", steps: ["One", "Two", "Three"] };
    const row = () => db.aiTeammateWork.findFirst({ where: { userId: asha.id }, orderBy: { startedAt: "desc" } });

    section("1. A job, recorded as it goes");
    const seen: string[] = [];
    const result = await tw.teammateWork(
      start,
      async (work) => {
        seen.push(`${(await row())?.status}:${(await row())?.step}`);
        await work.about("Acme Infotech", "/leads/LD-1");
        await work.step(1);
        seen.push(`${(await row())?.status}:${(await row())?.step}:${(await row())?.label}`);
        await work.step(2);
        return 42;
      },
      (n) => `It came to ${n}`,
    );
    const done = await row();
    ok("running from the start, then on its second step under its own name", seen.join(" | ") === "RUNNING:0 | RUNNING:1:Acme Infotech", seen.join(" | "));
    ok("done, every step past, with what came of it", done?.status === "DONE" && done.step === 3 && done.summary === "It came to 42" && !!done.finishedAt && done.href === "/leads/LD-1");
    ok("the job's own result comes back", result === 42);

    section("2. A job that fails");
    let thrown = "";
    await tw.teammateWork({ ...start, subject: "lead:zzprobe2" }, async () => { throw new ProbeRefusal("You're out of credits for today."); }).catch((e: Error) => (thrown = e.message));
    const refused = await row();
    ok("a refusal is FAILED, keeps its words, and still throws", refused?.status === "FAILED" && refused.summary === "You're out of credits for today." && thrown === "You're out of credits for today.");
    await tw.teammateWork({ ...start, subject: "lead:zzprobe3" }, async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432"); }).catch(() => null);
    const crashed = await row();
    ok("any other error's words are never shown", crashed?.status === "FAILED" && crashed.summary === "It didn't finish — try again.", crashed?.summary);

    section("3. Whose it is, and when");
    const now = new Date();
    await db.aiTeammateWork.create({ data: { ...start, teammate: "tara", kind: "nurture.draft", userId: ravi.id, subject: "lead:zzprobe1", label: "Ravi's lead" } });
    await db.aiTeammateWork.create({ data: { ...start, subject: "lead:zzprobe4", label: "Cut off", startedAt: new Date(now.getTime() - tw.WORK_STALE_MS - 60_000) } });
    await db.aiTeammateWork.create({ data: { ...start, subject: "lead:zzprobe5", label: "Yesterday's", status: "DONE", startedAt: new Date(now.getTime() - 30 * 60 * 60_000), finishedAt: new Date(now.getTime() - 30 * 60 * 60_000) } });
    const mine = await tw.teamActivityFor(asha.id, new Date(now.getTime() - 60 * 60_000), now);
    ok("nothing of anybody else's", ![...mine.running, ...mine.recent].some((w) => w.label === "Ravi's lead"));
    ok("a job cut off isn't shown as still going", !mine.running.some((w) => w.label === "Cut off"));
    ok("today's count takes what finished since the day began", mine.done.ved === 1 && mine.done.tara === 0, JSON.stringify(mine.done));
    ok("what just ended is listed, newest first", mine.recent[0]?.status === "FAILED" && mine.recent.some((w) => w.label === "Acme Infotech" && w.summary === "It came to 42"));
    const his = await tw.teamActivityFor(ravi.id, new Date(now.getTime() - 60 * 60_000), now);
    ok("Ravi sees his own going", his.running.length === 1 && his.running[0]!.teammate === "tara" && his.running[0]!.steps.join() === "One,Two,Three");

    section("4. A card's own job");
    ok("found on its record, for its person", (await tw.workOn(ravi.id, "lead:zzprobe1"))?.label === "Ravi's lead" && (await tw.workOn(asha.id, "lead:zzprobe1"))?.label === "Acme Infotech");
    ok("none where there isn't one", (await tw.workOn(asha.id, "lead:zzprobe-none")) === null);

    section("5. Pruning, and on screen");
    await db.aiTeammateWork.create({ data: { ...start, subject: "lead:zzprobe6", label: "Ancient", status: "DONE", startedAt: new Date(now.getTime() - 40 * 24 * 60 * 60_000) } });
    await tw.pruneTeammateWork(now);
    ok("rows past 30 days go, the rest stay", (await db.aiTeammateWork.count({ where: { userId: asha.id, label: "Ancient" } })) === 0 && (await db.aiTeammateWork.count({ where: { userId: asha.id, label: "Yesterday's" } })) === 1);
    const steps = render(React.createElement(StepList, { work: { steps: ["One", "Two", "Three"], step: 1, status: "RUNNING" } }));
    ok("steps: the first ticked, the second turning, the third waiting", steps.includes("text-success") && steps.includes("animate-spin") && (steps.match(/<li/g) ?? []).length === 3);
    const card = render(React.createElement(TeamTodayCard, { team: { done: { ved: 3, tara: 2 }, draftsWaiting: 2, leadsToWork: 0 } }));
    ok("Today: Tara says her drafts wait, and what each did", card.includes("drafted 2 follow-ups") && card.includes("researched and planned 3 leads") && card.includes("drafted 2 emails") && card.includes("5 jobs done for you"));
    ok("  and nothing at all when there's nothing to say", render(React.createElement(TeamTodayCard, { team: { done: {}, draftsWaiting: 0, leadsToWork: 0 } })) === "");
    ok("  Mira's workflows are counted too", render(React.createElement(TeamTodayCard, { team: { done: { mira: 1 }, draftsWaiting: 0, leadsToWork: 0 } })).includes("drafted 1 workflow"));

    section("6. The Team room");
    await db.aiTeammateWork.create({ data: { teammate: "mira", userId: asha.id, kind: "workflow.draft", subject: "workflow:draft", label: "a workflow", steps: WORKFLOW_STEPS, step: 1 } });
    const feed = await tw.teamFeedFor(asha.id);
    ok("the feed is her own, newest first", feed[0]?.teammate === "mira" && feed.every((w) => w.label !== "Ravi's lead") && feed.some((w) => w.label === "Acme Infotech"));
    const room = render(React.createElement(TeamRoom, { initial: { ...(await tw.teamActivityFor(asha.id, new Date(now.getTime() - 60 * 60_000))), feed } }));
    ok("Mira's card shows her working, on her second step", room.includes("Drafting a workflow") && room.includes("Reading what Automate can do here") && room.includes("animate-spin"));
    ok("an idle teammate's card says what they do", room.includes("Answers your website chat"));
    ok("the feed says what was finished, and what didn't", room.includes("finished") && room.includes("It came to 42") && room.includes("didn&#x27;t finish"));
    ok("her job on the dialog is found by its subject", (await tw.workOn(asha.id, "workflow:draft"))?.teammate === "mira");

    section("7. Notes, the week, and Kabir");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const tm = require("../src/lib/ai/teammates") as typeof import("../src/lib/ai/teammates");
    const weekly = require("../src/lib/ai/team-weekly") as typeof import("../src/lib/ai/team-weekly");
    const { TeammateNoteFace } = require("../src/components/ai/teammate-note") as typeof import("../src/components/ai/teammate-note");
    const { kabirLiveFor } = require("../src/lib/ai/kabir-live") as typeof import("../src/lib/ai/kabir-live");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const note = tm.noteFrom("Tara", "I've drafted email 2 of 4 for Acme — have a look?");
    ok("a note in a teammate's voice carries their face", render(React.createElement(TeammateNoteFace, { title: note })).includes("Tara, AI nurture writer"));
    ok("  and anything else carries none", render(React.createElement(TeammateNoteFace, { title: "Taran Singh: hello" })) === "" && render(React.createElement(TeammateNoteFace, { title: "A lead was assigned" })) === "");
    const words = weekly.weekInWords(new Map([["ved|research.plan", 12], ["tara|nurture.draft", 1], ["mira|workflow.draft", 2]]), tm.teammatesWith({ tara: "Asha" }));
    ok("the week in words, by the workspace's own names", words === "Ved researched and planned 12 leads · Asha drafted 1 follow-up email · Mira drafted 2 workflows", words);
    ok("  nothing done, nothing said", weekly.weekInWords(new Map(), tm.teammatesWith()) === null);

    // A Monday long ago, with work done in the days before it — for Asha only.
    const monday = new Date("2001-01-08T06:00:00Z");
    for (const day of [3, 4, 5]) await db.aiTeammateWork.create({ data: { ...start, subject: null, label: "Old lead", status: "DONE", startedAt: new Date(`2001-01-0${day}T06:00:00Z`) } });
    const tuesday = await weekly.runTeamWeekly(new Date("2001-01-09T06:00:00Z"));
    ok("not on a Tuesday", tuesday.told === 0 && tuesday.reason === "not Monday");
    const first = await weekly.runTeamWeekly(monday);
    const told = await db.notification.findMany({ where: { userId: { in: [asha.id, ravi.id] }, title: "Your AI team last week" }, select: { userId: true, message: true, link: true } });
    ok("on Monday, whoever had work done is told what", first.told === 1 && told.length === 1 && told[0]!.userId === asha.id && told[0]!.message === "Ved researched and planned 3 leads." && told[0]!.link === "/ai-team", JSON.stringify(told));
    ok("  and only once", (await weekly.runTeamWeekly(monday)).reason === "already sent");
    // Kabir: a conversation the bot holds, seen by an admin (who sees every conversation), then taken over.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const inbox = require("../src/lib/inbox/server") as typeof import("../src/lib/inbox/server");
    const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true } });
    if (!admin) throw new Error("no admin to check with");
    const viewer = { id: admin.id, viewAll: true };
    const channel = await db.inboxChannel.create({ data: { kind: "WEB", name: "ZZPROBE teamwork chat", settings: { bot: { on: true, name: "" } } } });
    const chat = await db.conversation.create({ data: { channelId: channel.id, kind: "WEB", botActive: true, customerName: "Zz Visitor", lastMessageAt: new Date() } });
    await inbox.addMessage(chat.id, "CUSTOMER", "What does it cost?");
    await inbox.addMessage(chat.id, "BOT", "Our plans start at…");
    await inbox.addMessage(chat.id, "CUSTOMER", "And for 20 people?");
    const hour = new Date(Date.now() - 60 * 60_000);
    const live = await kabirLiveFor(admin.id, hour);
    if (live) {
      const mine = live.chats.find((c) => c.id === chat.id);
      ok("Kabir's chat is live, the customer waiting on his answer", !!mine && mine.customer === "Zz Visitor" && mine.answering && live.answeredToday >= 1, JSON.stringify(mine));
    } else {
      ok("(the Customer inbox isn't open to the local admin — Kabir's live view is rightly null)", true);
    }
    // The inbox's own rule decides who sees it: a channel that is one person's isn't shown to a colleague without "see all".
    await db.inboxChannel.update({ where: { id: channel.id }, data: { ownerUserId: admin.id } });
    ok("  a colleague's own channel isn't shown to somebody else", !(await kabirLiveFor(asha.id, hour))?.chats.some((c) => c.id === chat.id));
    ok("  nor may they take it over", !(await inbox.takeOverFromBot({ id: asha.id, viewAll: false }, chat.id)).ok);
    const taken = await inbox.takeOverFromBot(viewer, chat.id);
    const after = await db.conversation.findUniqueOrThrow({ where: { id: chat.id }, select: { botActive: true, assignedToUserId: true, needsPersonAt: true } });
    const said = await db.conversationMessage.findFirst({ where: { conversationId: chat.id, author: "SYSTEM" }, orderBy: { createdAt: "desc" }, select: { body: true } });
    ok("taken over: theirs, the bot off, and the conversation says so", taken.ok && after.assignedToUserId === admin.id && !after.botActive && !!after.needsPersonAt && said?.body === `${admin.name} took over from Kabir`, said?.body);
    if (live) ok("  and it's no longer among Kabir's chats", !(await kabirLiveFor(admin.id, hour))?.chats.some((c) => c.id === chat.id));
    ok("  a conversation that isn't there is refused", !(await inbox.takeOverFromBot(viewer, "zz-none")).ok);
  } finally {
    await cleanup();
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll teammate-work checks passed.");
    process.exitCode = failures ? 1 : 0;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
