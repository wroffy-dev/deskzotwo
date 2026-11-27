"use server";

import { answerPoll } from "@/lib/marketing/polls";

/** A poll's answer page button (owner, 1 Nov 2026 — src/lib/marketing/polls.ts). The person's message token is the authority. */
export async function submitPollAnswer(token: string, question: string, answer: string): Promise<{ ok: boolean }> {
  if (typeof token !== "string" || typeof question !== "string" || typeof answer !== "string") return { ok: false };
  return { ok: await answerPoll(token, question, answer) };
}
