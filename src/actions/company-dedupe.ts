"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { currentTenant } from "@/lib/tenancy/resolve";
import { tenantAfter } from "@/lib/tenancy/after";
import {
  duplicateBreakdown,
  latestMergeJob,
  needsWorker,
  setMergeJobStatus,
  startGstinMergeJob,
  workMergeJob,
  type DuplicateBreakdown,
  type MergeJobView,
} from "@/lib/companies/gstin-merge";
import type { ActionResult } from "@/actions/company";

/**
 * Duplicate companies sorted into groups, and the ones sharing a GSTIN merged in the background (owner, 14 Nov 2026 —
 * src/lib/companies/gstin-merge.ts). `companies.merge`, as every merge is; the background merge also takes the
 * workspace's name typed to start it, and never while viewing as somebody.
 */

const NOT_ALLOWED = "You can't merge companies.";

/** The workspace's name typed to confirm, without case or extra spaces. */
const typedName = (typed: unknown, name: string) => {
  const norm = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();
  return typeof typed === "string" && norm(typed) !== "" && norm(typed) === norm(name);
};
/** How long one push of the worker runs from a request before handing on. */
const WORK_SLICE_MS = 240_000;

/** Keeps the job going after this response, in this process, for a few minutes at a time. */
async function nudge(): Promise<void> {
  await tenantAfter(async () => {
    while ((await workMergeJob(WORK_SLICE_MS)) > 0) {
      // Another slice while there's work and nobody else has it.
    }
  });
}

export async function getDuplicateBreakdown(): Promise<ActionResult<{ breakdown: DuplicateBreakdown; job: MergeJobView | null; confirmWith: string }>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };
  const [breakdown, job, tenant] = await Promise.all([duplicateBreakdown(user.id), latestMergeJob(), currentTenant()]);
  return { ok: true, data: { breakdown, job, confirmWith: tenant.name } };
}

export async function startGstinMerge(input: { confirm: string }): Promise<ActionResult<MergeJobView>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const tenant = await currentTenant();
  if (!typedName(input?.confirm, tenant.name)) return { ok: false, error: `Type the workspace's name, ${tenant.name}, to start.` };
  const started = await startGstinMergeJob(user.id);
  if (!started.ok) return started;
  await nudge();
  return { ok: true, data: started.job };
}

/** Where the job is — and, if it's meant to be running and nobody is working on it, sets it going again. */
export async function mergeJobProgress(): Promise<ActionResult<MergeJobView | null>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };
  const job = await latestMergeJob();
  if (job?.status === "RUNNING") {
    const row = await db.companyMergeJob.findUnique({ where: { id: job.id }, select: { status: true, lockedAt: true } });
    if (row && needsWorker({ status: row.status as MergeJobView["status"], lockedAt: row.lockedAt })) await nudge();
  }
  if (job && job.status !== "RUNNING") revalidatePath("/companies/duplicates");
  return { ok: true, data: job };
}

export async function controlGstinMerge(input: { jobId: string; to: "PAUSED" | "RUNNING" | "STOPPED" }): Promise<ActionResult<MergeJobView>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!["PAUSED", "RUNNING", "STOPPED"].includes(input?.to)) return { ok: false, error: "Pause, carry on or stop." };
  const job = await setMergeJobStatus(String(input?.jobId ?? ""), input.to, user.id);
  if (!job) return { ok: false, error: "That merge isn't there any more." };
  if (job.status === "RUNNING") await nudge();
  revalidatePath("/companies/duplicates");
  return { ok: true, data: job };
}
