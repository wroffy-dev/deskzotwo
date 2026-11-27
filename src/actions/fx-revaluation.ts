"use server";

import { revalidatePath } from "next/cache";
import { plainError } from "@/lib/plain-error";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { indiaClock } from "@/lib/time/zone";
import { ensureChartOfAccounts } from "@/lib/ledger/journal";
import { listRevaluations, postRevaluation, previewRevaluation, revaluationHere, undoRevaluation } from "@/lib/ledger/fx-revaluation";
import { formatMoney } from "@/lib/currency";
import type { ActionResult } from "@/actions/company";

/**
 * Revalue foreign balances (owner, 30 Oct 2026) — a sibling of Close the Books, and gated as it is: `books.close`. The
 * work is src/lib/ledger/fx-revaluation.ts.
 */

async function requireCloser() {
  const user = await requireModuleUser("accounting");
  return { user, allowed: await hasEffectivePermission(user.id, "books.close") };
}

/** Typed rates from a form: currency → a positive number; anything else dropped. */
function ratesOf(input: Record<string, string | number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [currency, value] of Object.entries(input ?? {})) {
    if (value === "" || value === null || value === undefined) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) out[currency] = n;
  }
  return out;
}

export async function getFxRevaluationPreview(input: { asOf: string; rates?: Record<string, string | number> }) {
  const { allowed } = await requireCloser();
  if (!allowed) return null;
  if (!(await revaluationHere())) return { notReady: true as const };
  try {
    return toPlain({ notReady: false as const, preview: await previewRevaluation(input.asOf, ratesOf(input.rates)), error: null });
  } catch (error) {
    return { notReady: false as const, preview: null, error: plainError(error, "Could not read the balances.") };
  }
}

export async function listFxRevaluations() {
  const { allowed } = await requireCloser();
  if (!allowed || !(await revaluationHere())) return [];
  return toPlain(await listRevaluations());
}

export async function postFxRevaluation(input: {
  asOf: string;
  rates?: Record<string, string | number>;
}): Promise<ActionResult<{ entryNumber: string; reversalNumber: string; net: number }>> {
  const { user, allowed } = await requireCloser();
  if (!allowed) return { ok: false, error: "Only whoever closes the books can revalue foreign balances." };
  if (!(await revaluationHere())) return { ok: false, error: "This workspace's database hasn't been updated for revaluations yet." };
  try {
    await ensureChartOfAccounts();
    const result = await postRevaluation({ asOf: input.asOf, rates: ratesOf(input.rates), userId: user.id, today: indiaClock.today() });
    await recordAudit({
      userId: user.id,
      action: "CREATE",
      entityType: "FxRevaluation",
      entityId: result.id,
      entityLabel: `Revalued foreign balances at ${input.asOf} — unrealised ${result.net >= 0 ? "gain" : "loss"} ${formatMoney(Math.abs(result.net))} (${result.entryNumber}, reversed by ${result.reversalNumber})`,
    });
    revalidatePath("/accounting/books/revalue");
    revalidatePath("/accounting/journal");
    return { ok: true, data: { entryNumber: result.entryNumber, reversalNumber: result.reversalNumber, net: result.net } };
  } catch (error) {
    return { ok: false, error: plainError(error, "Could not post the revaluation.") };
  }
}

export async function undoFxRevaluation(id: string): Promise<ActionResult<null>> {
  const { user, allowed } = await requireCloser();
  if (!allowed) return { ok: false, error: "Only whoever closes the books can undo a revaluation." };
  try {
    const { asOf } = await undoRevaluation(id);
    await recordAudit({
      userId: user.id,
      action: "DELETE",
      entityType: "FxRevaluation",
      entityId: id,
      entityLabel: `Undid the ${asOf} revaluation of foreign balances — its entry and reversal removed`,
    });
    revalidatePath("/accounting/books/revalue");
    revalidatePath("/accounting/journal");
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, error: plainError(error, "Could not undo that revaluation.") };
  }
}
