"use server";

import { headers } from "next/headers";
import { clientIpFrom } from "@/lib/client-ip";
import { answerPublicForm } from "@/lib/smart-lists/public-forms";

/**
 * A stranger's answer to a Smart List's public form (owner, 20 Nov 2026 — Smart Lists phase 4). Nobody is signed in:
 * the link is the only key, and every check — open, consent, spam, rate — is src/lib/smart-lists/public-forms.ts.
 */
export async function sendPublicListForm(input: { slug: string; title: string; answers: Record<string, unknown>; consent: boolean; website?: string; elapsedMs?: number }) {
  // No request behind the call (a check script): no address to count by.
  let caller: string | null = null;
  try {
    caller = clientIpFrom(await headers());
  } catch {
    caller = null;
  }
  return answerPublicForm({ slug: input?.slug, title: input?.title, answers: input?.answers, consent: input?.consent, website: input?.website, elapsedMs: input?.elapsedMs, caller });
}
