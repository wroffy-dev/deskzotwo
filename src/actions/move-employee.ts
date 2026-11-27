"use server";

import { revalidatePath } from "next/cache";
import { tooLong } from "@/lib/validation/text";
import { z } from "zod";
import { db } from "@/lib/db";
import { PEOPLE_ONLY } from "@/lib/people";
import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { actorContext, assertMayActOnTarget, assertNotSelf, AuthzError } from "@/lib/authz/guards";
import { BLANK_RECORD, moveEmployee, planEmployeeMove, type MovePlan } from "@/lib/hr/move-employee";
import { personPath } from "@/lib/record-links";
import type { ActionResult } from "@/actions/company";

/**
 * "Move to another account" on an employee record (owner, 31 Oct 2026) — src/lib/hr/move-employee.ts.
 *
 * Gated on hr.manage AND payroll.manage, both existing keys: the move re-keys the employee record
 * (hr.manage's) and every payslip, salary structure and tax declaration with it (payroll.manage's).
 * No new key — permissions are Himanshu's to add. Switching the old account off rides on the same two,
 * as recording an exit's "deactivate their login" rides on hr.manage alone (src/lib/hr/exit.ts).
 */
async function mover() {
  const user = await requireModuleUser("hr");
  const [hr, payroll] = await Promise.all([hasEffectivePermission(user.id, "hr.manage"), hasEffectivePermission(user.id, "payroll.manage")]);
  return hr && payroll ? user : null;
}

const NOT_ALLOWED = "Moving an employee record takes both managing people records and managing payroll.";

/** Accounts the record could go to: switched on, a person (not support or automation), with no record of their own — or only a blank one. */
export async function moveTargets(fromUserId: string): Promise<{ id: string; name: string; email: string }[]> {
  if (!(await mover())) return [];
  return db.user.findMany({
    where: { ...PEOPLE_ONLY, active: true, OR: [{ employeeProfile: { is: null } }, { employeeProfile: { is: BLANK_RECORD } }], NOT: { id: fromUserId } },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });
}

export async function previewEmployeeMove(fromUserId: string, toUserId: string): Promise<ActionResult<MovePlan>> {
  const user = await mover();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  // As whoever is looking: the reportees that would go with the record are the ones they may put under the new account
  // (owner, 3 Nov 2026 — "Phase 2 permission fixes", audit M-5 follow-up).
  const result = await planEmployeeMove(String(fromUserId), String(toUserId), user.id);
  return result.ok ? { ok: true, data: result.plan } : result;
}

const moveSchema = z.object({
  fromUserId: z.string().max(100, tooLong(100)).min(1),
  toUserId: z.string().max(100, tooLong(100)).min(1),
  confirmEmail: z.string().trim().max(254, tooLong(254)),
  switchOffSource: z.boolean(),
  handOverReportees: z.boolean(),
});

export async function moveEmployeeRecord(input: unknown): Promise<ActionResult<{ path: string; switchedOff: boolean; reporteesMoved: number }>> {
  const user = await mover();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const parsed = moveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  // Security audit, 11 Nov 2026 (SEC-38): switching the old account off is switching a login off, which is
  // users.manage's — HR and payroll alone could switch off an admin's sign-in this way. The same rules as Settings ›
  // Users switching somebody off (src/actions/user.ts switchUser): the key, never yourself, never the super admin
  // unless you are one.
  if (data.switchOffSource) {
    if (!(await hasEffectivePermission(user.id, "users.manage"))) {
      return { ok: false, error: "Switching the old account off takes managing users. Move the record without it, and ask whoever manages users." };
    }
    try {
      const actor = await actorContext(user.id);
      assertNotSelf(actor.id, data.fromUserId, "account's sign-in");
      const source = await db.user.findUnique({ where: { id: data.fromUserId }, select: { id: true, isSuperAdmin: true } });
      if (source) assertMayActOnTarget(actor, source);
    } catch (err) {
      if (err instanceof AuthzError) return { ok: false, error: err.message };
      throw err;
    }
  }

  // Typed, not ticked: the move is hard to undo by hand, and the name of the wrong Jitender looks
  // very like the right one's in a picker.
  const target = await db.user.findUnique({ where: { id: data.toUserId }, select: { email: true, userSeq: true } });
  if (!target) return { ok: false, error: "That account no longer exists." };
  if (data.confirmEmail.toLowerCase() !== target.email.toLowerCase()) {
    return { ok: false, error: `Type ${target.email} to confirm.` };
  }

  const moved = await moveEmployee(data.fromUserId, data.toUserId, user.id, { switchOffSource: data.switchOffSource, handOverReportees: data.handOverReportees });
  if (!moved.ok) return moved;

  revalidatePath("/people", "layout");
  revalidatePath("/attendance", "layout");
  revalidatePath("/leave", "layout");
  revalidatePath("/payroll", "layout");
  if (moved.switchedOff) revalidatePath("/settings", "layout");
  return { ok: true, data: { path: personPath(target.userSeq), switchedOff: moved.switchedOff, reporteesMoved: moved.reporteesMoved } };
}
