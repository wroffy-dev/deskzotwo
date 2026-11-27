"use server";

import type { ConsoleResult } from "@/actions/platform/console";
import { looksLikeEmail } from "@/lib/email-verification";
import { ENTER, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { ConsoleRefused } from "@/lib/platform/refused";
import { addressHash, platformSuppressionOf, removePlatformSuppression } from "@/lib/platform/mail/suppressions";
import { StaffRefused, requireStaff } from "@/lib/platform/staff-session";

/**
 * Mail log › Suppressed (src/lib/platform/mail/suppressions.ts — owner, 31 Oct 2026): an address looked up on the
 * platform's suppression list, or taken off it once the customer has fixed their mailbox — by the staff who answer for
 * delivery (the Mail log's own gate). Audited by the address's hash, never the address.
 */

export type SuppressionLookup = {
  on: boolean;
  reason?: string;
  detail?: string | null;
  firstAt?: Date;
  lastAt?: Date;
  expiresAt?: Date;
  hits?: number;
  stopped?: number;
};

async function staffOr(): Promise<{ ok: true; staff: Awaited<ReturnType<typeof requireStaff>> } | { ok: false; error: string }> {
  try {
    return { ok: true, staff: await requireStaff(ENTER) };
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
}

function addressOf(raw: unknown): string {
  const address = String(raw ?? "").trim().toLowerCase();
  if (!looksLikeEmail(address)) throw new ConsoleRefused("Type the whole address, like ravi@acme.com.");
  return address;
}

export async function consoleLookupSuppression(raw: unknown): Promise<ConsoleResult<SuppressionLookup>> {
  const who = await staffOr();
  if (!who.ok) return who;
  try {
    const row = await platformSuppressionOf(addressOf(raw));
    if (!row) return { ok: true, data: { on: false } };
    return { ok: true, data: { on: true, reason: row.reason, detail: row.detail, firstAt: row.firstAt, lastAt: row.lastAt, expiresAt: row.expiresAt, hits: row.hits, stopped: row.stopped } };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

export async function consoleRemoveSuppression(raw: unknown): Promise<ConsoleResult<null>> {
  const who = await staffOr();
  if (!who.ok) return who;
  try {
    const address = addressOf(raw);
    if (!(await removePlatformSuppression(address))) throw new ConsoleRefused("That address isn't on the list.");
    await consoleAudit(who.staff, "mail.suppression.remove", { hash: addressHash(address).slice(0, 16) });
    revalidateConsole();
    return { ok: true, data: null };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}
