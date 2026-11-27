"use server";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { saveCompanyTemplate } from "@/lib/smart-lists/company-templates";
import { recordAudit } from "@/lib/audit";
import type { ActionResult } from "@/actions/company";
import { openList } from "@/lib/smart-lists/open-list";
import { companyInList } from "@/lib/smart-lists/membership";
import { rowHistory, type HistoryLine } from "@/lib/smart-lists/history";
import { addCommentOnRow, commentsOnRow, listReaders, listTeams, type OwnRowComment } from "@/lib/smart-lists/comments";
import { FORM_LIMITS, cleanFormFields, formToFill, submitForm, type FormField } from "@/lib/smart-lists/forms";
import { PUBLIC_LIMITS, decideAnswer, newSlug, waitingAnswers, type WaitingAnswer } from "@/lib/smart-lists/public-forms";
import type { PropertyKind } from "@/lib/smart-lists/values";

/**
 * Working on a Smart List together (owner, 20 Nov 2026 — Smart Lists phase 3): a row's history, and comments on a row
 * of a list of its own, with @mentions. Who may — the list's own rule (src/lib/smart-lists/open-list.ts): whoever may
 * open the list reads a row's history and its comments and comments on it; a comment is deleted by whoever wrote it,
 * or whoever may edit the list.
 */

const NOT_YET = "This workspace is still being updated. Try again in a few minutes.";

/** Whether `rowKey` is a row of this list for this person. */
async function rowIn(opened: NonNullable<Awaited<ReturnType<typeof openList>>>, rowKey: unknown): Promise<{ title: string } | null> {
  if (typeof rowKey !== "string" || !rowKey) return null;
  if (opened.workbook.mode === "ROWS") return db.workbookRow.findFirst({ where: { id: rowKey, workbookId: opened.workbook.id }, select: { title: true } });
  if (!(await companyInList(opened.userId, opened.workbook, rowKey))) return null;
  return db.company.findUnique({ where: { id: rowKey }, select: { name: true } }).then((c) => (c ? { title: c.name } : null));
}

/** `teams`: the teams of guests the list is shared with — who a shared comment can be meant for. */
export type RowActivity = { history: HistoryLine[]; comments: OwnRowComment[] | null; people: { id: string; name: string }[]; teams: { id: string; name: string }[] };

/** A row's history, and — on a list of its own — its comments and the people a comment may mention. */
export async function rowActivity(workbookId: string, rowKey: string): Promise<RowActivity | null> {
  const opened = await openList(workbookId);
  if (!opened || !(await rowIn(opened, rowKey))) return null;
  const own = opened.workbook.mode === "ROWS";
  const [history, comments, people, teams] = await Promise.all([
    rowHistory(opened.workbook.id, rowKey),
    own ? commentsOnRow(rowKey, opened.userId) : Promise.resolve(null),
    own ? listReaders(opened.workbook.id) : Promise.resolve([]),
    own ? listTeams(opened.workbook.id) : Promise.resolve([]),
  ]);
  return { history, comments, people, teams };
}

/** `to`: "" only staff; "all" every guest of the list; a team's id — that team's guests only. */
export async function commentOnRow(input: { workbookId: string; rowId: string; body: string; shared?: boolean; to?: string }): Promise<ActionResult<{ comment: OwnRowComment; told: number }>> {
  const opened = await openList(input?.workbookId);
  if (!opened) return { ok: false, error: "That list no longer exists." };
  if (opened.workbook.mode !== "ROWS") return { ok: false, error: "Comments on a list of companies are on the company's row page." };
  const row = await rowIn(opened, input.rowId);
  if (!row) return { ok: false, error: "That row no longer exists." };
  if (!String(input.body ?? "").trim()) return { ok: false, error: "Write something first." };
  const me = await db.user.findUnique({ where: { id: opened.userId }, select: { name: true } });
  const to = typeof input.to === "string" ? input.to : input.shared ? "all" : "";
  const team = to && to !== "all" ? ((await listTeams(opened.workbook.id)).find((t) => t.id === to) ?? null) : null;
  if (to && to !== "all" && !team) return { ok: false, error: "That team doesn't share this list any more." };
  try {
    const done = await addCommentOnRow({ workbookId: opened.workbook.id, workbookName: opened.workbook.name, rowId: input.rowId, rowTitle: row.title, body: String(input.body), userId: opened.userId, userName: me?.name ?? "Somebody", shared: !!to, team });
    return { ok: true, data: done };
  } catch {
    return { ok: false, error: NOT_YET };
  }
}

export async function deleteRowComment(commentId: string): Promise<ActionResult<null>> {
  const c = typeof commentId === "string" ? await db.workbookRowComment.findUnique({ where: { id: commentId }, select: { id: true, workbookId: true, authorUserId: true } }).catch(() => null) : null;
  const opened = c ? await openList(c.workbookId) : null;
  if (!c || !opened) return { ok: true, data: null };
  if (c.authorUserId !== opened.userId && !opened.canEdit) return { ok: false, error: "Only whoever wrote a comment, or whoever built the list, can delete it." };
  await db.workbookRowComment.delete({ where: { id: c.id } });
  await recordAudit({ userId: opened.userId, action: "UPDATE", entityType: "Workbook", entityId: opened.workbook.id, entityLabel: `${opened.workbook.name}: a comment deleted` });
  return { ok: true, data: null };
}

// ─── Forms that add rows ──────────────────────────────────────────────────────

/** `publicLink`: its link for people outside the company, if it was ever given one (phase 4). */
export type ListForm = { id: string; name: string; intro: string | null; fields: FormField[]; active: boolean; publicLink: { slug: string; consent: string; approve: boolean; active: boolean } | null };

/** A list's forms, for whoever may change it. */
export async function listForms(workbookId: string): Promise<ListForm[] | null> {
  const opened = await openList(workbookId);
  if (!opened || !opened.canEdit || opened.workbook.mode !== "ROWS") return null;
  const props = await db.workbookProperty.findMany({ where: { workbookId: opened.workbook.id }, select: { id: true, kind: true } });
  const rows = await db.workbookForm.findMany({ where: { workbookId: opened.workbook.id }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, intro: true, fields: true, active: true } }).catch(() => []);
  // Their public links (phase 4) — none on a workspace not migrated yet.
  const links = new Map(
    (await db.workbookPublicForm.findMany({ where: { formId: { in: rows.map((f) => f.id) } }, select: { formId: true, slug: true, consent: true, approve: true, active: true } }).catch(() => [])).map((l) => [l.formId, l]),
  );
  return rows.map((f) => {
    const l = links.get(f.id);
    return { ...f, fields: cleanFormFields(f.fields, props.map((p) => ({ id: p.id, kind: p.kind as PropertyKind }))), publicLink: l ? { slug: l.slug, consent: l.consent, approve: l.approve, active: l.active } : null };
  });
}

export async function saveListForm(input: { workbookId: string; id?: string | null; name: string; intro?: string | null; fields: unknown; active?: boolean }): Promise<ActionResult<{ id: string }>> {
  const opened = await openList(input?.workbookId);
  if (!opened) return { ok: false, error: "That list no longer exists." };
  if (!opened.canEdit) return { ok: false, error: "Only whoever built this list can make its forms." };
  if (opened.workbook.mode !== "ROWS") return { ok: false, error: "Forms add rows to a list of its own rows." };
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim().slice(0, FORM_LIMITS.name);
  if (!name) return { ok: false, error: "Give the form a name." };
  const props = await db.workbookProperty.findMany({ where: { workbookId: opened.workbook.id }, select: { id: true, kind: true } });
  const fields = cleanFormFields(input.fields, props.map((p) => ({ id: p.id, kind: p.kind as PropertyKind })));
  const data = { name, intro: String(input.intro ?? "").trim().slice(0, FORM_LIMITS.intro) || null, fields: fields as unknown as Prisma.InputJsonValue, active: input.active !== false };
  try {
    const existing = input.id ? await db.workbookForm.findFirst({ where: { id: input.id, workbookId: opened.workbook.id }, select: { id: true } }) : null;
    if (input.id && !existing) return { ok: false, error: "That form no longer exists." };
    const saved = existing
      ? await db.workbookForm.update({ where: { id: existing.id }, data, select: { id: true } })
      : await db.workbookForm.create({ data: { ...data, workbookId: opened.workbook.id, createdByUserId: opened.userId }, select: { id: true } });
    await recordAudit({ userId: opened.userId, action: existing ? "UPDATE" : "CREATE", entityType: "Workbook", entityId: opened.workbook.id, entityLabel: `${opened.workbook.name}: the form "${name}"${data.active ? "" : " (closed)"}` });
    return { ok: true, data: saved };
  } catch {
    return { ok: false, error: NOT_YET };
  }
}

export async function deleteListForm(formId: string): Promise<ActionResult<null>> {
  const form = typeof formId === "string" ? await db.workbookForm.findUnique({ where: { id: formId }, select: { id: true, workbookId: true, name: true } }).catch(() => null) : null;
  const opened = form ? await openList(form.workbookId) : null;
  if (!form || !opened) return { ok: true, data: null };
  if (!opened.canEdit) return { ok: false, error: "Only whoever built this list can delete its forms." };
  await db.workbookForm.delete({ where: { id: form.id } });
  // Its public answers go with it (phase 4); its public link goes by the cascade.
  await db.workbookFormSubmission.deleteMany({ where: { formId: form.id } }).catch(() => {});
  await recordAudit({ userId: opened.userId, action: "UPDATE", entityType: "Workbook", entityId: opened.workbook.id, entityLabel: `${opened.workbook.name}: the form "${form.name}" deleted` });
  return { ok: true, data: null };
}

/**
 * A form's public link (phase 4): on or off, its consent wording, and whether answers wait to be accepted. `newLink`
 * gives it a new address — the old one stops working. Turned off, the link is kept (off), so turning it on again
 * brings the same address back.
 */
export async function savePublicLink(input: { formId: string; on: boolean; consent?: string | null; approve?: boolean; newLink?: boolean }): Promise<ActionResult<{ slug: string | null }>> {
  const form = typeof input?.formId === "string" ? await db.workbookForm.findUnique({ where: { id: input.formId }, select: { id: true, name: true, workbookId: true } }).catch(() => null) : null;
  const opened = form ? await openList(form.workbookId) : null;
  if (!form || !opened) return { ok: false, error: "That form no longer exists." };
  if (!opened.canEdit) return { ok: false, error: "Only whoever may change this list can give its forms a public link." };
  const consent = String(input.consent ?? "").replace(/\s+/g, " ").trim().slice(0, PUBLIC_LIMITS.consent);
  try {
    const existing = await db.workbookPublicForm.findUnique({ where: { formId: form.id }, select: { slug: true, active: true } });
    if (!input.on && !existing) return { ok: true, data: { slug: null } };
    const data = { active: input.on === true, approve: input.approve !== false, consent, ...(input.newLink || !existing ? { slug: newSlug() } : {}) };
    const saved = existing
      ? await db.workbookPublicForm.update({ where: { formId: form.id }, data, select: { slug: true, active: true } })
      : await db.workbookPublicForm.create({ data: { ...data, slug: data.slug ?? newSlug(), formId: form.id }, select: { slug: true, active: true } });
    if (!existing || existing.active !== saved.active || input.newLink)
      await recordAudit({
        userId: opened.userId,
        action: "UPDATE",
        entityType: "Workbook",
        entityId: opened.workbook.id,
        entityLabel: `${opened.workbook.name}: the form "${form.name}" — public link ${saved.active ? (input.newLink && existing ? "changed" : "on") : "off"}`,
      });
    return { ok: true, data: { slug: saved.active ? saved.slug : null } };
  } catch {
    return { ok: false, error: NOT_YET };
  }
}

/** Answers to the list's public forms waiting to be accepted — for whoever may change the list. */
export async function answersWaiting(workbookId: string): Promise<WaitingAnswer[] | null> {
  const opened = await openList(workbookId);
  if (!opened || !opened.canEdit || opened.workbook.mode !== "ROWS") return null;
  return waitingAnswers(opened.workbook.id);
}

export async function decidePublicAnswer(input: { workbookId: string; submissionId: string; accept: boolean }): Promise<ActionResult<{ rowId: string | null }>> {
  const opened = await openList(input?.workbookId);
  if (!opened) return { ok: false, error: "That list no longer exists." };
  if (!opened.canEdit) return { ok: false, error: "Only whoever may change this list accepts its answers." };
  const done = await decideAnswer({ workbookId: opened.workbook.id, submissionId: String(input.submissionId ?? ""), accept: input.accept === true, userId: opened.userId });
  if (!done.ok) return done;
  if (done.rowId) await recordAudit({ userId: opened.userId, action: "CREATE", entityType: "Workbook", entityId: opened.workbook.id, entityLabel: `${opened.workbook.name}: a row from a public form, accepted` });
  return { ok: true, data: { rowId: done.rowId } };
}

/** A form to fill in — for anybody with Smart Lists open to them, whether or not they may open its list. */
export async function formForFilling(formId: string) {
  await requireModuleAccess("workspace");
  return typeof formId === "string" && formId ? formToFill(formId) : null;
}

export async function sendListForm(input: { formId: string; title: string; answers: Record<string, unknown> }): Promise<ActionResult<{ rowId: string }>> {
  const user = await requireModuleAccess("workspace");
  const done = await submitForm({ formId: String(input?.formId ?? ""), title: String(input?.title ?? ""), answers: input?.answers && typeof input.answers === "object" ? input.answers : {}, userId: user.id });
  return done.ok ? { ok: true, data: { rowId: done.rowId } } : { ok: false, error: done.error };
}

// ─── The company's own templates ──────────────────────────────────────────────

/** A list of its own rows saved as one of the company's templates — its columns and views, never its rows. */
export async function saveListAsTemplate(input: { workbookId: string; name: string; description?: string | null }): Promise<ActionResult<{ key: string }>> {
  const opened = await openList(input?.workbookId);
  if (!opened) return { ok: false, error: "That list no longer exists." };
  if (!opened.canEdit) return { ok: false, error: "Only whoever built this list can make a template of it." };
  if (opened.workbook.mode !== "ROWS") return { ok: false, error: "A template is made from a list of its own rows." };
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) return { ok: false, error: "Give the template a name." };
  try {
    const id = await saveCompanyTemplate({ workbookId: opened.workbook.id, name, description: String(input.description ?? "").trim().slice(0, 300) || null, userId: opened.userId });
    await recordAudit({ userId: opened.userId, action: "CREATE", entityType: "Workbook", entityId: opened.workbook.id, entityLabel: `${opened.workbook.name}: saved as the template "${name}"` });
    return { ok: true, data: { key: `custom:${id}` } };
  } catch {
    return { ok: false, error: NOT_YET };
  }
}

export async function deleteListTemplate(key: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("workspace");
  const id = typeof key === "string" && key.startsWith("custom:") ? key.slice(7) : "";
  const row = id ? await db.workbookTemplate.findUnique({ where: { id }, select: { id: true, name: true, createdByUserId: true } }).catch(() => null) : null;
  if (!row) return { ok: true, data: null };
  if (row.createdByUserId !== user.id && !(await hasEffectivePermission(user.id, "workspace.manageAny"))) return { ok: false, error: "Only whoever made a template, or whoever manages every list, can delete it." };
  await db.workbookTemplate.delete({ where: { id: row.id } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "WorkbookTemplate", entityId: row.id, entityLabel: `Deleted the Smart List template "${row.name}"` });
  return { ok: true, data: null };
}

// ─── Who may see and fill in a list (Smart Lists phase 4) ─────────────────────

export type AccessSettings = {
  shared: boolean;
  own: boolean;
  audience: "EVERYONE" | "CHOSEN";
  everyoneRole: "EDIT" | "VIEW";
  rowRule: "ANY" | "OWN";
  ownerPropertyId: string | null;
  members: { userId: string | null; departmentId: string | null; name: string; role: "EDIT" | "VIEW" }[];
  people: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  personColumns: { id: string; name: string }[];
};

/** A list's access, for whoever may change it — and who could be chosen. */
export async function listAccessSettings(workbookId: string): Promise<AccessSettings | null> {
  const opened = await openList(workbookId);
  if (!opened || !opened.canEdit) return null;
  const wb = await db.workbook.findUnique({ where: { id: opened.workbook.id }, select: { shared: true } });
  const [access, members, people, departments, personColumns] = await Promise.all([
    db.workbookAccess.findUnique({ where: { workbookId: opened.workbook.id }, select: { audience: true, everyoneRole: true, rowRule: true, ownerPropertyId: true } }).catch(() => null),
    db.workbookMember.findMany({ where: { workbookId: opened.workbook.id }, select: { userId: true, departmentId: true, role: true } }).catch(() => []),
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.workbookProperty.findMany({ where: { workbookId: opened.workbook.id, kind: "PERSON" }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true } }),
  ]);
  const names = new Map([...people.map((p) => [p.id, p.name] as const), ...departments.map((d) => [d.id, `${d.name} (department)`] as const)]);
  return {
    shared: wb?.shared ?? true,
    own: opened.workbook.mode === "ROWS",
    audience: access?.audience === "CHOSEN" ? "CHOSEN" : "EVERYONE",
    everyoneRole: access?.everyoneRole === "VIEW" ? "VIEW" : "EDIT",
    rowRule: access?.rowRule === "OWN" ? "OWN" : "ANY",
    ownerPropertyId: access?.ownerPropertyId ?? null,
    members: members.map((m) => ({ userId: m.userId, departmentId: m.departmentId, name: names.get(m.userId ?? m.departmentId ?? "") ?? "Somebody who left", role: m.role === "VIEW" ? "VIEW" : "EDIT" })),
    people,
    departments,
    personColumns,
  };
}

export async function saveListAccess(input: {
  workbookId: string;
  audience: string;
  everyoneRole: string;
  rowRule: string;
  ownerPropertyId?: string | null;
  members: { userId?: string | null; departmentId?: string | null; role: string }[];
}): Promise<ActionResult<null>> {
  const opened = await openList(input?.workbookId);
  if (!opened) return { ok: false, error: "That list no longer exists." };
  if (!opened.canEdit) return { ok: false, error: "Only whoever built this list can change who sees it." };
  const workbookId = opened.workbook.id;
  const own = opened.workbook.mode === "ROWS";
  const audience = input.audience === "CHOSEN" ? "CHOSEN" : "EVERYONE";
  const everyoneRole = input.everyoneRole === "VIEW" ? "VIEW" : "EDIT";
  const rowRule = input.rowRule === "OWN" ? "OWN" : "ANY";
  let ownerPropertyId: string | null = null;
  if (rowRule === "OWN") {
    if (input.ownerPropertyId) {
      const p = await db.workbookProperty.findFirst({ where: { id: input.ownerPropertyId, workbookId, kind: "PERSON" }, select: { id: true } });
      if (!p) return { ok: false, error: "Choose the Person column that says whose each row is." };
      ownerPropertyId = p.id;
    } else if (!own) return { ok: false, error: "On a list of companies, choose the Person column that says whose each row is." };
  }
  const people = new Set((await db.user.findMany({ where: { active: true }, select: { id: true } })).map((u) => u.id));
  const departments = new Set((await db.department.findMany({ select: { id: true } })).map((d) => d.id));
  const seen = new Set<string>();
  const members: { userId: string | null; departmentId: string | null; role: string }[] = [];
  for (const m of Array.isArray(input.members) ? input.members.slice(0, 500) : []) {
    const userId = typeof m?.userId === "string" && people.has(m.userId) ? m.userId : null;
    const departmentId = !userId && typeof m?.departmentId === "string" && departments.has(m.departmentId) ? m.departmentId : null;
    const key = userId ? `u:${userId}` : departmentId ? `d:${departmentId}` : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    members.push({ userId, departmentId, role: m.role === "VIEW" ? "VIEW" : "EDIT" });
  }
  if (audience === "CHOSEN" && members.length === 0) return { ok: false, error: "Choose at least one person or department — or let everyone see it." };
  try {
    await db.$transaction(async (tx) => {
      await tx.workbookAccess.upsert({ where: { workbookId }, create: { workbookId, audience, everyoneRole, rowRule, ownerPropertyId }, update: { audience, everyoneRole, rowRule, ownerPropertyId }, select: { workbookId: true } });
      await tx.workbookMember.deleteMany({ where: { workbookId } });
      if (members.length) await tx.workbookMember.createMany({ data: members.map((m) => ({ workbookId, ...m })) });
    });
  } catch {
    return { ok: false, error: NOT_YET };
  }
  await recordAudit({
    userId: opened.userId,
    action: "UPDATE",
    entityType: "Workbook",
    entityId: workbookId,
    entityLabel: `${opened.workbook.name}: open to ${audience === "CHOSEN" ? `${members.length} chosen` : `everyone (${everyoneRole === "VIEW" ? "view only" : "can fill in"})`}${rowRule === "OWN" ? "; each changes only their own rows" : ""}`,
  });
  return { ok: true, data: null };
}
