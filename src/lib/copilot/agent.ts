import { cleanPage, pageLine, teammatesLine } from "@/lib/copilot/page-context";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { MILLI, type AiFeature } from "@/lib/ai/catalogue";
import { usedTodayBy } from "@/lib/ai/credits";
import { AiProviderFailed, AiRefusal, aiCanEscalate, aiSelfHosted, aiShouldStop, aiTurn, aiUnavailable, type AiTurnOutcome } from "@/lib/ai/gateway";
import { claimsDone, toolsForQuestion } from "@/lib/copilot/local-tools";
import { copilotConfig } from "@/lib/copilot/settings";
import { outputText, runTool, toolSpec, toolsFor } from "@/lib/copilot/tools";
import { workspaceClock } from "@/lib/time/workspace";
import { compactSystemPrompt, systemPrompt } from "@/lib/copilot/prompt";
import { smallTalkReply } from "@/lib/copilot/small-talk";
import { ownConversation } from "@/lib/copilot/review";
import { STALE_TOOL_RESULT, isStaleToolResult } from "@/lib/copilot/retention";
import type { ChatEvent, DisplayBlock, ToolCall, ToolResult, Turn } from "@/lib/copilot/types";

/**
 * One exchange with the copilot: the person's message in, the answer streamed out, with as many
 * tool calls in between as it takes (up to MAX_STEPS).
 *
 *   1. Refused before anything is spent if the copilot is off here, the person lacks `copilot.use`, or
 *      Deskzo AI says no (src/lib/ai/gateway.ts): paused, not set up, the workspace's credits used up,
 *      or the person's daily cap reached.
 *   2. The conversation so far is read back, provider-neutral, and handed to the gateway, which runs it
 *      on the model Deskzo chose for the copilot — see ./types.ts.
 *   3. Each model turn streams its text out as it is written. Tool calls are checked and run as the
 *      person (./tools.ts), and their results — plus any chart or confirmation card — go back to the
 *      model and out to the screen.
 *   4. Every turn is saved as it completes, and charged in credits as it ends, so a request that fails
 *      half way has still been paid for and is still on the record.
 */

export const MAX_STEPS = 8;
/** On a self-hosted model a step can take a minute; four is a look-up, a follow-up and the answer, with one to spare. */
export const LOCAL_MAX_STEPS = 4;
/** The stronger model a question the chat's model couldn't answer is handed to (src/lib/ai/catalogue.ts). */
const ESCALATE: AiFeature = "copilot.escalate";
/** How much of a long conversation is sent back each time. Older turns stay saved, just not resent. */
const HISTORY_MESSAGES = 40;

type RunInput = {
  userId: string;
  userName: string;
  role: string;
  conversationId?: string | null;
  text: string;
  appName: string;
  emit: (event: ChatEvent) => void;
  signal?: AbortSignal;
  /** The page the person is on, as the panel sent it (src/lib/copilot/page-context.ts) — "this lead" means its lead. */
  page?: string | null;
};

export class CopilotRefusal extends Error {}

/** Why the copilot won't run for this person right now, or null when it will. */
export async function unavailableBecause(userId: string): Promise<string | null> {
  const config = await copilotConfig();
  if (!config.enabled) return "Deskzo AI is switched off. An admin can switch it on in Settings → Deskzo AI.";
  if (!(await can(userId, "copilot.use"))) return "You don't have access to Deskzo AI.";
  return aiUnavailable(userId, "copilot.chat");
}

function turnOf(role: string, content: Prisma.JsonValue): Turn | null {
  const c = (content ?? {}) as Record<string, unknown>;
  if (role === "user") return { role: "user", text: String(c.text ?? "") };
  if (role === "note") return { role: "note", text: String(c.text ?? "") };
  if (role === "tool") return { role: "tool", results: (c.results as ToolResult[]) ?? [] };
  if (role === "assistant") {
    return {
      role: "assistant",
      text: String(c.text ?? ""),
      toolCalls: (c.toolCalls as ToolCall[]) ?? [],
      native: c.native as Extract<Turn, { role: "assistant" }>["native"],
    };
  }
  return null;
}

/**
 * The conversation so far, as the model is sent it. Security audit, 13 Nov 2026 (A7): a lookup older than
 * TOOL_RESULT_DAYS goes back as a short "expired" note in its place (./retention.ts) — the call and its result stay
 * paired, as every provider needs, but last month's customer list isn't resent with every question.
 */
export async function history(conversationId: string, now = new Date()): Promise<Turn[]> {
  const rows = await db.copilotMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_MESSAGES,
    select: { role: true, content: true, createdAt: true },
  });
  const turns = rows
    .reverse()
    .map((r) => {
      const turn = turnOf(r.role, r.content);
      if (turn?.role !== "tool" || !isStaleToolResult(r.createdAt, now)) return turn;
      return { role: "tool" as const, results: turn.results.map((x) => ({ id: x.id, name: x.name, output: STALE_TOOL_RESULT })) };
    })
    .filter((t): t is Turn => t !== null);
  // Never start mid-exchange: a tool result whose call was cut off is a malformed request everywhere.
  while (turns.length && turns[0]!.role !== "user") turns.shift();
  return turns;
}

/** The person's questions before the one just asked, newest first, for a follow-up that names nothing ("and last month?", "do it"). */
async function earlierQuestions(conversationId: string): Promise<string[]> {
  const asked = (await history(conversationId)).flatMap((t) => (t.role === "user" ? [t.text] : []));
  return asked.slice(0, -1).reverse();
}

/**
 * Whether a card was confirmed since the person's question before this one — then "it has been updated" is true
 * (src/actions/copilot.ts notes each confirmed card in the conversation).
 */
async function savedSinceLastQuestion(conversationId: string): Promise<boolean> {
  const turns = await history(conversationId);
  const asked = turns.flatMap((t, i) => (t.role === "user" ? [i] : []));
  const since = turns.slice(asked.length >= 2 ? asked[asked.length - 2]! + 1 : 0, asked.at(-1));
  return since.some((t) => t.role === "note" && /^The user confirmed .* and it was saved/.test(t.text));
}

/** Said after an answer that claims a change or a new record, when no card was drawn for it (./local-tools.ts `claimsDone`). */
const NOTHING_SAVED =
  "Nothing has been changed or created: that is only done from a card with a button, such as **Save changes** or **Create task**, and no card was shown here. Ask again naming the record, for example \"change the title of LEAD-000014 to test75\".";

export async function runCopilot(input: RunInput): Promise<void> {
  const refusal = await unavailableBecause(input.userId);
  if (refusal) throw new CopilotRefusal(refusal);
  const text = input.text.trim();
  if (!text) throw new CopilotRefusal("Type a question first.");
  if (text.length > 4000) throw new CopilotRefusal("That's too long for one message — keep it under 4,000 characters.");

  // The conversation — only ever the person's own.
  // Never one they deleted — that is kept only for review (./review.ts).
  let conversation = input.conversationId ? await ownConversation(input.conversationId, input.userId) : null;
  if (input.conversationId && !conversation) throw new CopilotRefusal("That conversation isn't there any more.");
  if (!conversation) {
    const title = text.replace(/\s+/g, " ").slice(0, 60) + (text.length > 60 ? "…" : "");
    conversation = await db.copilotConversation.create({ data: { userId: input.userId, title }, select: { id: true, title: true } });
  }
  input.emit({ type: "conversation", id: conversation.id, title: conversation.title });

  const save = (role: string, content: object, extra: Partial<Prisma.CopilotMessageUncheckedCreateInput> = {}) =>
    db.copilotMessage.create({ data: { conversationId: conversation!.id, role, content: content as Prisma.InputJsonValue, ...extra } });
  await save("user", { text });

  // "Hi", "How are you?", "Thanks" — answered at once, without the model reaching for a lookup (./small-talk.ts).
  const quick = smallTalkReply(text, input.userName);
  if (quick) {
    input.emit({ type: "text", delta: quick });
    await save("assistant", { text: quick, toolCalls: [] });
    await db.copilotConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
    const { dailyCreditLimit } = await copilotConfig();
    input.emit({ type: "done", usedToday: await usedTodayBy(input.userId), limit: dailyCreditLimit === null ? null : dailyCreditLimit * MILLI });
    return;
  }

  const allowed = await toolsFor();
  // A self-hosted model is offered only the tools this question is about — none for a "Hi" (./local-tools.ts). A
  // subset of what the person may use; the system prompt is still written from all of them, so it stays cached.
  const local = await aiSelfHosted("copilot.chat");
  const tools = local ? toolsForQuestion(text, await earlierQuestions(conversation.id), allowed) : allowed;
  const specs = tools.map(toolSpec);
  // Today and the zone are the workspace's: a time the model writes is read on the same clock.
  const clock = await workspaceClock();
  const about = {
    userName: input.userName,
    role: input.role,
    today: clock.today(),
    timeZone: clock.zone,
    appName: input.appName,
    // Told to search AI Knowledge first only while it's offered — once the workspace has a file there.
    knowledge: allowed.some((t) => t.name === "search_knowledge"),
  };
  // A self-hosted model gets the short prompt, and no list of the teammates' tools it isn't offered (./prompt.ts).
  const system = local
    ? compactSystemPrompt(about) + (await pageLine(input.userId, cleanPage(input.page)))
    : systemPrompt(about) +
      // The teammates they may ask by name, and the record they are looking at (owner, 20 Nov 2026 — step 3).
      (await teammatesLine(allowed.map((t) => t.name))) +
      (await pageLine(input.userId, cleanPage(input.page)));
  const ctx = { userId: input.userId, conversationId: conversation.id };

  // Haiku first, Sonnet when it can't (owner, 23 Nov 2026): the question moves to the stronger model — "copilot.escalate",
  // when the console gives it one — for the rest of this question once the chat's model fails the call, declines, comes
  // back with nothing, or makes calls that are all refused twice. A step is re-run there only if nothing of it reached
  // the screen, so no answer is shown twice. The next question starts on the chat's model again.
  let feature: AiFeature = "copilot.chat";
  const canEscalate = await aiCanEscalate("copilot.chat", ESCALATE);
  let failedCalls = 0;
  const escalate = (why: string): boolean => {
    if (!canEscalate || feature === ESCALATE) return false;
    feature = ESCALATE;
    console.info(`[ai] copilot.chat handed to ${ESCALATE}: ${why}`);
    input.emit({ type: "block", block: { type: "activity", label: "Asked a stronger model" } });
    return true;
  };

  // Whether this question drew a card, and the last thing the model said — to catch "it has been updated" with no card.
  let carded = false;
  let lastAnswer = "";
  try {
    for (let step = 0; step < (local ? LOCAL_MAX_STEPS : MAX_STEPS); step++) {
      if (step > 0) {
        // The workspace's credits run out the same way as a person's day: between steps, never mid-answer.
        if (await aiShouldStop(input.userId, feature)) {
          const note = "\n\n_(Stopped: the Deskzo AI credits are used up.)_";
          input.emit({ type: "text", delta: note });
          await save("assistant", { text: note.trim(), toolCalls: [] });
          break;
        }
        input.emit({ type: "step" });
      }

      let written = "";
      let outcome: AiTurnOutcome;
      try {
        outcome = await aiTurn({
          userId: input.userId,
          feature,
          system,
          history: await history(conversation.id),
          tools: specs,
          signal: input.signal,
          onText: (delta) => {
            written += delta;
            input.emit({ type: "text", delta });
          },
        });
      } catch (err) {
        // The provider failed the call: the same step again, on the stronger model.
        if (err instanceof AiProviderFailed && !written && escalate("the call failed")) {
          step -= 1;
          continue;
        }
        if (written) await save("assistant", { text: written, toolCalls: [] });
        if (err instanceof AiRefusal) throw new CopilotRefusal(err.message);
        throw err;
      }
      // Declined, or nothing to show, with nothing on the screen yet: the same step again, on the stronger model.
      if (!written && !input.signal?.aborted && (outcome.stop === "refused" || (outcome.stop === "done" && !outcome.text.trim()))) {
        if (escalate(outcome.stop === "refused" ? "it declined" : "it answered nothing")) {
          step -= 1;
          continue;
        }
      }
      // Nothing to show — a small model that wrote only JSON matching no tool (providers/text-tool-calls.ts).
      if (outcome.stop === "done" && !outcome.text.trim()) {
        const fallback = "I couldn't work that out. Try asking it another way, or name the record or period you mean.";
        input.emit({ type: "text", delta: fallback });
        outcome = { ...outcome, text: fallback };
      }

      await save(
        "assistant",
        {
          text: outcome.text,
          toolCalls: outcome.toolCalls,
          ...(outcome.native ? { native: { provider: outcome.family, model: outcome.model, content: outcome.native, masked: outcome.masked } } : {}),
        },
        { provider: outcome.family, model: outcome.modelKey, inputTokens: outcome.usage.input, outputTokens: outcome.usage.output },
      );

      lastAnswer = outcome.text;

      // The person went away: what was answered is kept (and was charged), and nothing more is started for them —
      // no tools run on their behalf, no further step (aiTurn's `signal`).
      if (input.signal?.aborted) return;

      if (outcome.stop === "refused") {
        const note = "Deskzo AI declined to answer that one. Try asking it differently.";
        input.emit({ type: "text", delta: (written ? "\n\n" : "") + note });
        await save("note", { text: note });
        break;
      }
      if (outcome.stop === "truncated") {
        input.emit({ type: "text", delta: "\n\n_(The answer was cut short — ask a narrower question.)_" });
        break;
      }
      if (outcome.stop !== "tools") break;

      // The calls, checked and run as the person — in parallel, their results returned together.
      const ran = await Promise.all(outcome.toolCalls.map((call) => runTool(tools, ctx, call.name, call.input)));
      const results: ToolResult[] = outcome.toolCalls.map((call, i) => ({ id: call.id, name: call.name, output: outputText(ran[i]!.output), isError: ran[i]!.isError }));
      const blocks: DisplayBlock[] = ran.flatMap((r) => [{ type: "activity" as const, label: r.activity }, ...(r.blocks ?? [])]);
      for (const block of blocks) input.emit({ type: "block", block });
      if (blocks.some((b) => b.type === "proposal")) carded = true;
      await save("tool", { results, blocks });
      // Every call refused (a tool it may not use, input that doesn't fit) twice in one question: the rest of it goes to
      // the stronger model, which reads the refusals in the history and calls again.
      if (results.length && results.every((r) => r.isError) && ++failedCalls >= 2) escalate("its calls were refused twice");
    }
    // The answer is already on the screen, so the correction follows it — and is kept, so the model reads it next time.
    if (!carded && !input.signal?.aborted && claimsDone(lastAnswer) && !(await savedSinceLastQuestion(conversation.id))) {
      input.emit({ type: "text", delta: `\n\n_${NOTHING_SAVED}_` });
      await save("note", { text: NOTHING_SAVED });
    }
  } finally {
    await db.copilotConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
  }
  const { dailyCreditLimit } = await copilotConfig();
  input.emit({ type: "done", usedToday: await usedTodayBy(input.userId), limit: dailyCreditLimit === null ? null : dailyCreditLimit * MILLI });
}
