"use server";

import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { db } from "@/lib/db";
import { parseWorkflowRef, workflowRef } from "@/lib/automate/refs";
import { workflowEmailReport, type WorkflowEmailReport } from "@/lib/automate/email-report";

/**
 * A workflow's emails (owner, 2 Nov 2026 — src/lib/automate/email-report.ts), for whoever may use Automate — the
 * workspace's admins for now, as its runs are (src/actions/automate.ts). Null for a workflow that isn't there, or a
 * person who may not see it. Its contact recipients as this person's contacts policy shows them (owner, 5 Nov 2026 —
 * Phase 3 masking fixes).
 */
export async function workflowEmails(ref: string): Promise<{ workflow: { id: string; name: string; ref: string }; report: WorkflowEmailReport } | null> {
  const user = await requireModuleUser("automate");
  if (!(await can(user.id, "settings.manage"))) return null;
  const seq = parseWorkflowRef(String(ref ?? ""));
  if (seq === null) return null;
  const workflow = await db.automationWorkflow.findUnique({ where: { workflowSeq: seq }, select: { id: true, name: true, workflowSeq: true } });
  if (!workflow) return null;
  return { workflow: { id: workflow.id, name: workflow.name, ref: workflowRef(workflow.workflowSeq) }, report: await workflowEmailReport(workflow.id, user.id) };
}
