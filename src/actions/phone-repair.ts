"use server";

import { revalidatePath } from "next/cache";
import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { can } from "@/lib/authz/resolve";
import { parseFile } from "@/lib/portability/import";
import { applyPhoneRepair, planPhoneRepair, type PhoneRepairPlan, type PhoneRepairResult } from "@/lib/leads/phone-repair";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Data › Shortened phone numbers (src/lib/leads/phone-repair.ts): the phones Excel shortened, put back from
 * the file they came from. It rewrites contacts across the workspace, so it is the super admin's, acting as
 * themselves — as the duplicate-leads tool beside it is.
 */
type Upload = { base64: string; filename: string };

async function gate(): Promise<{ userId: string } | { error: string }> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage")) || !(await actingAsSuperAdmin(user.id))) return { error: "Only the workspace's super admin can repair phone numbers." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { error: viewingAs };
  return { userId: user.id };
}

async function rowsOf(input: Upload): Promise<Record<string, string>[] | { error: string }> {
  if (!input || typeof input.base64 !== "string" || typeof input.filename !== "string") return { error: "Choose a file." };
  if (!/\.(csv|xlsx)$/i.test(input.filename)) return { error: "Upload the file as CSV or Excel (.xlsx)." };
  try {
    return await parseFile(input.base64, input.filename);
  } catch {
    return { error: "That file couldn't be read. Upload it as CSV or Excel (.xlsx)." };
  }
}

export async function previewPhoneRepair(input: Upload): Promise<ActionResult<PhoneRepairPlan>> {
  const allowed = await gate();
  if ("error" in allowed) return { ok: false, error: allowed.error };
  const rows = await rowsOf(input);
  if ("error" in rows) return { ok: false, error: rows.error };
  // Its names and numbers as the viewer's contacts policy shows them (owner, 5 Nov 2026 — Phase 3 masking fixes).
  const plan = await planPhoneRepair(rows, undefined, allowed.userId);
  return "error" in plan ? { ok: false, error: plan.error } : { ok: true, data: plan };
}

export async function runPhoneRepair(input: Upload & { clearUnfixed: boolean }): Promise<ActionResult<PhoneRepairResult>> {
  const allowed = await gate();
  if ("error" in allowed) return { ok: false, error: allowed.error };
  const rows = await rowsOf(input);
  if ("error" in rows) return { ok: false, error: rows.error };
  const result = await applyPhoneRepair(rows, allowed.userId, input.clearUnfixed === true);
  if ("error" in result) return { ok: false, error: result.error };
  revalidatePath("/leads");
  revalidatePath("/contacts");
  revalidatePath("/settings/data/phone-repair");
  return { ok: true, data: result };
}
