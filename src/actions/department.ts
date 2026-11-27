"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { createDepartmentSchema, updateDepartmentSchema } from "@/lib/validation/department";
import { CARD_WIDGETS } from "@/lib/dashboard/charts";
import type { ActionResult } from "@/actions/company";
import { ASSIGN_ROLES, type AssignRole } from "@/lib/companies/assign-roles";
import { notMigratedYet } from "@/lib/not-migrated";
import { recordAudit } from "@/lib/audit";
import { TEXT_MAX, tooMany } from "@/lib/validation/text";
import { PEOPLE_ONLY } from "@/lib/people";

/**
 * A department decides whose manager sees whom on TEAM reach, who may be given a company, and who answers tickets —
 * so creating, renaming, re-flagging and deleting one are logged (owner, 2 Nov 2026 — "Phase 1 security fixes",
 * audit M-9), like every other workspace setting. A side effect: it never fails the change it records.
 */
async function auditDepartment(userId: string, action: "CREATE" | "UPDATE" | "DELETE", id: string, entityLabel: string) {
  await recordAudit({ userId, action, entityType: "Department", entityId: id, entityLabel });
}

/**
 * Departments, for a filter or a form — the directory's, the employee form's, the fixed asset
 * register's. Here rather than with HR: every workspace has departments, whatever its plan.
 */
export async function listDepartmentOptions() {
  await requireUser();
  return db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
}

/** Active people who can be named as somebody's manager, or as an asset's custodian. */
export async function listManagerOptions() {
  await requireUser();
  return db.user.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

export async function listDepartments() {
  await requireUser();
  // `_count.members` is everybody, switched off or not — what decides whether it can be deleted; `people` is the team.
  const [departments, people] = await Promise.all([
    db.department.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { members: true } } },
    }),
    db.user.groupBy({ by: ["departmentId", "active"], where: { ...PEOPLE_ONLY, departmentId: { not: null } }, _count: { _all: true } }),
  ]);
  const peopleIn = (id: string, active: boolean) => people.find((p) => p.departmentId === id && p.active === active)?._count._all ?? 0;
  // Who may be given a company, read by name — none ticked in a workspace not migrated yet (src/lib/companies/assign-teams.ts).
  const flags = new Map<string, { callerTeam: boolean; accountManagerTeam: boolean; renewalManagerTeam: boolean; leadOwnerTeam?: boolean }>();
  try {
    for (const d of await db.department.findMany({ select: { id: true, callerTeam: true, accountManagerTeam: true, renewalManagerTeam: true } })) flags.set(d.id, d);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  // The lead owner's tick, on its own: it came later (20261221600000).
  try {
    for (const d of await db.department.findMany({ where: { leadOwnerTeam: true }, select: { id: true } })) {
      const had = flags.get(d.id);
      if (had) flags.set(d.id, { ...had, leadOwnerTeam: true });
    }
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return departments.map((d) => ({ ...d, callerTeam: false, accountManagerTeam: false, renewalManagerTeam: false, leadOwnerTeam: false, ...flags.get(d.id), id: d.id, people: { active: peopleIn(d.id, true), switchedOff: peopleIn(d.id, false) } }));
}

export async function createDepartment(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "users.manage"))) {
    return { ok: false, error: "You can't manage departments." };
  }
  const parsed = createDepartmentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const department = await db.department.create({ data: { name: parsed.data.name.trim() } });
    await auditDepartment(user.id, "CREATE", department.id, `Department ${department.name} created`);
    revalidatePath("/settings", "layout");
    return { ok: true, data: { id: department.id, name: department.name } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A department with this name already exists." };
    }
    throw err;
  }
}

export async function updateDepartment(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "users.manage"))) {
    return { ok: false, error: "You can't manage departments." };
  }
  const parsed = updateDepartmentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const before = await db.department.findUnique({ where: { id: parsed.data.id }, select: { name: true } });
    const department = await db.department.update({
      where: { id: parsed.data.id },
      data: { name: parsed.data.name.trim() },
    });
    await auditDepartment(user.id, "UPDATE", department.id, before && before.name !== department.name ? `Department ${before.name} renamed ${department.name}` : `Department ${department.name} saved`);
    revalidatePath("/settings", "layout");
    return { ok: true, data: { id: department.id, name: department.name } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A department with this name already exists." };
    }
    throw err;
  }
}

export async function setDepartmentSupportTeam(id: string, isSupportTeam: boolean): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "users.manage"))) {
    return { ok: false, error: "You can't manage departments." };
  }

  const department = await db.department.update({ where: { id }, data: { isSupportTeam }, select: { id: true, name: true } });
  await auditDepartment(user.id, "UPDATE", department.id, `Department ${department.name} ${isSupportTeam ? "made" : "no longer"} a support team`);
  revalidatePath("/settings", "layout");
  return { ok: true, data: null };
}

/** Whether this department's members may own a lead, or be a company's caller, account manager or renewal manager (src/lib/companies/assign-teams.ts). */
export async function setDepartmentAssignTeam(id: string, role: AssignRole, on: boolean): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "users.manage"))) {
    return { ok: false, error: "You can't manage departments." };
  }
  const spec = Object.hasOwn(ASSIGN_ROLES, role) ? ASSIGN_ROLES[role] : null;
  if (!spec) return { ok: false, error: "Choose what the department may be given." };
  let department: { id: string; name: string };
  try {
    department = await db.department.update({ where: { id }, data: { [spec.flag]: on === true }, select: { id: true, name: true } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace is still being updated — try again in a few minutes." };
    throw err;
  }
  await auditDepartment(user.id, "UPDATE", department.id, `Department ${department.name}: members ${on === true ? "may" : "may no longer"} be ${role === "leadOwner" ? "a lead's owner" : `given a company as ${spec.label.toLowerCase()}`}`);
  revalidatePath("/settings", "layout");
  return { ok: true, data: null };
}

export async function setDepartmentDashboardWidgets(id: string, widgetKeys: string[]): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "users.manage"))) {
    return { ok: false, error: "You can't manage departments." };
  }
  // Security audit, 13 Nov 2026 (SEC-30 follow-up): a raw list is held to a count and each entry to a short string.
  if (!Array.isArray(widgetKeys) || widgetKeys.some((k) => typeof k !== "string" || k.length > TEXT_MAX.id)) return { ok: false, error: "That list isn't valid." };
  if (widgetKeys.length > 200) return { ok: false, error: tooMany(200, "widgets") };
  // The widgets a layout can name, kept by their older card's key (src/lib/dashboard/charts.ts CARD_WIDGETS).
  const validKeys = new Set(Object.keys(CARD_WIDGETS));
  const filtered = widgetKeys.filter((k) => validKeys.has(k));

  const department = await db.department.update({ where: { id }, data: { defaultDashboardWidgets: filtered }, select: { id: true, name: true } });
  await auditDepartment(user.id, "UPDATE", department.id, `Department ${department.name}: default dashboard set to ${filtered.length} widget(s)`);
  revalidatePath("/settings", "layout");
  return { ok: true, data: null };
}

export async function deleteDepartment(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "users.manage"))) {
    return { ok: false, error: "You can't manage departments." };
  }

  const department = await db.department.delete({ where: { id }, select: { id: true, name: true } });
  await auditDepartment(user.id, "DELETE", department.id, `Department ${department.name} deleted`);
  revalidatePath("/settings", "layout");
  return { ok: true, data: null };
}
