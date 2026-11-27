import type { ToolSpec, Turn } from "@/lib/copilot/types";

/**
 * Making a turn fit the model's window, and keeping its start the same from question to question.
 *
 * Owner, 20 Nov 2026: Deskzo AI on Deskzo's own Ollama (qwen2.5 7B, an 8,192-token window) answered two or three
 * questions and then failed with "couldn't answer just now". Every turn resent the system prompt, all the tools,
 * the training and up to 40 earlier messages — and a lookup's result can be 12,000 characters — so a short chat
 * outgrew the window. A hosted model's window is hundreds of thousands of tokens and never met this; a self-hosted
 * one is whatever its server was started with.
 *
 *   · **Training goes in as a note just before the question**, not at the end of the system prompt. The training
 *     differs with each question (what it finds for it); at the end of the system prompt it changed everything after
 *     it — the tools and the whole conversation — so a server that reuses the start of the last request (Ollama's
 *     cache, a hosted provider's prompt cache) had to read all of it again for every question. Now the system prompt
 *     and the tools never change, and only the new question onward is read fresh.
 *   · **A self-hosted model gets the conversation cut to its window** (`fitHistory`): older lookups are shortened
 *     first (they can be looked up again), then the oldest exchanges are left out, then — only if the current
 *     question's own lookups are still too long — those are shortened. Everything stays saved; this is only what is
 *     sent. Its answer is capped too, so the answer has room in the window.
 */

/** Characters per token, on the low side for English, Markdown and JSON, so an estimate errs toward fitting. */
const CHARS_PER_TOKEN = 3;
/** What the chat template adds around each message and tool, in characters. */
const TEMPLATE_CHARS = 900;
/** An older lookup, sent again, is cut to this. */
const OLD_RESULT_CHARS = 600;
/** A lookup in the current question is never cut shorter than this. */
const MIN_RESULT_CHARS = 800;
/** An image or PDF in a message, counted as this many characters. */
const FILE_CHARS = 3_000;

export type ContextWindow = { contextTokens: number; replyTokens: number };

/**
 * A self-hosted model's window: AI_LOCAL_CONTEXT_TOKENS, the same number the server was started with (Ollama's
 * OLLAMA_CONTEXT_LENGTH), 8,192 when unset. The answer is given a quarter of it, at most 1,536 tokens — about 1,100 words.
 */
export function localContextWindow(env: Record<string, string | undefined> = process.env): ContextWindow {
  const n = Number(env.AI_LOCAL_CONTEXT_TOKENS);
  const contextTokens = Number.isFinite(n) && n >= 2048 ? Math.floor(n) : 8192;
  return { contextTokens, replyTokens: Math.min(1536, Math.floor(contextTokens / 4)) };
}

/** The training as a note right before the question it was found for — or nothing added, when there's none. */
export function withTraining(history: Turn[], training: string): Turn[] {
  const text = training.trim();
  if (!text) return history;
  const at = lastUserIndex(history);
  const note: Turn = { role: "note", text };
  return at < 0 ? [...history, note] : [...history.slice(0, at), note, ...history.slice(at)];
}

/** How many characters of conversation fit, once the system prompt, the tools and the answer have their room. */
export function historyBudget(window: ContextWindow, system: string, tools: ToolSpec[]): number {
  const room = (window.contextTokens - window.replyTokens) * CHARS_PER_TOKEN - system.length - JSON.stringify(tools).length - TEMPLATE_CHARS;
  return Math.max(2_000, room);
}

/** The conversation cut to `budget` characters — the current question always kept. */
export function fitHistory(history: Turn[], budget: number): Turn[] {
  const current = lastUserIndex(history);
  // Older lookups first: they can be looked up again, and they are most of a conversation's size.
  let turns = history.map((t, i) => (i < current && t.role === "tool" ? cutResults(t, OLD_RESULT_CHARS) : t));
  // Then whole exchanges, oldest first, always starting at a question — a tool result without its call is refused.
  // A note just before a question (the training) belongs to it and goes with it.
  const starts: number[] = [];
  for (let i = 1; i <= current; i++) if (turns[i]!.role === "user") starts.push(turns[i - 1]!.role === "note" ? i - 1 : i);
  let start = 0;
  for (const next of starts) {
    if (size(turns.slice(start)) <= budget) break;
    if (next > start) start = next;
  }
  turns = turns.slice(start);
  // Still too long: the current question's own lookups share what's left.
  const over = size(turns) - budget;
  if (over > 0) {
    const results = turns.flatMap((t) => (t.role === "tool" ? t.results : []));
    const resultChars = results.reduce((n, r) => n + r.output.length, 0);
    if (results.length) {
      const each = Math.max(MIN_RESULT_CHARS, Math.floor((resultChars - over) / results.length));
      turns = turns.map((t) => (t.role === "tool" ? cutResults(t, each) : t));
    }
  }
  return turns;
}

function lastUserIndex(history: Turn[]): number {
  for (let i = history.length - 1; i >= 0; i--) if (history[i]!.role === "user") return i;
  return -1;
}

function cutResults(turn: Extract<Turn, { role: "tool" }>, max: number): Turn {
  return {
    ...turn,
    results: turn.results.map((r) => (r.output.length > max ? { ...r, output: `${r.output.slice(0, max)}… (cut short to save room — look it up again if it's needed)` } : r)),
  };
}

function turnSize(t: Turn): number {
  switch (t.role) {
    case "user":
      return t.text.length + (t.files?.length ?? 0) * FILE_CHARS + 40;
    case "note":
      return t.text.length + 80;
    case "tool":
      return t.results.reduce((n, r) => n + r.output.length + 60, 0);
    default:
      return t.text.length + JSON.stringify(t.toolCalls).length + 40;
  }
}

function size(turns: Turn[]): number {
  return turns.reduce((n, t) => n + turnSize(t), 0);
}
