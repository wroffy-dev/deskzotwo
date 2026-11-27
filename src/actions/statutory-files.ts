"use server";

import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { statutoryFilesOfRun } from "@/lib/hr/statutory-data";

/**
 * A payroll month's bank advice, PF ECR and ESI return (owner, 31 Oct 2026) — for whoever runs payroll, and only once
 * the month is locked: a draft's figures can still change under a file already uploaded to EPFO or the bank.
 * `ready: false` says the month is still a draft; null, that this person may not see it.
 */
export async function statutoryFiles(runId: string) {
  const user = await requireModuleUser("payroll");
  if (!(await hasEffectivePermission(user.id, "payroll.manage"))) return null;
  const files = await statutoryFilesOfRun(runId);
  if (!files) return null;
  return { ...files, ready: files.run.status !== "DRAFT" };
}
