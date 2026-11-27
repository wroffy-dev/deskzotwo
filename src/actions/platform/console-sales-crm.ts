"use server";

import type { ConsoleResult } from "@/actions/platform/console";
import { OWNERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { ConsoleRefused } from "@/lib/platform/refused";
import { salesCrmWorkspace, setSalesCrmWorkspace } from "@/lib/platform/sales-crm";
import { StaffRefused, requireStaff } from "@/lib/platform/staff-session";

/**
 * Settings › Sales CRM (owner, 18 Nov 2026 — src/lib/platform/sales-crm.ts): the workspace Deskzo's own sales team works
 * in, which deskzo.com's enquiries, new sign-ups and their billing changes go to. Owners only, as every platform-wide
 * setting is; audited.
 */
export async function consoleSetSalesCrm(raw: unknown): Promise<ConsoleResult<{ workspace: string | null }>> {
  let staff;
  try {
    staff = await requireStaff(OWNERS);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    const value = String(raw ?? "").trim().toLowerCase();
    const before = await salesCrmWorkspace();
    if ((before ?? "") === value) return { ok: true, data: { workspace: before } };
    const done = await setSalesCrmWorkspace(value || null, staff.id);
    if (!done.ok) throw new ConsoleRefused(done.error);
    await consoleAudit(staff, "console.sales-crm", { from: before, to: value || null });
    revalidateConsole();
    return { ok: true, data: { workspace: value || null } };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}
