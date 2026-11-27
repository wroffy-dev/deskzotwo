/**
 * The tools a self-hosted model is offered for one question (owner, 23 Nov 2026, with a screenshot).
 *
 * On Deskzo's own Ollama (llama3.2 3B, CPU only) the copilot was offered all twenty tools on every question. A "Hi"
 * came back as a search for "Microsoft 365" and a look-up of COM-000123 — the examples in the tools' own
 * descriptions — and every question carried ~4,600 tokens of tools and prompt, read at ~50 tokens a second before the
 * first word. A small model picks well among a few tools and badly among twenty.
 *
 * So a self-hosted model (src/lib/ai/gateway.ts `aiSelfHosted`) is offered only the tools the question is about:
 *   · small talk — a greeting, thanks — gets none, and is simply answered;
 *   · otherwise the tools whose words the question uses (company, lead, renewal, how many…), at most MAX_TOOLS;
 *   · a follow-up that names nothing ("and last month?", "do it", "yes") gets the tools of the last question before it
 *     that named something, and the answer to "which lead?" ("LEAD-000123", "the Acme one") keeps the change to a lead
 *     that was asked for;
 *   · anything else gets a few general ones.
 * Only ever a subset of what the person may use (`toolsFor`), so nothing is widened; a hosted model still gets all.
 */

/** At most this many tools for one question. */
export const MAX_TOOLS = 6;

/** Tried when a question names nothing a tool is about, and the question before it didn't either. */
const GENERAL = ["search_knowledge", "search_companies", "dashboard_summary"];

const ADD = /\b(add|create|make|new|log|record|banao|bana do|jodo)\b/;

/** Words a question uses → the tools it is about. Lower-case; Hinglish where people type it. */
const TOPICS: { words: RegExp; tools: string[] }[] = [
  { words: /\b(compan(y|ies)|customers?|clients?|accounts?|com-\d+|gstin)\b/, tools: ["search_companies", "get_company"] },
  { words: /\b(leads?|prospects?|enquir(y|ies)|inquir(y|ies)|lead-\d+|pipeline)\b/, tools: ["list_leads", "search_companies"] },
  { words: /\b(orders?|sales?|sold|deals?|bookings?|ord-\d+)\b/, tools: ["list_orders"] },
  { words: /\b(renewals?|renew\w*|expir\w*|subscriptions?|licen[cs]es?)\b/, tools: ["list_renewals"] },
  { words: /\b(tickets?|complaints?|support|issues?|tck-\d+)\b/, tools: ["list_tickets"] },
  { words: /\b(tasks?|to-?dos?|follow[- ]?ups?|reminders?|my day|pending work)\b/, tools: ["my_tasks"] },
  { words: /\b(dashboard|summary|overview|today|this week|how are we doing)\b/, tools: ["dashboard_summary"] },
  {
    words: /\b(reports?|totals?|count|how many|how much|kitne|kitna|sum|trend|compare|comparison|revenue|top \d*|by month|monthly|quarter\w*|yearly|last (month|year|week)|this (month|year|quarter)|growth|chart)\b/,
    tools: ["report_options", "run_report"],
  },
  { words: /\b(colleagues?|who is|manager|team|employees?|staff|headcount|people|reports to|department)\b/, tools: ["find_colleague", "people_directory"] },
  { words: /\b(research|qualify|brief|ved)\b/, tools: ["ved_research_plan", "search_companies"] },
  { words: /\b(nurture|tara|follow-?up emails?)\b/, tools: ["tara_nurture_lead", "list_leads"] },
  { words: /\b(chase|collect\w*|overdue|outstanding|receivables?|unpaid|dues?|payments? due|arjun)\b/, tools: ["arjun_who_to_chase", "arjun_draft_chase"] },
  { words: /\b(how (do|to|can)|process|policy|policies|guide|steps|what is|kaise|procedure|explain)\b/, tools: ["search_knowledge"] },
];

/** Creating one of the three things the copilot creates — the question must ask for it. */
const CREATES: { words: RegExp; tool: string }[] = [
  { words: /\b(tasks?|reminders?|to-?dos?|follow[- ]?ups?)\b/, tool: "propose_task" },
  { words: /\bnotes?\b/, tool: "propose_note" },
  { words: /\b(leads?|prospects?|enquir(y|ies))\b/, tool: "propose_lead" },
];

const SMALL_TALK =
  /^(hi+|hii+|hello+|hey+|hiya|yo|namaste|namaskar|good (morning|afternoon|evening|night)|thanks?( you)?|thank u|thx|ty|ok(ay)?|cool|great|nice|bye|see you|who are you|what can you do|how are you|kaise ho|kya haal hai|shukriya|dhanyavaad)[\s!.?,]*$/;

/** Changing a lead that exists (propose_lead_update) — the question must ask for a change, to a lead or a quantity. */
const CHANGE = /\b(edit\w*|change\w*|update\w*|modify|correct|fix|revise|rename|set|increase|decrease|reduce|raise|lower|make (it|this|that|the)|badlo|badal\w*|badha\w*|kam kar\w*|kar ?do)\b/;
const LEAD_WORDS = /\b(leads?|prospects?|enquir(y|ies)|inquir(y|ies)|lead-\d+|deal|quantity|qty|close date|estimated value)\b/;
/**
 * A lead's own fields, which a change can name without the word "lead" (owner, 26 Nov 2026: "change this title add
 * test75", right after a lead was made, was never offered the change and the model said it had made it) — unless the
 * question names another kind of record, whose title or value it is then about.
 */
const LEAD_FIELDS = /\b(title|description|value|amount|closing date|expected close|requirement)\b/;
const OTHER_RECORD = /\b(tasks?|notes?|tickets?|orders?|invoices?|quot(e|es|ation|ations)|compan(y|ies)|contacts?|renewals?|items?|products?|campaigns?|templates?|projects?)\b/;
const asksLeadChange = (question: string) => {
  const q = question.toLowerCase();
  return CHANGE.test(q) && (LEAD_WORDS.test(q) || (LEAD_FIELDS.test(q) && !OTHER_RECORD.test(q)));
};
/** The topics the answer to "which lead?" can be about. */
const WHICH_LEAD = new Set(["list_leads", "search_companies", "get_company"]);

function topicTools(question: string): string[] {
  const q = question.toLowerCase();
  const names: string[] = [];
  if (asksLeadChange(q)) names.push("propose_lead_update", "list_leads");
  if (ADD.test(q)) for (const c of CREATES) if (c.words.test(q)) names.push(c.tool);
  for (const t of TOPICS) if (t.words.test(q)) names.push(...t.tools);
  if (names.includes("propose_lead")) names.unshift("search_companies");
  return [...new Set(names)];
}

/**
 * An answer that says something was saved when no card was drawn this question (owner, 26 Nov 2026: "The lead title has
 * been updated", twice, with nothing changed). Only what the model says it has done — "has been updated", "I've
 * created" — never a record's history ("LEAD-000014 was created on 5 Oct").
 */
const CLAIMS_DONE =
  /\b(?:has|have)\s+(?:now\s+)?been\s+(?:successfully\s+)?(?:updated|changed|edited|renamed|created|saved|added|made|set|confirmed|applied|done)\b|\bi(?:'ve|\s+have)\s+(?:now\s+)?(?:successfully\s+)?(?:updated|changed|edited|renamed|created|saved|added|made|set|applied)\b|\b(?:change|update)s?\s+(?:has|have)\s+been\s+made\b/i;
/** A sentence that says it wasn't ("Nothing has been changed yet") isn't a claim. */
const NOT = /\b(nothing|not|no|never|yet to)\b|n't\b/i;
export const claimsDone = (answer: string): boolean => answer.split(/(?<=[.!?\n])\s+/).some((s) => CLAIMS_DONE.test(s) && !NOT.test(s));

/** Whether the question is only a greeting or thanks — answered without any tool. */
export function isSmallTalk(question: string): boolean {
  return SMALL_TALK.test(question.trim().toLowerCase());
}

/** How far back a follow-up looks for the question it follows ("change the title" → "do it" → "yes" → …). */
const FOLLOW_UP_DEPTH = 5;

/**
 * The tools offered for `question`, in their usual order (so a question's steps send the same list): a subset of
 * `tools`, at most MAX_TOOLS. `earlier` is the questions before it in the conversation, newest first (or only the one
 * before it), for a follow-up: it follows the newest of them that named something.
 */
export function toolsForQuestion<T extends { name: string }>(question: string, earlier: string | string[], tools: T[]): T[] {
  if (isSmallTalk(question)) return [];
  const previous = (typeof earlier === "string" ? [earlier] : earlier).slice(0, FOLLOW_UP_DEPTH).find((q) => q.trim() && !isSmallTalk(q) && topicTools(q).length) ?? "";
  let wanted = topicTools(question);
  if (asksLeadChange(previous) && !ADD.test(question.toLowerCase()) && wanted.every((n) => WHICH_LEAD.has(n))) wanted = ["propose_lead_update", "list_leads", ...wanted];
  else if (!wanted.length && previous) wanted = topicTools(previous);
  if (!wanted.length) wanted = GENERAL;
  const chosen = new Set(wanted.slice(0, MAX_TOOLS));
  return tools.filter((t) => chosen.has(t.name));
}
