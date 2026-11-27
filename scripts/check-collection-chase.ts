/**
 * check:collection-chase — Arjun, the Collections teammate (owner, 19 Nov 2026 — phases 1 and 2;
 * src/lib/collections/chase.ts and chase-server.ts).
 *
 *   · Who to chase today, by rules: a broken promise first and by phone; a promise still ahead, a paused customer or
 *     nothing late left out; a promise due today to be checked; somebody emailed yesterday pushed down; a good payer gone
 *     quiet called.
 *   · The call brief, the tone, the amounts an email may say, where the invoices go, the email as text and HTML, the
 *     reply-to address, a reply's own words and what Arjun's reading keeps.
 *   · On a workspace, with its own customer (Zz Chase …): a draft — the model sees amounts and what was said, never a
 *     person's name or address, and an email naming an amount not in the books is written again; sending from the
 *     person's mailbox with the chase's reply-to, the invoices listed, each noted as followed up; the schedule leaving
 *     them alone for five days; a reply through the signed door, forwarded; Arjun reading it on the heartbeat; the
 *     promise logged from it; a dispute pausing reminders with a task.
 *
 * Nothing leaves: Deskzo AI, the mailbox and Deskzo's own mail are stand-ins.
 *
 *   npm run check:collection-chase
 */
import "dotenv/config";
import Module from "node:module";
import { createHmac, randomUUID } from "node:crypto";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

process.env.INBOUND_MAIL_DOMAIN = "zz-inbound.test";
process.env.INBOUND_MAIL_SECRET = "zz-chase-secret-0123456789abcdef";
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
const prompts: { feature: string; text: string }[] = [];
const emailAnswers: { subject: string; body: string }[] = [];
let readingAnswer: Record<string, unknown> = {};
let refuseNext = false;
const gateway = {
  AiRefusal,
  aiService: async () => ({ model: "Zz Model", residency: "Zzland", noTraining: true }),
  aiUnavailable: async () => null,
  aiTurn: async (turn: { feature: string; history: { role: string; text?: string }[] }) => {
    if (refuseNext) {
      refuseNext = false;
      throw new AiRefusal("This workspace has used all its Deskzo AI credits. They renew on 1 Dec.");
    }
    prompts.push({ feature: turn.feature, text: turn.history.filter((h) => h.role === "user").map((h) => h.text ?? "").join("\n") });
    const reply = turn.feature === "collections.reply";
    const input = reply ? readingAnswer : (emailAnswers.shift() ?? { subject: "Payment due", body: "Dear {{firstName}},\n\nPlease see the invoices below.\n\n{{invoices}}\n\nRegards,\n{{senderName}}" });
    const name = reply ? "propose_reading" : "propose_email";
    return { text: "", toolCalls: [{ id: randomUUID(), name, input }], native: null, usage: { input: 1, output: 1 }, stop: "tools", model: "zz", family: "BEDROCK", modelKey: "zz", charge: { credits: 1 } };
  },
};
type Out = { subject: string; html: string; to: { name: string | null; email: string }[]; replyTo?: { name: string | null; email: string } };
const mailboxSends: Out[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  // An open dialog portals into the page's document, which a render on the server hasn't: its contents drawn in place.
  if (request === "@/components/ui/dialog" || request.endsWith("/components/ui/dialog")) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createElement } = require("react") as typeof import("react");
    return { Dialog: ({ open, title, children }: { open: boolean; title: string; children: unknown }) => (open ? createElement("div", { "data-dialog": title }, children as never) : null) };
  }
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/collections",
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
  // The person's documents go from their own mailbox here, whatever the workspace's choice: nothing reaches a real server.
  if (request === "@/lib/documents/mail-route" || request.endsWith("/lib/documents/mail-route")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, documentSender: async () => ({ mode: "OWN", choice: "OWN", from: "owner@zz-own.test — your Gmail", company: null }) };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const DAY = 86_400_000;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const c = require("../src/lib/collections/chase") as typeof import("../src/lib/collections/chase");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("1. Who to chase today — by rules");
  const today = new Date("2026-11-19T00:00:00Z");
  const now = new Date("2026-11-19T06:00:00Z");
  const ago = (n: number) => new Date(now.getTime() - n * DAY);
  type Facts = import("../src/lib/collections/chase").CompanyFacts;
  const due = (id: string, inr: number, late: number, promise: Facts["dues"][number]["promise"] = null): Facts["dues"][number] => ({
    id,
    kind: "invoice",
    label: `INV-${id}`,
    dueOn: new Date(today.getTime() - late * DAY),
    daysLate: late,
    balance: inr,
    currency: "INR",
    balanceInr: inr,
    promise,
  });
  const facts = (name: string, dues: Facts["dues"], extra: Partial<Facts> = {}): Facts => ({
    companyId: name,
    companySeq: 1,
    companyName: name,
    ownerName: null,
    onTheirAccount: true,
    dues,
    lastFollowUp: null,
    plannedOn: null,
    promisesKept: 0,
    promisesBroken: 0,
    paused: null,
    lastReminderAt: null,
    lastChaseAt: null,
    usualDaysLate: null,
    ...extra,
  });
  const list = [
    facts("A", [due("a1", 50_000, 20)]),
    facts("B", [due("b1", 200_000, 10, { on: "2026-11-15", amount: 200_000, now: "broken" })]),
    facts("C", [due("c1", 900_000, 60)], { paused: { reason: "Disputed" } }),
    facts("D", [due("d1", 80_000, 12, { on: "2026-11-25", amount: null, now: "ahead" })]),
    facts("E", [due("e1", 30_000, 5, { on: "2026-11-19", amount: 30_000, now: "today" })]),
    facts("F", [due("f1", 40_000, 15)], { lastChaseAt: ago(1) }),
    facts("G", [due("g1", 60_000, 20)], { usualDaysLate: 2 }),
    facts("H", [due("h1", 70_000, -5)]),
  ];
  const ranked = c.rankChases(list, today, now);
  const at = (id: string) => ranked.find((r) => r.companyId === id);
  ok("a broken promise comes first, by phone, saying so", ranked[0]?.companyId === "B" && at("B")?.action === "CALL" && at("B")!.reasons.some((r) => /Promised .* by 15 Nov — it didn't come/.test(r)), ranked.map((r) => r.companyId));
  ok("paused, a promise still ahead, and nothing late: not listed", !at("C") && !at("D") && !at("H"));
  ok("a promise due today: check it came in", at("E")?.action === "CHECK" && at("E")!.reasons.some((r) => /today — check it came in/.test(r)));
  ok("emailed yesterday: said, pushed below one not touched, and called rather than emailed again", at("F")!.reasons.includes("Emailed yesterday") && at("F")!.score < at("A")!.score && at("F")!.action === "CALL");
  ok("a good payer gone quiet: called, and said why", at("G")?.action === "CALL" && at("G")!.reasons.includes("Usually pays on time — this isn't like them"));
  ok("an ordinary late invoice: an email", at("A")?.action === "EMAIL" && at("A")!.reasons[0] === "₹50,000 overdue on 1 invoice, the oldest 20 days late", at("A")?.reasons);
  ok("amounts said short, in lakhs", c.shortMoney(320_000, "INR") === "₹3.2L" && c.shortMoney(12_500_000, "INR") === "₹1.3Cr" && c.shortMoney(45_000, "INR") === "₹45,000");

  section("2. The call brief and the tone");
  const brief = c.callBrief(list[1]!, today, now);
  ok("the brief: what's owed, and asking about the broken promise", /₹2L owed, ₹2L of it overdue/.test(brief.headline) && /promised .* by 15 Nov/.test(brief.ask) && brief.ask.includes("INV-b1"), brief);
  const plain = c.callBrief(facts("P", [due("p1", 120_000, 41), due("p2", 30_000, 3)], { lastFollowUp: { at: ago(9), channel: "CALL", remarks: "Waiting for HO approval", byName: "Asha" }, usualDaysLate: 35 }), today, now);
  ok("  and for an ordinary one: ask for the overdue in three days (never a Sunday), the last thing they said, how they pay", /^Ask for ₹1\.5L \(INV-p1, INV-p2\) by Monday, 23 Nov/.test(plain.ask) && plain.lines.some((l) => l.text.includes("Waiting for HO approval")) && plain.lines.some((l) => l.text.includes("about 35 days after")), plain);
  ok("the tone: a broken promise, then final after 45 days, firm after 15, else gentle", c.toneFor(list[1]!) === "broken" && c.toneFor(facts("x", [due("x", 1, 50)])) === "final" && c.toneFor(facts("x", [due("x", 1, 20)])) === "firm" && c.toneFor(facts("x", [due("x", 1, 3)])) === "gentle");

  section("3. The email's words");
  const allowed = ["₹1,20,000.00", "₹30,000.00"];
  ok("an amount from the books is allowed, in any grouping", c.strayAmounts("Please pay ₹1,20,000 and Rs. 30,000.00 — 41 days late.", allowed).length === 0);
  ok("  one that isn't, or said in lakhs, is caught", c.strayAmounts("Pay ₹1,50,000 now", allowed).join() === "₹1,50,000" && c.strayAmounts("about 1.2 lakh", allowed).length === 1);
  ok("the invoices go before the sign-off when the model left them out", c.withInvoicesPlace("Dear {{firstName}},\n\nPlease pay.\n\nRegards,\n{{senderName}}").includes("Please pay.\n\n{{invoices}}\n\nRegards,"));
  const lines = [{ number: "INV-1", due: "3 Oct 2026", late: "47 days late", balance: "₹1,20,000.00", payUrl: "https://pay.test/x" }];
  const text = c.chaseText("Dear {{firstName}},\n\nSee below.\n\n{{invoices}}\n\nRegards,\n{{senderName}}", { names: "Ravi and Asha", senderName: "Neha" }, lines, "Interest line.");
  ok("as text: names, the invoices with their pay links, the sign-off, the note under it", text.startsWith("Dear Ravi and Asha,") && text.includes("INV-1 · due 3 Oct 2026 · 47 days late · ₹1,20,000.00 — pay online: https://pay.test/x") && text.includes("Regards,\nNeha") && text.endsWith("Interest line."));
  const html = c.chaseHtml("Dear {{firstName}},\n\n<script>x</script>\n\n{{invoices}}\n\nRegards,\n{{senderName}}", { names: "Ravi", senderName: "Neha" }, lines, null);
  ok("as HTML: escaped, the invoices a table with Pay now", !html.includes("<script>") && html.includes("&lt;script&gt;") && html.includes('<a href="https://pay.test/x">Pay now</a>'));
  ok("scrubbed before the model: email addresses and phone numbers", c.scrubRemarks("Call ravi@acme.com or +91 98765 43210 tomorrow") === "Call [email] or [phone] tomorrow");
  const token = "0123456789abcdef01234567";
  ok("the reply-to address reads back; a nurture's doesn't", c.chaseTokenOf(c.chaseReplyAddress("wroffy", token, "tickets.deskzo.com").toUpperCase()) === token && c.chaseTokenOf(`wroffy+n-${token}@tickets.deskzo.com`) === null);
  ok("a reply's own words, without the email it quotes", c.stripQuoted("Will pay Friday.\n\nOn Tue, 18 Nov 2026 at 10:00, Neha wrote:\n> Dear Ravi\n> please pay") === "Will pay Friday.");
  const read = c.settleReading(
    { kind: "PROMISE", summary: "They will pay next Friday.", promisedOn: "2026-11-28", promisedAmount: 120000, invoices: ["inv-1", "INV-9"] },
    today,
    [{ id: "i1", number: "INV-1" }],
  );
  ok("a reading kept where it holds: the promised day, the amount, the invoice it names among those emailed", read.promisedOn?.toISOString().slice(0, 10) === "2026-11-28" && read.promisedAmount === 120000 && read.documentIds.join() === "i1");
  const past = c.settleReading({ kind: "PROMISE", summary: "x x x", promisedOn: "2026-11-01" }, today, []);
  const future = c.settleReading({ kind: "PAID", summary: "x x x", paidOn: "2026-12-01", reference: "UTR 123" }, today, []);
  ok("  a promised day already gone, or a payment dated ahead, is dropped — not guessed", past.promisedOn === null && future.paidOn === null && future.reference === "UTR 123");

  section("4. On a workspace");
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const server = require("../src/lib/collections/chase-server") as typeof import("../src/lib/collections/chase-server");
  const actions = require("../src/actions/collection-chase") as typeof import("../src/actions/collection-chase");
  const copilotSettings = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
  const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { currentTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  const { receiveInbound } = require("../src/lib/support-mail/inbound") as typeof import("../src/lib/support-mail/inbound");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const forwarded: { to: string; subject: string; text: string; replyTo?: string }[] = [];
  mailer.setTestPlatformMailer(async (m) => {
    forwarded.push({ to: m.to, subject: m.subject, text: m.text, replyTo: m.replyTo });
  });
  copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: null });

  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  if (!admin) throw new Error("no super admin");
  actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
  const slug = (await currentTenant()).slug;
  const clock = await workspaceClock();
  const wsToday = clock.calendarDate(new Date());
  const day = (n: number) => new Date(wsToday.getTime() + n * DAY);

  const tag = randomUUID().slice(0, 6);
  const NAME = `Zz Chase ${tag} Pvt Ltd`;
  const company = await db.company.create({ data: { name: NAME, normalizedName: NAME.toLowerCase(), createdById: admin.id, ownerUserId: admin.id }, select: { id: true } });
  const contact = await db.contact.create({
    data: { companyId: company.id, name: "Ravi Zzkumar", email: `ravi.${tag}@zzchase.example.com`, phone: "+919876543210", designation: "IT_MANAGER", isPrimary: true, receivesDocuments: true, createdByUserId: admin.id },
    select: { id: true, email: true },
  });
  let n = 0;
  const invoice = (total: number, issued: number, dueIn: number) =>
    db.tradeDocument.create({
      data: { docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: company.id, docNumber: `ZZCH-${tag}-${++n}`, taxableValue: total, total, createdById: admin.id, issueDate: day(issued), dueDate: day(dueIn) } as never,
      select: { id: true, docNumber: true },
    });
  const tasksBefore = await db.task.count({ where: { companyId: company.id } });
  const morningCompanies: string[] = [];

  try {
    const old = await invoice(118_000, -70, -40);
    const newer = await invoice(23_600, -25, -10);
    const ahead = await invoice(5_900, -2, 20);
    await db.paymentFollowUp.create({ data: { companyId: company.id, documentId: old.id, byUserId: admin.id, channel: "CALL", remarks: `Said HO approval pending; call ravi.${tag}@zzchase.example.com or 98765 43210` } });

    const f = await server.factsOf(admin.id, company.id);
    ok("their facts: three invoices, the follow-up, nothing paused", f?.dues.length === 3 && f.lastFollowUp?.channel === "CALL" && !f.paused, f?.dues.length);
    const mine = c.rankChases([f!], wsToday, new Date())[0];
    ok("  ranked: two overdue invoices, an email", mine?.action === "EMAIL" && /^₹1\.4L overdue on 2 invoices, the oldest 40 days late/.test(mine.reasons[0] ?? ""), mine?.reasons);
    const started = Date.now();
    const listed = await server.chaseListFor(admin.id);
    ok("the whole list for somebody who sees everything, read in two passes", Array.isArray(listed.items) && listed.items.length <= 8, `${listed.items.length} of ${listed.considered} in ${Date.now() - started} ms`);
    console.log(`        (${listed.considered} customers owing, listed in ${Date.now() - started} ms)`);

    // Drafting: the first answer names an amount that isn't in the books, the second keeps to them.
    prompts.length = 0;
    emailAnswers.push(
      { subject: "Overdue: ₹9,99,999", body: "Dear {{firstName}},\n\nPlease pay ₹9,99,999 today.\n\nRegards,\n{{senderName}}" },
      { subject: "Two invoices past due", body: "Dear {{firstName}},\n\nTwo of our invoices are now past due — details below.\n\n{{invoices}}\n\nCould you let us know when it will be paid?\n\nRegards,\n{{senderName}}" },
    );
    const drafted = await actions.draftChaseEmail({ companyId: company.id });
    ok("a draft, after the one naming an amount not in the books was written again", drafted.ok && drafted.data.subject === "Two invoices past due" && prompts.filter((p) => p.feature === "collections.email").length === 2, drafted.ok ? drafted.data.subject : drafted.error);
    const sent0 = prompts[0]?.text ?? "";
    ok("  the model saw the overdue invoices, the tone and what they said — scrubbed", sent0.includes(old.docNumber!) && sent0.includes(newer.docNumber!) && !sent0.includes(`${ahead.docNumber} `) && /Tone: Firm/.test(sent0) && sent0.includes("HO approval pending") && sent0.includes("[email]") && sent0.includes("[phone]"), sent0);
    ok("  and never a person's name or address", !sent0.includes("Ravi") && !sent0.includes(contact.email!) && !sent0.includes(admin.email));
    const view = drafted.ok ? drafted.data : null;
    ok("the draft as the dialog shows it: the two invoices, the contact ticked, from their mailbox", view?.lines.length === 2 && view.recipients.some((r) => r.id === contact.id && r.ticked) && !view.fromProblem, view);

    // A second draft for the same customer sets the first aside.
    emailAnswers.push({ subject: "Payment reminder", body: "Dear {{firstName}},\n\nA reminder about the invoices below.\n\n{{invoices}}\n\nRegards,\n{{senderName}}" });
    const second = await actions.draftChaseEmail({ companyId: company.id, tone: "gentle" });
    const firstNow = await db.collectionChase.findUnique({ where: { id: view!.id }, select: { status: true } });
    ok("a newer draft for them sets the earlier one aside", second.ok && second.data.tone === "gentle" && firstNow?.status === "DISCARDED");
    const waiting = await server.arjunWaiting(admin.id);
    ok("  one draft waiting, for Today", waiting.drafts >= 1);

    // The screens, drawn on the server as a browser would get them (no session needed — the person is the stand-in's).
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
    const { createElement } = require("react") as typeof import("react");
    const CollectionsPage = (require("../src/app/(dashboard)/collections/page") as { default: (p: unknown) => Promise<unknown> }).default;
    const { TodayView } = require("../src/components/today/today-view") as typeof import("../src/components/today/today-view");
    const { ChaseDialog } = require("../src/components/collections/chase-dialog") as typeof import("../src/components/collections/chase-dialog");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const mine2 = await actions.arjunForMe();
    // What crosses into the client components must be plain: no Decimal or other class (node-renders-miss-client-boundary).
    const plainOnly = (v: unknown, path = "data"): string | null => {
      if (v === null || typeof v !== "object") return null;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== Array.prototype && !(v instanceof Date)) return path;
      for (const [k, x] of Object.entries(v)) {
        const bad = plainOnly(x, `${path}.${k}`);
        if (bad) return bad;
      }
      return null;
    };
    ok("Arjun's part of My collections: plain data for the panel, the customer listed, the draft waiting", !!mine2 && plainOnly(mine2) === null && mine2.waiting.some((w) => w.companyName === NAME) && mine2.mayDraft, plainOnly(mine2));
    const page = await renderHtml(CollectionsPage({ searchParams: Promise.resolve({ q: NAME }) }));
    ok("  My collections draws the panel: who to chase, the call brief, drafting, the draft to check", page.includes("Who to chase today") && page.includes("Call brief") && page.includes("Draft email") && page.includes("Drafts to check") && page.includes("Payment reminder"), page.slice(0, 300));
    const todayHtml = await renderHtml(
      createElement(TodayView, {
        today: { date: "2026-11-19", attendance: null, location: null, tasks: null, approvals_waiting: 0, approvals_by_kind: {}, approvals_more: false, leave: null } as never,
        greeting: "Good morning",
        zone: "Asia/Kolkata",
        approvals: false,
        newLead: false,
        chases: { items: [{ id: company.id, companyName: NAME, action: "EMAIL", reasons: "₹1.4L overdue on 2 invoices" }], drafts: 1, replies: 0 },
      }),
    );
    ok("  Today: Arjun on the team card, and the payments to chase", todayHtml.includes("Payments to chase") && todayHtml.includes(NAME) && /drafted 1 chase email/.test(todayHtml), todayHtml.slice(0, 300));
    const dialog = await renderHtml(createElement(ChaseDialog, { view: second.ok ? second.data : view!, onClose: () => {} }));
    ok("  the draft dialog: the subject, the invoices, the contact ticked, Send", dialog.includes(old.docNumber!) && dialog.includes("ravi.") && dialog.includes("Send") && dialog.includes("Write again"), dialog.slice(0, 300));

    // Sending.
    mailboxSends.length = 0;
    const send = await actions.sendChaseEmail({ id: second.ok ? second.data.id : "", subject: "Payment reminder", body: second.ok ? second.data.body : "", contactIds: [contact.id], attachStatement: false });
    const chase = await db.collectionChase.findFirst({ where: { companyId: company.id, status: "SENT" }, select: { id: true, replyToken: true, documentIds: true } });
    const m = mailboxSends[0];
    ok("sent from their mailbox to the contact", send.ok && mailboxSends.length === 1 && m?.to[0]?.email === contact.email, send.ok ? send.data : send.error);
    ok("  replies to the workspace's address with the chase's secret", m?.replyTo?.email === `${slug}+c-${chase?.replyToken}@zz-inbound.test`, m?.replyTo);
    ok("  'Dear Ravi', and the two invoices listed — not the one not yet due", !!m && m.html.includes("Dear Ravi,") && m.html.includes(old.docNumber!) && m.html.includes(newer.docNumber!) && !m.html.includes(ahead.docNumber!));
    const notes = await db.paymentFollowUp.findMany({ where: { companyId: company.id, channel: "EMAIL" }, select: { documentId: true, remarks: true } });
    ok("each invoice in it noted as followed up by email", notes.length === 2 && notes.every((x) => /Chase email sent by .* \(drafted by Arjun\)/.test(x.remarks)));
    ok("in the mail log", (await db.marketingMessage.count({ where: { companyId: company.id, contactId: contact.id, status: "SENT" } })) === 1);
    ok("the reminder schedule leaves them alone for five days", (await server.recentlyChased([company.id])).has(company.id) && !(await server.recentlyChased([company.id], new Date(Date.now() + 6 * DAY))).has(company.id));
    const again = await actions.sendChaseEmail({ id: chase!.id, subject: "x x x", body: "y".repeat(30), contactIds: [contact.id], attachStatement: false });
    ok("  and it can't be sent twice", !again.ok && /sent already/.test(again.ok ? "" : again.error));

    // A reply through the signed door.
    const senderDomain = contact.email!.split("@")[1]!;
    const post = (words: string, extraHeaders: string[] = []) => {
      const to = `${slug}+c-${chase!.replyToken}@zz-inbound.test`;
      const raw = [
        `From: Ravi Zzkumar <${contact.email}>`,
        `To: ${to}`,
        "Subject: Re: Payment reminder",
        `Message-ID: <${randomUUID()}@zzchase.example.com>`,
        "Date: Thu, 19 Nov 2026 10:00:00 +0530",
        ...extraHeaders,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        words,
        "",
      ].join("\r\n");
      const auth = { authservId: "mx.cloudflare.net", dmarc: "pass", dmarcDomain: senderDomain, dkim: [{ result: "pass", domain: senderDomain }], spf: "pass" };
      const body = JSON.stringify({ recipient: to, sender: contact.email, raw: Buffer.from(raw).toString("base64"), auth });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", process.env.INBOUND_MAIL_SECRET!).update(`${timestamp}.${body}`).digest("hex");
      return receiveInbound(body, new Headers({ "x-deskzo-timestamp": timestamp, "x-deskzo-signature": signature }));
    };
    forwarded.length = 0;
    const promised = day(7).toISOString().slice(0, 10);
    const answer = await post(`We will clear ${old.docNumber} by next week.\n\nOn Thu, Neha wrote:\n> Dear Ravi`);
    const reply = await db.collectionReply.findFirst({ where: { chaseId: chase!.id }, orderBy: { createdAt: "desc" } });
    ok("a reply the mail worker posts: kept for Arjun, not made a ticket", answer.status === 200 && answer.body.result === undefined && reply?.reading === null && reply.text === `We will clear ${old.docNumber} by next week.`, answer);
    ok("  forwarded to whoever sent the email, answering going to the customer", forwarded.length === 1 && forwarded[0]!.to === admin.email && forwarded[0]!.replyTo === contact.email);
    const ooo = await post("I am out of the office until Monday.", ["Auto-Submitted: auto-replied"]);
    ok("an out-of-office: dropped", ooo.status === 200 && (await db.collectionReply.count({ where: { chaseId: chase!.id } })) === 1);

    // Arjun reads it on the heartbeat.
    readingAnswer = { kind: "PROMISE", summary: "They will clear it by next week.", promisedOn: promised, invoices: [old.docNumber] };
    const readRun = await server.readChaseReplies();
    const readOne = await db.collectionReply.findUnique({ where: { id: reply!.id } });
    ok("read on the heartbeat: a promise, by the day, on the invoice it names", readRun.read >= 1 && readOne?.reading === "PROMISE" && readOne.promisedOn?.toISOString().slice(0, 10) === promised && readOne.documentIds.join() === old.id, readOne);
    const readPrompt = prompts.find((p) => p.feature === "collections.reply")?.text ?? "";
    ok("  the model read their words, without the email they quoted", readPrompt.includes("by next week") && !readPrompt.includes("Dear Ravi"));
    const told = await db.notification.findFirst({ where: { userId: admin.id, message: NAME }, orderBy: { createdAt: "desc" }, select: { title: true } });
    ok("  and says so, in Arjun's voice", /^Arjun: Ravi Zzkumar replied: They will clear it by next week — they'll pay by/.test(told?.title ?? ""), told?.title);
    const replies = await server.repliesFor(admin.id);
    const rv = replies.find((r) => r.id === reply!.id);
    ok("the reply waiting in My collections, with its invoice", rv?.reading === "PROMISE" && rv.invoices.map((i) => i.id).join() === old.id);

    const logged = await actions.actOnChaseReply({ replyId: reply!.id, action: "promise", promisedOn: promised, documentIds: [old.id] });
    const promise = await db.paymentFollowUp.findFirst({ where: { documentId: old.id, promiseStatus: "OPEN" }, select: { promisedOn: true, channel: true, remarks: true } });
    ok("the promise logged from it, as any follow-up — tracked, and the reminders wait for it", logged.ok && promise?.promisedOn?.toISOString().slice(0, 10) === promised && promise.channel === "EMAIL" && promise.remarks.includes("They will clear it"), logged.ok ? logged.data : logged.error);
    ok("  the reply closed", (await db.collectionReply.findUnique({ where: { id: reply!.id }, select: { status: true } }))?.status === "DONE");
    const twice = await actions.actOnChaseReply({ replyId: reply!.id, action: "dismiss" });
    ok("  and can't be acted on twice", !twice.ok);

    // A dispute.
    await post("The amount on the second invoice is wrong — we ordered 10 licences, not 12.");
    readingAnswer = { kind: "DISPUTE", summary: "They say the second invoice charges for 12 licences, not 10.", detail: "12 licences billed, 10 ordered", invoices: [newer.docNumber] };
    await server.readChaseReplies();
    const dispute = await db.collectionReply.findFirst({ where: { chaseId: chase!.id, reading: "DISPUTE" } });
    const acted = await actions.actOnChaseReply({ replyId: dispute!.id, action: "dispute" });
    const pause = await db.paymentReminderPause.findUnique({ where: { companyId: company.id } });
    ok("a dispute: reminders paused, saying why, and a task to sort it out", acted.ok && /Disputed by email: 12 licences billed, 10 ordered/.test(pause?.reason ?? "") && (await db.task.count({ where: { companyId: company.id } })) === tasksBefore + 1, acted.ok ? acted.data : acted.error);
    emailAnswers.push({ subject: "x x x", body: "Dear {{firstName}},\n\nPlease pay.\n\n{{invoices}}\n\nRegards,\n{{senderName}}" });
    const whilePaused = await actions.draftChaseEmail({ companyId: company.id });
    ok("  and while they're paused, Arjun won't draft to them", !whilePaused.ok && /paused/.test(whilePaused.ok ? "" : whilePaused.error));

    const unknownToken = await (async () => {
      const raw = ["From: x@zz.example.com", `To: ${slug}+c-ffffffffffffffffffffffff@zz-inbound.test`, "Subject: hi", "", "hello", ""].join("\r\n");
      const body = JSON.stringify({ recipient: `${slug}+c-ffffffffffffffffffffffff@zz-inbound.test`, sender: "x@zz.example.com", raw: Buffer.from(raw).toString("base64"), auth: {} });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", process.env.INBOUND_MAIL_SECRET!).update(`${timestamp}.${body}`).digest("hex");
      return receiveInbound(body, new Headers({ "x-deskzo-timestamp": timestamp, "x-deskzo-signature": signature }));
    })();
    ok("a secret nobody has: on to the helpdesk as any email, not lost", unknownToken.status === 200 || unknownToken.status === 404, unknownToken);

    section("5. By himself — the morning drafts, the Monday note, the settings");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const auto = require("../src/lib/collections/arjun-auto") as typeof import("../src/lib/collections/arjun-auto");
    const settingsActions = require("../src/actions/arjun-settings") as typeof import("../src/actions/arjun-settings");
    const { ArjunSettings } = require("../src/components/settings/arjun-settings") as typeof import("../src/components/settings/arjun-settings");
    /* eslint-enable @typescript-eslint/no-require-imports */
    // A working morning at ten, on the workspace's clock — tomorrow when today is a Sunday.
    let morning = new Date((clock.startOfDay(clock.today(new Date())) ?? new Date()).getTime() + 10 * 3_600_000);
    if (clock.parts(morning).weekday === 0) morning = new Date(morning.getTime() + DAY);
    const mDay = clock.calendarDate(morning);
    const mAgo = (n: number) => new Date(mDay.getTime() - n * DAY);
    const t0 = new Date();
    const fixture = async (label: string, owner: string | null, lateDays: number, total: number) => {
      const nm = `${NAME} ${label}`;
      const co = await db.company.create({ data: { name: nm, normalizedName: nm.toLowerCase(), createdById: admin.id, ownerUserId: owner }, select: { id: true } });
      morningCompanies.push(co.id);
      await db.contact.create({ data: { companyId: co.id, name: `Asha ${label}`, email: `asha.${label.toLowerCase()}.${tag}@zzchase.example.com`, isPrimary: true, receivesDocuments: true, createdByUserId: admin.id } });
      await db.tradeDocument.create({
        data: { docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: co.id, docNumber: `ZZCH-${tag}-${++n}`, taxableValue: total, total, createdById: admin.id, issueDate: mAgo(lateDays + 30), dueDate: mAgo(lateDays) } as never,
      });
      return co.id;
    };
    const hard = await fixture("Hard", admin.id, 40, 236_000);
    const soft = await fixture("Soft", admin.id, 5, 11_800);
    const nobody = await fixture("Nobody", null, 60, 59_000);

    const before5 = await db.collectionAgentSettings.findUnique({ where: { id: "global" } });
    await db.collectionAgentSettings.deleteMany({});
    ok("off until an admin switches it on", (await auto.runArjunMorning(morning)).reason === "off" && (await auto.runArjunWeekly(morning)).reason === "off");
    const bad = await settingsActions.saveArjunSettings({ enabled: true, perDay: 0, minDaysLate: 15, minAmount: 0, brokenAlways: true, weeklyTo: [] });
    ok("  a day's limit of nought refused, in words", !bad.ok && /Drafts a day/.test(bad.ok ? "" : bad.error));
    const saved = await settingsActions.saveArjunSettings({ enabled: true, perDay: 50, minDaysLate: 15, minAmount: 1000, brokenAlways: true, weeklyTo: [admin.id, "not-a-person"] });
    ok("switched on: the note's people only those who follow payments up; on since now, charged to whoever switched it on", saved.ok && saved.data.weeklyTo.join() === admin.id && saved.data.people.some((p) => p.id === admin.id) && (await auto.arjunConfig()).enabledById === admin.id, saved.ok ? saved.data.weeklyTo : saved.error);

    // The day's list: made directly here, so a run against this full workspace drafts only this suite's own customers.
    await db.dailyJobRun.deleteMany({ where: { job: { in: ["arjun-morning", "arjun-weekly"] }, day: mDay } });
    await db.dailyJobRun.create({ data: { job: "arjun-morning", day: mDay, ranAt: morning } });
    const already = new Set((await db.collectionAutoRun.findMany({ where: { day: mDay }, select: { id: true } })).map((r) => r.id));
    await auto.queueMorning({ perDay: 200, minDaysLate: 15, minAmount: 1000, brokenAlways: true }, mDay, morning);
    const queued = await db.collectionAutoRun.findMany({ where: { day: mDay, companyId: { in: morningCompanies } }, select: { companyId: true, forUserId: true, status: true } });
    ok("the morning's list: the hard case, for its account manager — not the one 5 days late, not the one with nobody to see it", queued.length === 1 && queued[0]!.companyId === hard && queued[0]!.forUserId === admin.id && !queued.some((q) => q.companyId === soft || q.companyId === nobody), queued);
    // Everybody else's from this workspace set aside, so only the suite's own customer is drafted.
    await db.collectionAutoRun.deleteMany({ where: { day: mDay, id: { notIn: [...already] }, companyId: { notIn: morningCompanies } } });

    prompts.length = 0;
    emailAnswers.push({ subject: "Your account with us", body: "Dear {{firstName}},\n\nAn invoice of ours is well past due.\n\n{{invoices}}\n\nRegards,\n{{senderName}}" });
    const ran = await auto.runArjunMorning(morning);
    const run = await db.collectionAutoRun.findFirst({ where: { day: mDay, companyId: hard } });
    const draft = run?.chaseId ? await db.collectionChase.findUnique({ where: { id: run.chaseId }, select: { status: true, createdById: true, tone: true } }) : null;
    ok("drafted by himself into the account manager's drafts — waiting, not sent", ran.drafted === 1 && run?.status === "DRAFTED" && draft?.status === "WAITING" && draft.createdById === admin.id && draft.tone === "firm" && run.chargedTo === admin.id, { ran, run, draft });
    ok("  no email went anywhere", mailboxSends.length === 1);
    const shown = await server.waitingChasesFor(admin.id, morning);
    ok("  in their Drafts to check, marked as his own morning's", shown.some((w) => w.id === run!.chaseId && w.auto));
    const toldMorning = await db.notification.findFirst({ where: { userId: admin.id, createdAt: { gte: t0 }, title: { contains: "this morning" } }, select: { title: true } });
    ok("  and he says so, once the morning's are done", /^Arjun: I've drafted 1 chase email for you this morning/.test(toldMorning?.title ?? ""), toldMorning?.title);
    ok("the next heartbeat drafts nothing more", (await auto.runArjunMorning(morning)).drafted === 0);

    // Deskzo AI saying no: the rest of the day's list let go, saying why.
    const more1 = await fixture("More1", admin.id, 50, 47_200);
    const more2 = await fixture("More2", admin.id, 55, 35_400);
    await db.collectionAutoRun.createMany({ data: [more1, more2].map((companyId, i) => ({ companyId, day: mDay, forUserId: admin.id, score: 90 - i })) });
    refuseNext = true;
    const refused = await auto.runArjunMorning(morning);
    const after = await db.collectionAutoRun.findMany({ where: { day: mDay, companyId: { in: [more1, more2] } }, select: { status: true, reason: true } });
    ok("out of credits: that one failed, the rest of the day's let go — saying why", refused.failed === 1 && after.every((a) => /credits/.test(a.reason ?? "")) && after.some((a) => a.status === "FAILED") && after.some((a) => a.status === "SKIPPED"), after);

    // The Monday note: from the books, in the person's own collections — this week's Monday at ten, last week before it.
    const monday = new Date(morning.getTime() - ((clock.parts(morning).weekday + 6) % 7) * DAY);
    const mondayDay = clock.calendarDate(monday);
    const lastTuesday = new Date(mondayDay.getTime() - 6 * DAY);
    const noteBefore = await auto.weekNote(admin.id, monday);
    await db.payment.create({ data: { companyId: hard, amount: 5000, paidOn: lastTuesday, method: "BANK_TRANSFER", direction: "RECEIVED", recordedByUserId: admin.id } as never });
    const noteAfter = await auto.weekNote(admin.id, monday);
    ok("the week's money in, from the books — a payment last week counted", noteAfter.payments === noteBefore.payments + 1 && Math.abs(noteAfter.received - noteBefore.received - 5000) < 0.01, { before: noteBefore.received, after: noteAfter.received });
    ok("  and the note in words: the week, promises, chase emails, what's overdue now", /^Last week \(\d+ \w+ – \d+ \w+\):/.test(noteAfter.text) && noteAfter.text.includes("• Promises to pay:") && noteAfter.text.includes("• Chase emails:") && /\nNow: .* overdue on \d+ dues?\./.test(noteAfter.text), noteAfter.text);
    await db.dailyJobRun.deleteMany({ where: { job: "arjun-weekly", day: mondayDay } });
    const notTuesday = await auto.runArjunWeekly(new Date(monday.getTime() + DAY));
    const weekly = await auto.runArjunWeekly(monday);
    const again2 = await auto.runArjunWeekly(new Date(monday.getTime() + 3_600_000));
    const weeklyNote = await db.notification.findFirst({ where: { userId: admin.id, type: "COLLECTIONS_WEEKLY", createdAt: { gte: t0 } }, select: { title: true, message: true } });
    ok("the Monday note: on a Monday, once, to the people chosen, in Arjun's voice", notTuesday.reason === "not Monday" && weekly.told === 1 && again2.reason === "already sent" && weeklyNote?.title === "Arjun: your week in collections" && weeklyNote.message.startsWith("Last week ("), { notTuesday, weekly, again2 });
    await db.dailyJobRun.deleteMany({ where: { job: "arjun-weekly", day: mondayDay } });

    const view5 = await settingsActions.getArjunSettings();
    const card = await renderHtml(createElement(ArjunSettings, { settings: view5! }));
    ok("the settings card: the switch, the hard cases, the day's limit, the Monday note, the last 30 days", card.includes("chases payments by himself") && card.includes("Late at least") && card.includes("drafts a day") && card.includes("The Monday note") && card.includes("Drafted (30 days)") && view5!.report.drafted >= 1, view5?.report);

    await db.collectionAgentSettings.deleteMany({});
    if (before5) await db.collectionAgentSettings.create({ data: before5 });
    await db.dailyJobRun.deleteMany({ where: { job: "arjun-morning", day: mDay } });
    await db.notification.deleteMany({ where: { userId: admin.id, createdAt: { gte: t0 }, OR: [{ type: "COLLECTIONS_WEEKLY" }, { title: { startsWith: "Arjun:" } }] } });
  } finally {
    await db.collectionAutoRun.deleteMany({ where: { companyId: { in: morningCompanies } } }).catch(() => undefined);
    await db.payment.deleteMany({ where: { companyId: { in: morningCompanies } } }).catch(() => undefined);
    await db.aiTeammateWork.deleteMany({ where: { label: { startsWith: NAME } } }).catch(() => undefined);
    await db.collectionChase.deleteMany({ where: { companyId: { in: morningCompanies } } }).catch(() => undefined);
    await db.tradeDocument.deleteMany({ where: { companyId: { in: morningCompanies } } }).catch(() => undefined);
    await db.contact.deleteMany({ where: { companyId: { in: morningCompanies } } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: { in: morningCompanies } } }).catch(() => undefined);
    copilotSettings.setTestSettings(null);
    mailer.setTestPlatformMailer(null);
    await db.paymentReminderPause.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.task.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.marketingMessage.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.notification.deleteMany({ where: { message: { contains: NAME } } }).catch(() => undefined);
    await db.aiTeammateWork.deleteMany({ where: { label: NAME } }).catch(() => undefined);
    await db.paymentFollowUp.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.collectionChase.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.tradeDocument.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
    await db.contact.deleteMany({ where: { id: contact.id } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: company.id } }).catch(() => undefined);
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? `All ${passes} collection chase checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
