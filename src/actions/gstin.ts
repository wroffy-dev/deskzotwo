"use server";

import { requireUser } from "@/lib/session";
import { GstinLookupRefused, lookupGstin } from "@/lib/gstin/lookup";
import type { GstinCheckView } from "@/lib/gstin/notes";
import type { ActionResult } from "@/actions/company";

/**
 * "Check with GST" beside a customer's or vendor's GSTIN (owner, 25 Oct 2026; src/lib/gstin/lookup.ts).
 *
 * Anybody signed in may ask: what the GST system says about a GSTIN is public, and the form asking is the one
 * they're filling in. The limit is per person and per hour, because the workspace's e-invoice login is shared.
 * `fresh` asks the GST system again rather than reusing a recent answer.
 */
export async function checkGstin(input: { gstin: string; fresh?: boolean }): Promise<ActionResult<{ check: GstinCheckView; reused: boolean }>> {
  const user = await requireUser();
  try {
    return { ok: true, data: await lookupGstin(String(input?.gstin ?? ""), user.id, { fresh: input?.fresh === true }) };
  } catch (err) {
    if (err instanceof GstinLookupRefused) return { ok: false, error: err.message };
    throw err;
  }
}
