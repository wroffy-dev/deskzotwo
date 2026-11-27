import { styled } from "@/lib/ai/house-style";
import { AiRefusal, aiTurn, aiUnavailable } from "@/lib/ai/gateway";
import type { Turn } from "@/lib/copilot/types";
import type { ChannelSettings } from "@/lib/inbox/settings";
import type { Passage } from "@/lib/inbox/knowledge";
import type { KnowledgeHit } from "@/lib/ai-knowledge/search";
import { KNOWLEDGE_PROMPT_CHARS, fitKnowledge, inboxFileRender, inboxPageRender, renderedLength } from "@/lib/ai-knowledge/budget";

/**
 * Deskzo AI answering a customer for the Customer inbox's bot (owner, 24 Oct 2026: set answers by
 * default, AI an option a channel switches on). Through Deskzo AI's gateway (src/lib/ai/gateway.ts) — the
 * workspace's credits, the platform's pause, the feature's model — as feature "inbox.answer".
 *
 * Told as little as will do (the owner is wary of what goes to a model): the conversation, the channel's
 * set answers, its notes about the business, the few passages of its own public website that match
 * the question (src/lib/inbox/knowledge.ts), and — where the channel ticks "Use AI Knowledge" — the 3 chunks of
 * the workspace's AI Knowledge files that do (src/lib/ai-knowledge). No customer record, no other conversation.
 * The files and the website together are at most 4,000 characters (src/lib/ai-knowledge/budget.ts: the model has
 * 8k of context), the files first — they're what the business wrote for the purpose. It answers
 * briefly from those alone, and says HANDOVER — and the bot passes the customer to a person — for
 * anything it isn't sure of, anything about the customer's own order or account, or a person asked for.
 * A refusal or a failure hands over the same way: a customer never waits on the AI.
 */

export const HANDOVER_MARK = "HANDOVER";

export type AiReply = { text: string } | { handover: true };

type Answerer = (input: { system: string; history: Turn[]; chargedTo: string }) => Promise<string | null>;
let testAnswerer: Answerer | null = null;

/** For the checks: every AI answer comes from here instead of a model. Null puts the gateway back. */
export function setTestInboxAi(answerer: Answerer | null) {
  testAnswerer = answerer;
}

/**
 * The knowledge a brief is given: AI Knowledge's chunks first, then the website's passages in the room left — the two
 * together never more than KNOWLEDGE_PROMPT_CHARS as written into the prompt.
 */
export function briefKnowledge(files: KnowledgeHit[], pages: Passage[], budget: number = KNOWLEDGE_PROMPT_CHARS): { files: KnowledgeHit[]; pages: Passage[] } {
  const keptFiles = fitKnowledge(files, inboxFileRender, budget);
  const used = renderedLength(keptFiles, inboxFileRender);
  return { files: keptFiles, pages: fitKnowledge(pages, inboxPageRender, budget - used) };
}

/**
 * What the model is told: who it speaks for, how a good agent chats (owner, 24 Oct 2026: "like a real
 * human agent talks"), what it may say, and when to stop. Honest about being the assistant when asked.
 */
export function aiSystemPrompt(settings: ChannelSettings, business: string, customerFirstName: string | null = null, website: Passage[] = [], knowledgeFiles: KnowledgeHit[] = []): string {
  const answers = settings.bot.answers.map((a) => `- When asked about ${a.keywords}: ${a.answer}`).join("\n");
  const name = settings.bot.name.trim();
  const { files, pages: knowledge } = briefKnowledge(knowledgeFiles, website);
  return [
    `You are ${name || "the assistant"} in ${business}'s website chat and WhatsApp, chatting with a customer the way a friendly, experienced support agent would.`,
    "Write like a person typing in a chat: one or two short sentences, warm and natural, with contractions. No lists, no headings, no bold, no sign-off. Ask at most one question.",
    customerFirstName ? `The customer's name is ${customerFirstName}; use it now and then, not in every message.` : "",
    "Acknowledge how they feel in a few words when they're unhappy or in a hurry. Use an emoji only if they do.",
    "Reply in the language and script the customer writes in — English, Hindi or Hinglish.",
    `If they ask whether you're a bot or a real person, say honestly that you're ${name ? `${name}, ` : ""}the virtual assistant, and offer to bring in someone from the team. Never say you are human.`,
    "Answer only from the facts below. Never invent prices, dates, stock, offers or promises, and never ask for a password, card number or one-time code.",
    files.length ? "The knowledge files below are the business's own notes: answer from them in your own words, and never mention the files or their names." : "",
    knowledge.length ? "When an answer comes from one of the website's pages below, you may give that page's address so they can read more — just the address, once." : "",
    `Reply with exactly ${HANDOVER_MARK} and nothing else when: the answer isn't in the facts; the customer asks for a person, a quotation or a call; it's about their own order, invoice, account or a complaint; or you are not sure.`,
    "",
    "Facts:",
    answers || "(no set answers)",
    settings.bot.ai.about ? `\nAbout the business:\n${settings.bot.ai.about}` : "",
    // The chunks of the business's AI Knowledge files that best match what the customer asked (src/lib/ai-knowledge).
    files.length ? `\nFrom the business's own knowledge files:\n${files.map(inboxFileRender).join("\n\n")}` : "",
    // The passages of the business's own website that best match what the customer asked (src/lib/inbox/knowledge.ts).
    knowledge.length ? `\nFrom the website:\n${knowledge.map(inboxPageRender).join("\n\n")}` : "",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

/** The conversation, as turns: the customer's words as theirs, the bot's and the team's as the assistant's. The last ten. */
export function aiHistory(messages: { author: string; body: string }[]): Turn[] {
  const turns: Extract<Turn, { role: "user" | "assistant" }>[] = [];
  // Colleagues' notes to each other are never the customer's conversation.
  for (const m of messages.filter((x) => x.author !== "SYSTEM" && x.author !== "NOTE").slice(-10)) {
    const role = m.author === "CUSTOMER" ? "user" : "assistant";
    const last = turns[turns.length - 1];
    // Two of the same in a row are one turn: the model wants them taking turns.
    if (last && last.role === role) {
      last.text = `${last.text}\n${m.body}`;
      continue;
    }
    turns.push(role === "user" ? { role, text: m.body } : { role, text: m.body, toolCalls: [] });
  }
  // It must start with the customer.
  while (turns.length && turns[0]!.role !== "user") turns.shift();
  return turns;
}

/** Deskzo AI's answer to the customer's latest message, or a handover. Never throws. */
export async function aiAnswer(input: {
  settings: ChannelSettings;
  business: string;
  messages: { author: string; body: string }[];
  customerFirstName?: string | null;
  /** The website's passages that match (src/lib/inbox/knowledge.ts). */
  knowledge?: Passage[];
  /** AI Knowledge's chunks that match, where the channel ticks "Use AI Knowledge" (src/lib/ai-knowledge). */
  files?: KnowledgeHit[];
}): Promise<AiReply> {
  const chargedTo = input.settings.bot.ai.chargedTo;
  if (!input.settings.bot.ai.on || !chargedTo) return { handover: true };
  const history = aiHistory(input.messages);
  if (!history.length || history[history.length - 1]!.role !== "user") return { handover: true };
  // The workspace's house style after Kabir's own rules (owner, 20 Nov 2026 — src/lib/ai/house-style.ts), no sign-off in a chat.
  const system = await styled(aiSystemPrompt(input.settings, input.business, input.customerFirstName ?? null, input.knowledge ?? [], input.files ?? []), { signOff: false });
  try {
    let text: string | null;
    if (testAnswerer) {
      text = await testAnswerer({ system, history, chargedTo });
    } else {
      if (await aiUnavailable(chargedTo, "inbox.answer")) return { handover: true };
      const outcome = await aiTurn({ userId: chargedTo, feature: "inbox.answer", system, history, tools: [] });
      text = outcome.stop === "done" ? outcome.text : null;
    }
    const answer = text?.trim() ?? "";
    if (!answer || answer.toUpperCase().includes(HANDOVER_MARK) || answer.length > 1200) return { handover: true };
    return { text: answer };
  } catch (err) {
    if (!(err instanceof AiRefusal)) console.error("[inbox] Deskzo AI couldn't answer; handed over", err instanceof Error ? err.message : err);
    return { handover: true };
  }
}
