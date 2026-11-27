import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { escapeHtml } from "@/lib/marketing/html";
import { POLL_LIMITS } from "@/lib/marketing/email-widgets";

/**
 * Answers to the polls inside marketing emails (owner, 1 Nov 2026 — src/lib/marketing/email-widgets.ts).
 *
 * The person's own message token is the authority, as it is for unsubscribing: nobody signs in. A question and an
 * answer count only if they are one poll in the email that token was sent — so nobody can make up a question, or an
 * answer the email never offered. Pressing again changes the answer; one per person per question.
 */

export type PollAsk = { question: string; answer: string; current: string | null; ours: string };

/**
 * Security audit round two, 13 Nov 2026 (O8): an answer used to count when the question and the answer were each
 * somewhere in the email — so any word of it ("Unsubscribe", a product's name) could be filed as an answer. Now
 * they must be one poll block as it was drawn into the email (src/lib/marketing/email-widgets.ts, expandWidgets):
 * the question, and one of the buttons under it — or, in a text email, one of the answer lines under it.
 * Questions and answers come back HTML-escaped, as the HTML carries them.
 */
export function sentPolls(body: string, textBody?: string | null): { question: string; answers: string[] }[] {
  const polls: { question: string; answers: string[] }[] = [];
  // HTML: <p …>question</p> then its buttons <a …>answer</a>…, closing the block's </div>.
  const block = /<p style="margin:0 0 8px;font:600 15px Arial,sans-serif;color:#0f172a">([^<]*)<\/p>((?:<a\s[^>]*>[^<]*<\/a>)+)<\/div>/g;
  for (const m of body.matchAll(block)) {
    polls.push({ question: m[1]!, answers: [...m[2]!.matchAll(/<a\s[^>]*>([^<]*)<\/a>/g)].map((a) => a[1]!) });
  }
  // Text: the question on its own line, then "· answer: <link>" lines under it. Escaped here to compare alike.
  for (const text of [body, textBody ?? ""]) {
    const lines = text.split(/\r?\n/);
    let current: { question: string; answers: string[] } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const cut = line.lastIndexOf(": ");
      if (line.startsWith("· ") && cut > 2 && i > 0) {
        if (!current) {
          const question = lines[i - 1]!.trim();
          if (!question || question.startsWith("· ")) continue;
          current = { question: escapeHtml(question), answers: [] };
          polls.push(current);
        }
        current.answers.push(escapeHtml(line.slice(2, cut).trim()));
      } else current = null;
    }
  }
  return polls;
}

async function messageFor(token: string, question: string, answer: string) {
  const q = question.trim().slice(0, POLL_LIMITS.text);
  const a = answer.trim().slice(0, POLL_LIMITS.text);
  if (!token || !q || !a) return null;
  const message = await db.marketingMessage.findUnique({ where: { token: token.slice(0, 200) }, select: { id: true, campaignId: true, body: true, textBody: true } });
  if (!message) return null;
  const [eq, ea] = [escapeHtml(q), escapeHtml(a)];
  if (!sentPolls(message.body, message.textBody).some((p) => p.question === eq && p.answers.includes(ea))) return null;
  return { message, q, a };
}

export async function pollAsk(token: string, question: string, answer: string, ours: string): Promise<PollAsk | null> {
  const found = await messageFor(token, question, answer);
  if (!found) return null;
  const current = await db.emailPollAnswer
    .findUnique({ where: { messageId_question: { messageId: found.message.id, question: found.q } }, select: { answer: true } })
    .catch((err) => {
      if (notMigratedYet(err)) return null;
      throw err;
    });
  return { question: found.q, answer: found.a, current: current?.answer ?? null, ours };
}

export async function answerPoll(token: string, question: string, answer: string): Promise<boolean> {
  const found = await messageFor(token, question, answer);
  if (!found) return false;
  const { message, q, a } = found;
  await db.emailPollAnswer.upsert({
    where: { messageId_question: { messageId: message.id, question: q } },
    create: { messageId: message.id, campaignId: message.campaignId, question: q, answer: a },
    update: { answer: a, answeredAt: new Date() },
  });
  return true;
}

export type PollResult = { question: string; total: number; answers: { answer: string; count: number }[] };

/** Each question a campaign asked, with how many pressed each answer. */
export async function pollResults(campaignId: string): Promise<PollResult[]> {
  const rows = await db.emailPollAnswer.groupBy({ by: ["question", "answer"], where: { campaignId }, _count: { _all: true } }).catch((err) => {
    if (notMigratedYet(err)) return [];
    throw err;
  });
  const byQuestion = new Map<string, PollResult>();
  for (const r of rows) {
    const p = byQuestion.get(r.question) ?? { question: r.question, total: 0, answers: [] };
    p.total += r._count._all;
    p.answers.push({ answer: r.answer, count: r._count._all });
    byQuestion.set(r.question, p);
  }
  for (const p of byQuestion.values()) p.answers.sort((x, y) => y.count - x.count);
  return [...byQuestion.values()];
}
