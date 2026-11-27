"use server";

import { confirmConsent } from "@/lib/marketing/double-opt-in";

/** The confirmation page's button (owner, 1 Nov 2026 — src/lib/marketing/double-opt-in.ts). The token is the authority: nobody signs in. */
export async function confirmSignup(token: string): Promise<{ ok: boolean }> {
  return { ok: typeof token === "string" && (await confirmConsent(token)) };
}
