"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { projectAccess } from "@/lib/authz/access";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { notMigratedYet } from "@/lib/not-migrated";
import { STILL_THERE } from "@/lib/contacts/left";
import { maskContactRows } from "@/lib/contacts/masking";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { clip, TEXT_MAX } from "@/lib/text/bounded";
import type { ActionResult } from "@/actions/company";
import { checkQuestionsForSave, parseAnswers, parseQuestions, type Question } from "@/lib/projects/questionnaire";
import { PROJECT_STARTERS } from "@/lib/projects/starters";
import { emailQuestionnaire, newLink, questionnaireUrl } from "@/lib/projects/questionnaire-server";

/**
 * A project's questionnaire, from the staff side (owner, 16 Nov 2026 — "how about we do this within projects?";
 * src/lib/projects/questionnaire.ts): the questions a project type asks, the examples to start one from, and sending,
 * withdrawing and reopening it on a project.
 *
 * Changing a project type's questions takes "projects.manage", as its stages do. Sending one takes "projects.manage"
 * and a project this person may edit (`projectAccess`); reading the answers, one they may see.
 */

const NOT_READY = "Questionnaires aren't ready in this workspace yet — try again after the next update.";

async function manager() {
  const user = await requireModuleUser("projects");
  return { user, manage: await hasEffectivePermission(user.id, "projects.manage") };
}

// ─── Project types ─────────────────────────────────────────────────────────────────────────────

/** Each project type's questions, by type id — read by name, none before the workspace is migrated. */
export async function projectTypeQuestions(): Promise<Record<string, Question[]>> {
  await requireModuleUser("projects");
  try {
    const rows = await db.projectType.findMany({ select: { id: true, questions: true } });
    return toPlain(Object.fromEntries(rows.map((r) => [r.id, parseQuestions(r.questions)])));
  } catch (err) {
    if (notMigratedYet(err)) return {};
    throw err;
  }
}

export async function saveProjectTypeQuestions(typeId: string, questions: unknown): Promise<ActionResult<{ count: number }>> {
  const { user, manage } = await manager();
  if (!manage) return { ok: false, error: "You can't manage project types." };
  const checked = checkQuestionsForSave(questions);
  if (!checked.ok) return checked;
  const type = await db.projectType.findUnique({ where: { id: String(typeId) }, select: { id: true, name: true } });
  if (!type) return { ok: false, error: "That kind of project no longer exists." };
  try {
    await db.projectType.update({ where: { id: type.id }, data: { questions: checked.questions as unknown as Prisma.InputJsonValue }, select: { id: true } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_READY };
    throw err;
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ProjectType", entityId: type.id, entityLabel: `${type.name} — questionnaire (${checked.questions.length} questions)` });
  revalidatePath("/settings/lists");
  return { ok: true, data: { count: checked.questions.length } };
}

/** A new project type copied from one of the examples — its stages and questions, then the workspace's own. */
export async function createProjectTypeFromStarter(key: string): Promise<ActionResult<{ id: string; name: string }>> {
  const { user, manage } = await manager();
  if (!manage) return { ok: false, error: "You can't manage project types." };
  const starter = PROJECT_STARTERS.find((s) => s.key === key);
  if (!starter) return { ok: false, error: "That example isn't one of ours." };
  // Its own name, or the name with a number when that is taken.
  const taken = new Set((await db.projectType.findMany({ where: { name: { startsWith: starter.name } }, select: { name: true } })).map((t) => t.name));
  let name = starter.name;
  for (let n = 2; taken.has(name); n++) name = `${starter.name} (${n})`;
  const count = await db.projectType.count();
  const made = await db.$transaction(async (tx) => {
    const type = await tx.projectType.create({ data: { name, description: starter.blurb, sortOrder: count }, select: { id: true } });
    await tx.projectTemplateMilestone.createMany({ data: starter.steps.map((s, i) => ({ typeId: type.id, name: s.name, note: s.note ?? null, dayOffset: s.dayOffset, sortOrder: i })) });
    return type;
  });
  try {
    await db.projectType.update({ where: { id: made.id }, data: { questions: starter.questions as unknown as Prisma.InputJsonValue }, select: { id: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "ProjectType", entityId: made.id, entityLabel: `${name} — from the example` });
  revalidatePath("/settings/lists");
  revalidatePath("/projects");
  return { ok: true, data: { id: made.id, name } };
}

// ─── On a project ──────────────────────────────────────────────────────────────────────────────

async function projectFor(userId: string, projectId: string, level: "view" | "edit") {
  return db.project.findFirst({
    where: { AND: [{ id: String(projectId) }, await projectAccess(userId, level)] },
    select: { id: true, code: true, name: true, companyId: true, typeId: true },
  });
}

/** The Requirements tab: the type's questions, every round sent with its answers, and who it can go to. */
export async function projectQuestionnaires(projectId: string) {
  const user = await requireModuleAccess("projects");
  const project = await projectFor(user.id, projectId, "view");
  if (!project) return null;
  const canSend = (await hasEffectivePermission(user.id, "projects.manage")) && !!(await projectFor(user.id, projectId, "edit"));
  let questions: Question[] = [];
  let rounds: { id: string; round: number; contactId: string | null; questions: unknown; answers: unknown; sentById: string | null; sentAt: Date; openedAt: Date | null; savedAt: Date | null; submittedAt: Date | null; closedAt: Date | null }[] = [];
  try {
    if (project.typeId) questions = parseQuestions((await db.projectType.findUnique({ where: { id: project.typeId }, select: { questions: true } }))?.questions);
    rounds = await db.projectQuestionnaire.findMany({
      where: { projectId: project.id },
      orderBy: { round: "desc" },
      select: { id: true, round: true, contactId: true, questions: true, answers: true, sentById: true, sentAt: true, openedAt: true, savedAt: true, submittedAt: true, closedAt: true },
    });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const contacts = await db.contact.findMany({
    where: { companyId: project.companyId, ...STILL_THERE },
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
    select: { id: true, name: true, email: true, phone: true, isPrimary: true },
  });
  // As the contacts policy shows people in a list; the real address is read again when it is sent.
  const shown = await maskContactRows(user.id, "list", contacts);
  const byId = new Map(shown.map((c) => [c.id, c]));
  const senders = await db.user.findMany({ where: { id: { in: rounds.flatMap((r) => (r.sentById ? [r.sentById] : [])) } }, select: { id: true, name: true } });
  return toPlain({
    project: { id: project.id, name: project.name, hasType: !!project.typeId },
    questions,
    canSend,
    contacts: shown.filter((c) => !!c.email).map((c) => ({ id: c.id, name: c.name, email: c.email, primary: c.isPrimary })),
    rounds: rounds.map((r) => ({
      id: r.id,
      round: r.round,
      contact: r.contactId ? (byId.get(r.contactId)?.name ?? "A contact no longer on the account") : null,
      contactId: r.contactId,
      sentBy: senders.find((s) => s.id === r.sentById)?.name ?? null,
      sentAt: r.sentAt,
      openedAt: r.openedAt,
      savedAt: r.savedAt,
      submittedAt: r.submittedAt,
      closedAt: r.closedAt,
      questions: parseQuestions(r.questions),
      answers: parseAnswers(r.answers),
    })),
  });
}

/**
 * Sends the questionnaire to one of the customer's people. With a round still open, it goes again as a reminder with a
 * new link (the old one stops working), to this person; otherwise a new round starts with the type's questions as they
 * are now — and, after an answered round, `reopen` starts it with those answers to change.
 */
export async function sendProjectQuestionnaire(input: { projectId: string; contactId: string; note?: string; reopen?: boolean }): Promise<ActionResult<{ round: number; reminder: boolean }>> {
  const user = await requireModuleAccess("projects");
  if (!(await hasEffectivePermission(user.id, "projects.manage"))) return { ok: false, error: "You can't send questionnaires on projects." };
  const project = await projectFor(user.id, input.projectId, "edit");
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };
  const contact = await db.contact.findFirst({ where: { id: String(input.contactId ?? ""), companyId: project.companyId, ...STILL_THERE }, select: { id: true, name: true, email: true } });
  if (!contact) return { ok: false, error: "Choose one of the customer's people." };
  if (!contact.email) return { ok: false, error: `${contact.name} has no email address.` };
  const note = clip(input.note ?? "", TEXT_MAX.paragraph);

  try {
    const latest = await db.projectQuestionnaire.findFirst({ where: { projectId: project.id }, orderBy: { round: "desc" }, select: { id: true, round: true, answers: true, submittedAt: true, closedAt: true } });
    const open = latest && !latest.submittedAt && !latest.closedAt ? latest : null;
    let questions: Question[] = [];
    if (!open) {
      if (latest?.submittedAt && !input.reopen) return { ok: false, error: "They've answered it already. Reopen it to let them change their answers." };
      questions = project.typeId ? parseQuestions((await db.projectType.findUnique({ where: { id: project.typeId }, select: { questions: true } }))?.questions) : [];
      if (questions.filter((q) => q.type !== "HEADING").length === 0) return { ok: false, error: "This kind of project has no questions yet — add them in Settings › Lists › Project types." };
    }
    const link = newLink();
    const sent = await emailQuestionnaire({ senderId: user.id, companyId: project.companyId, contact: { id: contact.id, name: contact.name, email: contact.email }, projectName: project.name, link: questionnaireUrl(await tenantOrigin(), link.token), note, reminder: !!open });
    if (!sent.ok) return sent;
    const now = new Date();
    let round: number;
    if (open) {
      await db.projectQuestionnaire.update({ where: { id: open.id }, data: { tokenHash: link.hash, contactId: contact.id, sentById: user.id, sentAt: now } });
      round = open.round;
    } else {
      round = (latest?.round ?? 0) + 1;
      await db.projectQuestionnaire.create({
        data: {
          projectId: project.id,
          round,
          contactId: contact.id,
          tokenHash: link.hash,
          questions: questions as unknown as Prisma.InputJsonValue,
          // Reopened: the answers given, to change rather than type again — files included.
          ...(input.reopen && latest?.submittedAt && latest.answers ? { answers: latest.answers as Prisma.InputJsonValue } : {}),
          sentById: user.id,
          sentAt: now,
        },
      });
    }
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Project", entityId: project.id, entityLabel: `${project.code} — questionnaire ${open ? "sent again" : input.reopen ? "reopened" : "sent"} to ${contact.name}` });
    revalidatePath(`/projects/${project.id}`);
    return { ok: true, data: { round, reminder: !!open } };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_READY };
    throw err;
  }
}

/** The link stops working; what was answered so far stays on the tab. */
export async function withdrawProjectQuestionnaire(roundId: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("projects");
  if (!(await hasEffectivePermission(user.id, "projects.manage"))) return { ok: false, error: "You can't change questionnaires on projects." };
  const round = await db.projectQuestionnaire.findUnique({ where: { id: String(roundId) }, select: { id: true, projectId: true, submittedAt: true, closedAt: true } });
  const project = round ? await projectFor(user.id, round.projectId, "edit") : null;
  if (!round || !project) return { ok: false, error: "That questionnaire doesn't exist, or you're not on its project." };
  if (round.submittedAt || round.closedAt) return { ok: false, error: "It's already answered or withdrawn." };
  await db.projectQuestionnaire.update({ where: { id: round.id }, data: { closedAt: new Date() } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Project", entityId: project.id, entityLabel: `${project.code} — questionnaire withdrawn` });
  revalidatePath(`/projects/${project.id}`);
  return { ok: true, data: null };
}
