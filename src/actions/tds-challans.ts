"use server";

import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { challanSectionNumber } from "@/lib/tds/challan-rules";
import { ChallanRefusal, deleteChallan, linkDeductions, recordChallan, unlinkDeduction, type ChallanInput } from "@/lib/tds/challans";
import type { ActionResult } from "@/actions/company";

/**
 * TDS challans on the TDS page (owner, 25 Oct 2026; src/lib/tds/challans.ts): recording one, linking the
 * deductions it paid, and deleting one recorded by mistake. Finance's, as the page is (`payments.manage`).
 */

async function financeUser() {
  const user = await requireModuleAccess("accounting");
  return (await hasEffectivePermission(user.id, "payments.manage")) ? user : null;
}

const REFUSED = "Recording TDS challans needs the “Manage finance records” permission.";

/** A refusal said as it is; anything else is the error page's. */
async function answer<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    if (err instanceof ChallanRefusal) return { ok: false, error: err.message };
    if (err instanceof Error && /books are closed/.test(err.message)) return { ok: false, error: err.message };
    throw err;
  }
}

export async function recordTdsChallan(input: ChallanInput): Promise<ActionResult<{ id: string; cin: string }>> {
  const user = await financeUser();
  if (!user) return { ok: false, error: REFUSED };
  const result = await answer(() => recordChallan(input, user.id));
  if (result.ok) {
    await recordAudit({
      userId: user.id,
      action: "CREATE",
      entityType: "TdsChallan",
      entityId: result.data.id,
      entityLabel: `TDS challan ${result.data.cin} (${challanSectionNumber(input.sectionKey)}, ${input.majorHead}, paid ${input.paidOn})`,
    });
    revalidatePath("/accounting/tds");
  }
  return result;
}

export async function linkTdsDeductions(challanId: string, refs: string[]): Promise<ActionResult<null>> {
  const user = await financeUser();
  if (!user) return { ok: false, error: REFUSED };
  if (Array.isArray(refs) && refs.length > 5000) return { ok: false, error: "That's too many at once — 5,000 deductions at most." };
  const result = await answer(async () => {
    await linkDeductions(String(challanId ?? ""), Array.isArray(refs) ? refs : []);
    return null;
  });
  if (result.ok) revalidatePath("/accounting/tds");
  return result;
}

export async function unlinkTdsDeduction(challanId: string, ref: string): Promise<ActionResult<null>> {
  const user = await financeUser();
  if (!user) return { ok: false, error: REFUSED };
  const removed = await unlinkDeduction(String(challanId ?? ""), String(ref ?? ""));
  if (removed === 0) return { ok: false, error: "That deduction isn't on this challan." };
  revalidatePath("/accounting/tds");
  return { ok: true, data: null };
}

export async function deleteTdsChallan(challanId: string): Promise<ActionResult<null>> {
  const user = await financeUser();
  if (!user) return { ok: false, error: REFUSED };
  const result = await answer(() => deleteChallan(String(challanId ?? ""), user.id));
  if (!result.ok) return result;
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "TdsChallan", entityId: String(challanId), entityLabel: `TDS challan ${result.data.cin} deleted; its entry reversed` });
  revalidatePath("/accounting/tds");
  return { ok: true, data: null };
}
