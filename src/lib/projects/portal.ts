import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { projectStatusLabels } from "@/lib/projects/status";

/**
 * Projects on the customer portal (owner, 16 Nov 2026 — projects phase 2: "option to create stages so customer can see
 * whats going on on its customer portal"). Plain, not `"use server"`: the portal's actions resolve the link to a
 * company first and pass only that company here, so nothing in this file can be asked about anybody else's projects.
 *
 * What the customer sees of a project is only what the team chose: the project marked for the portal, its stages less
 * any hidden, the updates and documents shared. Never the internal log, risks, billing, credentials or people.
 */

export type PortalStage = {
  id: string;
  name: string;
  dueDate: string | null;
  completedAt: string | null;
  link: string | null;
  /** Asked to approve this stage now. */
  awaitingApproval: boolean;
  needsApproval: boolean;
  /** Theirs to do, and not done yet (phase 3). */
  yourTodo: boolean;
  lastReview: { decision: "APPROVED" | "CHANGES"; comment: string | null; byName: string; at: string } | null;
};
export type PortalProject = {
  id: string;
  code: string;
  name: string;
  type: string | null;
  status: string;
  startDate: string | null;
  targetEndDate: string | null;
  stages: PortalStage[];
  done: number;
  updates: { body: string; at: string }[];
  documents: { id: string; name: string; sizeBytes: number; at: string }[];
  questionnaireWaiting: boolean;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** A link the team gave a stage: http(s) only, nothing that runs. */
export function cleanStageLink(raw: unknown): string | null | { error: string } {
  if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) return null;
  if (typeof raw !== "string") return { error: "That isn't a web address." };
  const text = raw.trim().slice(0, 500);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "Give an address starting https://." };
    return url.toString();
  } catch {
    return { error: "That isn't a web address — it should start https://." };
  }
}

/** One company's projects as its portal shows them. Empty for a workspace not migrated yet. */
export async function portalProjectsFor(companyId: string): Promise<PortalProject[]> {
  try {
    const rows = await db.project.findMany({
      where: { companyId, portal: { isNot: null } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        startDate: true,
        targetEndDate: true,
        type: { select: { name: true } },
        milestones: {
          orderBy: [{ sortOrder: "asc" }, { dueDate: "asc" }],
          select: {
            id: true,
            name: true,
            dueDate: true,
            completedAt: true,
            portalStage: { select: { hidden: true, needsApproval: true, link: true, approvalRequestedAt: true, customerTask: true } },
            reviews: { orderBy: { createdAt: "desc" }, take: 1, select: { decision: true, comment: true, byName: true, createdAt: true } },
          },
        },
        portalShares: {
          orderBy: { createdAt: "desc" },
          take: 40,
          select: { update: { select: { body: true, at: true } }, document: { select: { id: true, name: true, sizeBytes: true, createdAt: true } } },
        },
        questionnaires: { where: { submittedAt: null, closedAt: null }, select: { id: true }, take: 1 },
      },
    });
    return rows.map((p) => {
      const stages = p.milestones
        .filter((m) => !m.portalStage?.hidden)
        .map((m) => ({
          id: m.id,
          name: m.name,
          dueDate: iso(m.dueDate),
          completedAt: iso(m.completedAt),
          link: m.portalStage?.link ?? null,
          needsApproval: !!m.portalStage?.needsApproval,
          awaitingApproval: !!m.portalStage?.needsApproval && !!m.portalStage.approvalRequestedAt && !m.completedAt,
          yourTodo: !!m.portalStage?.customerTask && !m.completedAt,
          lastReview: m.reviews[0] && m.reviews[0].decision !== "DONE" ? { decision: (m.reviews[0].decision === "APPROVED" ? "APPROVED" : "CHANGES") as "APPROVED" | "CHANGES", comment: m.reviews[0].comment, byName: m.reviews[0].byName, at: m.reviews[0].createdAt.toISOString() } : null,
        }));
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        type: p.type?.name ?? null,
        status: projectStatusLabels[p.status],
        startDate: iso(p.startDate),
        targetEndDate: iso(p.targetEndDate),
        stages,
        done: stages.filter((s) => s.completedAt).length,
        updates: p.portalShares.flatMap((s) => (s.update ? [{ body: s.update.body, at: s.update.at.toISOString() }] : [])).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10),
        documents: p.portalShares.flatMap((s) => (s.document ? [{ id: s.document.id, name: s.document.name, sizeBytes: s.document.sizeBytes, at: s.document.createdAt.toISOString() }] : [])),
        questionnaireWaiting: p.questionnaires.length > 0,
      };
    });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/**
 * The customer marks a stage that is theirs to do as done (phase 3): the stage is finished, the team told, the log says
 * so, with their note if they left one. Only such a stage, not done yet, on a project of this company on its portal.
 */
export async function completeCustomerTask(input: { companyId: string; milestoneId: string; note: unknown; byName: string; portalLoginId: string | null }): Promise<{ ok: true } | { ok: false; error: string }> {
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 2000) : "";
  const stage = await db.projectPortalStage.findFirst({
    where: { milestoneId: String(input.milestoneId ?? ""), customerTask: true, hidden: false, milestone: { completedAt: null }, project: { companyId: input.companyId, portal: { isNot: null } } },
    select: { milestoneId: true, projectId: true, milestone: { select: { name: true } }, project: { select: { code: true, name: true, stakeholders: { where: { userId: { not: null } }, select: { userId: true } } } } },
  });
  if (!stage) return { ok: false, error: "This isn't waiting for you any more." };
  const now = new Date();
  const done = await db.$transaction(async (tx) => {
    // Only while not done: two clicks at once finish it once.
    const { count } = await tx.projectMilestone.updateMany({ where: { id: stage.milestoneId, completedAt: null }, data: { completedAt: now, completedById: null } });
    if (count === 0) return false;
    await tx.projectStageReview.create({ data: { projectId: stage.projectId, milestoneId: stage.milestoneId, decision: "DONE", comment: note || null, byName: input.byName.slice(0, 200), portalLoginId: input.portalLoginId } });
    await tx.projectUpdate.create({ data: { projectId: stage.projectId, body: `${input.byName} marked "${stage.milestone.name}" done on the customer portal.${note ? `\n${note}` : ""}` } });
    return true;
  });
  if (!done) return { ok: false, error: "This isn't waiting for you any more." };
  await Promise.all(
    [...new Set(stage.project.stakeholders.map((s) => s.userId!))].map((userId) =>
      notifyUser({ userId, type: "PROJECT_STATUS_CHANGED", title: `${stage.project.code}: the customer did "${stage.milestone.name}"`, message: note ? note.slice(0, 200) : stage.project.name, link: `/projects/${stage.projectId}?tab=portal` }),
    ),
  );
  return { ok: true };
}

/** Whether anything on this project waits on the customer: an approval asked for, or a to do of theirs not done. */
export async function waitingOnCustomer(projectId: string): Promise<number> {
  try {
    return await db.projectPortalStage.count({
      where: { projectId, hidden: false, project: { portal: { isNot: null } }, milestone: { completedAt: null }, OR: [{ customerTask: true }, { needsApproval: true, approvalRequestedAt: { not: null } }] },
    });
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
}

/** Whether a document is one shared with this company on a project shown on its portal. */
export async function portalProjectDocumentAllowed(companyId: string, documentId: string): Promise<boolean> {
  if (!documentId || typeof documentId !== "string") return false;
  try {
    return (await db.projectPortalShare.count({ where: { documentId, project: { companyId, portal: { isNot: null } } } })) > 0;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/**
 * The customer's answer to "please approve this stage": approved finishes the stage; changes needs a word on what to
 * change. Either way the request is answered, the team is told, and the project's log says so. Only a stage asked
 * about now, on a project of this company shown on its portal.
 */
export async function reviewStage(input: {
  companyId: string;
  milestoneId: string;
  decision: unknown;
  comment: unknown;
  byName: string;
  portalLoginId: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const decision = input.decision === "APPROVED" ? "APPROVED" : input.decision === "CHANGES" ? "CHANGES" : null;
  if (!decision) return { ok: false, error: "Approve it, or say what to change." };
  const comment = typeof input.comment === "string" ? input.comment.trim().slice(0, 2000) : "";
  if (decision === "CHANGES" && !comment) return { ok: false, error: "Say what you'd like changed, so the team can act on it." };
  const stage = await db.projectPortalStage.findFirst({
    where: { milestoneId: String(input.milestoneId ?? ""), needsApproval: true, approvalRequestedAt: { not: null }, hidden: false, milestone: { completedAt: null }, project: { companyId: input.companyId, portal: { isNot: null } } },
    select: { milestoneId: true, projectId: true, milestone: { select: { name: true } }, project: { select: { code: true, name: true, stakeholders: { where: { userId: { not: null } }, select: { userId: true } } } } },
  });
  if (!stage) return { ok: false, error: "This stage isn't waiting for your approval any more." };
  const now = new Date();
  const answered = await db.$transaction(async (tx) => {
    // Only while still asked: two clicks at once answer it once.
    const { count } = await tx.projectPortalStage.updateMany({ where: { milestoneId: stage.milestoneId, approvalRequestedAt: { not: null } }, data: { approvalRequestedAt: null } });
    if (count === 0) return false;
    await tx.projectStageReview.create({ data: { projectId: stage.projectId, milestoneId: stage.milestoneId, decision, comment: comment || null, byName: input.byName.slice(0, 200), portalLoginId: input.portalLoginId } });
    if (decision === "APPROVED") await tx.projectMilestone.update({ where: { id: stage.milestoneId }, data: { completedAt: now, completedById: null } });
    await tx.projectUpdate.create({
      data: {
        projectId: stage.projectId,
        body: decision === "APPROVED" ? `${input.byName} approved "${stage.milestone.name}" on the customer portal.` : `${input.byName} asked for changes to "${stage.milestone.name}" on the customer portal:\n${comment}`,
      },
    });
    return true;
  });
  if (!answered) return { ok: false, error: "This stage isn't waiting for your approval any more." };
  const ids = [...new Set(stage.project.stakeholders.map((s) => s.userId!))];
  await Promise.all(
    ids.map((userId) =>
      notifyUser({
        userId,
        type: "PROJECT_STATUS_CHANGED",
        title: decision === "APPROVED" ? `${stage.project.code}: "${stage.milestone.name}" approved by the customer` : `${stage.project.code}: the customer asked for changes to "${stage.milestone.name}"`,
        message: decision === "APPROVED" ? stage.project.name : comment.slice(0, 200),
        link: `/projects/${stage.projectId}?tab=portal`,
      }),
    ),
  );
  return { ok: true };
}
