import { keyPagePath } from "@/lib/inbox/activity-rules";

/**
 * A Customer inbox channel's settings (owner, 24 Oct 2026; `InboxChannel.settings`): what its bot says
 * and knows, whether a new conversation makes a lead, office hours, who gets a conversation, and — for
 * a website's bubble — how it looks and which sites may show it. Pure and client-safe: the settings page,
 * the bot (./bot.ts), the widget's route and the checks all read it. A stored value is read through
 * `channelSettings`, which fills in whatever is missing, so a channel saved before a setting existed
 * still works.
 */

export type InboxKind = "WEB" | "WHATSAPP";

/** One of the bot's set answers: given when a customer's message has one of the words. */
export type BotAnswer = { keywords: string; answer: string };

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** A day's opening, as the workspace's clock reads it: "09:00" to "18:00". Null: closed all day. */
export type OpenSpan = { from: string; to: string } | null;

/**
 * A customer's details the inbox knows about (owner, 25 Oct 2026: "let admin decide what fields are
 * required" — to make a lead, to start a chat, for the bot to ask before handing over).
 */
export const DETAIL_FIELDS = ["name", "company", "email", "phone"] as const;
export type DetailField = (typeof DETAIL_FIELDS)[number];
export const DETAIL_LABELS: Record<DetailField, string> = { name: "Name", company: "Company name", email: "Email", phone: "Phone number" };

/** Which details something needs. With `either`, and both email and phone ticked, one of the two will do. */
export type DetailNeeds = { name: boolean; company: boolean; email: boolean; phone: boolean; either: boolean };

/** What's known of a customer, as the needs read it. */
export type KnownDetails = { name: string | null; company?: string | null; email: string | null; phone: string | null };

/** A pre-chat form field: must be filled in, may be, or isn't shown. */
export type FieldRule = "required" | "optional" | "off";

export type MissingDetail = "name" | "company" | "contact" | "phone" | "email";

/**
 * What's still missing of `needs`, in the order it would be asked: "name", "company", then "contact" (a
 * phone number or an email, where either will do), or "phone" and "email" one by one. Empty: all there.
 */
export function detailsMissing(needs: DetailNeeds, known: KnownDetails, skip: readonly string[] = []): MissingDetail[] {
  const out: MissingDetail[] = [];
  if (needs.name && !known.name) out.push("name");
  if (needs.company && !known.company) out.push("company");
  if (needs.either && needs.email && needs.phone) {
    if (!known.email && !known.phone) out.push("contact");
  } else {
    if (needs.phone && !known.phone) out.push("phone");
    if (needs.email && !known.email) out.push("email");
  }
  return out.filter((f) => !skip.includes(f));
}

/** "a name and a phone number or email", "a name, an email and a phone number" — for the settings page. */
export function needsText(needs: DetailNeeds): string {
  const parts: string[] = [];
  if (needs.name) parts.push("a name");
  if (needs.company) parts.push("a company name");
  if (needs.either && needs.email && needs.phone) parts.push("a phone number or email");
  else {
    if (needs.email) parts.push("an email");
    if (needs.phone) parts.push("a phone number");
  }
  if (!parts.length) return "nothing";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export type ChannelSettings = {
  /** The first thing a customer is told — the bubble's welcome, or the bot's reply to a first WhatsApp message. */
  greeting: string;
  bot: {
    /** Set answers, by default (owner: AI answers are a switch of their own). */
    on: boolean;
    answers: BotAnswer[];
    /** Before handing over, ask for the customer's details — those in `ask` it doesn't have yet. */
    askDetails: boolean;
    /** Which details it asks for (on WhatsApp the number is always known). */
    ask: DetailNeeds;
    /** What the customer is told when the bot hands them to a person. `{name}`: their first name, when known. */
    handover: string;
    /**
     * What the assistant calls itself ("Asha"), on its messages and when asked who it is. Empty: "the
     * assistant". Asked whether it's a person, it says it's the virtual assistant, whatever its name.
     */
    name: string;
    /**
     * Deskzo AI answers what the set answers don't (owner: an option you switch on). It is told only the
     * conversation, the set answers and `about`, and hands over whenever it isn't sure. Each answer is
     * charged in AI credits as `chargedTo` — whoever switched it on, set by the server, never the form.
     */
    ai: {
      on: boolean;
      about: string;
      chargedTo: string | null;
      /**
       * WEB: the business's own pages it may answer from (owner, 31 Oct 2026) — page addresses, or a sitemap.xml that
       * names them; read by "Read the pages now" (src/lib/inbox/knowledge.ts), on the allowed sites when any are named.
       */
      pages: string[];
      /**
       * "Use AI Knowledge" (owner, 3 Nov 2026): before answering, the AI is told the 3 chunks of the workspace's AI
       * Knowledge files (Settings › AI Knowledge, src/lib/ai-knowledge) that best match the question. Off by default:
       * those files may hold what's for the team only, and ticking it says they may be told to customers.
       */
      knowledge: boolean;
    };
    /**
     * WEB: questions the bubble offers as buttons under the welcome (owner, 31 Oct 2026) — "Pricing", "Book a demo".
     * A tap sends it as the visitor's message, so the bot answers it like any other.
     */
    suggestions: string[];
  };
  /** A new customer makes a lead (owner: WhatsApp and bot chats can create leads) — once the details in `leadNeeds` are in. */
  autoLead: boolean;
  /** What a lead waits for. Always a phone number or an email among them: a lead needs some way to reach them. */
  leadNeeds: DetailNeeds;
  /**
   * WEB: the team sees what a visitor is typing before they send it (owner, 24 Oct 2026). Never kept —
   * held in memory for a few seconds — and gone the moment they send or stop. WhatsApp shows nothing of the kind.
   */
  peek: boolean;
  /** Ask the customer "How did we do? 👍 / 👎" once the conversation is closed (the bubble, or a WhatsApp message). */
  csat: boolean;
  /** WEB: a reply to a visitor who has left goes to their email too, when they gave one — no more than one a quarter hour. */
  emailFollowUp: boolean;
  /** WEB: before the first message, a short form — each detail required, optional, or not asked. */
  prechat: { on: boolean; fields: Record<DetailField, FieldRule> };
  /**
   * WEB: a message the bubble offers by itself on some pages, after some seconds there (owner, 24 Oct 2026) —
   * "/pricing", or "*" for any page. Only to a visitor not already chatting, once a visit.
   */
  proactive: { path: string; delay: number; message: string }[];
  /**
   * Files (owner, 25 Oct 2026: "option for admin to stop file uploading"): whether customers may send them
   * — the bubble's attach button; on WhatsApp, which can't be stopped, theirs aren't kept — and whether
   * the team may send them.
   */
  files: { customers: boolean; team: boolean };
  /** Office hours: outside them, a customer is told when the team is back — once, not every message. `away` may hold `{name}`. */
  hours: { on: boolean; days: Record<Weekday, OpenSpan>; away: string };
  /** Who gets a conversation the bot hands over, or one that starts without it: the queue, or each in turn (`people`; empty: everybody who answers). */
  assign: { mode: "queue" | "rotate"; people: string[] };
  /** WEB: the bubble's title and colour, and which corner. */
  look: { title: string; colour: string; position: "right" | "left" };
  /** WEB: the sites allowed to show the bubble, as origins ("https://example.com"). Empty: any site. */
  allowedSites: string[];
  /**
   * Website activity (owner, 6 Nov 2026; src/lib/inbox/activity.ts). Off until switched on, and never without the
   * visitor's agreement: the bubble's own notice, or — "site" — the site's cookie banner calling DeskzoChat.consent(true).
   * Somebody known on a key page tells whoever looks after them.
   */
  activity: { on: boolean; consent: "notice" | "site"; notice: string; keyPages: string[] };
};

export const INBOX_LIMITS = {
  /** A message either way. WhatsApp's own limit is 4,096; a chat bubble needs far less. */
  message: 2000,
  name: 80,
  greeting: 300,
  answers: 30,
  keywords: 200,
  answer: 1000,
  handover: 300,
  sites: 10,
  title: 60,
  channelName: 60,
  ticketTitle: 200,
  about: 3000,
  away: 300,
  team: 50,
  assistantName: 30,
  proactive: 5,
  proactiveMessage: 200,
  suggestions: 4,
  suggestion: 40,
  pages: 20,
} as const;

/** WhatsApp lets a business write freely for 24 hours after the customer's last message; after that, only an approved template. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

// The way a person on the team would put it (owner, 24 Oct 2026: "like a real human agent talks").
export const DEFAULT_GREETING = "Hi there! 👋 How can I help you today?";
export const DEFAULT_HANDOVER = "Thanks, {name}! I've let the team know — someone will be with you in a moment.";
export const DEFAULT_AWAY = "Thanks for writing in, {name}! We're closed right now, but we'll get back to you as soon as we're back.";
export const DEFAULT_COLOUR = "#0249FE";
/** As the bot has always asked: a name, then a phone number or an email. Also a website lead's default. */
const DEFAULT_ASK: DetailNeeds = { name: true, company: false, email: true, phone: true, either: true };
/** A WhatsApp number comes with its number: a lead from the first message. */
const WHATSAPP_LEAD: DetailNeeds = { name: false, company: false, email: false, phone: true, either: false };
const DEFAULT_PRECHAT: Record<DetailField, FieldRule> = { name: "required", company: "off", email: "required", phone: "off" };
const NINE_TO_SIX: OpenSpan = { from: "09:00", to: "18:00" };

export function defaultChannelSettings(kind: InboxKind): ChannelSettings {
  return {
    greeting: DEFAULT_GREETING,
    bot: { on: kind === "WEB", answers: [], askDetails: true, ask: { ...DEFAULT_ASK }, handover: DEFAULT_HANDOVER, name: "", ai: { on: false, about: "", chargedTo: null, pages: [], knowledge: false }, suggestions: [] },
    autoLead: true,
    leadNeeds: kind === "WEB" ? { ...DEFAULT_ASK } : { ...WHATSAPP_LEAD },
    peek: true,
    csat: true,
    emailFollowUp: true,
    prechat: { on: false, fields: { ...DEFAULT_PRECHAT } },
    proactive: [],
    files: { customers: true, team: true },
    hours: { on: false, days: { mon: NINE_TO_SIX, tue: NINE_TO_SIX, wed: NINE_TO_SIX, thu: NINE_TO_SIX, fri: NINE_TO_SIX, sat: null, sun: null }, away: DEFAULT_AWAY },
    assign: { mode: "queue", people: [] },
    look: { title: "Chat with us", colour: DEFAULT_COLOUR, position: "right" },
    allowedSites: [],
    activity: { on: false, consent: "notice", notice: DEFAULT_ACTIVITY_NOTICE, keyPages: ["/pricing"] },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, fallback = ""): string => (typeof v === "string" ? v.trim().slice(0, max) : fallback);
const HEX = /^#[0-9a-f]{6}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A day's opening as stored, or the default when it isn't one: closed stays closed, nonsense is the default. */
function spanOf(raw: unknown, fallback: OpenSpan): OpenSpan {
  if (raw === null) return null;
  if (!isObj(raw) || typeof raw.from !== "string" || typeof raw.to !== "string" || !TIME.test(raw.from) || !TIME.test(raw.to) || raw.from >= raw.to) return fallback;
  return { from: raw.from, to: raw.to };
}

/** Stored needs, whole; anything missing is the default's. */
function needsOf(raw: unknown, fallback: DetailNeeds): DetailNeeds {
  if (!isObj(raw)) return { ...fallback };
  const pick = (k: keyof DetailNeeds) => (typeof raw[k] === "boolean" ? (raw[k] as boolean) : fallback[k]);
  return { name: pick("name"), company: pick("company"), email: pick("email"), phone: pick("phone"), either: pick("either") };
}

/** The pre-chat form's fields; a form saved as `{ phone: true }`, before the fields could be chosen, still asks what it did. */
function prechatFieldsOf(raw: Record<string, unknown>): Record<DetailField, FieldRule> {
  const fields = isObj(raw.fields) ? raw.fields : null;
  if (!fields) return { ...DEFAULT_PRECHAT, phone: raw.phone === true ? "required" : "off" };
  const rule = (v: unknown, fallback: FieldRule): FieldRule => (v === "required" || v === "optional" || v === "off" ? v : fallback);
  return { name: rule(fields.name, DEFAULT_PRECHAT.name), company: rule(fields.company, DEFAULT_PRECHAT.company), email: rule(fields.email, DEFAULT_PRECHAT.email), phone: rule(fields.phone, DEFAULT_PRECHAT.phone) };
}

/** A stored value, whole: what's missing or malformed is the default. Never throws. */
/** What the bubble says before remembering a visitor — it names what is kept, which is what makes the agreement count. */
export const DEFAULT_ACTIVITY_NOTICE = "May we remember your visit? We'd keep the pages you open here, with your device, browser, location and network, including your IP address, to help us help you.";

export function channelSettings(raw: unknown, kind: InboxKind): ChannelSettings {
  const d = defaultChannelSettings(kind);
  if (!isObj(raw)) return d;
  const bot = isObj(raw.bot) ? raw.bot : {};
  const ai = isObj(bot.ai) ? bot.ai : {};
  const look = isObj(raw.look) ? raw.look : {};
  const hours = isObj(raw.hours) ? raw.hours : {};
  const days = isObj(hours.days) ? hours.days : {};
  const assign = isObj(raw.assign) ? raw.assign : {};
  const answers = Array.isArray(bot.answers)
    ? bot.answers
        .filter(isObj)
        .map((a) => ({ keywords: str(a.keywords, INBOX_LIMITS.keywords), answer: str(a.answer, INBOX_LIMITS.answer) }))
        .filter((a) => a.keywords && a.answer)
        .slice(0, INBOX_LIMITS.answers)
    : [];
  return {
    greeting: str(raw.greeting, INBOX_LIMITS.greeting, d.greeting),
    bot: {
      on: typeof bot.on === "boolean" ? bot.on : d.bot.on,
      answers,
      askDetails: typeof bot.askDetails === "boolean" ? bot.askDetails : d.bot.askDetails,
      ask: needsOf(bot.ask, d.bot.ask),
      handover: str(bot.handover, INBOX_LIMITS.handover) || d.bot.handover,
      name: str(bot.name, INBOX_LIMITS.assistantName).replace(/[{}<>]/g, ""),
      ai: {
        on: ai.on === true,
        about: str(ai.about, INBOX_LIMITS.about),
        chargedTo: typeof ai.chargedTo === "string" && ai.chargedTo ? ai.chargedTo : null,
        pages: Array.isArray(ai.pages) ? [...new Set(ai.pages.map((v) => webAddress(String(v ?? ""))).filter((v): v is string => !!v))].slice(0, INBOX_LIMITS.pages) : [],
        knowledge: ai.knowledge === true,
      },
      suggestions: Array.isArray(bot.suggestions)
        ? [...new Set(bot.suggestions.map((v) => str(v, INBOX_LIMITS.suggestion).replace(/\s+/g, " ")).filter(Boolean))].slice(0, INBOX_LIMITS.suggestions)
        : [],
    },
    autoLead: typeof raw.autoLead === "boolean" ? raw.autoLead : d.autoLead,
    leadNeeds: needsOf(raw.leadNeeds, d.leadNeeds),
    peek: typeof raw.peek === "boolean" ? raw.peek : d.peek,
    csat: typeof raw.csat === "boolean" ? raw.csat : d.csat,
    emailFollowUp: typeof raw.emailFollowUp === "boolean" ? raw.emailFollowUp : d.emailFollowUp,
    prechat: { on: isObj(raw.prechat) && raw.prechat.on === true, fields: isObj(raw.prechat) ? prechatFieldsOf(raw.prechat) : { ...DEFAULT_PRECHAT } },
    proactive: Array.isArray(raw.proactive)
      ? raw.proactive
          .filter(isObj)
          .map((r) => ({ path: proactivePath(r.path), delay: Math.min(600, Math.max(3, Math.round(Number(r.delay) || 30))), message: str(r.message, INBOX_LIMITS.proactiveMessage) }))
          .filter((r): r is { path: string; delay: number; message: string } => !!r.path && !!r.message)
          .slice(0, INBOX_LIMITS.proactive)
      : [],
    // Allowed unless switched off by name: a channel saved before the setting existed keeps taking files.
    files: { customers: !(isObj(raw.files) && raw.files.customers === false), team: !(isObj(raw.files) && raw.files.team === false) },
    hours: {
      on: hours.on === true,
      days: Object.fromEntries(WEEKDAYS.map((w) => [w, w in days ? spanOf(days[w], d.hours.days[w]) : d.hours.days[w]])) as Record<Weekday, OpenSpan>,
      away: str(hours.away, INBOX_LIMITS.away) || d.hours.away,
    },
    assign: {
      mode: assign.mode === "rotate" ? "rotate" : "queue",
      people: Array.isArray(assign.people) ? [...new Set(assign.people.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length < 64))].slice(0, INBOX_LIMITS.team) : [],
    },
    look: {
      title: str(look.title, INBOX_LIMITS.title) || d.look.title,
      colour: typeof look.colour === "string" && HEX.test(look.colour) ? look.colour : d.look.colour,
      position: look.position === "left" ? "left" : "right",
    },
    allowedSites: Array.isArray(raw.allowedSites) ? raw.allowedSites.map((s) => siteOrigin(String(s))).filter((s): s is string => !!s).slice(0, INBOX_LIMITS.sites) : [],
    activity: {
      on: isObj(raw.activity) && raw.activity.on === true,
      consent: isObj(raw.activity) && raw.activity.consent === "site" ? "site" : "notice",
      notice: (isObj(raw.activity) && str(raw.activity.notice, 300)) || d.activity.notice,
      keyPages:
        isObj(raw.activity) && Array.isArray(raw.activity.keyPages)
          ? [...new Set(raw.activity.keyPages.map(keyPagePath).filter((p): p is string => !!p))].slice(0, 10)
          : d.activity.keyPages,
    },
  };
}

/** A page's address as kept: http or https, without its #fragment; null for anything else. */
export function webAddress(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** A proactive message's page: "/pricing" (that page and those under it), or "*" for every page; null otherwise. */
export function proactivePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (v === "*") return "*";
  if (!v.startsWith("/") || v.length > 200 || /\s/.test(v)) return null;
  return v;
}

/** Whether a proactive message's page is this page. */
export function proactiveMatches(path: string, pathname: string): boolean {
  if (path === "*") return true;
  const base = path.replace(/\/+$/, "");
  // "/" is the home page itself; "*" is every page.
  if (!base) return pathname === "/";
  return pathname === path || pathname === base || pathname.startsWith(`${base}/`);
}

/** "example.com/contact" → "https://example.com"; null for something that isn't a web address. */
export function siteOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Settings as the page sends them, checked for saving: the reason it can't be saved, or the settings.
 * A blank answer row is dropped rather than refused — the form adds rows freely. The AI's `chargedTo` is
 * the server's to set (src/actions/inbox-admin.ts), whatever the form sends.
 */
export function checkChannelSettings(input: unknown, kind: InboxKind): { ok: true; settings: ChannelSettings } | { ok: false; error: string } {
  if (!isObj(input)) return { ok: false, error: "Nothing to save." };
  const bot = isObj(input.bot) ? input.bot : {};
  const rawAnswers = Array.isArray(bot.answers) ? bot.answers.filter(isObj) : [];
  const filled = rawAnswers.filter((a) => str(a.keywords, 10_000) || str(a.answer, 10_000));
  if (filled.length > INBOX_LIMITS.answers) return { ok: false, error: `Keep it to ${INBOX_LIMITS.answers} answers.` };
  for (const a of filled) {
    if (!str(a.keywords, 10_000) || !str(a.answer, 10_000)) return { ok: false, error: "Each answer needs both its words and what the bot says." };
    if (String(a.keywords).trim().length > INBOX_LIMITS.keywords) return { ok: false, error: `Keep an answer's words under ${INBOX_LIMITS.keywords} characters.` };
    if (String(a.answer).trim().length > INBOX_LIMITS.answer) return { ok: false, error: `Keep an answer under ${INBOX_LIMITS.answer} characters.` };
  }
  if (typeof input.greeting === "string" && input.greeting.trim().length > INBOX_LIMITS.greeting) return { ok: false, error: `Keep the greeting under ${INBOX_LIMITS.greeting} characters.` };
  if (typeof bot.name === "string" && bot.name.trim().length > INBOX_LIMITS.assistantName) return { ok: false, error: `Keep the assistant's name under ${INBOX_LIMITS.assistantName} characters.` };
  const ai = isObj(bot.ai) ? bot.ai : {};
  if (typeof ai.about === "string" && ai.about.trim().length > INBOX_LIMITS.about) return { ok: false, error: `Keep what the AI may say under ${INBOX_LIMITS.about.toLocaleString("en-IN")} characters.` };
  const pages = Array.isArray(ai.pages) ? ai.pages.map((v) => String(v ?? "").trim()).filter(Boolean) : [];
  if (pages.length > INBOX_LIMITS.pages) return { ok: false, error: `List at most ${INBOX_LIMITS.pages} pages — a sitemap.xml counts as one and brings its pages.` };
  const badPage = pages.find((p) => !webAddress(p));
  if (badPage) return { ok: false, error: `“${badPage.slice(0, 60)}” isn't a web address — start it with https://.` };
  if (ai.on === true && !str(ai.about, INBOX_LIMITS.about) && filled.length === 0 && pages.length === 0 && ai.knowledge !== true) {
    return { ok: false, error: "Give the AI something to go on: set answers, your website's pages, AI Knowledge, or a few lines about your business." };
  }
  const suggestions = Array.isArray(bot.suggestions) ? bot.suggestions.map((v) => String(v ?? "").trim()).filter(Boolean) : [];
  if (suggestions.length > INBOX_LIMITS.suggestions) return { ok: false, error: `Offer at most ${INBOX_LIMITS.suggestions} suggested questions.` };
  if (suggestions.some((v) => v.length > INBOX_LIMITS.suggestion)) return { ok: false, error: `Keep each suggested question under ${INBOX_LIMITS.suggestion} characters — it's a button.` };
  const hours = isObj(input.hours) ? input.hours : {};
  if (typeof hours.away === "string" && hours.away.trim().length > INBOX_LIMITS.away) return { ok: false, error: `Keep the away message under ${INBOX_LIMITS.away} characters.` };
  if (isObj(hours.days)) {
    for (const w of WEEKDAYS) {
      const day = hours.days[w];
      if (day === null || day === undefined) continue;
      if (!isObj(day) || typeof day.from !== "string" || typeof day.to !== "string" || !TIME.test(day.from) || !TIME.test(day.to)) return { ok: false, error: "Give each open day its hours as 09:00 to 18:00." };
      if (day.from >= day.to) return { ok: false, error: "A day's closing time comes after its opening time." };
    }
  }
  const assign = isObj(input.assign) ? input.assign : {};
  if (Array.isArray(assign.people) && assign.people.length > INBOX_LIMITS.team) return { ok: false, error: `Name at most ${INBOX_LIMITS.team} people to take turns.` };
  const proactive = Array.isArray(input.proactive) ? input.proactive.filter(isObj).filter((r) => str(r.path, 300) || str(r.message, 1000)) : [];
  if (proactive.length > INBOX_LIMITS.proactive) return { ok: false, error: `Keep it to ${INBOX_LIMITS.proactive} proactive messages.` };
  for (const r of proactive) {
    if (!proactivePath(r.path)) return { ok: false, error: "Give each proactive message a page starting with “/” (like /pricing), or * for every page." };
    if (!str(r.message, 1000)) return { ok: false, error: "Each proactive message needs its words." };
    if (String(r.message).trim().length > INBOX_LIMITS.proactiveMessage) return { ok: false, error: `Keep a proactive message under ${INBOX_LIMITS.proactiveMessage} characters.` };
    const delay = Number(r.delay);
    if (!Number.isFinite(delay) || delay < 3 || delay > 600) return { ok: false, error: "Wait between 3 and 600 seconds before a proactive message." };
  }
  // A lead needs some way to reach them; a form that's on needs something in it.
  const read = channelSettings(input, kind);
  if (read.autoLead && !read.leadNeeds.email && !read.leadNeeds.phone) return { ok: false, error: "A lead needs a phone number or an email to reach them by — tick at least one of the two." };
  if (read.prechat.on && DETAIL_FIELDS.every((f) => read.prechat.fields[f] === "off")) return { ok: false, error: "The form before the chat needs at least one field — or switch it off." };
  const look = isObj(input.look) ? input.look : {};
  if (typeof look.colour === "string" && look.colour && !HEX.test(look.colour)) return { ok: false, error: "Choose the colour as #RRGGBB." };
  const sites = Array.isArray(input.allowedSites) ? input.allowedSites.map((s) => String(s).trim()).filter(Boolean) : [];
  if (sites.length > INBOX_LIMITS.sites) return { ok: false, error: `Name at most ${INBOX_LIMITS.sites} sites.` };
  const bad = sites.find((s) => !siteOrigin(s));
  if (bad) return { ok: false, error: `“${bad.slice(0, 60)}” isn't a website address.` };
  return { ok: true, settings: channelSettings({ ...input, bot: { ...bot, answers: filled }, proactive }, kind) };
}

/**
 * Whether the team is in, by the channel's office hours, at a moment as the workspace's clock reads it
 * (src/lib/time/zone.ts `parts`: 0 is Sunday). Always in while office hours are off.
 */
export function withinHours(hours: ChannelSettings["hours"], at: { weekday: number; hour: number; minute: number }): boolean {
  if (!hours.on) return true;
  const day = hours.days[WEEKDAYS[(at.weekday + 6) % 7]!];
  if (!day) return false;
  const now = `${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`;
  return now >= day.from && now < day.to;
}

/** CNV-000123: what staff quote. */
export const conversationRef = (seq: number) => `CNV-${String(seq).padStart(6, "0")}`;

/** Whether free text may go to a WhatsApp customer now. */
export function whatsappWindowOpen(lastCustomerAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!lastCustomerAt) return false;
  const at = typeof lastCustomerAt === "string" ? new Date(lastCustomerAt) : lastCustomerAt;
  return now.getTime() - at.getTime() < WHATSAPP_WINDOW_MS;
}

/** The snippet a website pastes before </body>. */
export function widgetSnippet(origin: string, publicKey: string): string {
  return `<script src="${origin}/api/inbox/public/widget.js" data-key="${publicKey}" async></script>`;
}
