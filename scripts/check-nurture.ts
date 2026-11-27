/**
 * check:nurture — Deskzo AI nurturing a lead (owner, 18 Nov 2026 — phase 3; src/lib/nurture).
 *
 *   · The cadence (days 0, 3, 7, 14, then a week to answer), the reply-to address and reading it back.
 *   · Off until switched on; a plan first; the first email the plan's own; every email waits for the lead's owner.
 *   · Approve & send: from the owner's mailbox, the reply-to the workspace's address with the secret, the contact's
 *     first name and the "manage what we send you" line, in the mail log and on the lead; the next falls due on the cadence.
 *   · The heartbeat drafts the next email (what was sent before, never the contact's name or address), and ends it at a
 *     call somebody logs, or after the last email with no answer — handing back with a task.
 *   · A reply: an out-of-office changes nothing; a real one ends it, is forwarded to the owner with a task; one to a
 *     nurture already ended is still forwarded.
 *   · Today's "Emails to check", the card, and the switch: off stops sending too.
 *
 * Nothing leaves: Deskzo AI, the mailbox and Deskzo's own mail are stand-ins. Local workspace, its own records (Zz Nurture …).
 *
 *   npm run check:nurture
 */
import "dotenv/config";
import Module from "node:module";
import { createHmac, randomUUID } from "node:crypto";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

process.env.INBOUND_MAIL_DOMAIN = "zz-inbound.test";
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
const prompts: string[] = [];
// Phase 4: what Deskzo AI says a reply means — set by each case; null answers with no reading at all.
let nextRead: Record<string, unknown> | null = null;
const replyPrompts: string[] = [];
// Step 2: the instructions each AI turn was given — the house style must reach them.
const systems: string[] = [];
const gateway = {
  AiRefusal,
  aiService: async () => ({ model: "Zz Model", residency: "Zzland", noTraining: true }),
  aiTurn: async (turn: { feature?: string; system?: string; history: { role: string; text?: string }[] }) => {
    systems.push(turn.system ?? "");
    if (turn.feature === "nurture.reply") {
      replyPrompts.push(turn.history.find((h) => h.role === "user")?.text ?? "");
      const calls = nextRead ? [{ id: "r", name: "read_reply", input: nextRead }] : [];
      return { text: "", toolCalls: calls, native: null, usage: { input: 1, output: 1 }, stop: "tools", model: "zz", family: "BEDROCK", modelKey: "zz", charge: { credits: 1 } };
    }
    prompts.push(turn.history.find((h) => h.role === "user")?.text ?? "");
    const input = { subject: "Following up on Microsoft 365", body: "Hi {{firstName}},\n\nJust checking whether the seat count is clearer now.\n\n{{senderName}}" };
    return { text: "", toolCalls: [{ id: "c", name: "propose_email", input }], native: null, usage: { input: 1, output: 1 }, stop: "tools", model: "zz", family: "BEDROCK", modelKey: "zz", charge: { credits: 1 } };
  },
};
type Out = { subject: string; html: string; to: { name: string | null; email: string }[]; replyTo?: { name: string | null; email: string } };
const mailboxSends: Out[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }), usePathname: () => "/leads/x", useSearchParams: () => new URLSearchParams() };
  if (request === "@/lib/session" || request.endsWith("/lib/session")) return session;
  if (request === "@/lib/ai/gateway" || request.endsWith("/lib/ai/gateway")) return gateway;
  // Phase 4's booking: no real calendar asked or written (as check:booking-extras).
  if (request === "@/lib/calendar/busy" || request.endsWith("/lib/calendar/busy")) return { busyFor: async (people: { id: string }[]) => new Map(people.map((p) => [p.id, []])) };
  if (request === "@/lib/calendar/meetings" || request.endsWith("/lib/calendar/meetings")) {
    return {
      scheduleMeeting: async (userId: string, draft: { title: string; startsAt: Date; endsAt: Date }, links: { leadId?: string | null; companyId?: string | null }) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
        const row = await db.calendarEvent.create({ data: { userId, title: draft.title, startsAt: draft.startsAt, endsAt: draft.endsAt, fromDeskzo: true, isOrganizer: true, leadId: links.leadId ?? null, companyId: links.companyId ?? null } });
        return { ok: true, eventId: row.id };
      },
      rescheduleMeeting: async () => ({ ok: true, eventId: "zz" }),
      cancelMeeting: async () => ({ ok: true, eventId: "zz" }),
    };
  }
  if (request === "@/lib/mail/mailbox" || request.endsWith("/lib/mail/mailbox")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      mailboxState: async () => ({ state: "connected", provider: "GOOGLE", mailbox: "owner@zz-own.test" }),
      sendAsUser: async (_userId: string, mail: Out) => {
        mailboxSends.push(mail);
        return { ok: true, mailbox: "owner@zz-own.test", provider: "GOOGLE" };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rules = require("../src/lib/nurture/rules") as typeof import("../src/lib/nurture/rules");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("1. The cadence and the reply address");
  const start = new Date("2026-11-18T05:00:00Z");
  const day = (n: number) => new Date(start.getTime() + n * 86_400_000).toISOString();
  ok("emails due on days 0, 3, 7 and 14 from starting", rules.nextTouchAt(start, 1, start).toISOString() === day(3) && rules.nextTouchAt(start, 2, new Date(day(3))).toISOString() === day(7) && rules.nextTouchAt(start, 3, new Date(day(7))).toISOString() === day(14));
  ok("  a late send keeps two days before the next", rules.nextTouchAt(start, 2, new Date(day(6))).toISOString() === day(8));
  ok("  after the fourth, a week to answer", rules.nextTouchAt(start, 4, new Date(day(14))).toISOString() === day(21));
  const token = rules.newReplyToken();
  const address = rules.replyAddress("wroffy", token, "tickets.deskzo.com");
  ok("the reply-to is the workspace's own inbound address with the secret, and reads back", address === `wroffy+n-${token}@tickets.deskzo.com` && rules.replyTokenOf(address.toUpperCase()) === token);
  ok("  the helpdesk's own address isn't a nurture reply", rules.replyTokenOf("wroffy@tickets.deskzo.com") === null && rules.replyTokenOf("wroffy+n-short@tickets.deskzo.com") === null);
  const text = rules.finalText("Hi {{firstName}},\n\nHello.\n\n{{senderName}}", { firstName: "Ravi", senderName: "Asha" }, "https://x.test/preferences/abc");
  ok("the email as sent: first name, sender, and the 'manage what we send you' line", text.startsWith("Hi Ravi,") && text.includes("\nAsha\n") && text.endsWith("Manage what we send you: https://x.test/preferences/abc"));

  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const nurture = require("../src/lib/nurture/server") as typeof import("../src/lib/nurture/server");
  const actions = require("../src/actions/nurture") as typeof import("../src/actions/nurture");
  const copilotSettings = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
  const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { currentTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const forwarded: { to: string; subject: string; text: string; replyTo?: string }[] = [];
  mailer.setTestPlatformMailer(async (m) => {
    forwarded.push({ to: m.to, subject: m.subject, text: m.text, replyTo: m.replyTo });
  });
  copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: null });

  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  if (!admin) throw new Error("no super admin");
  const other = await db.user.findFirst({ where: { active: true, isSuperAdmin: false, kind: "MEMBER", id: { not: admin.id } }, select: { id: true, name: true, email: true, role: true } });
  const asAdmin = () => (actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role });
  asAdmin();
  const slug = (await currentTenant()).slug;
  const before = await db.nurtureSettings.findUnique({ where: { id: "global" } });
  await db.nurtureSettings.deleteMany({});

  const tag = randomUUID().slice(0, 6);
  const NAME = `Zz Nurture ${tag} Pvt Ltd`;
  const company = await db.company.create({ data: { name: NAME, normalizedName: NAME.toLowerCase(), createdById: admin.id }, select: { id: true } });
  const contact = await db.contact.create({ data: { companyId: company.id, name: "Ravi Zzkumar", email: `ravi.${tag}@zznurture.example.com`, designation: "IT_MANAGER", isPrimary: true, createdByUserId: admin.id }, select: { id: true, email: true } });
  const makeLead = (title: string) => db.lead.create({ data: { companyId: company.id, contactId: contact.id, title: `Zz ${tag} ${title}`, ownerUserId: admin.id, createdByUserId: admin.id, status: "QUALIFYING" }, select: { id: true } });
  const plan = (leadId: string) =>
    db.researchPlan.create({
      data: {
        key: `lead:${leadId}`,
        companyId: company.id,
        leadId,
        createdById: admin.id,
        plan: { fit: "HOT", fitReasons: ["Asked for 50 seats"], summary: "Interested.", steps: [{ kind: "CALL", title: "Call", why: "x", dueInDays: 0 }], questions: ["Who signs?"], email: { subject: "Your Microsoft 365 enquiry", body: "Hi {{firstName}},\n\nThanks for asking about 50 seats.\n\n{{senderName}}" }, tasks: {}, model: "zz", credits: 0 },
      },
    });
  const enrolmentOf = (leadId: string) => db.nurtureEnrolment.findUnique({ where: { leadId }, include: { touches: { orderBy: { step: "asc" } } } });

  try {
    section("2. Starting");
    const lead = await makeLead("50 Microsoft 365 seats");
    const off = await actions.startNurture(lead.id);
    ok("switched off for the workspace: refused, saying where to switch it on", !off.ok && /Settings → Deskzo AI/.test(off.ok ? "" : off.error));
    const saved = await actions.saveNurtureSettings({ enabled: true, perDay: 50 });
    ok("an admin switches it on", saved.ok && saved.data.enabled);
    const noPlan = await actions.startNurture(lead.id);
    ok("no Research & plan yet: refused — its email is the first", !noPlan.ok && /Research & plan first/.test(noPlan.ok ? "" : noPlan.error));
    await plan(lead.id);
    const started = await actions.startNurture(lead.id);
    const e1 = await enrolmentOf(lead.id);
    ok("started: the plan's email waits as the first, for the lead's owner", started.ok && e1?.status === "ACTIVE" && e1.ownerId === admin.id && e1.touches.length === 1 && e1.touches[0]!.status === "WAITING" && e1.touches[0]!.subject === "Your Microsoft 365 enquiry", started);
    const twice = await actions.startNurture(lead.id);
    ok("  started twice: refused", !twice.ok);

    section("3. Approve & send");
    const waiting = e1!.touches[0]!;
    if (other) {
      actor = { id: other.id, name: other.name, email: other.email, role: other.role };
      const notOwner = await actions.sendNurtureEmail({ touchId: waiting.id, subject: waiting.subject, body: waiting.body, when: "now" });
      ok("somebody other than the owner can't send it — it goes from the owner's mailbox", !notOwner.ok);
      asAdmin();
    }
    const sent = await actions.sendNurtureEmail({ touchId: waiting.id, subject: "Your Microsoft 365 enquiry — 50 seats", body: waiting.body, when: "now" });
    const m = mailboxSends[mailboxSends.length - 1];
    ok("sent from the owner's mailbox, to the contact, as they changed it", sent.ok && m?.to[0]?.email === contact.email && m.subject === "Your Microsoft 365 enquiry — 50 seats", sent);
    ok("  replies go to the workspace's address with the secret", m?.replyTo?.email === `${slug}+n-${e1!.replyToken}@zz-inbound.test`, m?.replyTo);
    ok("  the first name filled, the 'manage what we send you' line added", !!m?.html.includes("Hi Ravi,") && /Manage what we send you/.test(m?.html ?? ""));
    const e2 = await enrolmentOf(lead.id);
    ok("  one sent; the next falls due three days after starting", e2?.touchesSent === 1 && e2.touches[0]!.status === "SENT" && Math.abs((e2.nextTouchAt?.getTime() ?? 0) - (e2.createdAt.getTime() + 3 * 86_400_000)) < 60_000);
    ok("  in the mail log, and on the lead", (await db.marketingMessage.count({ where: { contactId: contact.id, subject: "Your Microsoft 365 enquiry — 50 seats" } })) === 1 && (await db.activity.count({ where: { leadId: lead.id, type: "EMAIL", notes: { contains: "Nurture email 1 of 4" } } })) === 1);

    section("4. The heartbeat drafts the next");
    const early = await nurture.runNurture();
    ok("not due yet: nothing drafted", early.drafted === 0 && (await enrolmentOf(lead.id))?.touches.length === 1, early);
    await db.nurtureEnrolment.update({ where: { leadId: lead.id }, data: { nextTouchAt: new Date(Date.now() - 60_000) } });
    prompts.length = 0;
    const due = await nurture.runNurture();
    const e3 = await enrolmentOf(lead.id);
    ok("due: email 2 drafted by Deskzo AI, waiting for its owner", due.drafted >= 1 && e3?.touches[1]?.status === "WAITING" && e3.touches[1]!.step === 1 && e3.nextTouchAt === null, due);
    const prompt = prompts.find((p) => p.includes(`Zz ${tag}`)) ?? prompts[0] ?? "";
    ok("  written knowing what was sent before — never the contact's name or address", prompt.includes("Your Microsoft 365 enquiry — 50 seats") && prompt.includes("Email 2 of 4") && !prompt.includes(contact.email!) && !prompt.includes("Zzkumar"), prompt.slice(0, 200));
    const skipped = await actions.skipNurtureEmail(e3!.touches[1]!.id);
    const e4 = await enrolmentOf(lead.id);
    ok("skipped: set aside, the next on the cadence", skipped.ok && e4?.touches[1]?.status === "SKIPPED" && !!e4.nextTouchAt);

    section("5. Today and the card");
    await db.nurtureEnrolment.update({ where: { leadId: lead.id }, data: { nextTouchAt: new Date(Date.now() - 60_000) } });
    await nurture.runNurture();
    const list = (await nurture.waitingFor(admin.id, 50)).filter((w) => w.leadTitle.includes(`Zz ${tag}`));
    ok("the waiting email on its owner's Today", list.length === 1 && list[0]!.step === 2 && /^\/leads\/LEAD-\d+$/.test(list[0]!.href), list);
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createElement } = require("react") as typeof import("react");
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const { TodayView } = require("../src/components/today/today-view") as typeof import("../src/components/today/today-view");
    const { NurtureCard } = require("../src/components/research/nurture-card") as typeof import("../src/components/research/nurture-card");
    const view = require("../src/lib/nurture/view") as typeof import("../src/lib/nurture/view");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const empty = { date: "2026-11-18", attendance: null, approvals_waiting: 0, approvals_more: false, approvals_by_kind: {}, tasks: null, leave: null } as unknown as import("../src/components/today/today-view").TodayData;
    const today = renderToStaticMarkup(createElement(TodayView, { today: empty, greeting: "Hi", zone: "Asia/Kolkata", approvals: false, newLead: false, toCheck: list }));
    ok("  Today: 'Emails to check', with the subject", today.includes("Emails to check") && today.includes("Following up on Microsoft 365"));
    const card = await view.nurtureCardData(lead.id, admin.id);
    const html = renderToStaticMarkup(createElement(NurtureCard, { data: card }));
    ok("the card for its owner: the emails so far, the waiting one to change and send, Stop and They replied", card.isOwner && (html.includes("Approve &amp; send") || (html.includes("Approve — goes") && html.includes("Send now"))) && html.includes("Skip this one") && html.includes("They replied") && html.includes("Email 1"));

    section("6. A reply");
    const e5 = await enrolmentOf(lead.id);
    const ooo = await nurture.receiveNurtureReply(e5!.replyToken, { from: { address: contact.email!, name: "Ravi Zzkumar" }, to: [], cc: [], subject: "Out of office", text: "Away until Monday.", messageId: null, inReplyTo: null, references: [], automated: "An automatic reply", attachments: [], senderVerified: true });
    ok("an out-of-office changes nothing", ooo === "automated" && (await enrolmentOf(lead.id))?.status === "ACTIVE");
    forwarded.length = 0;
    const real = await nurture.receiveNurtureReply(e5!.replyToken, { from: { address: contact.email!, name: "Ravi Zzkumar" }, to: [], cc: [], subject: "Re: Your Microsoft 365 enquiry — 50 seats", text: "Yes, please call me tomorrow.", messageId: null, inReplyTo: null, references: [], automated: null, attachments: [], senderVerified: true });
    const e6 = await enrolmentOf(lead.id);
    ok("a real reply ends it, saying who replied", real === "forwarded" && e6?.status === "STOPPED" && !!e6.repliedAt && /replied/.test(e6.stopReason ?? "") && e6.touches.every((t) => t.status !== "WAITING"), e6?.stopReason);
    ok("  forwarded to the owner, a reply going straight back to the customer", forwarded.length === 1 && forwarded[0]!.to === admin.email && forwarded[0]!.replyTo === contact.email && forwarded[0]!.text.includes("Yes, please call me tomorrow."));
    ok("  with a task for the owner and the reply on the lead", (await db.task.count({ where: { leadId: lead.id, assignedToUserId: admin.id, title: { startsWith: "Answer Ravi Zzkumar" } } })) === 1 && (await db.activity.count({ where: { leadId: lead.id, notes: { contains: "please call me tomorrow" } } })) === 1);
    forwarded.length = 0;
    const late = await nurture.receiveNurtureReply(e5!.replyToken, { from: { address: contact.email!, name: "Ravi Zzkumar" }, to: [], cc: [], subject: "Re: one more thing", text: "Also 5 more seats.", messageId: null, inReplyTo: null, references: [], automated: null, attachments: [], senderVerified: true });
    ok("a reply after it ended is still forwarded — never lost", late === "forwarded" && forwarded.length === 1);
    ok("a secret nobody has: unknown, for the helpdesk to take", (await nurture.receiveNurtureReply("0".repeat(24), { from: null, to: [], cc: [], subject: "x", text: "x", messageId: null, inReplyTo: null, references: [], automated: null, attachments: [], senderVerified: false })) === "unknown");

    section("6b. Through the door the mail worker posts to");
    process.env.INBOUND_MAIL_SECRET = "zz-nurture-secret-0123456789abcdef";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { receiveInbound } = require("../src/lib/support-mail/inbound") as typeof import("../src/lib/support-mail/inbound");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const senderDomain = contact.email!.split("@")[1]!;
    const post = (token: string, words: string, dmarc: "pass" | "fail") => {
      const to = `${slug}+n-${token}@zz-inbound.test`;
      const raw = [
        `From: Ravi Zzkumar <${contact.email}>`,
        `To: ${to}`,
        "Subject: Re: Your Microsoft 365 enquiry",
        `Message-ID: <${randomUUID()}@zznurture.example.com>`,
        "Date: Wed, 18 Nov 2026 10:00:00 +0530",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        words,
        "",
      ].join("\r\n");
      const auth = { authservId: "mx.cloudflare.net", dmarc, dmarcDomain: senderDomain, dkim: [{ result: dmarc, domain: senderDomain }], spf: dmarc };
      const body = JSON.stringify({ recipient: to, sender: contact.email, raw: Buffer.from(raw).toString("base64"), auth });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", process.env.INBOUND_MAIL_SECRET!).update(`${timestamp}.${body}`).digest("hex");
      return receiveInbound(body, new Headers({ "x-deskzo-timestamp": timestamp, "x-deskzo-signature": signature }));
    };
    const routed = await makeLead("through the door");
    await plan(routed.id);
    await actions.startNurture(routed.id);
    const er = await enrolmentOf(routed.id);
    forwarded.length = 0;
    const answer = await post(er!.replyToken, "Send me the quote for 60 seats.", "pass");
    const er2 = await enrolmentOf(routed.id);
    ok("a reply the mail worker posts: taken by the nurture, not made a ticket", answer.status === 200 && answer.body.result === undefined && er2?.status === "STOPPED" && !!er2.repliedAt, answer);
    ok("  forwarded to the owner, replying going to the customer", forwarded.length === 1 && forwarded[0]!.to === admin.email && forwarded[0]!.replyTo === contact.email && forwarded[0]!.text.includes("quote for 60 seats"));
    forwarded.length = 0;
    const spoofed = await post(er!.replyToken, "Pay to this new account instead.", "fail");
    ok("a sender that fails DMARC: still forwarded, but replying doesn't go to the address it claims", spoofed.status === 200 && forwarded.length === 1 && forwarded[0]!.replyTo !== contact.email, forwarded[0]?.replyTo ?? "none");

    section("7. Ending by itself");
    const called = await makeLead("called");
    await plan(called.id);
    await actions.startNurture(called.id);
    await db.activity.create({ data: { leadId: called.id, userId: admin.id, type: "CALL", notes: "Spoke to Ravi", occurredAt: new Date(Date.now() + 1000) } });
    await db.nurtureEnrolment.update({ where: { leadId: called.id }, data: { nextTouchAt: new Date(Date.now() - 60_000) } });
    await nurture.runNurture(new Date(Date.now() + 2000));
    const ec = await enrolmentOf(called.id);
    ok("a call somebody logged: stopped — a person has it", ec?.status === "STOPPED" && /call was logged/.test(ec.stopReason ?? ""), ec?.stopReason);
    const quiet = await makeLead("quiet");
    await plan(quiet.id);
    await actions.startNurture(quiet.id);
    const eq = await enrolmentOf(quiet.id);
    for (const step of [1, 2, 3]) await db.nurtureTouch.create({ data: { enrolmentId: eq!.id, step, status: "SENT", subject: `Email ${step + 1}`, body: "x".repeat(30), sentAt: new Date() } });
    await db.nurtureTouch.updateMany({ where: { enrolmentId: eq!.id, step: 0 }, data: { status: "SENT", sentAt: new Date() } });
    await db.nurtureEnrolment.update({ where: { id: eq!.id }, data: { touchesSent: 4, nextTouchAt: new Date(Date.now() - 60_000) } });
    await nurture.runNurture();
    const eq2 = await enrolmentOf(quiet.id);
    ok("four emails and no answer: finished, handed back with a task", eq2?.status === "DONE" && /No reply after 4 emails/.test(eq2.stopReason ?? "") && (await db.task.count({ where: { leadId: quiet.id, title: { startsWith: "No reply from" } } })) === 1, eq2?.stopReason);

    section("8. Off is off");
    const fresh = await makeLead("fresh");
    await plan(fresh.id);
    await actions.startNurture(fresh.id);
    await actions.saveNurtureSettings({ enabled: false, perDay: 50 });
    const ef = await enrolmentOf(fresh.id);
    const blocked = await actions.sendNurtureEmail({ touchId: ef!.touches[0]!.id, subject: ef!.touches[0]!.subject, body: ef!.touches[0]!.body, when: "now" });
    ok("switched off: a waiting email can't be sent either", !blocked.ok && /switched off/.test(blocked.ok ? "" : blocked.error));
    ok("  and the heartbeat drafts nothing", (await nurture.runNurture()).reason === "off");
    const stopped = await actions.stopLeadNurture({ leadId: fresh.id, replied: false });
    ok("stopping by hand still works", stopped.ok && (await enrolmentOf(fresh.id))?.status === "STOPPED");

    // ─── Phase 4 (owner, 20 Nov 2026) ───────────────────────────────────────────────────────────────────────────────
    /* eslint-disable @typescript-eslint/no-require-imports */
    const p4 = require("../src/lib/nurture/replies") as typeof import("../src/lib/nurture/replies");
    const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
    const bookingServer = require("../src/lib/booking/server") as typeof import("../src/lib/booking/server");
    /* eslint-enable @typescript-eslint/no-require-imports */
    await actions.saveNurtureSettings({ enabled: true, perDay: 50 });
    const zone = (await workspaceClock()).zone;

    section("9. Working hours (Kolkata's clock)");
    const at = (iso: string) => new Date(iso);
    const ist = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(p4.sendTimeFor(at(iso), "Asia/Kolkata"));
    ok("Wednesday 11:00: at once", p4.sendTimeFor(at("2026-11-18T05:30:00Z"), "Asia/Kolkata").toISOString() === "2026-11-18T05:30:00.000Z");
    ok("  Wednesday 18:00: Thursday 10:00", ist("2026-11-18T12:30:00Z") === "Thu 10:00", ist("2026-11-18T12:30:00Z"));
    ok("  Wednesday 07:00: that morning, 10:00", ist("2026-11-18T01:30:00Z") === "Wed 10:00", ist("2026-11-18T01:30:00Z"));
    ok("  Friday evening and Saturday: Monday 10:00", ist("2026-11-20T15:00:00Z") === "Mon 10:00" && ist("2026-11-21T06:00:00Z") === "Mon 10:00");
    ok("  in Dubai, its own clock", new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", weekday: "short", hour: "2-digit", hourCycle: "h23" }).format(p4.sendTimeFor(at("2026-11-21T06:00:00Z"), "Asia/Dubai")) === "Mon, 10");

    section("10. A reply's words, cleaned");
    const raw = "Hi Asha,\nPlease call me on +91 98765 43210 or write to ravi.k@acme.example.\n\nOn Tue, 18 Nov 2026 at 10:00, Asha <asha@own.test> wrote:\n> Your Microsoft 365 enquiry";
    const clean = p4.scrubReply(raw);
    ok("addresses and numbers out, the quoted thread cut", !clean.includes("98765") && !clean.includes("ravi.k@") && !clean.includes("Your Microsoft 365 enquiry") && clean.includes("[number]") && clean.includes("[email]"), clean);
    ok("  the other address a reply names, for the person it points to", p4.otherAddresses("talk to Priya.S@acme.example — me: ravi@acme.example", "ravi@acme.example").join() === "priya.s@acme.example");
    ok("  a day kept only when ahead and within 18 months", p4.usableResume("2027-03-01", "2026-11-20") === "2027-03-01" && p4.usableResume("2026-11-01", "2026-11-20") === null && p4.usableResume("2029-01-01", "2026-11-20") === null);
    ok("  a booking reference reads back to its secret, nothing else does", p4.tokenOfBookingRef(p4.bookingRef("a".repeat(24))) === "a".repeat(24) && p4.tokenOfBookingRef("n-xyz") === null);

    // A lead, started and its first email waiting — for each case below.
    const fresh4 = async (title: string) => {
      const l = await makeLead(title);
      await plan(l.id);
      const started4 = await actions.startNurture(l.id);
      if (!started4.ok) throw new Error(`start: ${started4.error}`);
      return { lead: l, e: (await enrolmentOf(l.id))! };
    };
    const reply = (token: string, text: string, extra: Partial<{ automated: string | null; senderVerified: boolean; from: string }> = {}) =>
      nurture.receiveNurtureReply(token, {
        from: { address: extra.from ?? contact.email!, name: "Ravi Zzkumar" },
        to: [],
        cc: [],
        subject: "Re: Your Microsoft 365 enquiry",
        text,
        messageId: null,
        inReplyTo: null,
        references: [],
        automated: extra.automated ?? null,
        attachments: [],
        senderVerified: extra.senderVerified ?? true,
      });
    const lastReply = (enrolmentId: string) => db.nurtureReply.findFirst({ where: { enrolmentId }, orderBy: { createdAt: "desc" } });

    section("11. Approved for the working morning");
    const { e: w0 } = await fresh4("working hours");
    const saturday = at("2026-11-21T06:00:00Z");
    const sendsBefore = mailboxSends.length;
    const approved = await nurture.approveTouch(w0.touches[0]!.id, admin.id, { subject: "Held for Monday", body: w0.touches[0]!.body }, saturday, "working-hours");
    const w1 = await db.nurtureTouch.findUnique({ where: { id: w0.touches[0]!.id }, select: { status: true, sendAt: true, subject: true } });
    const expectedAt = p4.sendTimeFor(saturday, zone);
    ok("approved on a Saturday: held for the next working morning, nothing sent", !!approved.at && w1?.status === "SCHEDULED" && w1.sendAt?.toISOString() === expectedAt.toISOString() && mailboxSends.length === sendsBefore && w1.subject === "Held for Monday", { at: approved.at, status: w1?.status });
    const view4 = await view.nurtureCardData(w0.leadId, admin.id);
    const card4 = renderToStaticMarkup(createElement(NurtureCard, { data: view4 }));
    ok("  the card says when it goes, with Send now", card4.includes("is approved and goes") && card4.includes("Send now"));
    const early4 = await nurture.runNurture(new Date(expectedAt.getTime() - 60_000));
    ok("  the heartbeat before then sends nothing", (early4.sent ?? 0) === 0 && mailboxSends.length === sendsBefore);
    const due4 = await nurture.runNurture(new Date(expectedAt.getTime() + 60_000));
    const w2 = await db.nurtureTouch.findUnique({ where: { id: w0.touches[0]!.id }, select: { status: true } });
    ok("  then: sent as its owner, the next on the cadence", (due4.sent ?? 0) >= 1 && w2?.status === "SENT" && mailboxSends[mailboxSends.length - 1]?.subject === "Held for Monday", due4);
    const { e: n0 } = await fresh4("send now");
    const now4 = await nurture.approveTouch(n0.touches[0]!.id, admin.id, { subject: n0.touches[0]!.subject, body: n0.touches[0]!.body }, saturday, "now");
    ok("  “Send now” on a Saturday: sent at once", now4.at === null && (await db.nurtureTouch.findUnique({ where: { id: n0.touches[0]!.id }, select: { status: true } }))?.status === "SENT");

    section("12. The booking link, and a booking from it");
    const SLUG4 = `zz-nurture-${tag}`;
    const all4: [string, string][] = [["00:00", "23:59"]];
    await db.bookingPage.create({ data: { slug: SLUG4, title: `ZZ nurture booking ${tag}`, durationMinutes: 30, hostUserIds: [admin.id], hours: { "1": all4, "2": all4, "3": all4, "4": all4, "5": all4, "6": all4, "7": all4 }, daysAhead: 7, minNoticeHours: 1, online: true, createdById: admin.id } });
    const { lead: bl, e: b0 } = await fresh4("booking link");
    await actions.sendNurtureEmail({ touchId: b0.touches[0]!.id, subject: b0.touches[0]!.subject, body: b0.touches[0]!.body, when: "now" });
    const linked = mailboxSends[mailboxSends.length - 1];
    const linkRef = p4.bookingRef(b0.replyToken);
    ok("the email carries the owner's booking page, tied to the lead, above the sign-off", /\/book\/[a-z0-9-]+\?ref=/.test(linked?.html ?? "") && !!linked?.html.includes(`?ref=${linkRef}`) && (linked?.html ?? "").indexOf("pick a time") < (linked?.html ?? "").lastIndexOf(`<p>${admin.name}</p>`), (linked?.html ?? "").slice(Math.max(0, (linked?.html ?? "").indexOf("pick a time") - 40), (linked?.html ?? "").indexOf("pick a time") + 260));
    ok("  the email kept on the nurture without the link (none of it to Deskzo AI later)", !(await db.nurtureTouch.findUnique({ where: { id: b0.touches[0]!.id }, select: { body: true } }))?.body.includes("/book/"));
    const leadsBefore = await db.lead.count({ where: { companyId: company.id } });
    const shown4 = await bookingServer.publicBookingPage(SLUG4);
    const slot4 = (shown4?.days ?? []).flatMap((d) => d.slots)[0];
    const booked4 = slot4 ? await bookingServer.bookSlot(SLUG4, { start: slot4, name: "Ravi Zzkumar", email: contact.email!, answers: {}, ref: linkRef }, "203.0.113.9") : null;
    const be = await enrolmentOf(bl.id);
    const bookingRow = await db.booking.findFirst({ where: { page: { slug: SLUG4 } }, select: { leadId: true } });
    ok("booked from it: on that lead — no new lead made", !!booked4?.ok && bookingRow?.leadId === bl.id && (await db.lead.count({ where: { companyId: company.id } })) === leadsBefore, booked4 && !booked4.ok ? booked4.error : bookingRow);
    ok("  the nurture ends, its owner given a task to get ready", be?.status === "STOPPED" && /booked a meeting/.test(be.stopReason ?? "") && (await db.task.count({ where: { leadId: bl.id, title: { startsWith: "Get ready for the meeting" } } })) === 1, be?.stopReason);

    section("13. Replies, read");
    // Asked to stop: unsubscribed at once.
    const { e: u0 } = await fresh4("unsubscribe");
    nextRead = { kind: "UNSUBSCRIBE", summary: "Asks not to be emailed again." };
    replyPrompts.length = 0;
    await reply(u0.replyToken, "Please remove me from your list. Call +91 99999 11111 if needed.");
    const u1 = await enrolmentOf(u0.leadId);
    const consents = await db.contactConsent.findMany({ where: { contactId: contact.id, channel: "EMAIL" }, select: { status: true } });
    ok("“remove me”: unsubscribed from every email topic at once, the address suppressed", consents.length > 0 && consents.every((c) => c.status === "UNSUBSCRIBED") && (await db.suppression.count({ where: { scope: "EMAIL", value: contact.email!.toLowerCase() } })) === 1);
    ok("  the nurture stopped, said so, no task", u1?.status === "STOPPED" && /asked not to be emailed/.test(u1.stopReason ?? "") && (await db.task.count({ where: { leadId: u0.leadId } })) === 0, u1?.stopReason);
    ok("  what Deskzo AI read had no number in it", replyPrompts.length === 1 && !replyPrompts[0]!.includes("99999") && replyPrompts[0]!.includes("[number]"));
    const ur = await lastReply(u0.id);
    ok("  kept, with what was done", ur?.kind === "UNSUBSCRIBE" && /unsubscribed/.test(ur.acted ?? "") && !ur.answerBody);
    // Undo, for the cases after.
    await db.contactConsent.deleteMany({ where: { contactId: contact.id } });
    await db.suppression.deleteMany({ where: { scope: "EMAIL", value: { endsWith: "@zznurture.example.com" } } });

    // Not now, try in March: paused until then.
    const { e: p0 } = await fresh4("not now");
    nextRead = { kind: "NOT_NOW", summary: "Interested, but only after March.", resumeOn: "2027-03-01" };
    await reply(p0.replyToken, "Not now — please come back in March.");
    const p1 = await enrolmentOf(p0.leadId);
    const morning = p4.morningOf("2027-03-01", zone);
    ok("“try in March”: still on, picked up the first working morning of March", p1?.status === "ACTIVE" && p1.nextTouchAt?.toISOString() === morning.toISOString() && p1.touches.every((t) => t.status !== "WAITING"), p1?.nextTouchAt);
    ok("  kept: paused until then", /paused until/.test((await lastReply(p0.id))?.acted ?? ""));

    // An out-of-office naming the day they're back.
    const { e: o0 } = await fresh4("away");
    await db.nurtureEnrolment.update({ where: { id: o0.id }, data: { nextTouchAt: new Date(Date.now() + 86_400_000) } });
    nextRead = { kind: "OUT_OF_OFFICE", summary: "Away until 8 December.", resumeOn: "2026-12-08" };
    const oo = await reply(o0.replyToken, "I'm out of the office until 8 December.", { automated: "An automatic reply" });
    const o1 = await enrolmentOf(o0.leadId);
    ok("an out-of-office: still machine mail, the next email after they're back", oo === "automated" && o1?.status === "ACTIVE" && o1.nextTouchAt?.toISOString() === p4.morningOf("2026-12-08", zone).toISOString(), o1?.nextTouchAt);

    // Wants a call: handed back, an answer drafted and sent by the owner.
    const { e: c0 } = await fresh4("call me");
    nextRead = { kind: "CALL_ME", summary: "Wants a call tomorrow about 60 seats.", suggestedStage: "QUALIFIED", answer: { subject: "Re: a call", body: "Hi {{firstName}},\n\nHappy to — I'll call you tomorrow at 11.\n\n{{senderName}}" } };
    await reply(c0.replyToken, "Can you call me tomorrow? 60 seats.");
    const c1 = await enrolmentOf(c0.leadId);
    const cr = await lastReply(c0.id);
    ok("“call me”: ended, a task to call them back, the stage suggested, an answer drafted", c1?.status === "STOPPED" && (await db.task.count({ where: { leadId: c0.leadId, title: { startsWith: "Call Ravi Zzkumar back" } } })) === 1 && cr?.suggestedStage === "QUALIFIED" && !!cr.answerBody && !!cr.fromEmail);
    const card5 = renderToStaticMarkup(createElement(NurtureCard, { data: await view.nurtureCardData(c0.leadId, admin.id) }));
    ok("  the card: what it means, Move the lead to Qualified, the answer to send", card5.includes("Wants a call") && card5.includes("Move the lead to Qualified") && card5.includes("Send answer"));
    if (other) {
      actor = { id: other.id, name: other.name, email: other.email, role: other.role };
      ok("  somebody else can't send the answer", !(await actions.answerNurtureReply({ replyId: cr!.id, subject: "x", body: "Hi there, sure." })).ok);
      const otherCard = await view.nurtureCardData(c0.leadId, other.id);
      ok("  nor read it", otherCard.nurture?.replies.every((r) => r.answer === null) ?? true);
      asAdmin();
    }
    const answered = await actions.answerNurtureReply({ replyId: cr!.id, subject: "Re: a call", body: cr!.answerBody! });
    const am = mailboxSends[mailboxSends.length - 1];
    ok("  sent from the owner's mailbox to who wrote, the names filled", answered.ok && am?.to[0]?.email === contact.email && am.html.includes("Hi Ravi,") && !am.html.includes("{{"), answered);
    ok("  once only", !(await actions.answerNurtureReply({ replyId: cr!.id, subject: "Re: a call", body: cr!.answerBody! })).ok);

    // Points to somebody else; a sender not confirmed can't be answered from Deskzo.
    const { e: r0 } = await fresh4("wrong person");
    nextRead = { kind: "WRONG_PERSON", summary: "Says purchasing handles this.", suggestedName: "Priya", answer: { subject: "Thanks", body: "Hi {{firstName}}, thanks — I'll write to Priya. {{senderName}}" } };
    await reply(r0.replyToken, "Please talk to Priya, priya.p@zznurture.example.com, she handles purchasing.", { senderVerified: false });
    const rr = await lastReply(r0.id);
    ok("“talk to Priya”: her name and address kept, a task to add her", rr?.kind === "WRONG_PERSON" && rr.suggestedEmail === "priya.p@zznurture.example.com" && (await db.task.count({ where: { leadId: r0.leadId, title: { contains: "points to Priya" } } })) === 1);
    ok("  a sender not confirmed: answered from the owner's own inbox, not Deskzo", rr?.fromEmail === null && !(await actions.answerNurtureReply({ replyId: rr!.id, subject: "Thanks", body: "Hi there, thanks." })).ok);

    // Deskzo AI with nothing to say: as phase 3 — forwarded, ended, a task to answer.
    const { e: x0 } = await fresh4("unread");
    nextRead = null;
    await reply(x0.replyToken, "Thanks.");
    const x1 = await enrolmentOf(x0.leadId);
    ok("not read: ended as before, a task to answer", x1?.status === "STOPPED" && (await lastReply(x0.id))?.kind === "UNREAD" && (await db.task.count({ where: { leadId: x0.leadId, title: { startsWith: "Answer Ravi Zzkumar" } } })) === 1);

    section("14. Many at once, and by itself");
    const m1 = await makeLead("many one");
    await plan(m1.id);
    const m2 = await makeLead("many two");
    await plan(m2.id);
    const m3 = await makeLead("many no plan");
    const many = await actions.startNurtureMany([m1.id, m2.id, m3.id, m1.id]);
    ok("three chosen (one twice): two started, one needs a plan first", many.ok && many.data.started === 2 && many.data.needPlan === 1 && many.data.refused === 0, many);
    await actions.saveNurtureSettings({ enabled: true, perDay: 50, autoStart: true });
    const autoLead = await makeLead("auto hot");
    await plan(autoLead.id);
    const coldLead = await makeLead("auto cold");
    await db.researchPlan.create({ data: { key: `lead:${coldLead.id}`, companyId: company.id, leadId: coldLead.id, createdById: admin.id, plan: { fit: "COLD", fitReasons: [], summary: "x", steps: [], questions: [], email: { subject: "Hello there", body: "Hi {{firstName}},\n\nHello and thanks.\n\n{{senderName}}" }, tasks: {}, model: "zz", credits: 0 } } });
    await db.autoPlanRun.createMany({ data: [{ leadId: autoLead.id, status: "DONE", chargedToId: admin.id, at: new Date(Date.now() + 1000) }, { leadId: coldLead.id, status: "DONE", chargedToId: admin.id, at: new Date(Date.now() + 1000) }] });
    const autoRun = await nurture.runNurture(new Date(Date.now() + 5000));
    ok("auto-start on: the hot lead planned by itself is nurtured, the cold one isn't", (await enrolmentOf(autoLead.id))?.status === "ACTIVE" && !(await enrolmentOf(coldLead.id)) && (autoRun.started ?? 0) >= 1, autoRun);
    await actions.saveNurtureSettings({ enabled: true, perDay: 50, autoStart: false });
    const report4 = await nurture.nurtureReport();
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { NurtureSettings } = require("../src/components/settings/nurture-settings") as typeof import("../src/components/settings/nurture-settings");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const settingsView = await actions.getNurtureSettings();
    const settingsHtml = settingsView ? renderToStaticMarkup(createElement(NurtureSettings, { settings: settingsView })) : "";
    ok("Settings: the auto-start and booking-link switches, and replies by email and salesperson", settingsHtml.includes("Start by itself on hot and warm leads") && settingsHtml.includes("booking link") && settingsHtml.includes("Replies by email"));
    ok("the report: replies by email and by salesperson", report4.bySteps.length === 4 && report4.byOwner.some((o) => o.name === admin.name && o.sent > 0 && o.replies > 0), { steps: report4.bySteps, owners: report4.byOwner.length });

    section("15. Learning from what went (step 2)");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const drafts = require("../src/lib/ai/drafts") as typeof import("../src/lib/ai/drafts");
    const houseStyleLib = require("../src/lib/ai/house-style") as typeof import("../src/lib/ai/house-style");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const styleBefore = await houseStyleLib.houseStyle();
    await houseStyleLib.saveHouseStyle({ tone: "Warm and brief", signOff: "Warm regards, {{senderName}} — Team Zz", alwaysMention: "our 24x7 support", neverSay: "discounts", notes: "" }, admin.id);
    try {
      const { e: l0 } = await fresh4("learning");
      const draft0 = l0.touches[0]!;
      await actions.sendNurtureEmail({ touchId: draft0.id, subject: draft0.subject, body: draft0.body.replace("Thanks for asking", "Thank you for asking"), when: "now" });
      const rec0 = await db.aiDraftRecord.findUnique({ where: { kind_ref: { kind: "nurture.email", ref: draft0.id } } });
      ok("a draft sent with a few words changed: kept beside what went, lightly edited", rec0?.outcome === "LIGHT_EDIT" && rec0.draftBody === draft0.body && !!rec0.sentBody?.includes("Thank you for asking") && (rec0.changed ?? 0) > 0, { outcome: rec0?.outcome, changed: rec0?.changed });
      nextRead = { kind: "INTERESTED", summary: "Wants a quote.", answer: { subject: "Re: quote", body: "Hi {{firstName}}, I will send it today. {{senderName}}" } };
      await reply(l0.replyToken, "Please send a quote.");
      ok("  the customer answered it: marked", !!(await db.aiDraftRecord.findUnique({ where: { kind_ref: { kind: "nurture.email", ref: draft0.id } } }))?.repliedAt);
      const learnt = await drafts.examplesFor("nurture.email", 5);
      ok("  and it's now an example of what works — its company name taken out", learnt.some((x) => x.body.includes("Thank you for asking")) && !learnt.some((x) => x.body.includes(NAME)));
      const answerRow = await db.nurtureReply.findFirst({ where: { enrolmentId: l0.id }, orderBy: { createdAt: "desc" } });
      await actions.answerNurtureReply({ replyId: answerRow!.id, subject: "Re: quote", body: answerRow!.answerBody! });
      ok("  the drafted answer sent as written: kept as that", (await db.aiDraftRecord.findUnique({ where: { kind_ref: { kind: "nurture.answer", ref: answerRow!.id } } }))?.outcome === "AS_WRITTEN");
      const { e: s0 } = await fresh4("skip learning");
      await actions.skipNurtureEmail(s0.touches[0]!.id);
      ok("  a draft set aside: kept as that", (await db.aiDraftRecord.findUnique({ where: { kind_ref: { kind: "nurture.email", ref: s0.touches[0]!.id } } }))?.outcome === "SKIPPED");
      // The next draft: the house style in the instructions, the example in the prompt.
      const { e: n9 } = await fresh4("next draft");
      await actions.sendNurtureEmail({ touchId: n9.touches[0]!.id, subject: n9.touches[0]!.subject, body: n9.touches[0]!.body, when: "now" });
      await db.nurtureEnrolment.update({ where: { id: n9.id }, data: { nextTouchAt: new Date(Date.now() - 60_000) } });
      systems.length = 0;
      prompts.length = 0;
      await nurture.runNurture();
      ok("  the next draft: written to the house style", systems.some((x) => x.includes("house style") && x.includes("Warm and brief") && x.includes("Never say or promise: discounts")), systems[0]?.slice(-300));
      ok("  with this team's answered emails as examples", prompts.some((p) => p.includes("customers answered") && p.includes("Thank you for asking")));
    } finally {
      await db.aiHouseStyle.deleteMany({ where: { id: "global" } });
      if (styleBefore.tone || styleBefore.signOff || styleBefore.alwaysMention || styleBefore.neverSay || styleBefore.notes) await houseStyleLib.saveHouseStyle(styleBefore, admin.id);
    }
  } finally {
    copilotSettings.setTestSettings(null);
    mailer.setTestPlatformMailer(null);
    await db.nurtureSettings.deleteMany({});
    if (before) await db.nurtureSettings.create({ data: before });
    const leads = await db.lead.findMany({ where: { companyId: company.id }, select: { id: true } });
    const ownRefs = [
      ...(await db.nurtureTouch.findMany({ where: { enrolment: { lead: { companyId: company.id } } }, select: { id: true } })).map((t) => t.id),
      ...(await db.nurtureReply.findMany({ where: { enrolment: { lead: { companyId: company.id } } }, select: { id: true } })).map((r) => r.id),
    ];
    await db.aiDraftRecord.deleteMany({ where: { ref: { in: ownRefs } } }).catch(() => undefined);
    await db.aiFeedback.deleteMany({ where: { ref: { in: ownRefs } } }).catch(() => undefined);
    const ids = leads.map((l) => l.id);
    await db.task.deleteMany({ where: { leadId: { in: ids } } }).catch(() => undefined);
    await db.activity.deleteMany({ where: { leadId: { in: ids } } }).catch(() => undefined);
    await db.marketingMessage.deleteMany({ where: { contactId: contact.id } }).catch(() => undefined);
    await db.marketingMessage.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.bookingPage.deleteMany({ where: { slug: `zz-nurture-${tag}` } }).catch(() => undefined);
    await db.calendarEvent.deleteMany({ where: { title: { startsWith: `ZZ nurture booking ${tag}` } } }).catch(() => undefined);
    await db.suppression.deleteMany({ where: { scope: "EMAIL", value: { endsWith: "@zznurture.example.com" } } }).catch(() => undefined);
    await db.contactConsent.deleteMany({ where: { contactId: contact.id } }).catch(() => undefined);
    await db.notification.deleteMany({ where: { message: { contains: NAME } } }).catch(() => undefined);
    await db.researchPlan.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.lead.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.contact.deleteMany({ where: { id: contact.id } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: company.id } }).catch(() => undefined);
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? `All ${passes} nurture checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
