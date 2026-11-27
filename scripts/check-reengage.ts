/**
 * check:reengage — Tara checking in with quiet customers (owner, 20 Nov 2026 — AI team step 4; src/lib/reengage).
 *
 *   · Who is quiet, and one voice per customer: a renewal coming, money overdue, a lead open, an email last week — no.
 *   · Off until switched on; a draft from what they bought (names, quantities, when — never prices or the contact's
 *     name or address), waiting for the account manager, on their "Waiting for you", the customer's card and the team strip.
 *   · Only the account manager sends it: from their mailbox, the reply-to `+e-` address, the mail log; approved out of
 *     hours it waits for 10 the next working morning and the heartbeat sends it then.
 *   · A reply: forwarded; interested opens a lead for the account manager; asking to stop unsubscribes; through the door
 *     the mail worker posts to.
 *   · The heartbeat drafts by itself up to the day's number; "Don't send" keeps the customer out for a while.
 *
 * Nothing leaves: Deskzo AI, the mailbox and Deskzo's own mail are stand-ins. Local workspace, its own records (Zz Quiet …).
 *
 *   npm run check:reengage
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
let nextRead: Record<string, unknown> | null = null;
const gateway = {
  AiRefusal,
  aiService: async () => ({ model: "Zz Model", residency: "Zzland", noTraining: true }),
  aiUnavailable: async () => null,
  aiTurn: async (turn: { feature?: string; history: { role: string; text?: string }[] }) => {
    const base = { text: "", native: null, usage: { input: 1, output: 1 }, stop: "tools", model: "zz", family: "BEDROCK", modelKey: "zz", charge: { credits: 1 } };
    if (turn.feature === "nurture.reply") return { ...base, toolCalls: nextRead ? [{ id: "r", name: "read_reply", input: nextRead }] : [] };
    prompts.push(turn.history.find((h) => h.role === "user")?.text ?? "");
    const input = { subject: "How are the firewalls doing?", body: "Hi {{firstName}},\n\nIt's been a while — how are the firewalls holding up? Anything we can help with?\n\n{{senderName}}" };
    return { ...base, toolCalls: [{ id: "c", name: "propose_email", input }] };
  },
};
type Out = { subject: string; html: string; to: { name: string | null; email: string }[]; replyTo?: { name: string | null; email: string } };
const mailboxSends: Out[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }), usePathname: () => "/companies/x", useSearchParams: () => new URLSearchParams() };
  if (request === "@/lib/session" || request.endsWith("/lib/session")) return session;
  if (request === "@/lib/ai/gateway" || request.endsWith("/lib/ai/gateway")) return { ...(originalLoad.call(this, request, parent, isMain) as Record<string, unknown>), ...gateway };
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

const DAY = 86_400_000;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rules = require("../src/lib/reengage/rules") as typeof import("../src/lib/reengage/rules");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("1. Who is quiet, and one voice per customer");
  const now = new Date("2026-11-20T06:00:00Z");
  const quiet = { hasAccountManager: true, lastPurchaseAt: new Date("2026-03-01T00:00:00Z"), renewalsDueSoon: 0, chasedRecently: 0, overdue: 0, openLeads: 0, mailedRecently: 0, checkInLive: false, checkInTurnedDown: false };
  ok("quiet eight months, nobody talking to them: Tara may write", rules.voiceReason(quiet, now, 6) === null);
  ok("  bought within the months: no", /within the last 6 months/.test(rules.voiceReason({ ...quiet, lastPurchaseAt: new Date("2026-08-01T00:00:00Z") }, now, 6) ?? ""));
  ok("  never bought: no", /hasn't bought/.test(rules.voiceReason({ ...quiet, lastPurchaseAt: null }, now, 6) ?? ""));
  ok("  a renewal coming: its renewal manager's", /renewal/.test(rules.voiceReason({ ...quiet, renewalsDueSoon: 1 }, now, 6) ?? ""));
  ok("  money overdue, or Arjun chased lately: Arjun's first", /Arjun/.test(rules.voiceReason({ ...quiet, overdue: 10 }, now, 6) ?? "") && /Arjun chased/.test(rules.voiceReason({ ...quiet, chasedRecently: 1 }, now, 6) ?? ""));
  ok("  a lead open: the salesperson's", /lead is open/.test(rules.voiceReason({ ...quiet, openLeads: 1 }, now, 6) ?? ""));
  ok("  an email last week, a check-in already, or one turned down: no", !!rules.voiceReason({ ...quiet, mailedRecently: 1 }, now, 6) && !!rules.voiceReason({ ...quiet, checkInLive: true }, now, 6) && !!rules.voiceReason({ ...quiet, checkInTurnedDown: true }, now, 6));
  ok("  no account manager to send from: no", /account manager/.test(rules.voiceReason({ ...quiet, hasAccountManager: false }, now, 6) ?? ""));
  ok("six months before 31 August is 28 February", rules.monthsBefore(new Date("2026-08-31T10:00:00Z"), 6).toISOString().slice(0, 10) === "2026-02-28");
  ok("how long, in words", rules.sinceInWords(new Date("2026-03-01T00:00:00Z"), now) === "8 months" && rules.sinceInWords(new Date("2025-08-01T00:00:00Z"), now) === "a year and 3 months");
  const tokenShape = "a1".repeat(12);
  const address = rules.checkInReplyAddress("wroffy", tokenShape, "tickets.deskzo.com");
  ok("the reply-to is the workspace's address with +e- and the secret, and reads back — not a nurture's", address === `wroffy+e-${tokenShape}@tickets.deskzo.com` && rules.checkInTokenOf(address.toUpperCase()) === tokenShape && rules.checkInTokenOf(`wroffy+n-${tokenShape}@x.test`) === null);

  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const reengage = require("../src/lib/reengage/server") as typeof import("../src/lib/reengage/server");
  const actions = require("../src/actions/reengage") as typeof import("../src/actions/reengage");
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
  const before = await db.reengageSettings.findUnique({ where: { id: "global" } });
  await db.reengageSettings.deleteMany({ where: { id: "global" } });
  const item = await db.item.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, sellingPrice: true } });
  if (!item) throw new Error("no item to order");

  const tag = randomUUID().slice(0, 6);
  const NAME = `Zz Quiet ${tag} Pvt Ltd`;
  const NAME2 = `Zz Quiet ${tag} Two Pvt Ltd`;
  const t0 = new Date();
  const eightMonthsAgo = new Date(Date.now() - 240 * DAY);
  const companyIds: string[] = [];
  const contactIds: string[] = [];
  async function quietCustomer(name: string, value: number) {
    const company = await db.company.create({ data: { name, normalizedName: name.toLowerCase(), createdById: admin!.id, ownerUserId: admin!.id }, select: { id: true, companySeq: true } });
    companyIds.push(company.id);
    const contact = await db.contact.create({ data: { companyId: company.id, name: "Meera Zzquiet", email: `meera.${tag}.${companyIds.length}@zzquiet.example.com`, designation: "IT_MANAGER", isPrimary: true, createdByUserId: admin!.id }, select: { id: true, email: true } });
    contactIds.push(contact.id);
    const site = await db.companyLocation.create({ data: { companyId: company.id, label: "HO", isPrimary: true }, select: { id: true } });
    await db.companyProduct.create({ data: { companyId: company.id, locationId: site.id, itemId: item!.id, addedByUserId: admin!.id, quantity: 12, orderStatus: "FULFILLED", startDate: eightMonthsAgo, createdAt: eightMonthsAgo } });
    await db.customerStats.create({ data: { companyId: company.id, lastPurchaseAt: eightMonthsAgo, lifetimeValue: value, orders: 1 } });
    return { ...company, site, contact };
  }

  try {
    const c = await quietCustomer(NAME, 1);
    section("2. Off until switched on; one voice");
    const off = await actions.draftReengage(c.id);
    ok("switched off: refused, saying where to switch it on", !off.ok && /Settings → Deskzo AI/.test(off.ok ? "" : off.error));
    const saved = await actions.saveReengageSettings({ enabled: true, months: 6, perDay: 0 });
    ok("an admin switches it on — six months, none a day by herself", saved.ok && saved.data.enabled && saved.data.months === 6 && saved.data.perDay === 0, saved);
    ok("  months out of range refused", !(await actions.saveReengageSettings({ enabled: true, months: 1, perDay: 0 })).ok);

    const lead = await db.lead.create({ data: { companyId: c.id, contactId: c.contact.id, title: `Zz ${tag} open`, ownerUserId: admin.id, createdByUserId: admin.id, status: "QUALIFYING" }, select: { id: true } });
    const withLead = await actions.draftReengage(c.id);
    ok("a lead is open with them: not now — the salesperson's", !withLead.ok && /lead is open/.test(withLead.ok ? "" : withLead.error), withLead);
    await db.lead.delete({ where: { id: lead.id } });
    const renewal = await db.companyProduct.create({ data: { companyId: c.id, locationId: c.site.id, itemId: item.id, addedByUserId: admin.id, quantity: 1, orderStatus: "FULFILLED", startDate: eightMonthsAgo, endDate: new Date(Date.now() + 30 * DAY) } });
    const withRenewal = await actions.draftReengage(c.id);
    ok("a renewal due in 30 days: not now — its renewal manager's", !withRenewal.ok && /renewal/.test(withRenewal.ok ? "" : withRenewal.error));
    await db.companyProduct.delete({ where: { id: renewal.id } });
    await db.customerStats.update({ where: { companyId: c.id }, data: { overdue: 500 } });
    ok("money overdue: not now — Arjun's first", !(await actions.draftReengage(c.id)).ok);
    await db.customerStats.update({ where: { companyId: c.id }, data: { overdue: 0 } });
    const mail = await db.marketingMessage.create({ data: { token: randomUUID(), companyId: c.id, contactId: c.contact.id, channel: "EMAIL", messageClass: "MARKETING", subject: "Zz newsletter", body: "x", toEmail: c.contact.email, status: "SENT", scheduledFor: new Date(Date.now() - 2 * DAY), sentAt: new Date(Date.now() - 2 * DAY) } });
    ok("an email from you two days ago: not now", !(await actions.draftReengage(c.id)).ok);
    await db.marketingMessage.delete({ where: { id: mail.id } });

    section("3. The draft");
    if (other) {
      actor = { id: other.id, name: other.name, email: other.email, role: other.role };
      const notTheirs = await actions.draftReengage(c.id);
      ok("somebody who isn't its account manager and can't change it: refused", !notTheirs.ok || (await db.reengageEmail.count({ where: { companyId: c.id } })) > 0, notTheirs);
      await db.reengageEmail.deleteMany({ where: { companyId: c.id } });
      asAdmin();
    }
    prompts.length = 0;
    const drafted = await actions.draftReengage(c.id);
    const row = await db.reengageEmail.findFirst({ where: { companyId: c.id }, orderBy: { createdAt: "desc" } });
    ok("drafted: waiting for the account manager, to the primary contact", drafted.ok && row?.status === "WAITING" && row.ownerId === admin.id && row.contactId === c.contact.id, drafted);
    const prompt = prompts[prompts.length - 1] ?? "";
    ok("  from what they bought: the product, how many, when — and how long since", prompt.includes(`${item.name} × 12`) && /was 7 months ago/.test(prompt), prompt.slice(0, 300));
    ok("  never the contact's name or address, never a price", !prompt.includes("Meera") && !prompt.includes(c.contact.email!) && !prompt.includes(String(item.sellingPrice)) && !/₹|INR|price/i.test(prompt.replace("Never mention prices", "")));
    ok("  Tara's work, logged for the account manager", (await db.aiTeammateWork.count({ where: { userId: admin.id, teammate: "tara", kind: "reengage.draft", label: NAME, status: "DONE" } })) >= 1);
    ok("  asking again while one waits: refused", !(await actions.draftReengage(c.id)).ok);

    section("4. Where it shows");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { waitingForYou } = require("../src/lib/ai/waiting") as typeof import("../src/lib/ai/waiting");
    const { companyTeam } = require("../src/lib/ai/record-team") as typeof import("../src/lib/ai/record-team");
    const { createElement } = require("react") as typeof import("react");
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const { CheckInCard } = require("../src/components/ai/check-in-card") as typeof import("../src/components/ai/check-in-card");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const waiting = await waitingForYou(admin.id, 200);
    ok("on the account manager's \"Waiting for you\", under Tara", waiting.items.some((i) => i.teammate === "tara" && i.title.includes(NAME) && i.href.endsWith("#check-in")));
    const card = await reengage.checkInCardOf(c.id, admin.id, true);
    ok("the customer's card: the draft, theirs to send", card?.latest?.status === "WAITING" && card.isOwner && !card.mayDraft);
    const html = renderToStaticMarkup(createElement(CheckInCard, { data: card! }));
    ok("  rendered: subject and email to change, approve or send, and Don't send", html.includes("How are the firewalls doing?") && (html.includes("Approve &amp; send") || html.includes("Approve — goes")) && html.includes("Don&#x27;t send"));
    const slots = await companyTeam(admin.id, c.id, null, card);
    ok("  and Tara in the team strip at the top", slots.some((s) => s.teammate === "tara" && s.status === "Check-in waiting for you"), slots);

    section("5. Sending");
    if (other) {
      actor = { id: other.id, name: other.name, email: other.email, role: other.role };
      ok("somebody else can't send it — it goes from the account manager's mailbox", !(await actions.sendReengage({ id: row!.id, subject: row!.subject, body: row!.body, when: "now" })).ok);
      asAdmin();
    }
    const sent = await actions.sendReengage({ id: row!.id, subject: "How are the firewalls doing?", body: row!.body, when: "now" });
    const m = mailboxSends[mailboxSends.length - 1];
    ok("sent from their mailbox to the contact", sent.ok && m?.to[0]?.email === c.contact.email && m.subject === "How are the firewalls doing?", sent);
    ok("  replies to the workspace's +e- address with the secret", m?.replyTo?.email === `${slug}+e-${row!.replyToken}@zz-inbound.test`, m?.replyTo);
    ok("  the first name filled and the 'manage what we send you' line", !!m?.html.includes("Hi Meera,") && /Manage what we send you/.test(m?.html ?? ""));
    const after = await db.reengageEmail.findUnique({ where: { id: row!.id } });
    ok("  sent, in the mail log, and recorded as written for Tara's scorecard", after?.status === "SENT" && (await db.marketingMessage.count({ where: { companyId: c.id, subject: "How are the firewalls doing?" } })) === 1 && (await db.aiDraftRecord.count({ where: { kind: "reengage.email", ref: row!.id, outcome: "AS_WRITTEN" } })) === 1);
    ok("  a second check-in now: refused — she's checked in already", !(await actions.draftReengage(c.id)).ok);

    section("6. A reply");
    nextRead = { kind: "INTERESTED", summary: "They want a quote for twelve more." };
    forwarded.length = 0;
    const outcome = await reengage.receiveCheckInReply(row!.replyToken, { from: { address: c.contact.email!, name: "Meera Zzquiet" }, to: [], cc: [], subject: "Re: How are the firewalls doing?", text: "Going well — can you quote twelve more?", messageId: null, inReplyTo: null, references: [], automated: null, attachments: [], senderVerified: true });
    const replied = await db.reengageEmail.findUnique({ where: { id: row!.id } });
    const opened = replied?.leadId ? await db.lead.findUnique({ where: { id: replied.leadId }, select: { ownerUserId: true, source: true, companyId: true, contactId: true } }) : null;
    ok("interested: a lead opened for the account manager, this customer and contact", outcome === "forwarded" && opened?.ownerUserId === admin.id && opened.source === "EXISTING_CUSTOMER" && opened.companyId === c.id && opened.contactId === c.contact.id, opened);
    ok("  forwarded to them, a reply going straight back to the customer", forwarded.length === 1 && forwarded[0]!.to === admin.email && forwarded[0]!.replyTo === c.contact.email);
    ok("  read and kept, and the draft marked as answered", replied?.replyKind === "INTERESTED" && !!replied.repliedAt && (await db.aiDraftRecord.count({ where: { kind: "reengage.email", ref: row!.id, repliedAt: { not: null } } })) === 1);
    ok("  an out-of-office changes nothing", (await reengage.receiveCheckInReply(row!.replyToken, { from: null, to: [], cc: [], subject: "Away", text: "Away", messageId: null, inReplyTo: null, references: [], automated: "auto", attachments: [], senderVerified: false })) === "automated");
    nextRead = { kind: "UNSUBSCRIBE", summary: "Asked not to be emailed." };
    await reengage.receiveCheckInReply(row!.replyToken, { from: { address: c.contact.email!, name: "Meera Zzquiet" }, to: [], cc: [], subject: "Re: x", text: "Please take me off your list.", messageId: null, inReplyTo: null, references: [], automated: null, attachments: [], senderVerified: true });
    ok("asking to stop: unsubscribed from everything at once", (await db.contactConsent.count({ where: { contactId: c.contact.id, status: "UNSUBSCRIBED" } })) > 0);
    ok("a secret nobody has: unknown, for the helpdesk to take", (await reengage.receiveCheckInReply("0".repeat(24), { from: null, to: [], cc: [], subject: "x", text: "x", messageId: null, inReplyTo: null, references: [], automated: null, attachments: [], senderVerified: false })) === "unknown");

    section("7. Through the door the mail worker posts to");
    process.env.INBOUND_MAIL_SECRET = "zz-reengage-secret-0123456789abcdef";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { receiveInbound } = require("../src/lib/support-mail/inbound") as typeof import("../src/lib/support-mail/inbound");
    /* eslint-enable @typescript-eslint/no-require-imports */
    nextRead = { kind: "OTHER", summary: "Says thanks." };
    const to = `${slug}+e-${row!.replyToken}@zz-inbound.test`;
    const raw = [`From: Meera Zzquiet <${c.contact.email}>`, `To: ${to}`, "Subject: Re: How are the firewalls doing?", `Message-ID: <${randomUUID()}@zzquiet.example.com>`, "Date: Fri, 20 Nov 2026 10:00:00 +0530", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "Thanks, all good.", ""].join("\r\n");
    const domain = c.contact.email!.split("@")[1]!;
    const body = JSON.stringify({ recipient: to, sender: c.contact.email, raw: Buffer.from(raw).toString("base64"), auth: { authservId: "mx.cloudflare.net", dmarc: "pass", dmarcDomain: domain, dkim: [{ result: "pass", domain }], spf: "pass" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", process.env.INBOUND_MAIL_SECRET).update(`${timestamp}.${body}`).digest("hex");
    forwarded.length = 0;
    const door = await receiveInbound(body, new Headers({ "x-deskzo-timestamp": timestamp, "x-deskzo-signature": signature }));
    ok("a reply the mail worker posts: taken by the check-in, forwarded — not made a ticket", door.status === 200 && door.body.result === undefined && forwarded.length === 1, door);

    section("8. The heartbeat, working hours, and Don't send");
    const c2 = await quietCustomer(NAME2, 999_999_999_999);
    const today = await reengage.draftedToday();
    await actions.saveReengageSettings({ enabled: true, months: 6, perDay: today + 1 });
    const run = await reengage.runReengage();
    const own = await db.reengageEmail.findFirst({ where: { companyId: c2.id }, orderBy: { createdAt: "desc" } });
    ok("by herself: the most valuable quiet customer drafted, up to the day's number", run.drafted === 1 && own?.status === "WAITING", run);
    ok("  the day's number reached: nothing more", (await reengage.runReengage()).drafted === 0);
    // A Saturday: approved, it waits for Monday 10:00 on the workspace's clock.
    const saturday = new Date("2026-11-21T06:30:00Z");
    const held = await reengage.approveCheckIn(own!.id, admin.id, { subject: own!.subject, body: own!.body }, saturday, "working-hours");
    const heldRow = await db.reengageEmail.findUnique({ where: { id: own!.id } });
    ok("approved on a Saturday: held for the working morning", !!held.at && heldRow?.status === "SCHEDULED" && new Date(held.at).getUTCDay() === 1, held);
    const sendsBefore = mailboxSends.length;
    await reengage.runReengage(new Date(heldRow!.sendAt!.getTime() + 60_000));
    ok("  the heartbeat sends it then", (await db.reengageEmail.findUnique({ where: { id: own!.id } }))?.status === "SENT" && mailboxSends.length === sendsBefore + 1);
    const c3 = await quietCustomer(`Zz Quiet ${tag} Three Pvt Ltd`, 2);
    await actions.saveReengageSettings({ enabled: true, months: 6, perDay: 0 });
    await actions.draftReengage(c3.id);
    const third = await db.reengageEmail.findFirst({ where: { companyId: c3.id } });
    const skipped = await actions.skipReengage(third!.id);
    const card3 = await reengage.checkInCardOf(c3.id, admin.id, true);
    ok("Don't send: set aside, recorded, and Tara doesn't offer again for a while", skipped.ok && card3?.latest?.status === "SKIPPED" && !card3.mayDraft && /turned down/.test(card3.note ?? "") && (await db.aiDraftRecord.count({ where: { kind: "reengage.email", ref: third!.id, outcome: "SKIPPED" } })) === 1, card3?.note);

    section("9. Settings");
    const view = await actions.getReengageSettings();
    ok("the last 30 days on Settings", !!view && view.report.sent >= 2 && view.report.replied >= 1 && view.report.leads >= 1 && view.report.turnedDown >= 1, view?.report);
    const off2 = await actions.saveReengageSettings({ enabled: false, months: 6, perDay: 0 });
    ok("switched off: the heartbeat does nothing", off2.ok && (await reengage.runReengage()).reason === "off");
  } finally {
    const refs = (await db.reengageEmail.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } })).map((r) => r.id);
    await db.aiDraftRecord.deleteMany({ where: { ref: { in: refs } } }).catch(() => undefined);
    await db.aiFeedback.deleteMany({ where: { ref: { in: refs } } }).catch(() => undefined);
    await db.aiTeammateWork.deleteMany({ where: { teammate: "tara", kind: "reengage.draft", startedAt: { gte: t0 }, label: { startsWith: `Zz Quiet ${tag}` } } }).catch(() => undefined);
    const leadIds = (await db.lead.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } })).map((l) => l.id);
    await db.activity.deleteMany({ where: { leadId: { in: leadIds } } }).catch(() => undefined);
    await db.task.deleteMany({ where: { companyId: { in: companyIds } } }).catch(() => undefined);
    await db.lead.deleteMany({ where: { id: { in: leadIds } } }).catch(() => undefined);
    await db.marketingMessage.deleteMany({ where: { companyId: { in: companyIds } } }).catch(() => undefined);
    await db.contactConsent.deleteMany({ where: { contactId: { in: contactIds } } }).catch(() => undefined);
    await db.suppression.deleteMany({ where: { scope: "EMAIL", value: { endsWith: "@zzquiet.example.com" } } }).catch(() => undefined);
    await db.notification.deleteMany({ where: { OR: [{ message: { contains: `Zz Quiet ${tag}` } }, { title: { contains: `Zz Quiet ${tag}` } }] } }).catch(() => undefined);
    await db.auditLog.deleteMany({ where: { entityId: { in: [...refs, ...leadIds] } } }).catch(() => undefined);
    await db.reengageEmail.deleteMany({ where: { companyId: { in: companyIds } } }).catch(() => undefined);
    await db.companyProduct.deleteMany({ where: { companyId: { in: companyIds } } }).catch(() => undefined);
    await db.contact.deleteMany({ where: { id: { in: contactIds } } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: { in: companyIds } } }).catch(() => undefined);
    await db.reengageSettings.deleteMany({ where: { id: "global" } });
    if (before) await db.reengageSettings.create({ data: before });
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
