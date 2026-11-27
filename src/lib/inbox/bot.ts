import { INBOX_LIMITS, detailsMissing, type ChannelSettings, type InboxKind } from "@/lib/inbox/settings";

/**
 * The Customer inbox's bot (owner, 24 Oct 2026: set answers by default; "like a real human agent talks").
 * Pure — no database, no clock — so the settings page can try it and the checks can walk it.
 *
 *   · It answers from the channel's set answers when a message has one of their words, and otherwise
 *     hands the customer to a person: first asking for the details the channel says to (`bot.ask` — a
 *     name, a company name, an email, a phone number, or either of the last two), one at a time, each
 *     asked twice at most. Asking for a person hands over at once, by the same route.
 *   · It talks the way a good agent does: a greeting answered with a greeting, thanks with "you're
 *     welcome", the customer called by their first name once it knows it, one short thing at a time,
 *     and never the same line twice running — each line has a few ways of saying it, chosen by `seed`
 *     (the conversation and how far into it), so a conversation reads naturally and a check reads the
 *     same every time.
 *   · Asked whether it's a person, it says honestly that it's the assistant, and offers somebody from the
 *     team. Sounding human is the style; claiming to be one is not.
 */

export type BotState = {
  /** What it's waiting for: nothing; a name; a company name; a phone number or an email ("contact"); a phone number; an email. */
  step: "chatting" | "name" | "company" | "contact" | "phone" | "email" | "namecontact";
  /** With "namecontact": which way to reach them it asked for alongside the name. */
  want?: "contact" | "phone" | "email";
  /** Times the detail now asked for wasn't given: after the second, it's let go. */
  misses?: number;
  /** Details asked for twice and not given: not asked again. */
  skipped?: string[];
  /** Set answers given so far — after the first, it asks whether there's anything else. */
  answered?: number;
};

export type Known = { name: string | null; email: string | null; phone: string | null; company?: string | null };

export type BotTurn = {
  replies: string[];
  state: BotState;
  /** The bot is done: a person takes the conversation from here. */
  handover: boolean;
  /** What the customer told it. */
  learned: Partial<Known>;
  /**
   * Why it said what it said: a set answer; small talk (a greeting, thanks, goodbye, "are you a bot?");
   * on the way to a person because they asked for one; because no set answer fitted ("unknown" — where
   * Deskzo AI may answer instead, if the channel lets it); or asking for and taking their details.
   */
  reason: "answer" | "smalltalk" | "asked" | "unknown" | "details";
};

// ─── What it says, several ways ──────────────────────────────────────────────────────────────────

/** `{first}` is the customer's first name, when there is one; a line that needs it is only picked with one. */
const LINES = {
  // A name and a way to reach them in one go (owner, 31 Oct 2026: "lighter handover") — one message, not two.
  askNameContact: [
    "Happy to get someone for you! What's your name, and the best phone number or email to reach you on?",
    "Sure — I'll bring in a teammate. Could you share your name and a phone number or email, in case we get cut off?",
  ],
  askNamePhone: ["Happy to get someone for you! What's your name, and the best number to reach you on?", "Sure — I'll bring in a teammate. Could you share your name and a phone number?"],
  askNameEmail: ["Happy to get someone for you! What's your name, and your email address?", "Sure — I'll bring in a teammate. Could you share your name and email?"],
  nameContactAgain: ["Sorry, I didn't quite catch that — what's your name, and a number or email to reach you?", "Oops, I missed that. Your name, and a phone number or email?"],
  askName: ["Happy to get someone for you! Who am I chatting with?", "Sure — I'll bring in a teammate. May I have your name first?", "Of course. Before I pass you over, what's your name?"],
  askContact: [
    "Thanks, {first}! What's the best number or email to reach you on, just in case we get cut off?",
    "Nice to meet you, {first}. Could you share a phone number or email, so we can reach you if the chat drops?",
    "Thanks {first}! And a phone number or email, in case we need to get back to you?",
  ],
  askContactNoName: ["What's the best number or email to reach you on, just in case we get cut off?", "Could you share a phone number or email, so we can reach you if the chat drops?"],
  askContactAgain: ["Hmm, that doesn't look like a phone number or an email. Could you share one, so we don't lose you?", "Sorry, I couldn't spot a number or email there — mind sharing one?"],
  askPhone: ["Thanks, {first}! What's the best number to reach you on?", "Nice to meet you, {first}. Could you share a phone number, in case we need to call you back?"],
  askPhoneNoName: ["What's the best phone number to reach you on?", "Could you share a phone number, in case we need to call you back?"],
  askPhoneAgain: ["Hmm, that doesn't look like a phone number. Could you share one?", "Sorry, I couldn't spot a number there — mind sharing one?"],
  askEmail: ["Thanks, {first}! And your email address, so we can send you the details?", "Got it, {first}. What's your email, so we can follow up?"],
  askEmailNoName: ["What's your email address, so we can follow up?", "Could you share an email address, so we can send you the details?"],
  askEmailAgain: ["Hmm, that doesn't look like an email address. Could you share one?", "Sorry, I couldn't spot an email there — mind sharing it?"],
  askCompany: ["Thanks, {first}! Which company are you with?", "Nice to meet you, {first}. And which company are you from?"],
  askCompanyNoName: ["Which company are you with?", "And which company are you from?"],
  companyAgain: ["Sorry, I didn't catch the company's name — which company is it?", "Oops, I missed that. What's your company called?"],
  nameAgain: ["Sorry, I didn't quite catch that — what should I call you?", "Oops, I missed that. What's your name?"],
  hello: ["Hi there! 👋 How can I help?", "Hello! What can I do for you today?", "Hey! How can I help you today?"],
  helloNamed: ["Hi {first}! 👋 How can I help?", "Hello {first}! What can I do for you today?"],
  thanks: ["You're welcome! Anything else I can help with?", "Happy to help! Is there anything else?", "Anytime! Let me know if there's anything else."],
  thanksNamed: ["You're welcome, {first}! Anything else I can help with?", "Happy to help, {first}! Is there anything else?"],
  bye: ["Take care! 👋", "Thanks for chatting — have a great day!", "Bye for now! We're here whenever you need us."],
  ack: ["👍", "Great!", "Perfect."],
  anythingElse: ["Anything else I can help with?", "Is there anything else you'd like to know?", "Happy to help with anything else, too."],
  botIntro: [
    "I'm {assistant} — the virtual assistant here. I can answer quick questions, or get someone from the team whenever you like. Just say the word!",
    "I'm {assistant}, the virtual assistant for the team. Happy to help with quick questions — or I can bring in a person straight away if you'd prefer.",
  ],
} as const;

export const ASK_NAME = LINES.askName[0];
export const ASK_NAME_LINES: readonly string[] = LINES.askName;
/** Every way it asks for a name and a way to reach them in one message. */
export const ASK_NAME_CONTACT_LINES: readonly string[] = [...LINES.askNameContact, ...LINES.askNamePhone, ...LINES.askNameEmail];

/** A stable number from a seed — the same seed picks the same line, so the bot is pure. */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The customer's first name, for talking to them; null without one. */
export const firstNameOf = (name: string | null | undefined): string | null => name?.trim().split(/\s+/)[0]?.slice(0, 40) || null;

/** One way of saying `lines`, by `seed`, with the customer's first name and the assistant's name filled in. */
function say(lines: readonly string[], seed: string, first: string | null, assistant = "the assistant"): string {
  return lines[hash(seed) % lines.length]!.replace(/\{first\}/g, first ?? "").replace(/\{assistant\}/g, assistant);
}

/**
 * A channel's own line with `{name}` in it, as the customer reads it: their first name, or — without one —
 * the name and the comma before it left out ("Thanks, {name}!" → "Thanks!").
 */
export function withName(text: string, first: string | null): string {
  return first ? text.replace(/\{name\}/g, first) : text.replace(/,?\s*\{name\}/g, "");
}

// ─── Reading the customer ────────────────────────────────────────────────────────────────────────

const WANTS_PERSON = /\b(agent|human|person|someone|somebody|executive|representative|operator|talk to|speak to|speak with|call me|call back|callback|real person)\b/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
/** The whole message is one of these — said on its own, not inside a question. */
const HELLO = /^(hi+|hello+|hey+|hiya|namaste|namaskar|hola|good (morning|afternoon|evening)|greetings|yo)[\s!.,👋🙏]*$/iu;
const THANKS = /^(ok(ay)?[\s,]*)?(thanks?|thank you|thx|ty|many thanks|thank u|dhanyavad|shukriya|thanks a lot)( (so much|a lot))?[\s!.🙏😊👍]*$/iu;
const BYE = /^(bye+|goodbye|good night|see (you|ya)|take care|cya|tata)[\s!.👋]*$/iu;
const ACK = /^(ok(ay)?|k|kk|cool|great|nice|got it|alright|sure|fine|done|👍|👌|🙂|😊)[\s!.]*$/iu;
const ARE_YOU_BOT = /\b(are you|r u|is this) (a |an )?(bot|robot|machine|ai|human|real( person)?|person|automated)\b|\bam i (talking|chatting|speaking) (to|with) (a |an )?(bot|human|real person|person|machine)\b/i;

/** Words and phrases, lower case, from an answer's comma-separated list. */
function keywordsOf(list: string): string[] {
  return list
    .split(",")
    .map((k) => k.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((k) => k.length >= 2);
}

/**
 * Words people use for the same thing (owner, 31 Oct 2026: "smarter set-answer matching") — an answer listed
 * under one is found by any of them, in English, Hindi or Hinglish. Kept to groups that can't mislead.
 */
const SAME_THING: readonly (readonly string[])[] = [
  ["price", "pricing", "cost", "rate", "charges", "fee", "fees", "kitna", "kitne", "kitni", "keemat", "kimat", "daam"],
  ["demo", "demonstration", "walkthrough"],
  ["trial", "free trial", "try it"],
  ["refund", "money back"],
  ["discount", "offer", "coupon"],
  ["timings", "timing", "opening hours", "office hours", "working hours"],
  ["address", "location", "where are you", "office address"],
  ["delivery", "shipping", "dispatch"],
];

/** A keyword with the words that mean the same as it. */
export function withSameThing(keyword: string): string[] {
  const group = SAME_THING.find((g) => g.includes(keyword));
  return group ? [...new Set([keyword, ...group])] : [keyword];
}

/**
 * Whether `phrase` appears in `text` as whole words — a single word also in its everyday forms ("price":
 * "prices", "priced", "pricing"; "plan": "plans", "planning"), so a customer needn't type it as the list does.
 */
function hasPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  const single = !phrase.includes(" ") && /^\p{L}{3,}$/u.test(phrase);
  // "price" → "pric(e|es|ed|ing)"; "plan" → "plan(s|ned|ning|…)": the endings that keep the meaning — never
  // "-er", which makes another word ("open" isn't "opener").
  const stem = single && phrase.endsWith("e") ? `${escaped.slice(0, -1)}(?:e|es|ed|ing)` : single ? `${escaped}(?:s|es|ed|ing|${escaped.slice(-1)}ed|${escaped.slice(-1)}ing)?` : escaped;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${stem}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

/** How a set answer fits a message: the answer, and whether it is only a short word passing through a long message. */
export type AnswerMatch = { answer: string; weak: boolean };

/**
 * The set answer a message asks for — the one with most of its words in it, and between two with as many,
 * the one whose longest match says more ("price list" over "price") — or null. A single short word in a
 * long message ("…and what does it cost to add a user to the plan I'm on and…") is `weak`: Deskzo AI, where
 * it's on, reads the whole message instead — the set answers are among what it is told.
 */
export function matchAnswerDetail(text: string, answers: ChannelSettings["bot"]["answers"]): AnswerMatch | null {
  let best: { answer: string; hits: number; longest: number } | null = null;
  for (const a of answers) {
    // Each thing asked about counts once: "price" and "cost" in one list are one hit, not two.
    const said = new Map<string, number>();
    for (const k of keywordsOf(a.keywords)) {
      const group = withSameThing(k);
      const word = group.find((w) => hasPhrase(text, w));
      const key = [...group].sort().join("|");
      if (word) said.set(key, Math.max(said.get(key) ?? 0, word.length));
    }
    if (!said.size) continue;
    const hits = said.size;
    const longest = Math.max(...said.values());
    if (!best || hits > best.hits || (hits === best.hits && longest > best.longest)) best = { answer: a.answer, hits, longest };
  }
  if (!best) return null;
  const words = text.trim().split(/\s+/).length;
  return { answer: best.answer, weak: best.hits === 1 && best.longest <= 5 && words > 12 };
}

export function matchAnswer(text: string, answers: ChannelSettings["bot"]["answers"]): string | null {
  return matchAnswerDetail(text, answers)?.answer ?? null;
}

/** An email and a phone number in what the customer typed — either, both or neither. */
export function contactIn(text: string): { email?: string; phone?: string } {
  const out: { email?: string; phone?: string } = {};
  const email = text.match(EMAIL)?.[0];
  if (email) out.email = email.toLowerCase();
  // The number is looked for in what's left, so an email's digits are never taken for one.
  const candidate = text.replace(EMAIL, " ").match(/\+?[\d][\d\s().-]{6,20}\d/)?.[0];
  if (candidate) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) out.phone = candidate.trim().startsWith("+") ? `+${digits}` : digits;
  }
  return out;
}

/** A name from "I'm Priya", "my name is Priya Sharma" or just "Priya" — or null for something that isn't one. */
export function nameIn(text: string): string | null {
  const cleaned = text
    .trim()
    .replace(/^(hi|hello|hey)[,!.\s]+/i, "")
    .replace(/^(my name is|my name's|name is|this is|i am|i'm|im|it's|its)\s+/i, "")
    .replace(/[.!]+$/, "")
    .trim();
  if (cleaned.length < 2 || cleaned.length > INBOX_LIMITS.name) return null;
  if (EMAIL.test(cleaned) || /\d{3,}/.test(cleaned)) return null;
  if (cleaned.split(/\s+/).length > 5) return null;
  if (HELLO.test(cleaned) || THANKS.test(cleaned) || ACK.test(cleaned)) return null;
  // Thinking aloud, or saying no, isn't a name.
  if (/^(h+m+|u+m+|uh+|er+m*|no|nope|nah|na|skip|why|what|later|not now)\??$/i.test(cleaned)) return null;
  return cleaned;
}

/** A company's name from "I'm with Acme", "Acme Pvt Ltd" or "it's Acme" — or null for something that isn't one. */
export function companyIn(text: string): string | null {
  const cleaned = text
    .trim()
    .replace(/^(i'?m |i am |we'?re |we are )?(with|from|at|working (at|for)|work (at|for))\s+/i, "")
    .replace(/^(my |our |the )?(company|firm|business|organi[sz]ation)( name)?( is|'s)?\s*:?\s*/i, "")
    .replace(/^(it'?s|its|this is)\s+/i, "")
    .replace(/[.!]+$/, "")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 120) return null;
  if (EMAIL.test(cleaned) || /^\+?[\d\s().-]+$/.test(cleaned)) return null;
  if (cleaned.split(/\s+/).length > 8) return null;
  if (HELLO.test(cleaned) || THANKS.test(cleaned) || ACK.test(cleaned) || /^(no|nope|none|na|n\/a|skip)$/i.test(cleaned)) return null;
  return cleaned;
}

/** The bot's opening words, or null when it isn't on. */
export function botGreeting(settings: ChannelSettings): string | null {
  return settings.bot.on ? settings.greeting : null;
}

/** The small talk a whole message is, if it's only that. */
export function smallTalkOf(text: string): "hello" | "thanks" | "bye" | "ack" | "bot" | null {
  const t = text.trim();
  if (HELLO.test(t)) return "hello";
  if (THANKS.test(t)) return "thanks";
  if (BYE.test(t)) return "bye";
  if (ACK.test(t)) return "ack";
  if (ARE_YOU_BOT.test(t)) return "bot";
  return null;
}

// ─── A turn ──────────────────────────────────────────────────────────────────────────────────────

/** The words for asking a detail: first time with their name or without, and again. */
const ASKING = {
  contact: { named: LINES.askContact, plain: LINES.askContactNoName, again: LINES.askContactAgain },
  phone: { named: LINES.askPhone, plain: LINES.askPhoneNoName, again: LINES.askPhoneAgain },
  email: { named: LINES.askEmail, plain: LINES.askEmailNoName, again: LINES.askEmailAgain },
} as const;

/**
 * On the way to a person: the next detail the channel wants and doesn't have (`bot.ask`), or the
 * handover. WhatsApp already knows the number. A detail not given after asking twice is let go.
 */
function towardsPerson(settings: ChannelSettings, kind: InboxKind, known: Known, reason: BotTurn["reason"], seed: string, misses = 0, skipped: string[] = []): BotTurn {
  const first = firstNameOf(known.name);
  // A WhatsApp customer's number is the conversation's own.
  const have = kind === "WHATSAPP" ? { ...known, phone: known.phone ?? "whatsapp" } : known;
  const missing = settings.bot.askDetails ? detailsMissing(settings.bot.ask, have, skipped) : [];
  const next = missing[0];
  // The name and the way to reach them asked together, where both are wanted and neither is known.
  const reach = missing.find((m): m is "contact" | "phone" | "email" => m === "contact" || m === "phone" || m === "email");
  if (next === "name" && reach && !skipped.includes("namecontact")) {
    const lines = misses ? LINES.nameContactAgain : reach === "phone" ? LINES.askNamePhone : reach === "email" ? LINES.askNameEmail : LINES.askNameContact;
    return { replies: [say(lines, `${seed}:namecontact`, null)], state: { step: "namecontact", want: reach, misses, skipped }, handover: false, learned: {}, reason };
  }
  if (next === "name") return { replies: [say(LINES.askName, `${seed}:name`, null)], state: { step: "name", misses, skipped }, handover: false, learned: {}, reason };
  if (next === "company") {
    const line = misses ? say(LINES.companyAgain, `${seed}:companyagain`, first) : say(first ? LINES.askCompany : LINES.askCompanyNoName, `${seed}:company`, first);
    return { replies: [line], state: { step: "company", misses, skipped }, handover: false, learned: {}, reason };
  }
  if (next) {
    const words = ASKING[next];
    const line = misses ? say(words.again, `${seed}:again`, first) : say(first ? words.named : words.plain, `${seed}:${next}`, first);
    return { replies: [line], state: { step: next, misses, skipped }, handover: false, learned: {}, reason };
  }
  return { replies: [withName(settings.bot.handover, first)], state: { step: "chatting" }, handover: true, learned: {}, reason };
}

/**
 * The bot's turn after a customer's message. `seed` makes the choice of words: the conversation and how
 * far into it (src/lib/inbox/server.ts gives its id and the number of messages so far).
 */
export function botReply(input: { text: string; settings: ChannelSettings; state: BotState | null; known: Known; kind: InboxKind; seed?: string }): BotTurn {
  const { text, settings, kind } = input;
  const seed = input.seed ?? text;
  const state: BotState = input.state ?? { step: "chatting" };
  const known = { ...input.known };
  const first = firstNameOf(known.name);
  const assistant = settings.bot.name.trim() || "the assistant";

  const skipped = state.skipped ?? [];
  if (state.step === "namecontact") {
    // Whatever of the two they gave is kept; the name is what's left once a number or email is taken out.
    const found = contactIn(text);
    const rest = text
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, " ")
      .replace(/\+?[\d][\d\s().-]{6,20}\d/g, " ")
      .replace(/\b(and\s+)?(my\s+)?(phone|mobile|contact|number|email|e-mail|whatsapp)(\s+(number|no\.?|id))?(\s+is)?\s*:?/gi, " ")
      .replace(/[,;:|/-]+/g, " ")
      .replace(/\s+and\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    // "you can call me on …" isn't a name.
    const name = /\b(call|reach|contact|me|you|at|on|please|can)\b/i.test(rest) ? null : nameIn(rest);
    const learned: Partial<Known> = { ...found, ...(name ? { name } : {}) };
    Object.assign(known, learned);
    if (name || found.email || found.phone) return { ...towardsPerson(settings, kind, known, "details", seed, 0, [...skipped, "namecontact"]), learned };
    const misses = (state.misses ?? 0) + 1;
    // Asked twice together and not given: ask for each on its own, as before.
    return misses >= 2 ? towardsPerson(settings, kind, known, "details", seed, 0, [...skipped, "namecontact"]) : towardsPerson(settings, kind, known, "details", seed, misses, skipped);
  }
  if (state.step === "name") {
    const name = nameIn(text);
    if (!name) return { replies: [say(LINES.nameAgain, `${seed}:nameagain`, null)], state, handover: false, learned: {}, reason: "details" };
    known.name = name;
    return { ...towardsPerson(settings, kind, known, "details", seed, 0, skipped), learned: { name } };
  }

  if (state.step === "company") {
    const company = companyIn(text);
    if (company) {
      known.company = company;
      return { ...towardsPerson(settings, kind, known, "details", seed, 0, skipped), learned: { company } };
    }
    const misses = (state.misses ?? 0) + 1;
    return misses >= 2 ? towardsPerson(settings, kind, known, "details", seed, 0, [...skipped, "company"]) : towardsPerson(settings, kind, known, "details", seed, misses, skipped);
  }

  if (state.step === "contact" || state.step === "phone" || state.step === "email") {
    const found = contactIn(text);
    // Whatever they gave is kept, even if it isn't what was asked.
    Object.assign(known, found);
    const got = state.step === "contact" ? !!(found.email || found.phone) : !!found[state.step];
    if (got) return { ...towardsPerson(settings, kind, known, "details", seed, 0, skipped), learned: found };
    const misses = (state.misses ?? 0) + 1;
    // Twice asked, twice not given: let it go and move on.
    const turn = misses >= 2 ? towardsPerson(settings, kind, known, "details", seed, 0, [...skipped, state.step]) : towardsPerson(settings, kind, known, "details", seed, misses, skipped);
    return { ...turn, learned: found };
  }

  // Chatting. Small talk first, as a person would answer it — without handing over.
  const talk = smallTalkOf(text);
  const keep = { step: "chatting" as const, answered: state.answered ?? 0 };
  if (talk === "hello") return { replies: [say(first ? LINES.helloNamed : LINES.hello, `${seed}:hello`, first)], state: keep, handover: false, learned: {}, reason: "smalltalk" };
  if (talk === "thanks") return { replies: [say(first ? LINES.thanksNamed : LINES.thanks, `${seed}:thanks`, first)], state: keep, handover: false, learned: {}, reason: "smalltalk" };
  if (talk === "bye") return { replies: [say(LINES.bye, `${seed}:bye`, first)], state: keep, handover: false, learned: {}, reason: "smalltalk" };
  if (talk === "ack") return { replies: [say(LINES.ack, `${seed}:ack`, first)], state: keep, handover: false, learned: {}, reason: "smalltalk" };
  if (talk === "bot") return { replies: [say(LINES.botIntro, `${seed}:bot`, first, assistant)], state: keep, handover: false, learned: {}, reason: "smalltalk" };

  // A name or a number given unasked is kept all the same.
  const offered = contactIn(text);
  if (WANTS_PERSON.test(text)) {
    Object.assign(known, offered);
    return { ...towardsPerson(settings, kind, known, "asked", seed), learned: offered };
  }
  const match = matchAnswerDetail(text, settings.bot.answers);
  // A weak match is the AI's to read, where the channel has it on; without the AI, the set answer is still better than nothing.
  const answer = match && !(match.weak && settings.bot.ai.on) ? match.answer : null;
  if (answer) {
    const answered = (state.answered ?? 0) + 1;
    // After the first answer, a second short message — the way a person checks in.
    const replies = answered === 1 ? [answer, say(LINES.anythingElse, `${seed}:else`, first)] : [answer];
    return { replies, state: { step: "chatting", answered }, handover: false, learned: offered, reason: "answer" };
  }
  Object.assign(known, offered);
  return { ...towardsPerson(settings, kind, known, "unknown", seed), learned: offered };
}

/**
 * How long a person would take to type `text` before it appears: a beat to read, then a quick typist's
 * pace, capped so nobody waits long. For the website bubble's typing dots and WhatsApp's pause.
 */
export function typingMs(text: string): number {
  return Math.round(Math.min(3200, Math.max(900, 500 + text.length * 22)));
}
