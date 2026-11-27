import { db } from "@/lib/db";

/**
 * How long the copilot keeps what was said (security audit, 13 Nov 2026 — A7). A conversation holds what the
 * copilot looked up for the person — customers, figures, people's names — and was kept for ever, and every old
 * lookup was sent to the model again whenever the person carried the chat on.
 *
 *   - A conversation nobody has touched in CONVERSATION_DAYS is deleted with its messages and drafts, by the
 *     heartbeat's once-a-day part (src/lib/marketing/heartbeat.ts).
 *   - When a chat is carried on, a lookup older than TOOL_RESULT_DAYS goes back to the model as a short note, not
 *     its old answer (src/lib/copilot/agent.ts `history`): the model asks again, as the person, with their access now.
 */
export const CONVERSATION_DAYS = 90;
export const TOOL_RESULT_DAYS = 7;

const DAY = 86_400_000;

/**
 * Deletes the conversations not touched in CONVERSATION_DAYS. Their messages and drafts go with them (cascade).
 * `onlyUserIds` is for the check suites, which run against a real database and must sweep only their own.
 */
export async function sweepOldCopilotConversations(now = new Date(), onlyUserIds?: string[]): Promise<number> {
  const before = new Date(now.getTime() - CONVERSATION_DAYS * DAY);
  const { count } = await db.copilotConversation.deleteMany({ where: { updatedAt: { lt: before }, ...(onlyUserIds ? { userId: { in: onlyUserIds } } : {}) } });
  return count;
}

/** What the model is given in place of a lookup older than TOOL_RESULT_DAYS. */
export const STALE_TOOL_RESULT = JSON.stringify({
  expired: `This lookup is more than ${TOOL_RESULT_DAYS} days old and isn't kept for the model. Run the tool again if it's still needed.`,
});

/** Whether a tool result saved at `savedAt` is too old to send to the model again. */
export function isStaleToolResult(savedAt: Date, now = new Date()): boolean {
  return now.getTime() - savedAt.getTime() > TOOL_RESULT_DAYS * DAY;
}
