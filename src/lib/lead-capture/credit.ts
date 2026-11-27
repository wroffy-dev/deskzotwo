import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { isAutomationKind } from "@/lib/people";
import { DEFAULT_CREDIT_LABEL, isCreditMode, type KeyCredit } from "@/lib/lead-capture/credit-modes";

/**
 * Who a website form's leads are raised and sourced by (owner, 9 Nov 2026 — "let the workspace admin decide: the form's
 * maker, the website, or any other name"). Raised by is what "Leads raised" incentives pay on, so a person credited
 * here is paid for what the form brings.
 *
 *   · NOBODY (or nothing set) — no person; the lead shows the key's label, "Website" when it has none.
 *   · MAKER — whoever made the key.
 *   · PERSON — the person chosen.
 *
 * A person who can't be credited any more (switched off, gone) falls back to nobody rather than to somebody else.
 */
export { CREDIT_MODES, DEFAULT_CREDIT_LABEL, isCreditMode, type CreditMode, type KeyCredit } from "@/lib/lead-capture/credit-modes";

/** A key's setting, read by name: a workspace not migrated yet credits nobody, as before the setting. */
export async function keyCredit(keyId: string): Promise<KeyCredit> {
  try {
    const row = await db.leadCaptureKey.findUnique({ where: { id: keyId }, select: { creditMode: true, creditUserId: true, creditLabel: true } });
    return { mode: isCreditMode(row?.creditMode) ? row.creditMode : "NOBODY", userId: row?.creditUserId ?? null, label: row?.creditLabel?.trim() || DEFAULT_CREDIT_LABEL };
  } catch (err) {
    if (notMigratedYet(err)) return { mode: "NOBODY", userId: null, label: DEFAULT_CREDIT_LABEL };
    throw err;
  }
}

/** The person a key's lead is raised by, or null for nobody. */
export async function raisedByForKey(keyId: string, makerId: string | null): Promise<string | null> {
  const credit = await keyCredit(keyId);
  const candidate = credit.mode === "MAKER" ? makerId : credit.mode === "PERSON" ? credit.userId : null;
  if (!candidate) return null;
  const person = await db.user.findUnique({ where: { id: candidate }, select: { active: true, kind: true } });
  return person?.active && !isAutomationKind(person.kind) ? candidate : null;
}
