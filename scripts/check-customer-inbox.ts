/**
 * The Customer inbox (src/lib/inbox, src/actions/inbox.ts) — website chat with its bot, and WhatsApp.
 *
 *   · The rules without a database: a channel's settings read and checked, the bot's answers and its
 *     way to a person, Meta's webhook read and its signature checked, the 24-hour window, the bubble.
 *   · A website visitor's conversation: the greeting, a set answer, asking for a person, the name and
 *     email asked for, the handover, and the lead it makes; their token is theirs alone.
 *   · WhatsApp: a new number makes a lead, a known one links to its contact and doesn't, Meta's retries
 *     are skipped, receipts only move forward, the 24 hours and templates.
 *   · Staff: who sees what (a rep's own number), replying, the bot stepping aside, assigning and being
 *     told, closing, reopening on a new message, a ticket from a conversation, unread counts, the live bus.
 *   · The actions refuse somebody without the inbox, and anybody viewing as somebody.
 *
 * On the local database, every row named Zzprobe / ZZPROBE_INBOX and removed in a finally; nothing is
 * sent to Meta (a stand-in takes every WhatsApp message).
 *
 *   npm run check:customer-inbox
 */
import "dotenv/config";
import { createHmac } from "node:crypto";
import Module from "node:module";
import path from "node:path";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { ASK_NAME_CONTACT_LINES, ASK_NAME_LINES, botReply, companyIn, contactIn, firstNameOf, matchAnswer, matchAnswerDetail, nameIn, smallTalkOf, typingMs, withName, type BotState, type Known } from "../src/lib/inbox/bot";

/** One of the bot's ways of asking a name. */
const asksName = (line: string | undefined) => !!line && ASK_NAME_LINES.includes(line);
const asksNameAndContact = (line: string | undefined) => !!line && ASK_NAME_CONTACT_LINES.includes(line);
import { channelSettings, checkChannelSettings, conversationRef, defaultChannelSettings, siteOrigin, whatsappWindowOpen, withinHours, type ChannelSettings } from "../src/lib/inbox/settings";
import { parseWebhook, verifySignature } from "../src/lib/inbox/whatsapp";
import { WIDGET_SCRIPT } from "../src/lib/inbox/widget-script";
import { detailsMissing, needsText, proactiveMatches } from "../src/lib/inbox/settings";
import { checkPrechat, cleanShortcut, fileText, fillReply, matchReplies, normaliseTags, ratingOf, replyInText, sendableType } from "../src/lib/inbox/team-rules";
import { clockFor } from "../src/lib/time/zone";

let actorId = "";
let viewingAs = false;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  // Only the settings page reads the request's host; tenancy needs headers() to fail outside a request, as it does.
  const from = (parent as { filename?: string } | undefined)?.filename ?? "";
  if (request === "next/headers" && from.includes(`settings${path.sep}inbox${path.sep}page`)) return { headers: async () => new Headers({ host: "zz.localhost:3000" }) };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/inbox",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => (actorId ? { id: actorId, role: "SUPPORT", name: "Zzprobe", email: `${actorId}${MAIL}` } : null);
    return {
      requireUser: async () => {
        const u = user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: async () => user(),
      viewAsContext: async () => (viewingAs ? { user: user(), actor: user() } : null),
      refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody." : null),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_INBOX";
const MAIL = "@zzprobe-inbox.invalid";
const DOMAIN = "zzprobe-inbox.invalid";
const PHONE_IDS = ["990000000101", "990000000102", "990000000103", "990000000104", "990000000105"];
/**
 * A module's own action refused because the module isn't open to the person — its section, its view permission or
 * the company's switch (`requireModuleAccess`, owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-6).
 */
async function notOpen(call: Promise<unknown>, module: string): Promise<boolean> {
  try {
    await call;
    return false;
  } catch (err) {
    return err instanceof Error && err.message === `${module} isn't open to you.`;
  }
}

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const channels = await db.inboxChannel.findMany({ where: { OR: [{ name: { startsWith: TAG } }, { phoneNumberId: { in: PHONE_IDS } }] }, select: { id: true } });
  const conversations = await db.conversation.findMany({ where: { channelId: { in: channels.map((c) => c.id) } }, select: { companyId: true, leadId: true, ticketId: true } });
  const companies = await db.company.findMany({
    where: { OR: [{ name: { startsWith: "Zzprobe" } }, { name: { equals: DOMAIN, mode: "insensitive" } }, { id: { in: conversations.map((c) => c.companyId).filter((v): v is string => !!v) } }] },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  const conversationIds = (await db.conversation.findMany({ where: { channelId: { in: channels.map((c) => c.id) } }, select: { id: true } })).map((c) => c.id);
  await db.automationEvent.deleteMany({ where: { recordType: "conversation", recordId: { in: conversationIds } } });
  await db.conversation.deleteMany({ where: { channelId: { in: channels.map((c) => c.id) } } });
  await db.inboxChannel.deleteMany({ where: { id: { in: channels.map((c) => c.id) } } });
  const tickets = await db.ticket.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  await db.ticket.deleteMany({ where: { id: { in: tickets.map((t) => t.id) } } });
  const leads = await db.lead.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  await db.auditLog.deleteMany({ where: { OR: [{ entityType: "Company", entityId: { in: companyIds } }, { entityType: "Lead", entityId: { in: leads.map((l) => l.id) } }, { entityType: "Ticket", entityId: { in: tickets.map((t) => t.id) } }] } });
  await db.lead.deleteMany({ where: { id: { in: leads.map((l) => l.id) } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.inboxSavedReply.deleteMany({ where: { shortcut: { startsWith: "zzprobe" } } });
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.inboxBlock.deleteMany({ where: { OR: [{ createdById: { in: ids } }, { label: { startsWith: "Zzprobe" } }, { value: { startsWith: "91990000" } }] } });
  if (ids.length) {
    await db.inboxAgentStatus.deleteMany({ where: { userId: { in: ids } } });
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

/** A page, rendered as the server would, awaited all the way down (nested async components included). */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}
type Page = (props: never) => Promise<unknown>;
async function render(page: Page, searchParams: Record<string, string> = {}): Promise<string> {
  const el = await page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}
async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Why the bot answers a first message as it does. */
function talkReason(settings: ChannelSettings, text: string) {
  return botReply({ text, settings, state: null, known: { name: null, email: null, phone: null }, kind: "WEB" }).reason;
}

/** A whole conversation with the bot, message by message: its replies, and where it ends up. */
function talk(settings: ChannelSettings, kind: "WEB" | "WHATSAPP", lines: string[], known: Known = { name: null, email: null, phone: null }) {
  let state: BotState | null = null;
  const said: string[] = [];
  let handover = false;
  for (const text of lines) {
    const turn = botReply({ text, settings, state, known, kind });
    said.push(...turn.replies);
    Object.assign(known, turn.learned);
    state = turn.state;
    handover = turn.handover;
  }
  return { said, handover, known, state };
}

async function main() {
  section("The rules, without a database");

  const web = defaultChannelSettings("WEB");
  ok("a new website channel: the bot on, asking for details, making leads", web.bot.on && web.bot.askDetails && web.autoLead && web.allowedSites.length === 0);
  ok("  a new WhatsApp number: the bot off until it's given answers", !defaultChannelSettings("WHATSAPP").bot.on);
  ok("a stored value with gaps reads whole, with the defaults filled in", channelSettings({ greeting: "Hello", look: { colour: "not a colour" } }, "WEB").look.colour === "#0249FE" && channelSettings({ greeting: "Hello" }, "WEB").greeting === "Hello");
  ok("  and nonsense reads as the defaults", JSON.stringify(channelSettings("nonsense", "WEB")) === JSON.stringify(web));
  ok("sites are kept as origins", siteOrigin("example.com/contact") === "https://example.com" && siteOrigin("http://shop.example.in") === "http://shop.example.in" && siteOrigin("not a site") === null);
  const refusedSettings = [
    checkChannelSettings({ bot: { answers: [{ keywords: "price", answer: "" }] } }, "WEB"),
    checkChannelSettings({ look: { colour: "blue" } }, "WEB"),
    checkChannelSettings({ allowedSites: ["nope nope"] }, "WEB"),
    checkChannelSettings({ bot: { answers: Array.from({ length: 31 }, () => ({ keywords: "a", answer: "b" })) } }, "WEB"),
  ];
  ok("settings are refused: an answer without words, a colour, a site, too many answers", refusedSettings.every((r) => !r.ok), refusedSettings.map((r) => (r.ok ? "ok" : r.error)).join(" | "));
  const blankRow = checkChannelSettings({ bot: { answers: [{ keywords: "", answer: "" }, { keywords: "hours", answer: "9 to 6" }] } }, "WEB");
  ok("  a blank answer row is dropped, not refused", blankRow.ok && blankRow.settings.bot.answers.length === 1);
  ok("CNV-000123", conversationRef(123) === "CNV-000123");
  const now = new Date("2026-10-24T12:00:00.000Z");
  ok("WhatsApp's window: open within 24 hours of the customer's last message, shut after", whatsappWindowOpen(new Date("2026-10-23T12:30:00.000Z"), now) && !whatsappWindowOpen(new Date("2026-10-23T11:59:00.000Z"), now) && !whatsappWindowOpen(null, now));

  const answers = [
    { keywords: "price, pricing, cost", answer: "PRICE" },
    { keywords: "price list, brochure", answer: "BROCHURE" },
    { keywords: "office hours, open", answer: "HOURS" },
  ];
  ok("the answer with most of its words wins", matchAnswer("Can I get the price list?", answers) === "BROCHURE" && matchAnswer("What does it cost?", answers) === "PRICE");
  ok("  whole words only: 'opener' isn't 'open'", matchAnswer("is there a bottle opener", answers) === null && matchAnswer("Are you OPEN today?", answers) === "HOURS");
  // Smarter matching (owner, 31 Oct 2026): the forms of a word, the words people use for the same thing, and a passing word.
  ok("a word in its everyday forms: 'prices', 'pricing' find 'price'", matchAnswer("what are your prices", [{ keywords: "price", answer: "P" }]) === "P" && matchAnswer("pricing please", [{ keywords: "price", answer: "P" }]) === "P");
  ok("  the words people use for the same thing, Hinglish too: 'cost', 'kitna' find 'price'", matchAnswer("kitna hai?", [{ keywords: "price", answer: "P" }]) === "P" && matchAnswer("how much does it cost", [{ keywords: "price", answer: "P" }]) === "P");
  const long = "I was wondering whether your payroll handles PF and ESI properly for all our staff and what the cost is";
  ok("  one short word passing through a long message is a weak match", matchAnswerDetail(long, answers)?.weak === true && matchAnswerDetail("What does it cost?", answers)?.weak === false);
  ok("  a weak match goes to Deskzo AI where it's on, stays the set answer where it isn't", talkReason({ ...web, bot: { ...web.bot, answers, ai: { on: true, about: "x", chargedTo: "u", pages: [], knowledge: false } } }, long) === "unknown" && talkReason({ ...web, bot: { ...web.bot, answers } }, long) === "answer");
  ok("  'our staff' isn't asking for a person", talkReason({ ...web, bot: { ...web.bot, answers } }, "do you handle leave for our staff") !== "asked");
  ok("a phone number or an email is found in what they type", contactIn("call me on +91 98765 43210 please").phone === "+919876543210" && contactIn("mail zz@Example.com").email === "zz@example.com" && !contactIn("my order 12345").phone);
  ok("a name from 'I'm Priya' or 'my name is Priya Sharma'", nameIn("I'm Priya") === "Priya" && nameIn("my name is Priya Sharma.") === "Priya Sharma" && nameIn("98765 43210") === null);

  const bot: ChannelSettings = { ...web, bot: { ...web.bot, answers } };
  const answered = talk(bot, "WEB", ["How much does it cost?"]);
  ok("a set answer, then — the first time — a check-in, and the bot keeps the conversation", answered.said[0] === "PRICE" && answered.said.length === 2 && /anything else/i.test(answered.said[1] ?? "") && !answered.handover);
  const twice = talk(bot, "WEB", ["What does it cost?", "And the price?"]);
  ok("  the check-in only after the first answer", twice.said.length === 3 && twice.said[2] === "PRICE");
  const handed = talk(bot, "WEB", ["Do you integrate with SAP?", "I'm Zz Visitor", "zz@example.com"]);
  ok(
    "a question it can't answer: its name and a way to reach them asked together; given the name alone, the way to reach them (by name), then a person",
    asksNameAndContact(handed.said[0]) && /Zz/.test(handed.said[1] ?? "") && /number or email|phone number or email/i.test(handed.said[1] ?? "") && handed.handover && handed.said[2] === withName(bot.bot.handover, "Zz") && handed.known.name === "Zz Visitor" && handed.known.email === "zz@example.com",
    handed.said.join(" / "),
  );
  // The lighter handover (owner, 31 Oct 2026): both in one reply, one message from the bot, then a person.
  const oneGo = talk(bot, "WEB", ["Do you integrate with SAP?", "Zz Visitor, 98765 43210"]);
  ok("  both in one reply: straight to a person, with the name and the number", oneGo.handover && oneGo.said.length === 2 && oneGo.known.name === "Zz Visitor" && oneGo.known.phone === "9876543210", oneGo.said.join(" / "));
  const emailOnly = talk(bot, "WEB", ["Do you integrate with SAP?", "zz@example.com", "Zz Visitor"]);
  ok("  an email alone: kept, and then the name asked on its own", emailOnly.handover && emailOnly.known.email === "zz@example.com" && asksName(emailOnly.said[1]) && emailOnly.known.name === "Zz Visitor", emailOnly.said.join(" / "));
  const callMe = talk(bot, "WEB", ["agent", "you can call me on 9876543210"]);
  ok("  'you can call me on…' isn't taken for a name", callMe.known.phone === "9876543210" && callMe.known.name === null && asksName(callMe.said[1]), callMe.said.join(" / "));
  const hmm = talk(bot, "WEB", ["agent", "hmm"]);
  ok("  'hmm' isn't a name: asked again", hmm.known.name === null && !hmm.handover, hmm.said.join(" / "));
  const person = talk(bot, "WEB", ["Can I talk to a person? I'm on 9876543210"]);
  ok("asking for a person goes the same way, keeping a number given unasked", asksName(person.said[0]) && person.known.phone === "9876543210");
  const wa = talk(bot, "WHATSAPP", ["agent please", "Zz Customer"], { name: null, email: null, phone: "+919800000000" });
  ok("on WhatsApp the number is known: only the name is asked", wa.handover && wa.said.length === 2 && asksName(wa.said[0]));
  const stubborn = talk(bot, "WEB", ["agent", "Zz Visitor", "no", "still no"]);
  ok("no phone number or email after asking twice: handed over all the same", stubborn.handover);
  const quick = talk({ ...bot, bot: { ...bot.bot, askDetails: false } }, "WEB", ["agent"]);
  ok("with nothing to ask, straight to a person — the handover without a name it doesn't know", quick.handover && quick.said.join() === withName(bot.bot.handover, null) && !quick.said.join().includes("{name}"));

  section("Talking like a person");
  ok("small talk is recognised whole: a greeting, thanks, goodbye, okay, 'are you a bot?'", smallTalkOf("Hi!") === "hello" && smallTalkOf("namaste 🙏") === "hello" && smallTalkOf("ok thanks") === "thanks" && smallTalkOf("bye") === "bye" && smallTalkOf("👍") === "ack" && smallTalkOf("are you a real person?") === "bot");
  ok("  but not inside a question", smallTalkOf("hi, what does it cost?") === null && smallTalkOf("thanks, but where do you deliver?") === null);
  const hello = talk(bot, "WEB", ["hello"]);
  ok("a greeting gets a greeting back — not a handover", !hello.handover && /hi|hello|hey/i.test(hello.said[0] ?? "") && botReply({ text: "hello", settings: bot, state: null, known: { name: null, email: null, phone: null }, kind: "WEB" }).reason === "smalltalk");
  const named = botReply({ text: "thank you", settings: bot, state: null, known: { name: "Priya Sharma", email: null, phone: null }, kind: "WEB", seed: "s" });
  ok("  thanks gets 'you're welcome', by their first name once known", !named.handover && /welcome|happy to help/i.test(named.replies[0] ?? "") && named.replies[0]!.includes("Priya") && !named.replies[0]!.includes("Sharma"));
  const honest = botReply({ text: "Am I talking to a bot?", settings: { ...bot, bot: { ...bot.bot, name: "Asha" } }, state: null, known: { name: null, email: null, phone: null }, kind: "WEB", seed: "x" });
  ok("asked whether it's a person, it says it's the virtual assistant — by its name — and offers the team", !honest.handover && honest.replies[0]!.includes("Asha") && /virtual assistant/i.test(honest.replies[0]!) && !/i('m| am) (a )?human/i.test(honest.replies[0]!));
  const lines = new Set(["a", "b", "c", "d", "e", "f"].map((s) => botReply({ text: "agent", settings: bot, state: null, known: { name: null, email: null, phone: null }, kind: "WEB", seed: s }).replies[0]));
  ok("it says things more than one way, by the conversation — and the same way for the same seed", lines.size > 1 && botReply({ text: "agent", settings: bot, state: null, known: { name: null, email: null, phone: null }, kind: "WEB", seed: "a" }).replies[0] === botReply({ text: "agent", settings: bot, state: null, known: { name: null, email: null, phone: null }, kind: "WEB", seed: "a" }).replies[0]);
  ok("{name}: their first name, or left out comma and all", withName("Thanks, {name}! Back soon.", "Ravi") === "Thanks, Ravi! Back soon." && withName("Thanks, {name}! Back soon.", null) === "Thanks! Back soon." && firstNameOf("  Ravi Kumar ") === "Ravi");
  ok("'hello' isn't taken for a name, nor 'ok'", nameIn("hello") === null && nameIn("ok") === null);
  ok("a person's typing time: a beat, then by length, never long", typingMs("Hi") === 900 && typingMs("x".repeat(100)) === 2700 && typingMs("x".repeat(2000)) === 3200);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const aiBrief = (require("../src/lib/inbox/ai") as typeof import("../src/lib/inbox/ai")).aiSystemPrompt({ ...bot, bot: { ...bot.bot, name: "Asha", ai: { on: true, about: "x", chargedTo: "u", pages: [], knowledge: false } } }, "Zz", "Priya");
  ok("the AI is told to chat like a person, by the customer's name, honest that it's the assistant", /support agent/i.test(aiBrief) && aiBrief.includes("Priya") && aiBrief.includes("Asha") && /never say you are human/i.test(aiBrief));

  const SECRET = "0123456789abcdef0123456789abcdef";
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "123" },
              contacts: [{ wa_id: "919800000001", profile: { name: "Zz Wa" } }],
              messages: [
                { from: "919800000001", id: "wamid.a", timestamp: "1761300000", type: "text", text: { body: "Hello" } },
                { from: "919800000001", id: "wamid.b", timestamp: "1761300001", type: "image", image: { caption: "my bill" } },
                { from: "919800000001", id: "wamid.c", timestamp: "1761300002", type: "reaction", reaction: { emoji: "👍" } },
              ],
              statuses: [
                { id: "wamid.out1", status: "read" },
                { id: "wamid.out2", status: "failed", errors: [{ title: "Re-engagement message" }] },
              ],
            },
          },
        ],
      },
    ],
  });
  const parsed = parseWebhook(JSON.parse(body));
  ok("Meta's webhook: a text, a photo with its caption, no reaction; its sender's name", parsed.messages.length === 2 && parsed.messages[0].text === "Hello" && parsed.messages[1].text === "[Photo] my bill" && parsed.messages[0].profileName === "Zz Wa" && parsed.messages[0].phoneNumberId === "123");
  ok("  receipts: read, and failed with Meta's reason", parsed.statuses.length === 2 && parsed.statuses[0].status === "READ" && parsed.statuses[1].error === "Re-engagement message");
  ok("  anything that isn't a WhatsApp account's is ignored", parseWebhook({ object: "page", entry: [] }).messages.length === 0);
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  ok("the signature: the app secret's HMAC of the body, and nothing else", verifySignature(body, signature, SECRET) && !verifySignature(`${body} `, signature, SECRET) && !verifySignature(body, signature, "f".repeat(32)) && !verifySignature(body, null, SECRET));
  ok("the bubble's script is whole JavaScript, talking only to its own workspace", !WIDGET_SCRIPT.includes("${") && !WIDGET_SCRIPT.includes("`") && WIDGET_SCRIPT.includes("/api/inbox/public/web/") && WIDGET_SCRIPT.includes('credentials: "omit"'));
  let parses = true;
  try {
    new Function(WIDGET_SCRIPT);
  } catch {
    parses = false;
  }
  ok("  and it parses", parses);

  section("The team's tools: the rules");
  ok("tags: lower case, hyphenated, each once, ten at most", normaliseTags(["Follow up", " SALES ", "sales", "", 5, "a/b!"]).join() === "follow-up,sales,ab" && normaliseTags(Array.from({ length: 14 }, (_, i) => `t${i}`)).length === 10);
  ok("a saved reply's shortcut, with or without its '/'", cleanShortcut("/Pricing") === "pricing" && cleanShortcut("demo-call") === "demo-call" && cleanShortcut("two words") === null && cleanShortcut("-x") === null);
  ok(
    "{name} and {agent} filled — {name} left out, comma and all, when it isn't known",
    fillReply("Hi {name}, it's {agent}.", { customer: "Priya Sharma", agent: "Ravi Kumar" }) === "Hi Priya, it's Ravi." && fillReply("Hi {name}, it's {agent}.", { customer: null, agent: "Ravi" }) === "Hi, it's Ravi." && fillReply("Thanks, {name}!", { customer: null, agent: null }) === "Thanks!",
  );
  const library = [
    { shortcut: "pricing", title: "Our plans" },
    { shortcut: "demo", title: "Book a demo of pricing" },
    { shortcut: "hours", title: "Office hours" },
  ];
  ok("'/pri' finds shortcuts first, then titles", matchReplies(library, "pri").map((r) => r.shortcut).join() === "pricing,demo" && matchReplies(library, "").length === 3);
  ok("a rating from the whole reply: 👍, 1, 'good' — 👎, 2, 'bad' — and nothing from a sentence", ratingOf("👍") === "GOOD" && ratingOf(" Good! ") === "GOOD" && ratingOf("2") === "BAD" && ratingOf("👎🏽") === "BAD" && ratingOf("good morning, one more question") === null);
  ok("'usually replies within…' only with three answered to go on", replyInText(3 * 60_000, 5) === "Usually replies within a few minutes" && replyInText(40 * 60_000, 3) === "Usually replies within an hour" && replyInText(60_000, 2) === null);
  ok("files: photos, PDFs and office documents — never a page or a program", sendableType("image/png", "a.png") === "image/png" && sendableType("", "quote.PDF") === "application/pdf" && sendableType("text/html", "x.html") === null && sendableType("application/octet-stream", "setup.exe") === null);
  ok("  and how one reads in the conversation", fileText("image/jpeg", "a.jpg", "my bill") === "[Photo] my bill" && fileText("application/pdf", "quote.pdf", null) === "[Document: quote.pdf]");
  ok(
    "files are allowed both ways unless switched off by name — a channel saved before the setting keeps them",
    channelSettings({}, "WEB").files.customers && channelSettings({}, "WEB").files.team && JSON.stringify(channelSettings({ files: { customers: false } }, "WHATSAPP").files) === JSON.stringify({ customers: false, team: true }),
  );
  const nameEmail = { name: "required", company: "off", email: "required", phone: "off" } as const;
  ok(
    "the form before the chat: each field required, optional or not asked, as the channel sets it",
    checkPrechat({ name: "Zz", email: "zz@example.com" }, nameEmail).ok &&
      !checkPrechat({ name: "Z", email: "zz@example.com" }, nameEmail).ok &&
      !checkPrechat({ name: "Zz", email: "not an email" }, nameEmail).ok &&
      !checkPrechat({ name: "Zz", email: "zz@example.com" }, { ...nameEmail, phone: "required" }).ok &&
      checkPrechat({ name: "Zz", email: "zz@example.com" }, { ...nameEmail, phone: "optional" }).ok &&
      !checkPrechat({ name: "Zz", email: "zz@example.com", phone: "call me" }, { ...nameEmail, phone: "optional" }).ok,
  );
  const phoneOnly = checkPrechat({ name: "Zz", email: "zz@example.com", phone: "+91 98765 43210" }, { name: "off", company: "off", email: "optional", phone: "required" });
  ok("  a field not asked is dropped even if sent; an optional one is kept", phoneOnly.ok && phoneOnly.details.name === null && phoneOnly.details.email === "zz@example.com" && phoneOnly.details.phone === "+91 98765 43210");
  ok(
    "  a form saved before fields could be chosen asks what it did; a form with nothing in it is refused",
    channelSettings({ prechat: { on: true, phone: true } }, "WEB").prechat.fields.phone === "required" &&
      channelSettings({ prechat: { on: true } }, "WEB").prechat.fields.phone === "off" &&
      !checkChannelSettings({ prechat: { on: true, fields: { name: "off", email: "off", phone: "off" } } }, "WEB").ok,
  );

  section("Which details: what the bot asks, what a lead waits for");
  const missing = (needs: Partial<import("../src/lib/inbox/settings").DetailNeeds>, known: Partial<Known>) =>
    detailsMissing({ name: false, company: false, email: false, phone: false, either: false, ...needs }, { name: null, email: null, phone: null, ...known }).join();
  ok(
    "what's missing, in the order asked: name, then a number or email where either will do — or each in turn",
    missing({ name: true, email: true, phone: true, either: true }, {}) === "name,contact" &&
      missing({ name: true, email: true, phone: true, either: true }, { name: "Zz", email: "a@b.co" }) === "" &&
      missing({ email: true, phone: true }, {}) === "phone,email" &&
      missing({ phone: true }, { email: "a@b.co" }) === "phone",
  );
  ok("  a company name comes after the name", missing({ name: true, company: true, email: true, phone: true, either: true }, { name: "Zz" }) === "company,contact");
  ok("  and in words, for the settings page", needsText({ name: true, company: false, email: true, phone: true, either: true }) === "a name and a phone number or email" && needsText({ name: true, company: false, email: true, phone: true, either: false }) === "a name, an email and a phone number");
  const askPhone: ChannelSettings = { ...bot, bot: { ...bot.bot, ask: { name: true, company: false, email: false, phone: true, either: false } } };
  const byPhone = talk(askPhone, "WEB", ["agent", "Zz Visitor", "zz@example.com", "98765 43210"]);
  ok("a bot set to ask for a phone number asks for one — an email isn't enough, though it's kept", byPhone.handover && byPhone.known.email === "zz@example.com" && byPhone.known.phone === "9876543210" && /number/i.test(byPhone.said[1] ?? "") && /number/i.test(byPhone.said[2] ?? ""), byPhone.said.join(" / "));
  const both: ChannelSettings = { ...bot, bot: { ...bot.bot, ask: { name: false, company: false, email: true, phone: true, either: false } } };
  const askedBoth = talk(both, "WEB", ["agent", "98765 43210", "zz@example.com"]);
  ok("  set to ask for both: one, then the other, then a person", askedBoth.handover && askedBoth.said.length === 3 && /number/i.test(askedBoth.said[0] ?? "") && /email/i.test(askedBoth.said[1] ?? ""), askedBoth.said.join(" / "));
  const given = talk(both, "WEB", ["agent: 98765 43210, zz@example.com"]);
  ok("  given both unasked: nothing asked, straight to a person", given.handover && given.said.length === 1);
  const stubbornPhone = talk(askPhone, "WEB", ["agent", "Zz", "no", "no"]);
  ok("  asked twice and not given: it lets it go and hands over", stubbornPhone.handover);
  const waEmail: ChannelSettings = { ...bot, bot: { ...bot.bot, ask: { name: true, company: false, email: true, phone: true, either: false } } };
  const waAsked = talk(waEmail, "WHATSAPP", ["agent", "Zz Wa", "zz@example.com"], { name: null, email: null, phone: "+919800000000" });
  ok("  on WhatsApp the number is never asked for — an email is, when set", waAsked.handover && waAsked.said.length === 3 && /email/i.test(waAsked.said[1] ?? ""), waAsked.said.join(" / "));
  ok("  and with nothing ticked, straight to a person", talk({ ...bot, bot: { ...bot.bot, ask: { name: false, company: false, email: false, phone: false, either: false } } }, "WEB", ["agent"]).handover);
  const withCompany: ChannelSettings = { ...bot, bot: { ...bot.bot, ask: { name: true, company: true, email: true, phone: true, either: true } } };
  const askedCompany = talk(withCompany, "WEB", ["agent", "Zz Visitor", "I'm with Zzprobe Traders", "98765 43210"]);
  ok("a bot set to ask for the company asks after the name, and keeps it", askedCompany.handover && /company/i.test(askedCompany.said[1] ?? "") && askedCompany.known.company === "Zzprobe Traders", askedCompany.said.join(" / "));
  ok("  a company name from how people say it — not a number, an email or a no", companyIn("We're from Acme Pvt Ltd.") === "Acme Pvt Ltd" && companyIn("company name: Zz & Co") === "Zz & Co" && companyIn("98765 43210") === null && companyIn("no") === null);
  ok("a number and an email in one message are both read", JSON.stringify(contactIn("call 98765 43210 or mail zz@x.com")) === JSON.stringify({ email: "zz@x.com", phone: "9876543210" }) && contactIn("zz9876543210@x.com").phone === undefined);
  ok(
    "a lead waits for what the channel says — and never without a number or email",
    defaultChannelSettings("WHATSAPP").leadNeeds.phone && !defaultChannelSettings("WHATSAPP").leadNeeds.name && !checkChannelSettings({ leadNeeds: { name: true, email: false, phone: false, either: false } }, "WEB").ok,
  );
  ok("a proactive message's page: '/pricing' and under it, '/' the home page alone, '*' every page", proactiveMatches("/pricing", "/pricing/one") && !proactiveMatches("/pricing", "/pricingx") && proactiveMatches("/", "/") && !proactiveMatches("/", "/about") && proactiveMatches("*", "/anything"));
  const proChecked = checkChannelSettings({ proactive: [{ path: "pricing", delay: 30, message: "Hi" }] }, "WEB");
  ok("  refused without a '/' or '*'; the wait kept between 3 seconds and 10 minutes", !proChecked.ok && channelSettings({ proactive: [{ path: "/a", delay: 1, message: "x" }, { path: "/b", delay: 9999, message: "y" }] }, "WEB").proactive.map((r) => r.delay).join() === "3,600");

  section("Phase 2's rules: why the bot hands over, office hours, the AI's brief, media");
  ok("the bot says why: a set answer, asked for a person, nothing fitted, taking details", talkReason(bot, "What does it cost?") === "answer" && talkReason(bot, "agent please") === "asked" && talkReason(bot, "Do you do SAP?") === "unknown" && botReply({ text: "Zz", settings: bot, state: { step: "name" }, known: { name: null, email: null, phone: null }, kind: "WEB" }).reason === "details");
  const hours = { ...web.hours, on: true };
  ok("office hours: in on a weekday's hours, out at closing, out on a closed Sunday", withinHours(hours, { weekday: 1, hour: 10, minute: 0 }) && !withinHours(hours, { weekday: 1, hour: 18, minute: 0 }) && !withinHours(hours, { weekday: 0, hour: 11, minute: 0 }) && withinHours(web.hours, { weekday: 0, hour: 3, minute: 0 }));
  const badHours = [
    checkChannelSettings({ hours: { on: true, days: { mon: { from: "25:00", to: "18:00" } } } }, "WEB"),
    checkChannelSettings({ hours: { on: true, days: { mon: { from: "18:00", to: "09:00" } } } }, "WEB"),
    checkChannelSettings({ bot: { ai: { on: true, about: "" } } }, "WEB"),
    checkChannelSettings({ bot: { ai: { on: true, about: "x".repeat(3001) } } }, "WEB"),
  ];
  ok("refused: a time that isn't one, closing before opening, the AI with nothing to go on, too long a brief", badHours.every((r) => !r.ok), badHours.map((r) => (r.ok ? "ok" : r.error)).join(" | "));
  const spoofed = checkChannelSettings({ bot: { answers: [{ keywords: "a", answer: "b" }], ai: { on: true, about: "We sell paint.", chargedTo: "someone" } } }, "WEB");
  ok("  a brief is kept as given (who it's charged to is the server's to set)", spoofed.ok && spoofed.settings.bot.ai.about === "We sell paint.");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const aiLib = require("../src/lib/inbox/ai") as typeof import("../src/lib/inbox/ai");
  const turns = aiLib.aiHistory([
    { author: "BOT", body: "Hi!" },
    { author: "CUSTOMER", body: "Do you deliver?" },
    { author: "CUSTOMER", body: "To Pune?" },
    { author: "SYSTEM", body: "x took it" },
  ]);
  ok("the AI sees the conversation taking turns, starting with the customer, without staff's notes", turns.length === 1 && turns[0].role === "user" && turns[0].text === "Do you deliver?\nTo Pune?");
  ok("  nor colleagues' private notes", aiLib.aiHistory([{ author: "CUSTOMER", body: "Hi" }, { author: "NOTE", body: "@Ravi VIP, careful" }]).every((x) => !("text" in x) || !x.text.includes("VIP")));
  const brief = aiLib.aiSystemPrompt({ ...bot, bot: { ...bot.bot, ai: { on: true, about: "We deliver across Maharashtra.", chargedTo: "x", pages: [], knowledge: false } } }, "Zz Traders");
  ok("  its brief: the business, the set answers, the notes, and when to hand over", brief.includes("Zz Traders") && brief.includes("PRICE") && brief.includes("We deliver across Maharashtra.") && brief.includes(aiLib.HANDOVER_MARK));
  section("Answers from the website: reading pages and finding passages");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const know = require("../src/lib/inbox/knowledge") as typeof import("../src/lib/inbox/knowledge");
  const page = know.pageText(
    `<html><head><title>Payroll &amp; HR — Zz</title><style>.x{}</style><script>var secret=1</script></head><body><nav>Home Pricing Login</nav><main><h1>Payroll</h1><p>Run payroll with PF, ESI and professional tax worked out for you.</p><p>Payslips go to every employee&#39;s email. ${"Filler words about payroll features and statutory filing. ".repeat(12)}</p></main><footer>© Zz</footer></body></html>`,
  );
  ok("a page's title and words — the main part, without its menu, scripts and styles", page.title === "Payroll & HR — Zz" && page.text.includes("PF, ESI and professional tax") && page.text.includes("employee's email") && !page.text.includes("secret") && !page.text.includes("Login"), page);
  ok("  a sitemap's pages; a sitemap index brings none", know.sitemapUrls("<urlset><url><loc>https://zz.example/a</loc></url><url><loc> https://zz.example/b </loc></url></urlset>").join() === "https://zz.example/a,https://zz.example/b" && know.sitemapUrls("<sitemapindex><sitemap><loc>https://zz.example/s.xml</loc></sitemap></sitemapindex>").length === 0);
  ok("  only the channel's allowed sites, when it names any", know.onAllowedSite("https://zz.example/x", ["https://zz.example"]) && !know.onAllowedSite("https://other.example/x", ["https://zz.example"]) && know.onAllowedSite("https://other.example/x", []));
  const corpus = [
    { url: "https://zz.example/payroll", title: "Payroll", text: "Run payroll with PF and ESI.", words: new Set(know.terms("Payroll Run payroll with PF and ESI.")) },
    { url: "https://zz.example/crm", title: "CRM", text: "Leads, deals and quotations.", words: new Set(know.terms("CRM Leads, deals and quotations.")) },
    { url: "https://zz.example/pricing", title: "Pricing", text: "One costs ₹1,499 a person a month.", words: new Set(know.terms("Pricing One costs a person a month.")) },
  ];
  const found = know.bestPassages(corpus, "do you have payroll with ESI?");
  ok("the passage that answers the question comes first; one that shares no word isn't sent", found[0]?.url === "https://zz.example/payroll" && !found.some((p) => p.url.endsWith("/crm")), found);
  ok("  a question with only small words finds nothing", know.bestPassages(corpus, "is it and the").length === 0);
  ok("  long pages in passages of about a paragraph", know.passagesOf("a".repeat(600) + "\n" + "b".repeat(600) + "\n" + "c".repeat(100)).length === 2);
  const withPages = aiLib.aiSystemPrompt({ ...bot, bot: { ...bot.bot, ai: { on: true, about: "", chargedTo: "x", pages: ["https://zz.example/sitemap.xml"], knowledge: false } } }, "Zz Traders", null, found);
  ok("  the AI is told the passages with their addresses, and may link them", withPages.includes("From the website:") && withPages.includes("https://zz.example/payroll") && withPages.includes("PF and ESI") && /give that page's address/.test(withPages));
  ok("  a channel with only pages to go on may switch the AI on; a page that isn't an address is refused", checkChannelSettings({ bot: { ai: { on: true, about: "", pages: ["https://zz.example/sitemap.xml"] } } }, "WEB").ok && !checkChannelSettings({ bot: { ai: { on: true, about: "x", pages: ["javascript:alert(1)"] } } }, "WEB").ok);
  const suggested = checkChannelSettings({ bot: { suggestions: ["Pricing", " ", "Book a demo", "Pricing"] } }, "WEB");
  ok("suggested questions: blanks and repeats dropped", suggested.ok && suggested.settings.bot.suggestions.join("|") === "Pricing|Book a demo", suggested.ok ? suggested.settings.bot.suggestions : suggested.error);
  ok("  at most four, each short enough for a button", !checkChannelSettings({ bot: { suggestions: ["a", "b", "c", "d", "e"] } }, "WEB").ok && !checkChannelSettings({ bot: { suggestions: ["x".repeat(41)] } }, "WEB").ok);
  ok("  the bubble draws them and takes them away once the visitor writes", WIDGET_SCRIPT.includes("showChips()") && WIDGET_SCRIPT.includes("hideChips()") && WIDGET_SCRIPT.includes("config.suggestions"));

  const photo = parseWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: "1" }, messages: [{ from: "91", id: "w1", type: "image", image: { id: "media-1", mime_type: "image/jpeg; codecs=x", caption: "bill" } }] } }] }] });
  ok("a photo's media id comes with it, its type without parameters", photo.messages[0]?.media?.id === "media-1" && photo.messages[0]?.media?.mime === "image/jpeg");

  section("Who the visitor is: the helpers");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vis = require("../src/lib/inbox/visitor") as typeof import("../src/lib/inbox/visitor");
  ok("a number's country by its calling code — the longest code wins", vis.countryOfNumber("919876543210") === "IN" && vis.countryOfNumber("14155550123") === "US" && vis.countryOfNumber("971501234567") === "AE" && vis.countryOfNumber("18095551234") === "DO" && vis.countryOfNumber("123") === null);
  ok("countries by name; Cloudflare's 'unknown' is nothing", vis.countryName("IN") === "India" && vis.countryName("XX") === null && vis.countryName("in") === "India");
  const place = vis.locationFromHeaders(new Headers({ "cf-ipcountry": "IN", "cf-ipcity": "Mumbai", "cf-region": "Maharashtra" }));
  ok("where, from Cloudflare's headers — nothing when they aren't there", vis.placeText(place) === "Mumbai, Maharashtra, India" && vis.locationFromHeaders(new Headers()).country === null && vis.placeText({ city: null, region: null, country: "AE" }) === "United Arab Emirates");
  ok(
    "the browser and system, from its description",
    vis.deviceFromUserAgent("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36") === "Chrome on Android" &&
      vis.deviceFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1") === "Safari on iPhone" &&
      vis.deviceFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0") === "Edge on Windows" &&
      vis.deviceFromUserAgent("") === null,
  );
  ok("a time zone and a language only when they're real", vis.validZone("Asia/Kolkata") === "Asia/Kolkata" && vis.validZone("Not/A_Zone") === null && vis.validLanguage("en-IN") === "en-IN" && vis.validLanguage("<b>") === null && vis.languageName("hi") === "Hindi");
  const trail = Array.from({ length: 12 }, (_, i) => `https://example.com/p${i}`).reduce<{ url: string; at: string }[]>((list, url) => vis.withPage(list, url, new Date()), []);
  ok("the pages: the last ten, and the same page twice running counts once", trail.length === 10 && trail[9]!.url.endsWith("/p11") && vis.withPage(trail, "https://example.com/p11", new Date()).length === 10 && vis.pagePath("https://example.com/pricing?plan=one") === "/pricing?plan=one");

  section("Response times: the arithmetic");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const reportLib = require("../src/lib/inbox/report") as typeof import("../src/lib/inbox/report");
  ok("median and the 90th percentile, nearest rank; nothing for none", reportLib.median([5, 1, 3]) === 3 && reportLib.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90) === 9 && reportLib.median([]) === null);
  ok("the share within a target", reportLib.shareWithin([1, 2, 10], 2) === 2 / 3 && reportLib.shareWithin([], 5) === null);
  const ist = clockFor("Asia/Kolkata");
  const weekdays = { ...web.hours, on: true };
  const at = (d: number, h: number, m: number) => ist.at(2026, 9, d, h, m);
  const MIN = 60_000;
  ok("office-hours time: Monday 17:30 answered Tuesday 09:15 is 45 minutes", reportLib.officeMs(at(26, 17, 30), at(27, 9, 15), weekdays, ist) === 45 * MIN);
  ok("  a Saturday message answered Monday 09:10 is 10 minutes", reportLib.officeMs(at(24, 11, 0), at(26, 9, 10), weekdays, ist) === 10 * MIN);
  ok("  without office hours it's the clock's time", reportLib.officeMs(at(24, 11, 0), at(26, 9, 10), web.hours, ist) === at(26, 9, 10).getTime() - at(24, 11, 0).getTime());
  const t = (m: number) => new Date(Date.UTC(2026, 9, 24, 10, m));
  const waits = reportLib.replyWaits([
    { conversationId: "a", author: "CUSTOMER", userId: null, at: t(0) },
    { conversationId: "a", author: "CUSTOMER", userId: null, at: t(2) },
    { conversationId: "a", author: "AGENT", userId: "u1", at: t(5) },
    { conversationId: "a", author: "AGENT", userId: "u1", at: t(6) },
    { conversationId: "a", author: "CUSTOMER", userId: null, at: t(10) },
    { conversationId: "a", author: "AGENT", userId: "u2", at: t(30) },
  ]);
  ok("every reply's wait runs from the first message the team hadn't answered; a second reply in a row isn't a wait", waits.length === 2 && waits[0].at.getTime() - waits[0].from.getTime() === 5 * MIN && waits[1].userId === "u2" && waits[1].at.getTime() - waits[1].from.getTime() === 20 * MIN);
  ok("durations as people say them", reportLib.durationText(45_000) === "45 s" && reportLib.durationText(12 * MIN) === "12 min" && reportLib.durationText(185 * MIN) === "3 h 5 min" && reportLib.durationText(52 * 60 * MIN) === "2 d 4 h" && reportLib.durationText(null) === "—");

  /* eslint-disable @typescript-eslint/no-require-imports */
  const server = require("../src/lib/inbox/server") as typeof import("../src/lib/inbox/server");
  const whatsapp = require("../src/lib/inbox/whatsapp") as typeof import("../src/lib/inbox/whatsapp");
  const actions = require("../src/actions/inbox") as typeof import("../src/actions/inbox");
  const team = require("../src/lib/inbox/team") as typeof import("../src/lib/inbox/team");
  const followUp = require("../src/lib/inbox/follow-up") as typeof import("../src/lib/inbox/follow-up");
  const bus = require("../src/lib/chat/bus") as typeof import("../src/lib/chat/bus");
  const { tenantKey } = require("../src/lib/tenancy/cache") as typeof import("../src/lib/tenancy/cache");
  const { setTestPlatformMailer } = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const sent: import("../src/lib/inbox/whatsapp").WhatsAppOutbound[] = [];
  let failNext: string | null = null;
  whatsapp.setTestWhatsAppSender(async (m) => {
    if (failNext) {
      const error = failNext;
      failNext = null;
      return { ok: false, error };
    }
    sent.push(m);
    return { ok: true, id: `wamid.zzout${sent.length}` };
  });
  setTestPlatformMailer(async () => {});
  // No pauses between the bot's messages here, and every read receipt and "typing…" kept instead of sent.
  server.setInboxPacing(false);
  const reads: { messageId: string; typing: boolean }[] = [];
  whatsapp.setTestWhatsAppRead(async ({ messageId, typing }) => {
    reads.push({ messageId, typing });
    return true;
  });
  const mailed: import("../src/lib/inbox/follow-up").FollowUpMail[] = [];
  followUp.setTestFollowUpMailer(async (mail) => {
    mailed.push(mail);
  });

  await cleanup();
  try {
    const user = (name: string, role: string) => db.user.create({ data: { name: `Zzprobe ${name}`, email: `${name.toLowerCase()}${MAIL}`, role: role as never, active: true, passwordHash: "!zzprobe-no-sign-in" }, select: { id: true } });
    const [agent, rep, manager, outsider, admin] = [await user("Agent", "SUPPORT"), await user("Rep", "SALES"), await user("Manager", "MANAGEMENT"), await user("Outsider", "ACCOUNTS"), await user("Admin", "ADMIN")];
    const A = { id: agent.id, viewAll: false };
    const R = { id: rep.id, viewAll: false };
    const M = { id: manager.id, viewAll: true };

    section("Who may use it");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
    ok("support, sales and management answer customer conversations; accounts doesn't", (await can(agent.id, "inbox.view")) && (await can(rep.id, "inbox.view")) && (await can(manager.id, "inbox.view")) && !(await can(outsider.id, "inbox.view")));
    ok("  only management sees every one", (await can(manager.id, "inbox.viewAll")) && !(await can(agent.id, "inbox.viewAll")));

    const webChannel = await db.inboxChannel.create({ data: { kind: "WEB", name: `${TAG} site`, publicKey: `zzprobe${Date.now()}`, settings: bot as object, createdById: manager.id } });
    const shared = await db.inboxChannel.create({ data: { kind: "WHATSAPP", name: `${TAG} shared`, phoneNumberId: PHONE_IDS[0], settings: defaultChannelSettings("WHATSAPP") as object, createdById: manager.id } });
    const own = await db.inboxChannel.create({ data: { kind: "WHATSAPP", name: `${TAG} rep`, phoneNumberId: PHONE_IDS[1], ownerUserId: rep.id, settings: { ...defaultChannelSettings("WHATSAPP"), autoLead: false } as object, createdById: manager.id } });
    const tenantId = await tenantKey();
    const heard: string[] = [];
    const started: string[] = [];
    const unsubscribe = bus.subscribe(tenantId, agent.id, (e) => {
      if (e.type !== "inbox") return;
      heard.push(e.conversationId);
      if (e.started) started.push(e.conversationId);
    });

    section("A website visitor and the bot");
    const first = await server.receiveWebMessage(webChannel, { text: "How much does it cost?", pageUrl: "https://example.com/pricing" });
    const seen1 = (await server.webMessages(webChannel.id, first.token, null)) ?? [];
    ok("a new conversation: the greeting, their message, the set answer, a check-in", seen1.slice(0, 3).map((m) => `${m.from}:${m.body}`).join(" | ") === `bot:${bot.greeting} | you:How much does it cost? | bot:PRICE` && seen1.length === 4 && seen1[3].from === "bot", seen1.map((m) => m.body).join(" | "));
    ok("  the token is theirs alone: a wrong one, or another channel's, reads nothing", (await server.webMessages(webChannel.id, "x".repeat(32), null)) === null && (await server.webMessages(shared.id, first.token, null)) === null);
    ok("  and the change was announced, by id", heard.includes(first.conversationId));
    const again = await server.receiveWebMessage(webChannel, { token: first.token, text: "Can I speak to someone?" });
    ok("the same token keeps the same conversation", again.conversationId === first.conversationId && again.token === first.token);
    await server.receiveWebMessage(webChannel, { token: first.token, text: "I'm Zzprobe Visitor" });
    await server.receiveWebMessage(webChannel, { token: first.token, text: `zz-visitor@${DOMAIN}` });
    const visitor = await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId }, include: { lead: { select: { source: true, leadSeq: true } } } });
    ok("the bot asked, learned their name and email, and handed over", !visitor.botActive && visitor.customerName === "Zzprobe Visitor" && visitor.customerEmail === `zz-visitor@${DOMAIN}`);
    ok("  and a lead was made, from the website chat", visitor.lead?.source === "LIVE_CHAT" && !!visitor.contactId && !!visitor.companyId, visitor.lead ? `L${visitor.lead.leadSeq}` : "no lead");
    const visitorCompany = visitor.companyId ? await db.company.findUnique({ where: { id: visitor.companyId }, select: { name: true } }) : null;
    ok("  no company named: it goes on their own name", visitorCompany?.name === "Zzprobe Visitor", visitorCompany?.name);

    section("Staff and the website conversation");
    const queue = await server.listConversations(A, { view: "unassigned" });
    const row = queue.find((r) => r.id === first.conversationId);
    ok("it waits in the queue, unread", !!row && row.unread && row.customer === "Zzprobe Visitor" && row.kind === "WEB");
    const detail = await server.conversationDetail(A, first.conversationId);
    ok("opened: every message, and the lead on file", !!detail && detail.messages.length >= 8 && !!detail.lead && detail.windowOpen);
    ok("  and now read", !(await server.listConversations(A, { view: "unassigned" })).find((r) => r.id === first.conversationId)?.unread);
    const reply = await server.staffReply(A, first.conversationId, "Hi, Agent here — happy to help.");
    const afterReply = await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId } });
    ok("a reply: kept, theirs now, the first response timed", reply.ok && afterReply.assignedToUserId === agent.id && !!afterReply.firstResponseAt);
    const visitorSees = (await server.webMessages(webChannel.id, first.token, null)) ?? [];
    ok("  the visitor sees it, with a first name only", visitorSees.some((m) => m.from === "agent" && m.name === "Zzprobe" && m.body.startsWith("Hi, Agent here")));
    ok("  and none of staff's notes to each other", visitorSees.every((m) => m.from !== ("system" as never)));
    ok("an empty reply, or a long one, is refused", !(await server.staffReply(A, first.conversationId, "   ")).ok && !(await server.staffReply(A, first.conversationId, "x".repeat(2001))).ok);

    section("WhatsApp");
    const at = new Date();
    const newNumber = { phoneNumberId: PHONE_IDS[0], from: "919900000901", profileName: "Zzprobe Wa", id: `wamid.zzin${Date.now()}`, at, text: "Hello, do you deliver to Pune?" };
    ok("a message from a new number is kept", (await server.receiveWhatsApp(newNumber)) === "stored");
    ok("  Meta's retry of it is skipped", (await server.receiveWhatsApp(newNumber)) === "duplicate");
    ok("  a number the inbox doesn't have is left alone", (await server.receiveWhatsApp({ ...newNumber, phoneNumberId: "990000000999", id: `${newNumber.id}x` })) === "no-channel");
    const waConv = await db.conversation.findFirstOrThrow({ where: { channelId: shared.id, waId: "919900000901" }, include: { lead: { select: { source: true } } } });
    ok("a lead from its first message, from WhatsApp, with the profile name and number", waConv.lead?.source === "WHATSAPP" && waConv.customerName === "Zzprobe Wa" && waConv.customerPhone === "+919900000901");
    ok("  the bot is off on a new number, so nothing was sent", sent.length === 0 && !waConv.botActive);

    const known = await db.company.create({ data: { name: "Zzprobe Known Co", normalizedName: `zzprobe known co ${Date.now()}`, relationshipType: "CLIENT", createdById: manager.id, ownerUserId: agent.id }, select: { id: true } });
    const contact = await db.contact.create({ data: { companyId: known.id, name: "Zzprobe Known Person", phone: "+91 99000 00902" } as never, select: { id: true } });
    await server.receiveWhatsApp({ ...newNumber, from: "919900000902", profileName: "Someone", id: `wamid.zzknown${Date.now()}`, text: "Hi again" });
    const linked = await db.conversation.findFirstOrThrow({ where: { channelId: shared.id, waId: "919900000902" } });
    ok("a number already on file links to its contact — however it was typed — and makes no lead", linked.contactId === contact.id && linked.companyId === known.id && !linked.leadId);
    // A number typed into the website chat stands for somebody on file only when the name agrees too.
    const stranger = await server.receiveWebMessage(webChannel, { text: "Hello", name: "Dipesh Bachhish", email: `stranger@${DOMAIN}`, phone: "99000 00902" });
    const strangerRow = await db.conversation.findUniqueOrThrow({ where: { id: stranger.conversationId }, select: { contactId: true } });
    ok("a website visitor with someone else's number but another name isn't taken for them", strangerRow.contactId !== contact.id && (await server.conversationDetail(M, stranger.conversationId))?.previousConversations === 0);
    const sameName = await server.receiveWebMessage(webChannel, { text: "Hello again", name: "Zzprobe Known Person", phone: "+91 99000 00902" });
    // Security audit, 11 Nov 2026 (SEC-47): a typed number is never linked on its own — the team is offered it to confirm.
    const sameNameDetail = await server.conversationDetail(A, sameName.conversationId);
    ok(
      "  the same number with the same name is suggested, not linked",
      (await db.conversation.findUniqueOrThrow({ where: { id: sameName.conversationId }, select: { contactId: true } })).contactId === null && sameNameDetail?.couldBe.length === 1 && sameNameDetail.couldBe[0]!.contactId === contact.id,
    );
    // One person, two companies, one number (owner, 25 Oct 2026).
    const twinCos = [];
    for (const label of ["One", "Two"]) {
      const co = await db.company.create({ data: { name: `Zzprobe Twin ${label} Pvt Ltd`, normalizedName: `zzprobe twin ${label.toLowerCase()} pvt ltd ${Date.now()}`, relationshipType: "CLIENT", createdById: manager.id, ownerUserId: agent.id }, select: { id: true } });
      const person = await db.contact.create({ data: { companyId: co.id, name: "Zzprobe Twin", phone: "+91 99000 00950" } as never, select: { id: true } });
      twinCos.push({ companyId: co.id, contactId: person.id });
    }
    const twinChat = await server.receiveWebMessage(webChannel, { text: "Hi", name: "Zzprobe Twin", email: `twin@${DOMAIN}`, phone: "99000 00950" });
    const twinRow = await db.conversation.findUniqueOrThrow({ where: { id: twinChat.conversationId }, select: { contactId: true, leadId: true } });
    const twinDetail = await server.conversationDetail(A, twinChat.conversationId);
    ok("one number on file for two companies: not guessed — the team is asked which, and no lead made meanwhile", !twinRow.contactId && !twinRow.leadId && twinDetail?.couldBe.length === 2 && twinDetail.couldBe.every((o) => o.contactName === "Zzprobe Twin"));
    const named2 = await server.receiveWebMessage(webChannel, { text: "Hi", name: "Zzprobe Twin", company: "Zzprobe Twin Two", phone: "99000 00950" });
    const named2Detail = await server.conversationDetail(A, named2.conversationId);
    ok("  the company name they give picks the right one to suggest (SEC-47: not linked)", named2Detail?.couldBe.length === 1 && named2Detail.couldBe[0]!.companyId === twinCos[1]!.companyId);
    ok("  a contact that isn't one of them can't be chosen", !(await server.staffLinkCustomer(A, twinChat.conversationId, contact.id)).ok);
    const chosen = await server.staffLinkCustomer(A, twinChat.conversationId, twinCos[0]!.contactId);
    const chosenRow = await db.conversation.findUniqueOrThrow({ where: { id: twinChat.conversationId }, select: { contactId: true, companyId: true } });
    ok("  a person chooses: linked, with a line saying who chose", chosen.ok && chosenRow.contactId === twinCos[0]!.contactId && chosenRow.companyId === twinCos[0]!.companyId && (await server.conversationDetail(A, twinChat.conversationId))?.couldBe.length === 0 && !!(await db.conversationMessage.findFirst({ where: { conversationId: twinChat.conversationId, author: "SYSTEM", body: { contains: "linked it to" } } })));
    const unlinked = await server.staffUnlinkCustomer(A, twinChat.conversationId);
    ok("  and 'not them' undoes it", unlinked.ok && !(await db.conversation.findUniqueOrThrow({ where: { id: twinChat.conversationId }, select: { contactId: true } })).contactId);
    ok(
      "  a typed company name is a company's when its own words are all there",
      server.sameCompany("Trevento", "Trevento Media Pvt Ltd") && server.sameCompany("trevento media private limited", "Trevento Media Pvt. Ltd.") && !server.sameCompany("Acme Foods", "Acme Steel Ltd") && !server.sameCompany("", "Acme"),
    );
    ok(
      "  the rule: WhatsApp's number always; a typed one with a shared name, or with nothing else to go on",
      server.numberMatches("WHATSAPP", { name: "Someone", email: null }, { name: "Zz Person" }) &&
        server.numberMatches("WEB", { name: "Priya S", email: null }, { name: "Priya Sharma" }) &&
        server.numberMatches("WEB", { name: null, email: null }, { name: "Priya Sharma" }) &&
        !server.numberMatches("WEB", { name: "Dipesh Bachhish", email: null }, { name: "Sachin Chauhan" }) &&
        !server.numberMatches("WEB", { name: null, email: "d@x.com" }, { name: "Sachin Chauhan" }),
    );

    const replyWa = await server.staffReply(A, waConv.id, "Yes, we do!");
    ok("a reply on WhatsApp goes out through Meta, from the conversation's number", replyWa.ok && sent.length === 1 && "text" in sent[0] && sent[0].phoneNumberId === PHONE_IDS[0] && sent[0].to === "919900000901");
    const outId = "wamid.zzout1";
    await server.applyWhatsAppStatus({ id: outId, status: "DELIVERED", error: null });
    await server.applyWhatsAppStatus({ id: outId, status: "READ", error: null });
    await server.applyWhatsAppStatus({ id: outId, status: "DELIVERED", error: null });
    ok("receipts only move forward: read stays read", (await db.conversationMessage.findUniqueOrThrow({ where: { externalId: outId } })).delivery === "READ");
    failNext = "Meta said no";
    const failed = await server.staffReply(A, waConv.id, "This one fails");
    ok("a send Meta refuses is refused here too, and not kept", !failed.ok && failed.error === "Meta said no" && !(await db.conversationMessage.findFirst({ where: { conversationId: waConv.id, body: "This one fails" } })));
    await db.conversation.update({ where: { id: waConv.id }, data: { lastCustomerAt: new Date(Date.now() - 25 * 3_600_000) } });
    const late = await server.staffReply(A, waConv.id, "Still there?");
    ok("over 24 hours since they wrote: free text is refused", !late.ok && /24 hours/.test(late.error));
    ok("  a template's name must be Meta's, and every value filled", !(await server.staffTemplate(A, waConv.id, { name: "Order Update", variables: [] })).ok && !(await server.staffTemplate(A, waConv.id, { name: "order_update", variables: ["Zz", ""] })).ok);
    const template = await server.staffTemplate(A, waConv.id, { name: "order_update", variables: ["Zz", "42"] });
    ok("  a template goes", template.ok && "template" in sent[sent.length - 1] && (sent[sent.length - 1] as { template: { name: string; variables: string[] } }).template.variables.join() === "Zz,42");

    section("A rep's own number");
    await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[1], from: "919900000903", profileName: "Zzprobe Own", id: `wamid.zzown${Date.now()}`, at: new Date(), text: "Hi, it's me" });
    const ownConv = await db.conversation.findFirstOrThrow({ where: { channelId: own.id } });
    ok("theirs from the start, and they are told", ownConv.assignedToUserId === rep.id && (await db.notification.count({ where: { userId: rep.id, type: "INBOX_MESSAGE" } })) === 1);
    ok("  this channel makes no leads", !ownConv.leadId);
    ok("a colleague can't see it, open it or reply", !(await server.listConversations(A, { view: "open" })).some((r) => r.id === ownConv.id) && (await server.conversationDetail(A, ownConv.id)) === null && !(await server.staffReply(A, ownConv.id, "hi")).ok);
    ok("  the rep and management can", (await server.listConversations(R, { view: "mine" })).some((r) => r.id === ownConv.id) && (await server.conversationDetail(M, ownConv.id)) !== null);
    ok("a customer beginning a conversation is announced as new — once — so screens can chime", started.includes(first.conversationId) && started.filter((id) => id === first.conversationId).length === 1 && started.includes(ownConv.id));
    ok("  it chimes for whoever may see it, not a colleague who can't", (await server.chimesFor(A, first.conversationId)) && (await server.chimesFor(R, ownConv.id)) && !(await server.chimesFor(A, ownConv.id)));
    ok("  an old one doesn't", !(await server.chimesFor(A, first.conversationId, Date.now() + 10 * 60_000)));

    section("Assigning, closing, tickets");
    ok("it can't go to somebody who doesn't answer customers", !(await server.assignConversation(A, waConv.id, outsider.id)).ok);
    const given = await server.assignConversation(A, waConv.id, rep.id);
    ok("given to a colleague: theirs, a note in the conversation, and they're told", given.ok && (await db.conversation.findUniqueOrThrow({ where: { id: waConv.id } })).assignedToUserId === rep.id && (await db.notification.count({ where: { userId: rep.id, type: "INBOX_MESSAGE" } })) === 2 && !!(await db.conversationMessage.findFirst({ where: { conversationId: waConv.id, author: "SYSTEM", body: { contains: "gave it to" } } })));
    ok("closed", (await server.setConversationStatus(A, first.conversationId, "CLOSED")).ok && (await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId } })).status === "CLOSED");
    await server.receiveWebMessage(webChannel, { token: first.token, text: "One more thing" });
    ok("  and reopened by the customer writing again", (await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId } })).status === "OPEN");
    ok("a ticket needs a customer on file", !(await server.staffMakeTicket(A, ownConv.id, "Help")).ok);
    // The account is whoever the assignment rules gave the lead to: management reaches it, and opens the ticket.
    const ticket = await server.staffMakeTicket(M, first.conversationId, "Zzprobe needs help");
    ok("a ticket from a linked conversation, with what was said", ticket.ok && !!(await db.ticket.findFirst({ where: { title: "Zzprobe needs help", description: { contains: "How much does it cost?" } } })), ticket.ok ? "" : ticket.error);
    ok("  only once", !(await server.staffMakeTicket(M, first.conversationId, "Again")).ok);
    const lead = await server.staffMakeLead(A, waConv.id);
    ok("making a lead where there is one gives that one", lead.ok && lead.reference !== null && lead.leadId === waConv.leadId);

    section("Phase 2: Deskzo AI, office hours, round-robin, workflows, files");
    // Deskzo AI through the inbox's stand-in: nothing ever reaches a model.
    const asked: { system: string; last: string; chargedTo: string }[] = [];
    let aiSays = "We deliver across India in 3–5 days.";
    aiLib.setTestInboxAi(async ({ system, history, chargedTo }) => {
      const last = history[history.length - 1];
      asked.push({ system, last: last && last.role === "user" ? last.text : "", chargedTo });
      return aiSays;
    });
    const aiSettings = { ...bot, bot: { ...bot.bot, ai: { on: true, about: "We deliver across India.", chargedTo: admin.id } } };
    const aiChannel = await db.inboxChannel.create({ data: { kind: "WEB", name: `${TAG} ai`, publicKey: `zzprobeai${Date.now()}`, settings: aiSettings as object, createdById: admin.id } });
    const aiConv = await server.receiveWebMessage(aiChannel, { text: "Do you deliver to Kerala?" });
    const aiSeen = (await server.webMessages(aiChannel.id, aiConv.token, null)) ?? [];
    ok("a question the set answers don't cover: Deskzo AI answers, and the bot keeps the conversation", aiSeen.some((m) => m.from === "bot" && m.body === aiSays) && (await db.conversation.findUniqueOrThrow({ where: { id: aiConv.conversationId } })).botActive);
    ok("  told the brief and the customer's words, charged as whoever switched it on", asked.length === 1 && asked[0].system.includes("We deliver across India.") && asked[0].last === "Do you deliver to Kerala?" && asked[0].chargedTo === admin.id);
    await server.receiveWebMessage(aiChannel, { token: aiConv.token, text: "What does it cost?" });
    ok("  a set answer still comes first, without asking the AI", asked.length === 1);
    aiSays = "HANDOVER";
    await server.receiveWebMessage(aiChannel, { token: aiConv.token, text: "Can you fix my broken order?" });
    const afterAi = (await server.webMessages(aiChannel.id, aiConv.token, null)) ?? [];
    ok("when it isn't sure, the bot goes towards a person (asking their name first)", asksName(afterAi[afterAi.length - 1]?.body) || asksNameAndContact(afterAi[afterAi.length - 1]?.body));
    await server.receiveWebMessage(webChannel, { text: "Do you deliver to Goa?" });
    ok("a channel without the AI never asks it", asked.length === 2);

    // Answers from the website (owner, 31 Oct 2026): pages read through the stand-in fetcher, never the network.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const knowledge = require("../src/lib/inbox/knowledge") as typeof import("../src/lib/inbox/knowledge");
    const fetched: string[] = [];
    knowledge.setTestKnowledgeFetch(async (url) => {
      fetched.push(url);
      if (url.endsWith("/sitemap.xml")) return { status: 200, contentType: "application/xml", url, body: "<urlset><url><loc>https://zz-site.example/payroll</loc></url><url><loc>https://zz-site.example/gone</loc></url><url><loc>https://evil.example/x</loc></url></urlset>" };
      if (url.endsWith("/gone")) return { status: 404, contentType: "text/html", url, body: "" };
      return { status: 200, contentType: "text/html; charset=utf-8", url, body: "<title>Payroll</title><main><p>Zz payroll works out PF, ESI and professional tax, and emails every payslip. It runs on the first of each month for every employee on the rolls.</p></main>" };
    });
    const siteSettings = { ...bot, allowedSites: ["https://zz-site.example"], bot: { ...bot.bot, ai: { on: true, about: "", chargedTo: admin.id, pages: ["https://zz-site.example/sitemap.xml"] } } };
    const siteChannel = await db.inboxChannel.create({ data: { kind: "WEB", name: `${TAG} site`, publicKey: `zzprobesite${Date.now()}`, settings: siteSettings as object, createdById: admin.id } });
    const report = await knowledge.readChannelPages(siteChannel.id);
    ok("the sitemap's pages read; one gone is reported; one on another site is left out", report.read === 1 && report.failed.length === 1 && report.failed[0]!.url.endsWith("/gone") && report.skipped.includes("https://evil.example/x") && !fetched.includes("https://evil.example/x"), report);
    const stateNow = await knowledge.channelPagesState(siteChannel.id);
    ok("  what it read is kept, with the page that failed", stateNow?.pages === 1 && stateNow.failed.length === 1, stateNow);
    asked.length = 0;
    aiSays = "Yes — it works out PF and ESI for you: https://zz-site.example/payroll";
    const siteConv = await server.receiveWebMessage(siteChannel, { text: "Does your payroll handle ESI?" });
    ok("a customer's question: the AI is told the page that answers it, and answers", asked.length === 1 && asked[0]!.system.includes("https://zz-site.example/payroll") && asked[0]!.system.includes("professional tax") && ((await server.webMessages(siteChannel.id, siteConv.token, null)) ?? []).some((m) => m.body === aiSays));
    knowledge.setTestKnowledgeFetch(async (url) => ({ status: 503, contentType: "text/html", url, body: "" }));
    await knowledge.readChannelPages(siteChannel.id);
    ok("  the site down for a moment: the words it had are kept", (await knowledge.channelPagesState(siteChannel.id))?.pages === 1);
    knowledge.setTestKnowledgeFetch(null);
    aiSays = "HANDOVER";

    actorId = admin.id;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const adminActions = require("../src/actions/inbox-admin") as typeof import("../src/actions/inbox-admin");
    const saved = await adminActions.saveInboxChannel({ id: aiChannel.id, kind: "WEB", name: `${TAG} ai`, settings: { ...aiSettings, bot: { ...aiSettings.bot, ai: { on: true, about: "Paint.", chargedTo: outsider.id } } } });
    ok("the AI is charged as whoever switched it on — never whom the form names", saved.ok && channelSettings((await db.inboxChannel.findUniqueOrThrow({ where: { id: aiChannel.id } })).settings, "WEB").bot.ai.chargedTo === admin.id, saved.ok ? "" : saved.error);
    await adminActions.saveInboxChannel({ id: aiChannel.id, kind: "WEB", name: `${TAG} ai`, settings: { ...aiSettings, bot: { ...aiSettings.bot, ai: { on: false, about: "Paint.", chargedTo: admin.id } } } });
    ok("  switched off, it's charged to nobody", channelSettings((await db.inboxChannel.findUniqueOrThrow({ where: { id: aiChannel.id } })).settings, "WEB").bot.ai.chargedTo === null);
    actorId = "";

    const closed = { on: true, days: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null }, away: "Zz — we're away" };
    const awayChannel = await db.inboxChannel.create({ data: { kind: "WHATSAPP", name: `${TAG} away`, phoneNumberId: PHONE_IDS[2], settings: { ...defaultChannelSettings("WHATSAPP"), autoLead: false, hours: closed } as object, createdById: admin.id } });
    const sentBefore = sent.length;
    await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[2], from: "919900000904", profileName: "Zzprobe Late", id: `wamid.zzaway${Date.now()}`, at: new Date(), text: "Hello?" });
    const awayConv = await db.conversation.findFirstOrThrow({ where: { channelId: awayChannel.id } });
    const lastSent = sent[sent.length - 1];
    ok("outside office hours a customer waiting for a person is told so", sent.length === sentBefore + 1 && !!lastSent && "text" in lastSent && lastSent.text === "Zz — we're away" && !!awayConv.awayNoticeAt);
    await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[2], from: "919900000904", profileName: "Zzprobe Late", id: `wamid.zzaway2${Date.now()}`, at: new Date(), text: "Anyone?" });
    ok("  once — not again on their next message", sent.length === sentBefore + 1);

    const turnsChannel = await db.inboxChannel.create({ data: { kind: "WHATSAPP", name: `${TAG} turns`, phoneNumberId: PHONE_IDS[3], settings: { ...defaultChannelSettings("WHATSAPP"), autoLead: false, assign: { mode: "rotate", people: [agent.id, rep.id] } } as object, createdById: admin.id } });
    // Round-robin gives conversations only to people in Deskzo now and not away.
    await team.setAvailability(agent.id, "ONLINE");
    await team.setAvailability(rep.id, "ONLINE");
    const inTurn: (string | null)[] = [];
    for (let i = 0; i < 3; i += 1) {
      await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[3], from: `91990000091${i}`, profileName: `Zzprobe Turn ${i}`, id: `wamid.zzturn${i}${Date.now()}`, at: new Date(), text: "Hi" });
      inTurn.push((await db.conversation.findFirstOrThrow({ where: { channelId: turnsChannel.id, waId: `91990000091${i}` } })).assignedToUserId);
    }
    ok("round-robin: each new conversation to the next person, and round again", inTurn.join() === [agent.id, rep.id, agent.id].join());
    ok("  with a note in the conversation, and the person told it's their turn", !!(await db.conversationMessage.findFirst({ where: { conversation: { channelId: turnsChannel.id }, author: "SYSTEM", body: { contains: "in turn" } } })) && (await db.notification.count({ where: { userId: agent.id, type: "INBOX_MESSAGE", title: { contains: "your turn" } } })) === 2);
    const turnOf = async (i: number) => {
      await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[3], from: `91990000091${i}`, profileName: `Zzprobe Turn ${i}`, id: `wamid.zzturn${i}${Date.now()}`, at: new Date(), text: "Hi" });
      return (await db.conversation.findFirstOrThrow({ where: { channelId: turnsChannel.id, waId: `91990000091${i}` } })).assignedToUserId;
    };
    ok("  where somebody is away, their turn passes to the next person here", (await team.setAvailability(rep.id, "AWAY")).ok && (await turnOf(3)) === agent.id && (await team.availabilityOf(rep.id)) === "AWAY");
    await db.inboxAgentStatus.update({ where: { userId: agent.id }, data: { lastActiveAt: new Date(Date.now() - 20 * 60_000) } });
    ok("  and with nobody here — away, or not in Deskzo for ten minutes — it waits in the queue", (await turnOf(4)) === null && (await server.availableOf([agent.id, rep.id])).length === 0);
    await team.setAvailability(agent.id, "ONLINE");
    await team.setAvailability(rep.id, "ONLINE");
    await team.touchActive(manager.id);
    ok("  an open screen marks its person here", (await db.inboxAgentStatus.findUnique({ where: { userId: manager.id } }))?.status === "ONLINE");

    const events = await db.automationEvent.findMany({ where: { recordType: "conversation", recordId: { in: [aiConv.conversationId, awayConv.id] } }, select: { type: true, recordId: true, payload: true } });
    ok("workflows hear of it: a conversation started; one that needs a person", events.some((e) => e.recordId === aiConv.conversationId && e.type === "conversation.started") && events.some((e) => e.recordId === awayConv.id && e.type === "conversation.needs_person") && !events.some((e) => e.recordId === aiConv.conversationId && e.type === "conversation.needs_person"));
    const startedPayload = JSON.stringify(events.find((e) => e.recordId === awayConv.id && e.type === "conversation.started")?.payload ?? {});
    ok("  with what a workflow needs: its number, the customer, the first message", startedPayload.includes("CNV-") && startedPayload.includes("Zzprobe Late") && startedPayload.includes("Hello?"));

    let fetches = 0;
    whatsapp.setTestWhatsAppMedia(async (mediaId) => {
      fetches += 1;
      return mediaId === "zz-media-1" ? { ok: true, bytes: Buffer.from("zz-jpeg-bytes"), mime: "image/jpeg" } : { ok: false, error: "WhatsApp no longer has this file." };
    });
    await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[0], from: "919900000901", profileName: "Zzprobe Wa", id: `wamid.zzphoto${Date.now()}`, at: new Date(), text: "[Photo] my bill", media: { id: "zz-media-1", mime: "image/jpeg", name: null } });
    const photoMsg = await db.conversationMessage.findFirstOrThrow({ where: { mediaId: "zz-media-1" } });
    const opened = await server.conversationFile(A, photoMsg.id);
    const openedAgain = await server.conversationFile(A, photoMsg.id);
    ok("a photo: fetched from WhatsApp the first time it's opened, kept after that", opened.ok && opened.bytes.toString() === "zz-jpeg-bytes" && openedAgain.ok && fetches === 1);
    ok("  and shown in its conversation", (await server.conversationDetail(A, photoMsg.conversationId))?.messages.some((m) => m.id === photoMsg.id && m.media?.mime === "image/jpeg") === true);
    await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[1], from: "919900000903", profileName: "Zzprobe Own", id: `wamid.zzpdf${Date.now()}`, at: new Date(), text: "[Document: quote.pdf]", media: { id: "zz-media-2", mime: "application/pdf", name: "quote.pdf" } });
    const ownFile = await db.conversationMessage.findFirstOrThrow({ where: { mediaId: "zz-media-2" } });
    const notYours = await server.conversationFile(A, ownFile.id);
    ok("  a file in a conversation somebody can't see is not found, and not fetched", !notYours.ok && notYours.status === 404 && fetches === 1);
    const gone = await server.conversationFile(R, ownFile.id);
    ok("  one WhatsApp no longer has says so", !gone.ok && gone.status === 502 && /no longer/.test(gone.error));

    section("Like a person: blue ticks, typing, seen");
    await db.inboxChannel.create({ data: { kind: "WHATSAPP", name: `${TAG} bot wa`, phoneNumberId: PHONE_IDS[4], settings: { ...defaultChannelSettings("WHATSAPP"), autoLead: false, bot: { ...bot.bot, on: true } } as object, createdById: admin.id } });
    const readsBefore = reads.length;
    const sentBeforeBot = sent.length;
    const askId = `wamid.zzask${Date.now()}`;
    await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[4], from: "919900000920", profileName: "Zzprobe Asker", id: askId, at: new Date(), text: "What does it cost?" });
    const botTexts = sent.slice(sentBeforeBot).map((m) => ("text" in m ? m.text : ""));
    ok("on WhatsApp the bot reads the message (blue ticks) and shows 'typing…' before each reply", reads.slice(readsBefore).length === botTexts.length && reads.slice(readsBefore).every((r) => r.messageId === askId && r.typing) && botTexts.includes("PRICE"), botTexts.join(" / "));
    ok("  greeting, answer, check-in — three short messages, as a person sends them", botTexts.length === 3 && botTexts[0] === bot.greeting && botTexts[1] === "PRICE");

    const readsBeforeOpen = reads.length;
    await server.conversationDetail(A, (await db.conversation.findFirstOrThrow({ where: { channelId: shared.id, waId: "919900000902" } })).id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const knownLast = await db.conversationMessage.findFirstOrThrow({ where: { conversation: { channelId: shared.id, waId: "919900000902" }, author: "CUSTOMER" }, orderBy: { createdAt: "desc" } });
    ok("a WhatsApp conversation opened by the team: the customer's message marked read — their blue ticks", reads.slice(readsBeforeOpen).some((r) => r.messageId === knownLast.externalId && !r.typing) && knownLast.delivery === "READ");
    const readsBeforeAgain = reads.length;
    await server.conversationDetail(A, knownLast.conversationId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    ok("  once — opening it again tells Meta nothing new", reads.length === readsBeforeAgain);

    const visitorConv = await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId } });
    ok("before anybody types, the bubble shows no 'typing…'", (await server.webPresence(webChannel.id, first.token))?.typing === null);
    const typed = await server.staffTyping(A, visitorConv.id);
    ok("a staff member typing: the bubble shows '<first name> is typing…'", typed.ok && (await server.webPresence(webChannel.id, first.token))?.typing === "Zzprobe");
    ok("  for a few seconds, then not", server.typingIn(visitorConv.id, Date.now() + 7_000) === null);
    await server.receiveWebMessage(webChannel, { token: first.token, text: "Are you still there?" });
    ok("a new message the team hasn't read isn't 'Seen'", (await server.webPresence(webChannel.id, first.token))?.seen === false);
    await server.conversationDetail(A, visitorConv.id);
    ok("  once somebody opens it, it is", (await server.webPresence(webChannel.id, first.token))?.seen === true);
    const readsBeforeWaTyping = reads.length;
    await server.staffTyping(A, knownLast.conversationId);
    await server.staffTyping(A, knownLast.conversationId);
    ok("typing in a WhatsApp conversation shows 'typing…' on their phone — asked of Meta once, not every keystroke", reads.slice(readsBeforeWaTyping).length === 1 && reads[reads.length - 1]!.typing);
    ok("someone who can't see a conversation can't type in it", !(await server.staffTyping(A, ownConv.id)).ok);

    section("Who the visitor is: in the inbox");
    const visitorInfo = { timezone: "Asia/Dubai", language: "ar-AE", device: "Safari on iPhone", country: "AE", region: "Dubai", city: "Dubai", page: "https://example.com/pricing" };
    const fresh = await server.receiveWebMessage(webChannel, { text: "Hi, do you ship to Dubai?", visitor: visitorInfo, pageUrl: "https://example.com/pricing" });
    const freshDetail = await server.conversationDetail(A, fresh.conversationId);
    ok("a new visitor: where they are, their time zone, device and language, online now, the page they're on", freshDetail?.visitor?.place === "Dubai, United Arab Emirates" && freshDetail.visitor.timezone === "Asia/Dubai" && freshDetail.visitor.device === "Safari on iPhone" && freshDetail.visitor.online && freshDetail.visitor.currentPage === "/pricing", JSON.stringify(freshDetail?.visitor));
    ok("  and new: one visit, nothing earlier", freshDetail?.isNew === true && freshDetail.visits === 1 && freshDetail.previousConversations === 0);
    await db.conversation.update({ where: { id: fresh.conversationId }, data: { lastSeenAt: new Date(Date.now() - 45 * 60_000) } });
    await server.visitorSeen(webChannel.id, fresh.token, { page: "https://example.com/crm" });
    const back = await server.conversationDetail(A, fresh.conversationId);
    ok("back after half an hour away: a second visit, the new page on top, no longer new", back?.visits === 2 && back.isNew === false && back.visitor?.pages[0]?.path === "/crm" && back.visitor.pages.some((p) => p.path === "/pricing"));
    ok("  what was known about them isn't overwritten by a later visit", back?.visitor?.timezone === "Asia/Dubai");
    const listed = (await server.listConversations(A, { view: "open" })).find((r) => r.id === fresh.conversationId);
    ok("the list shows them online, with their visits", listed?.online === true && listed.visits === 2);
    const again2 = await server.receiveWebMessage(webChannel, { text: "Hello again" });
    await db.conversation.update({ where: { id: again2.conversationId }, data: { customerEmail: `zz-visitor@${DOMAIN}` } });
    ok("a conversation from somebody who wrote before (the same email): their earlier conversations counted", ((await server.conversationDetail(A, again2.conversationId))?.previousConversations ?? 0) >= 1);
    const asker = await db.conversation.findFirstOrThrow({ where: { waId: "919900000920", channel: { name: `${TAG} bot wa` } }, select: { id: true } });
    const waDetail = await server.conversationDetail(M, asker.id);
    ok("a WhatsApp customer's country, from their number", waDetail?.visitor?.country === "IN" && waDetail.visitor.place === "India");

    const typingHeard: string[] = [];
    const offTyping = bus.subscribe(tenantId, agent.id, (e) => e.type === "inbox-typing" && typingHeard.push(e.conversationId));
    ok("a visitor typing: the team sees what, live — told by id only", (await server.visitorTyping(webChannel, fresh.token, { active: true, text: "Do you have a   demo slot" })) && typingHeard.includes(fresh.conversationId));
    const peeked = await server.visitorPeek(A, fresh.conversationId);
    ok("  what they're typing, as one line", peeked?.typing === true && peeked.text === "Do you have a demo slot");
    await server.visitorTyping(webChannel, fresh.token, { active: false });
    ok("  and nothing once they stop", (await server.visitorPeek(A, fresh.conversationId))?.typing === false);
    const noPeek = await db.inboxChannel.update({ where: { id: webChannel.id }, data: { settings: { ...bot, peek: false } as object } });
    await server.visitorTyping(noPeek, fresh.token, { active: true, text: "secret draft" });
    const blind = await server.visitorPeek(A, fresh.conversationId);
    ok("with peeking off, the team sees only that they're typing — the words are never taken", blind?.typing === true && blind.text === null);
    await server.receiveWebMessage(noPeek, { token: fresh.token, text: "secret draft" });
    ok("  sending it ends the typing", (await server.visitorPeek(A, fresh.conversationId))?.typing === false);
    ok("an unknown visitor can't type into anybody's conversation, nor can somebody see one that isn't theirs", !(await server.visitorTyping(webChannel, "x".repeat(32), { active: true, text: "hi" })) && (await server.visitorPeek(A, ownConv.id)) === null);
    offTyping();

    section("The team's tools: notes, tags, saved replies");
    const repToldBefore = await db.notification.count({ where: { userId: rep.id, title: { contains: "mentioned you" } } });
    const noted = await team.staffNote(A, first.conversationId, "@Zzprobe Rep can you call them about the VIP discount?");
    const afterNote = await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId }, select: { botActive: true, firstResponseAt: true } });
    ok("a private note: kept, and the colleague named in it told", noted.ok && noted.data.told === 1 && (await db.notification.count({ where: { userId: rep.id, title: { contains: "mentioned you" } } })) === repToldBefore + 1);
    ok("  never in the visitor's bubble", ((await server.webMessages(webChannel.id, first.token, null)) ?? []).every((m) => !m.body.includes("VIP discount")));
    ok("  in the team's view of the conversation, as a note", (await server.conversationDetail(A, first.conversationId))?.messages.some((m) => m.author === "NOTE" && m.body.includes("VIP discount")) === true);
    ok("  not the list's preview, and not a reply (no response time moved)", !(await server.listConversations(A, { view: "open" })).find((r) => r.id === first.conversationId)?.preview.includes("VIP") && afterNote.firstResponseAt?.getTime() === afterReply.firstResponseAt?.getTime());
    ok("  somebody who can't see a conversation can't note in it, and an empty note is refused", !(await team.staffNote(A, ownConv.id, "hi")).ok && !(await team.staffNote(A, first.conversationId, "  ")).ok);

    const tagged = await team.setConversationTags(A, first.conversationId, ["Sales ", "follow up", "sales"]);
    ok("tags: kept tidy", tagged.ok && tagged.data.tags.join() === "sales,follow-up");
    ok("  the list filters by one, and shows them", (await server.listConversations(A, { view: "open", tag: "sales" })).some((r) => r.id === first.conversationId && r.tags.includes("follow-up")) && !(await server.listConversations(A, { view: "open", tag: "zz-none" })).some((r) => r.id === first.conversationId));
    ok("  and the tags in use are offered", (await team.tagsInUse(A)).includes("sales") && !(await team.tagsInUse(A)).includes("zz-none"));

    const savedReply = await team.saveSavedReply({ id: admin.id }, { shortcut: "/zzprobe-price", title: "Zz prices", body: "Hi {name}, it's ₹999 a month. — {agent}" });
    ok("a saved reply, by its shortcut", savedReply.ok && savedReply.data.shortcut === "zzprobe-price" && (await team.savedReplies()).some((r) => r.shortcut === "zzprobe-price"));
    const clash = await team.saveSavedReply({ id: admin.id }, { shortcut: "zzprobe-price", title: "Again", body: "x" });
    const badShortcut = await team.saveSavedReply({ id: admin.id }, { shortcut: "zz probe", title: "x", body: "x" });
    ok("  a shortcut is one reply's only, and letters, digits and hyphens", !clash.ok && /another reply/.test(clash.error) && !badShortcut.ok);
    actorId = agent.id;
    ok("  managing them is the workspace's settings: an agent can't", !(await adminActions.saveInboxSavedReply({ shortcut: "zzprobe-agent", title: "x", body: "y" })).ok);
    ok("  but reads them for '/'", (await actions.inboxSavedReplies()).some((r) => r.shortcut === "zzprobe-price"));
    actorId = admin.id;
    const viaAction = await adminActions.saveInboxSavedReply({ shortcut: "zzprobe-hours", title: "Zz hours", body: "9 to 6" });
    ok("  an admin can, and remove one", viaAction.ok && (await adminActions.deleteInboxSavedReply(viaAction.ok ? viaAction.data.id : "")).ok && !(await team.savedReplies()).some((r) => r.shortcut === "zzprobe-hours"));
    actorId = "";

    section("The team's tools: who else is here");
    await server.visitorPeek(A, first.conversationId);
    // A few seconds on, so the agent's typing from earlier has passed and only their being here shows.
    const managerSees = await server.visitorPeek(M, first.conversationId, {}, Date.now() + 7_000);
    ok("a colleague with the conversation open is shown", managerSees?.others.some((o) => o.name === "Zzprobe" && !o.replying) === true && managerSees.others.length === 1);
    await server.staffTyping(A, first.conversationId);
    ok("  and once they type: 'already replying'", (await server.visitorPeek(M, first.conversationId))?.others.some((o) => o.replying) === true);
    ok("  never yourself", (await server.visitorPeek(A, first.conversationId))?.others.every((o) => o.name !== "Zzprobe" || o.replying === false) !== false && (await server.visitorPeek(A, first.conversationId))!.others.length === 1);
    await server.visitorPeek(R, first.conversationId, { here: false });
    ok("  somebody viewing as a colleague isn't counted as that colleague", (await server.visitorPeek(M, first.conversationId))?.others.length === 1);

    section("The team's tools: the customer's rating");
    const askerConv = await db.conversation.findFirstOrThrow({ where: { waId: "919900000920", channel: { name: `${TAG} bot wa` } }, select: { id: true } });
    await server.staffReply(M, askerConv.id, "Happy to help with pricing.");
    const fileSent = await server.staffSendFile(M, askerConv.id, { bytes: Buffer.from("%PDF-1.4 zz"), mime: "application/pdf", name: "Zz quote.pdf", caption: "Our quote" });
    const lastOut = sent[sent.length - 1];
    ok("a file to a WhatsApp customer goes through Meta as a document, with its caption, and a copy kept", fileSent.ok && !!lastOut && "media" in lastOut && lastOut.media.mime === "application/pdf" && lastOut.media.caption === "Our quote" && !!(await db.conversationMessage.findFirst({ where: { conversationId: askerConv.id, author: "AGENT", body: "[Document: Zz quote.pdf] Our quote", file: { isNot: null } } })));
    ok("  a page or a program isn't sent", !(await server.staffSendFile(M, askerConv.id, { bytes: Buffer.from("<script>"), mime: "text/html", name: "x.html" })).ok && !(await server.staffSendFile(M, askerConv.id, { bytes: Buffer.alloc(6 * 1024 * 1024), mime: "image/png", name: "big.png" })).ok);
    const sentBeforeClose = sent.length;
    await server.setConversationStatus(M, askerConv.id, "CLOSED");
    const question = sent[sent.length - 1];
    ok("closed, with a person's answer in it: WhatsApp asks 'How did we do?'", sent.length === sentBeforeClose + 1 && !!question && "text" in question && /how did we do/i.test(question.text));
    const ratedAt = new Date();
    ok("  '👍' back is their rating — and it stays closed", (await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[4], from: "919900000920", profileName: "Zzprobe Asker", id: `wamid.zzrate${Date.now()}`, at: ratedAt, text: "👍" })) === "rated");
    const ratedRow = await db.conversation.findUniqueOrThrow({ where: { id: askerConv.id }, select: { status: true, rating: true, ratedAt: true } });
    ok("  kept, thanked, and shown to the team", ratedRow.status === "CLOSED" && ratedRow.rating === "GOOD" && !!ratedRow.ratedAt && "text" in sent[sent.length - 1]! && /thank/i.test((sent[sent.length - 1] as { text: string }).text) && (await server.conversationDetail(M, askerConv.id))?.rating === "GOOD");

    const csatWeb = await server.receiveWebMessage(webChannel, { text: "agent please" });
    ok("a conversation nobody from the team answered isn't asked to rate", (await server.setConversationStatus(A, csatWeb.conversationId, "CLOSED")).ok && (await server.webPresence(webChannel.id, csatWeb.token))?.rate === false);
    await server.setConversationStatus(A, csatWeb.conversationId, "OPEN");
    await server.staffReply(A, csatWeb.conversationId, "Sorted — anything else?");
    await server.setConversationStatus(A, csatWeb.conversationId, "CLOSED");
    ok("the bubble asks once a person answered and it's closed", (await server.webPresence(webChannel.id, csatWeb.token))?.rate === true);
    ok("  their 👎 and what they said are kept — once", (await server.rateWeb(webChannel.id, csatWeb.token, { rating: "BAD", comment: "Took   too long" })) && !(await server.rateWeb(webChannel.id, csatWeb.token, { rating: "GOOD" })) && (await server.webPresence(webChannel.id, csatWeb.token))?.rate === false);
    const csatDetail = await server.conversationDetail(A, csatWeb.conversationId);
    ok("  the team sees it, and the list does", csatDetail?.rating === "BAD" && csatDetail.ratingComment === "Took too long" && (await server.listConversations(A, { view: "closed" })).find((r) => r.id === csatWeb.conversationId)?.rating === "BAD");
    ok("  a rating that isn't one, or a stranger's, is refused", !(await server.rateWeb(webChannel.id, csatWeb.token, { rating: "MEH" })) && !(await server.rateWeb(webChannel.id, "x".repeat(32), { rating: "GOOD" })));
    const csatReport = await reportLib.inboxReport(M, { days: 7, channelId: webChannel.id });
    ok("the report: ratings given, and the share satisfied — by person too", csatReport.totals.rated === 1 && csatReport.totals.satisfied === 0 && csatReport.byPerson?.some((p) => p.id === agent.id && p.rated === 1 && p.satisfied === 0) === true);

    section("The team's tools: files from the website, emails, blocking, details first");
    const fileConv = await server.receiveWebMessage(webChannel, { text: "Hello" });
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("zz-png")]);
    const upload = await server.receiveWebFile(webChannel, fileConv.token, { bytes: png, mime: "image/png", name: "zz bill.png" });
    const fileRow = await db.conversation.findUniqueOrThrow({ where: { id: fileConv.conversationId }, select: { botActive: true, needsPersonAt: true } });
    ok("a visitor's photo: kept, and the bot steps aside for a person to look", upload?.ok === true && !fileRow.botActive && !!fileRow.needsPersonAt);
    const theirFile = ((await server.webMessages(webChannel.id, fileConv.token, null)) ?? []).find((m) => m.file);
    ok("  in their bubble as a photo, fetched with their token only", !!theirFile && theirFile.file?.image === true && (await server.visitorFile(webChannel.id, fileConv.token, theirFile.id))?.bytes.equals(png) === true && (await server.visitorFile(webChannel.id, first.token, theirFile.id)) === null);
    const staffOpens = theirFile ? await server.conversationFile(A, theirFile.id) : null;
    ok("  and the team opens it", staffOpens?.ok === true && staffOpens.mime === "image/png");
    ok("  a page, a program or a stranger's token isn't taken", (await server.receiveWebFile(webChannel, fileConv.token, { bytes: Buffer.from("<html>"), mime: "text/html", name: "x.html" }))?.ok === false && (await server.receiveWebFile(webChannel, "x".repeat(32), { bytes: png, mime: "image/png", name: "a.png" })) === null);
    const webSend = await server.staffSendFile(A, fileConv.conversationId, { bytes: Buffer.from("%PDF zz"), mime: "application/pdf", name: "Zz brochure.pdf" });
    ok("a file from the team to a website visitor: in their bubble to save", webSend.ok && ((await server.webMessages(webChannel.id, fileConv.token, null)) ?? []).some((m) => m.from === "agent" && m.file?.name === "Zz brochure.pdf" && !m.file.image));

    const noFiles = await db.inboxChannel.create({ data: { kind: "WEB", name: `${TAG} no files`, publicKey: `zzprobenofiles${Date.now()}`, settings: { ...bot, files: { customers: false, team: false } } as object, createdById: admin.id } });
    const nfConv = await server.receiveWebMessage(noFiles, { text: "Hello" });
    const nfUpload = await server.receiveWebFile(noFiles, nfConv.token, { bytes: png, mime: "image/png", name: "zz.png" });
    ok("files switched off for customers: a visitor's file is refused", nfUpload?.ok === false && /doesn't take files/.test(nfUpload.error) && !(await db.conversationMessage.findFirst({ where: { conversationId: nfConv.conversationId, mediaName: "zz.png" } })));
    const nfSend = await server.staffSendFile(A, nfConv.conversationId, { bytes: Buffer.from("%PDF zz"), mime: "application/pdf", name: "Zz.pdf" });
    ok("  and for the team: nothing goes, and the screen knows to hide the button", !nfSend.ok && /switched off/.test(nfSend.error) && (await server.conversationDetail(A, nfConv.conversationId))?.channel.files.team === false);
    await db.inboxChannel.update({ where: { id: shared.id }, data: { settings: { ...defaultChannelSettings("WHATSAPP"), files: { customers: false, team: true } } as object } });
    await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[0], from: "919900000901", profileName: "Zzprobe Wa", id: `wamid.zznofile${Date.now()}`, at: new Date(), text: "[Photo] my id card", media: { id: "zz-media-off", mime: "image/jpeg", name: null } });
    const dropped = await db.conversationMessage.findFirst({ where: { externalId: { startsWith: "wamid.zznofile" } }, select: { mediaId: true, body: true } });
    ok("  on WhatsApp, which can't stop them, a customer's file isn't kept — only that it came", dropped?.mediaId === null && dropped.body === "[Photo] my id card");
    await db.inboxChannel.update({ where: { id: shared.id }, data: { settings: shared.settings as object } });

    await db.conversation.update({ where: { id: first.conversationId }, data: { lastSeenAt: new Date(Date.now() - 5 * 60_000), followUpAt: null } });
    await server.staffReply(A, first.conversationId, "Following up on your question.");
    ok("a visitor who has left hears of a reply by email, with the way back to the chat", mailed.length === 1 && mailed[0].to === `zz-visitor@${DOMAIN}` && mailed[0].text.includes("Following up on your question.") && mailed[0].text.includes("https://example.com/pricing"));
    ok("  and the team sees it was emailed", !!(await db.conversationMessage.findFirst({ where: { conversationId: first.conversationId, author: "SYSTEM", body: { contains: "emailed" } } })));
    await server.staffReply(A, first.conversationId, "And one more thing.");
    ok("  one email in a quarter hour, however many replies", mailed.length === 1);
    await db.conversation.update({ where: { id: first.conversationId }, data: { lastSeenAt: new Date(), followUpAt: null } });
    await server.staffReply(A, first.conversationId, "You're here!");
    ok("  none while they're still on the website", mailed.length === 1);

    const blockedOut = await team.blockCustomer(A, fresh.conversationId, "Zz spam");
    ok("a visitor blocked: their token stops working, and the conversation closes", blockedOut.ok && (await server.visitorBlocked(fresh.token)) && (await db.conversation.findUniqueOrThrow({ where: { id: fresh.conversationId } })).status === "CLOSED" && (await server.conversationDetail(A, fresh.conversationId))?.blocked === true);
    ok("  listed for Settings, with why and who", (await team.blockedCustomers()).some((b) => b.kind === "WEB" && b.reason === "Zz spam" && b.by === "Zzprobe Agent"));
    ok("  another visitor isn't", !(await server.visitorBlocked(first.token)));
    await team.unblockCustomer(A, fresh.conversationId);
    ok("  unblocked from the conversation", !(await server.visitorBlocked(fresh.token)));
    await team.blockCustomer(M, askerConv.id, null);
    ok("a WhatsApp number blocked: its messages go nowhere", (await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[4], from: "919900000920", profileName: "Zzprobe Asker", id: `wamid.zzblocked${Date.now()}`, at: new Date(), text: "Hello?" })) === "blocked");
    const waBlock = (await team.blockedCustomers()).find((b) => b.kind === "WHATSAPP");
    ok("  and let back in from Settings", !!waBlock && (await team.removeBlock(waBlock.id)).ok && (await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[4], from: "919900000920", profileName: "Zzprobe Asker", id: `wamid.zzback${Date.now()}`, at: new Date(), text: "Hello again" })) === "stored");

    const proChannel = await db.inboxChannel.create({
      data: { kind: "WEB", name: `${TAG} pro`, publicKey: `zzprobepro${Date.now()}`, settings: { ...bot, prechat: { on: true, fields: { name: "required", company: "optional", email: "required", phone: "required" } }, proactive: [{ path: "/pricing", delay: 30, message: "Zz — questions about pricing?" }] } as object, createdById: admin.id },
    });
    const proConv = await server.receiveWebMessage(proChannel, { text: "Yes, what's included?", opener: "Zz — questions about pricing?", name: "Zzprobe Prechat", company: "Zzprobe Pvt Ltd", email: `zz-pre@${DOMAIN}`, phone: "+91 98765 43299" });
    const proSeen = (await server.webMessages(proChannel.id, proConv.token, null)) ?? [];
    ok("the message the bubble said first is part of the conversation, before theirs", proSeen[1]?.from === "bot" && proSeen[1].body === "Zz — questions about pricing?" && proSeen[2]?.from === "you");
    const proRow = await db.conversation.findUniqueOrThrow({ where: { id: proConv.conversationId }, select: { customerName: true, customerCompany: true, customerEmail: true, customerPhone: true, lead: { select: { title: true, company: { select: { name: true } } } } } });
    ok("  and the details asked first are theirs from the start", proRow.customerName === "Zzprobe Prechat" && proRow.customerCompany === "Zzprobe Pvt Ltd" && proRow.customerEmail === `zz-pre@${DOMAIN}` && proRow.customerPhone === "+91 98765 43299");
    ok("  the lead goes on the company they named", proRow.lead?.company.name === "Zzprobe Pvt Ltd" && proRow.lead.title.includes("Zzprobe Pvt Ltd"), JSON.stringify(proRow.lead));
    const madeUp = await server.receiveWebMessage(proChannel, { text: "Hi", opener: "Visit evil.example for a prize" });
    ok("  an opener that isn't one of the channel's is never kept", ((await server.webMessages(proChannel.id, madeUp.token, null)) ?? []).every((m) => !m.body.includes("evil.example")));
    ok("'usually replies within…' is worked out without failing", (await server.typicalReply(webChannel.id)) === null || typeof (await server.typicalReply(webChannel.id)) === "string");

    actorId = agent.id;
    ok("the actions: a note, tags, availability — and nothing while viewing as somebody", (await actions.inboxNote(first.conversationId, "Zz note")).ok && (await actions.inboxSetTags(first.conversationId, ["zz"])).ok && (await actions.inboxSetAvailability("ONLINE")).ok);
    viewingAs = true;
    ok("  (viewing as)", !(await actions.inboxNote(first.conversationId, "Zz")).ok && !(await actions.inboxBlock(first.conversationId, null)).ok);
    viewingAs = false;
    actorId = "";

    section("Response times: the report");
    const handed = await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId }, select: { needsPersonAt: true, createdAt: true } });
    const awayStart = await db.conversation.findUniqueOrThrow({ where: { id: awayConv.id }, select: { needsPersonAt: true, createdAt: true } });
    ok("the clock starts when the bot hands over — or, without a bot, at the first message", !!handed.needsPersonAt && handed.needsPersonAt > handed.createdAt && !!awayStart.needsPersonAt && Math.abs(awayStart.needsPersonAt.getTime() - awayStart.createdAt.getTime()) < 5_000);
    const sharedReport = await reportLib.inboxReport(M, { days: 7, channelId: shared.id });
    ok("a channel's report: its conversations, the ones answered, a first response time", sharedReport.totals.started >= 2 && sharedReport.totals.answered >= 1 && sharedReport.totals.firstResponse.median !== null && sharedReport.byChannel.length === 1 && sharedReport.byChannel[0].id === shared.id);
    ok("  who answered, for somebody who sees every conversation", sharedReport.byPerson?.some((p) => p.id === agent.id && p.firstResponses >= 1 && p.replies >= 1) === true);
    const agentReport = await reportLib.inboxReport(A, { days: 7, channelId: shared.id });
    ok("  and not for anybody else", agentReport.byPerson === null);
    ok("a rep's own number: in management's figures, not a colleague's", (await reportLib.inboxReport(M, { days: 7, channelId: own.id })).totals.started >= 1 && (await reportLib.inboxReport(A, { days: 7, channelId: own.id })).totals.started === 0);
    const aiReport = await reportLib.inboxReport(M, { days: 7, channelId: aiChannel.id });
    ok("a conversation the bot still has counts as handled by the bot alone", aiReport.totals.botOnly === 1 && aiReport.totals.neededPerson === 0);
    ok("waiting for a person now: open, needing one, nobody's replied", (await reportLib.inboxReport(M, { days: 7, channelId: awayChannel.id })).totals.waitingNow === 1);
    ok("a day for each day of the period", sharedReport.byDay.length === 7 && sharedReport.byDay.reduce((n, d) => n + d.started, 0) === sharedReport.totals.started);

    section("The pages, as the server draws them");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const InboxPage = (require("../src/app/(dashboard)/inbox/page") as { default: Page }).default;
    const SettingsPage = (require("../src/app/(dashboard)/settings/inbox/page") as { default: Page }).default;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const visitorRef = conversationRef((await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId } })).seq);
    actorId = agent.id;
    const inboxHtml = await render(InboxPage, { c: visitorRef });
    ok("the inbox: the conversation asked for, with its messages and who the customer is", inboxHtml.includes("Zzprobe Visitor") && inboxHtml.includes("How much does it cost?") && inboxHtml.includes(visitorRef), inboxHtml.length);
    ok("  and the actions this person may take", inboxHtml.includes("Close") || inboxHtml.includes("Reopen"));
    ok("  the settings aren't theirs: not found", (await thrown(() => render(SettingsPage))) === "notFound");
    actorId = outsider.id;
    ok("somebody without the inbox gets not found", (await thrown(() => render(InboxPage))) === "notFound");
    actorId = admin.id;
    const settingsHtml = await render(SettingsPage);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ReportsPage = (require("../src/app/(dashboard)/inbox/reports/page") as { default: Page }).default;
    actorId = manager.id;
    const reportHtml = await render(ReportsPage, { days: "7" });
    ok("the reports page: the figures, day by day, by channel and by person", reportHtml.includes("Inbox reports") && reportHtml.includes("First response (median)") && reportHtml.includes("By channel") && reportHtml.includes("By person"));
    actorId = agent.id;
    ok("  without who answered what for somebody who doesn't see every conversation", !(await render(ReportsPage, {})).includes("By person"));
    actorId = admin.id;
    ok("the settings: each channel, the website snippet, the webhook to give Meta, and no secret", settingsHtml.includes(`${TAG} site`) && settingsHtml.includes("/api/inbox/public/widget.js") && settingsHtml.includes("/api/inbox/public/whatsapp") && settingsHtml.includes("Verify token") && !/whatsappTokenCipher|whatsappAppSecretCipher/.test(settingsHtml));
    ok("  the saved replies, and who is blocked", settingsHtml.includes("Saved replies") && settingsHtml.includes("/zzprobe-price") && settingsHtml.includes("Blocked"));
    ok("the inbox: a reply or a note, and whether you're taking conversations", inboxHtml.includes("Note") && inboxHtml.includes("Available") && inboxHtml.includes("#zz"));

    section("Unread, and the actions");
    const unreadBefore = await server.unreadCount(A);
    const newChat = await server.receiveWebMessage(webChannel, { text: "Hi, anyone there?" });
    const withBot = (await db.conversation.findUniqueOrThrow({ where: { id: newChat.conversationId }, select: { botActive: true } })).botActive;
    ok("unread: a new visitor chat counts the moment it starts — the bot's too", withBot && (await server.unreadCount(A)) === unreadBefore + 1);
    await server.conversationDetail(A, newChat.conversationId);
    ok("  and stops counting for whoever opens it", (await server.unreadCount(A)) === unreadBefore);
    actorId = outsider.id;
    ok("somebody without the inbox lists nothing and can't reply", (await notOpen(actions.inboxList({ view: "open" }), "Customer inbox")) && (await notOpen(actions.inboxReply(first.conversationId, "hi"), "Customer inbox")));
    actorId = agent.id;
    ok("an agent lists it through the action", (await actions.inboxList({ view: "open" })).some((r) => r.id === first.conversationId));
    ok("  and opens it by its reference", (await actions.inboxConversation(conversationRef((await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId } })).seq)))?.id === first.conversationId);
    viewingAs = true;
    const asSomebody = await actions.inboxReply(first.conversationId, "hi");
    ok("nothing changes while viewing as somebody", !asSomebody.ok && /viewing as/.test(asSomebody.error));
    viewingAs = false;
    unsubscribe();
  } finally {
    whatsapp.setTestWhatsAppSender(null);
    whatsapp.setTestWhatsAppMedia(null);
    whatsapp.setTestWhatsAppRead(null);
    server.setInboxPacing(true);
    aiLib.setTestInboxAi(null);
    await cleanup();
    ok("everything named for this check is gone", (await db.inboxChannel.count({ where: { name: { startsWith: TAG } } })) === 0 && (await db.user.count({ where: { email: { endsWith: MAIL } } })) === 0);
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : "\nAll customer inbox checks passed.");
    process.exit(failures ? 1 : 0);
  })
  .catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    process.exit(1);
  });
