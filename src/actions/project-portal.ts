"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { projectAccess } from "@/lib/authz/access";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { clip, TEXT_MAX } from "@/lib/text/bounded";
import type { ActionResult } from "@/actions/company";
import { cleanStageLink } from "@/lib/projects/portal";
import { emailCustomerAboutStage } from "@/lib/projects/portal-mail";

/**
 * What a project shows on the customer portal, from the team's side (owner, 16 Nov 2026 — projects phase 2;
 * src/lib/projects/portal.ts): the project on or off the portal, each stage shown or hidden, a stage the customer
 * approves and asking them to, a link on a stage, and the updates and documents shared with them.
 *
 * Reading it takes sight of the project; every change takes "projects.manage" and a project this person may edit.
 */

const NOT_READY = "The customer portal for projects isn't ready in this workspace yet — try again after the next update.";

async function editable(userId: string, projectId: string) {
  if (!(await hasEffectivePermission(userId, "projects.manage"))) return null;
  return db.project.findFirst({ where: { AND: [{ id: String(projectId) }, await projectAccess(userId, "edit")] }, select: { id: true, code: true, health: true } });
}

async function guarded<T>(work: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await work();
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_READY };
    throw err;
  }
}

/** The Customer portal tab: whether it's on, each stage as the customer would see it, and what is shared. */
export async function projectPortalState(projectId: string) {
  const user = await requireModuleAccess("projects");
  const project = await db.project.findFirst({ where: { AND: [{ id: String(projectId) }, await projectAccess(user.id, "view")] }, select: { id: true } });
  if (!project) return null;
  const canManage = !!(await editable(user.id, project.id));
  const portalAvailable = await moduleAvailableForTenant("customer_portal");
  try {
    const p = await db.project.findUniqueOrThrow({
      where: { id: project.id },
      select: {
        portal: { select: { createdAt: true } },
        milestones: {
          orderBy: [{ sortOrder: "asc" }, { dueDate: "asc" }],
          select: {
            id: true,
            name: true,
            dueDate: true,
            completedAt: true,
            portalStage: { select: { hidden: true, needsApproval: true, link: true, approvalRequestedAt: true, customerTask: true } },
            reviews: { orderBy: { createdAt: "desc" }, take: 5, select: { id: true, decision: true, comment: true, byName: true, createdAt: true } },
          },
        },
        updates: { orderBy: { at: "desc" }, take: 30, select: { id: true, body: true, at: true, author: { select: { name: true } }, portalShare: { select: { id: true } } } },
        documents: { orderBy: { createdAt: "desc" }, select: { id: true, name: true, sizeBytes: true, createdAt: true, portalShare: { select: { id: true } } } },
      },
    });
    return toPlain({
      ready: true,
      portalAvailable,
      canManage,
      onPortal: !!p.portal,
      stages: p.milestones.map((m) => ({
        id: m.id,
        name: m.name,
        dueDate: m.dueDate,
        completedAt: m.completedAt,
        hidden: !!m.portalStage?.hidden,
        needsApproval: !!m.portalStage?.needsApproval,
        customerTask: !!m.portalStage?.customerTask,
        link: m.portalStage?.link ?? null,
        approvalRequestedAt: m.portalStage?.approvalRequestedAt ?? null,
        reviews: m.reviews,
      })),
      updates: p.updates.map((u) => ({ id: u.id, body: u.body, at: u.at, author: u.author?.name ?? null, shared: !!u.portalShare })),
      documents: p.documents.map((d) => ({ id: d.id, name: d.name, sizeBytes: d.sizeBytes, createdAt: d.createdAt, shared: !!d.portalShare })),
    });
  } catch (err) {
    if (notMigratedYet(err)) return toPlain({ ready: false, portalAvailable, canManage, onPortal: false, stages: [], updates: [], documents: [] });
    throw err;
  }
}

export async function setProjectOnPortal(projectId: string, on: boolean): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("projects");
  const project = await editable(user.id, projectId);
  if (!project) return { ok: false, error: "You can't change what this project shows its customer." };
  return guarded(async () => {
    if (on) await db.projectPortal.upsert({ where: { projectId: project.id }, create: { projectId: project.id, createdById: user.id }, update: {} });
    else await db.projectPortal.deleteMany({ where: { projectId: project.id } });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Project", entityId: project.id, entityLabel: `${project.code} — ${on ? "shown on" : "taken off"} the customer portal` });
    revalidatePath(`/projects/${project.id}`);
    return { ok: true, data: null };
  });
}

/** One stage's portal settings: hidden, the customer approves it, a link. Only what is given changes. */
export async function setStagePortal(milestoneId: string, patch: { hidden?: boolean; needsApproval?: boolean; customerTask?: boolean; link?: string | null }): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("projects");
  const milestone = await db.projectMilestone.findUnique({ where: { id: String(milestoneId) }, select: { id: true, projectId: true, name: true, completedAt: true } });
  const project = milestone ? await editable(user.id, milestone.projectId) : null;
  if (!milestone || !project) return { ok: false, error: "That stage doesn't exist, or you can't change its project." };
  const data: { hidden?: boolean; needsApproval?: boolean; customerTask?: boolean; link?: string | null; approvalRequestedAt?: null } = {};
  if (typeof patch.hidden === "boolean") data.hidden = patch.hidden;
  if (typeof patch.needsApproval === "boolean") {
    data.needsApproval = patch.needsApproval;
    // No longer the customer's to approve: nothing waits on them.
    if (!patch.needsApproval) data.approvalRequestedAt = null;
    // A stage is approved by them or done by them, never both.
    else data.customerTask = false;
  }
  if (typeof patch.customerTask === "boolean") {
    data.customerTask = patch.customerTask;
    if (patch.customerTask) {
      data.needsApproval = false;
      data.approvalRequestedAt = null;
    }
  }
  if (patch.hidden === true) data.approvalRequestedAt = null;
  if ("link" in patch) {
    const link = cleanStageLink(patch.link);
    if (link && typeof link === "object") return { ok: false, error: link.error };
    data.link = link;
  }
  return guarded(async () => {
    const before = await db.projectPortalStage.findUnique({ where: { milestoneId: milestone.id }, select: { customerTask: true } });
    await db.projectPortalStage.upsert({ where: { milestoneId: milestone.id }, create: { milestoneId: milestone.id, projectId: milestone.projectId, ...data }, update: data });
    // Newly theirs to do: they're told (src/lib/projects/portal-mail.ts).
    if (patch.customerTask === true && !before?.customerTask && !milestone.completedAt) await emailCustomerAboutStage(milestone.id, "TODO");
    revalidatePath(`/projects/${milestone.projectId}`);
    return { ok: true, data: null };
  });
}

/** Asks the customer to approve a stage on the portal — or takes the question back. */
export async function askStageApproval(milestoneId: string, ask: boolean): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("projects");
  const milestone = await db.projectMilestone.findUnique({ where: { id: String(milestoneId) }, select: { id: true, projectId: true, name: true, completedAt: true } });
  const project = milestone ? await editable(user.id, milestone.projectId) : null;
  if (!milestone || !project) return { ok: false, error: "That stage doesn't exist, or you can't change its project." };
  return guarded(async () => {
    if (ask) {
      if (milestone.completedAt) return { ok: false, error: "That stage is done already." };
      if (!(await db.projectPortal.findUnique({ where: { projectId: milestone.projectId }, select: { projectId: true } }))) return { ok: false, error: "Show the project on the customer portal first." };
      const { count } = await db.projectPortalStage.updateMany({ where: { milestoneId: milestone.id, needsApproval: true, hidden: false }, data: { approvalRequestedAt: new Date() } });
      if (count === 0) return { ok: false, error: "Tick \"Customer approves\" on the stage first (and keep it shown)." };
      // They're told, with their portal link (src/lib/projects/portal-mail.ts).
      await emailCustomerAboutStage(milestone.id, "APPROVAL_ASKED");
    } else {
      await db.projectPortalStage.updateMany({ where: { milestoneId: milestone.id }, data: { approvalRequestedAt: null } });
    }
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Project", entityId: milestone.projectId, entityLabel: `${project.code} — ${ask ? "asked the customer to approve" : "took back the approval request for"} "${milestone.name}"` });
    revalidatePath(`/projects/${milestone.projectId}`);
    return { ok: true, data: null };
  });
}

/** An update or a document shared with the customer, or no longer. */
export async function shareWithCustomer(input: { projectId: string; updateId?: string; documentId?: string; shared: boolean }): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("projects");
  const project = await editable(user.id, input.projectId);
  if (!project) return { ok: false, error: "You can't change what this project shows its customer." };
  const which = input.updateId ? { updateId: String(input.updateId) } : input.documentId ? { documentId: String(input.documentId) } : null;
  if (!which) return { ok: false, error: "Nothing to share." };
  return guarded(async () => {
    // Held to this project: an id from another project shares nothing.
    const belongs = "updateId" in which
      ? await db.projectUpdate.count({ where: { id: which.updateId, projectId: project.id } })
      : await db.projectDocument.count({ where: { id: which.documentId, projectId: project.id } });
    if (!belongs) return { ok: false, error: "That isn't on this project." };
    if (input.shared) {
      const exists = await db.projectPortalShare.findFirst({ where: which, select: { id: true } });
      if (!exists) await db.projectPortalShare.create({ data: { projectId: project.id, ...which, sharedById: user.id } });
    } else {
      await db.projectPortalShare.deleteMany({ where: { projectId: project.id, ...which } });
    }
    revalidatePath(`/projects/${project.id}`);
    return { ok: true, data: null };
  });
}

/** An update written for the customer: in the project's log, and shared at once. */
export async function postCustomerUpdate(projectId: string, body: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("projects");
  const project = await editable(user.id, projectId);
  if (!project) return { ok: false, error: "You can't change what this project shows its customer." };
  const text = clip(body, TEXT_MAX.paragraph * 2);
  if (!text) return { ok: false, error: "Write the update first." };
  return guarded(async () => {
    await db.$transaction(async (tx) => {
      const update = await tx.projectUpdate.create({ data: { projectId: project.id, body: text, health: project.health, authorId: user.id }, select: { id: true } });
      await tx.projectPortalShare.create({ data: { projectId: project.id, updateId: update.id, sharedById: user.id } });
    });
    revalidatePath(`/projects/${project.id}`);
    return { ok: true, data: null };
  });
}
