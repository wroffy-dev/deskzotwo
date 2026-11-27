"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { toPlain } from "@/lib/serialize";
import { PEOPLE_ONLY } from "@/lib/people";
import { workspaceClock } from "@/lib/time/workspace";
import { dateOnly, toKey } from "@/lib/hr/calendar";
import { formatCalendarDay } from "@/lib/time/zone";
import type { ActionResult } from "@/actions/company";

/**
 * Learning (owner, 31 Oct 2026: Deskzo People as a complete HRMS — Kredily's Learning).
 *
 * HR (`hr.manage`) keeps the courses — a title, what it covers, a link to the material, how long it takes — and gives
 * them to people, a department or everybody, with a day to finish by. A manager may give one to their own team. Each
 * person sees what they've been given and marks it done, with a line on what they took from it; HR and managers see
 * who has finished, and who is late.
 */

const DAY_ISO = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = "/people/learning";

export type CourseRow = {
  id: string;
  title: string;
  description: string | null;
  link: string | null;
  durationMinutes: number | null;
  archived: boolean;
  assigned: number;
  completed: number;
  overdue: number;
};
export type MyCourse = { assignmentId: string; courseId: string; title: string; description: string | null; link: string | null; durationMinutes: number | null; dueOn: string | null; completedAt: Date | null; note: string | null; overdue: boolean };
export type CourseLearner = { assignmentId: string; name: string; dueOn: string | null; completedAt: Date | null; note: string | null; overdue: boolean };

/** Somebody's own, or — for HR or their manager — theirs to see and to give courses to. */
async function scopeOf(userId: string): Promise<{ hr: boolean; team: string[] | null }> {
  if (await hasEffectivePermission(userId, "hr.manage")) return { hr: true, team: null };
  return { hr: false, team: await getDownlineUserIds(userId) };
}

/** People › Learning: what I've been given; the courses — every one for HR, those given my team for a manager. */
export async function learningPage(): Promise<{ hr: boolean; manages: boolean; mine: MyCourse[]; courses: CourseRow[]; departments: { id: string; name: string }[]; people: { id: string; name: string }[] }> {
  const user = await requireModuleAccess("hr");
  const { hr, team } = await scopeOf(user.id);
  const today = toKey((await workspaceClock()).calendarDate(new Date()));
  const late = (dueOn: Date | null, completedAt: Date | null) => !completedAt && !!dueOn && toKey(dueOn) < today;

  const mine = await db.courseAssignment.findMany({
    where: { userId: user.id, course: { archived: false } },
    orderBy: [{ completedAt: { sort: "asc", nulls: "first" } }, { dueOn: { sort: "asc", nulls: "last" } }],
    select: { id: true, dueOn: true, completedAt: true, note: true, course: { select: { id: true, title: true, description: true, link: true, durationMinutes: true } } },
  });
  const manages = hr || (team?.length ?? 0) > 0;
  const seen = hr ? undefined : { in: team ?? [] };
  const courses = manages
    ? await db.course.findMany({
        where: hr ? {} : { archived: false },
        orderBy: [{ archived: "asc" }, { createdAt: "desc" }],
        select: { id: true, title: true, description: true, link: true, durationMinutes: true, archived: true, assignments: { where: seen ? { userId: seen } : {}, select: { dueOn: true, completedAt: true } } },
      })
    : [];
  const [departments, people] = manages
    ? await Promise.all([
        hr ? db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
        db.user.findMany({
          where: { ...PEOPLE_ONLY, active: true, ...(hr ? {} : { id: { in: team ?? [] } }), OR: [{ employeeProfile: { is: null } }, { employeeProfile: { exitedOn: null } }] },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        }),
      ])
    : [[], []];

  return toPlain({
    hr,
    manages,
    mine: mine.map((a) => ({
      assignmentId: a.id,
      courseId: a.course.id,
      title: a.course.title,
      description: a.course.description,
      link: a.course.link,
      durationMinutes: a.course.durationMinutes,
      dueOn: a.dueOn ? toKey(a.dueOn) : null,
      completedAt: a.completedAt,
      note: a.note,
      overdue: late(a.dueOn, a.completedAt),
    })),
    // A manager sees only the courses their team has been given.
    courses: courses
      .filter((c) => hr || c.assignments.length > 0)
      .map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        link: c.link,
        durationMinutes: c.durationMinutes,
        archived: c.archived,
        assigned: c.assignments.length,
        completed: c.assignments.filter((a) => a.completedAt).length,
        overdue: c.assignments.filter((a) => late(a.dueOn, a.completedAt)).length,
      })),
    departments,
    people,
  });
}

/** Who has a course, and how they're getting on — everybody for HR, a manager's team. */
export async function courseLearners(courseId: string): Promise<CourseLearner[] | null> {
  const user = await requireModuleAccess("hr");
  const { hr, team } = await scopeOf(user.id);
  if (!hr && !team?.length) return null;
  const today = toKey((await workspaceClock()).calendarDate(new Date()));
  const rows = await db.courseAssignment.findMany({
    where: { courseId: String(courseId ?? ""), ...(hr ? {} : { userId: { in: team ?? [] } }) },
    orderBy: { user: { name: "asc" } },
    select: { id: true, dueOn: true, completedAt: true, note: true, user: { select: { name: true } } },
  });
  return toPlain(rows.map((r) => ({ assignmentId: r.id, name: r.user.name, dueOn: r.dueOn ? toKey(r.dueOn) : null, completedAt: r.completedAt, note: r.note, overdue: !r.completedAt && !!r.dueOn && toKey(r.dueOn) < today })));
}

const isLink = (s: string) => /^https?:\/\/[^\s]+$/i.test(s);

export async function saveCourse(input: { id?: string; title: string; description?: string; link?: string; durationMinutes?: number | null }): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleAccess("hr");
  if (!(await hasEffectivePermission(user.id, "hr.manage"))) return { ok: false, error: "Only HR can set up courses." };
  const title = String(input?.title ?? "").trim();
  if (title.length < 3 || title.length > 150) return { ok: false, error: "Give the course a title." };
  const link = String(input.link ?? "").trim();
  if (link && !isLink(link)) return { ok: false, error: "The link starts with https:// — a video, a document, a page." };
  const minutes = input.durationMinutes === null || input.durationMinutes === undefined || String(input.durationMinutes) === "" ? null : Number(input.durationMinutes);
  if (minutes !== null && (!Number.isInteger(minutes) || minutes <= 0 || minutes > 100 * 60)) return { ok: false, error: "How long it takes, in whole minutes." };
  const data = { title, description: String(input.description ?? "").trim() || null, link: link || null, durationMinutes: minutes };
  const saved = input.id ? await db.course.update({ where: { id: String(input.id) }, data, select: { id: true } }) : await db.course.create({ data: { ...data, createdById: user.id }, select: { id: true } });
  await recordAudit({ userId: user.id, action: input.id ? "UPDATE" : "CREATE", entityType: "Course", entityId: saved.id, entityLabel: `Course ${title}` });
  revalidatePath(PAGE);
  return { ok: true, data: { id: saved.id } };
}

export async function archiveCourse(id: string, archived: boolean): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  if (!(await hasEffectivePermission(user.id, "hr.manage"))) return { ok: false, error: "Only HR can change courses." };
  const c = await db.course.findUnique({ where: { id: String(id ?? "") }, select: { id: true, title: true } });
  if (!c) return { ok: false, error: "That course no longer exists." };
  await db.course.update({ where: { id: c.id }, data: { archived: !!archived } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Course", entityId: c.id, entityLabel: `Course ${c.title} ${archived ? "archived" : "brought back"}` });
  revalidatePath(PAGE);
  return { ok: true, data: null };
}

/**
 * Gives a course to the people chosen, a department, or everybody working (HR), or to people in one's own team (a
 * manager). Those who have it already keep it as it is; the rest are told.
 */
export async function assignCourse(input: { courseId: string; userIds?: string[]; departmentId?: string; everyone?: boolean; dueOn?: string }): Promise<ActionResult<{ assigned: number }>> {
  const user = await requireModuleAccess("hr");
  const { hr, team } = await scopeOf(user.id);
  if (!hr && !team?.length) return { ok: false, error: "Only HR, or a manager for their team, can give a course." };
  const course = await db.course.findUnique({ where: { id: String(input?.courseId ?? "") }, select: { id: true, title: true, archived: true } });
  if (!course || course.archived) return { ok: false, error: "Choose a course in use." };
  const dueOn = input.dueOn ? (DAY_ISO.test(input.dueOn) ? dateOnly(input.dueOn) : undefined) : null;
  if (dueOn === undefined) return { ok: false, error: "The day to finish by isn't a date." };
  if ((input.everyone || input.departmentId) && !hr) return { ok: false, error: "Only HR gives a course to a department or everybody." };

  const working = { ...PEOPLE_ONLY, active: true, OR: [{ employeeProfile: { is: null } }, { employeeProfile: { exitedOn: null } }] };
  const ids = input.everyone || input.departmentId
    ? (await db.user.findMany({ where: { ...working, ...(input.departmentId ? { departmentId: String(input.departmentId) } : {}) }, select: { id: true } })).map((u) => u.id)
    : [...new Set((input.userIds ?? []).map(String))];
  if (ids.length === 0) return { ok: false, error: "Choose who takes the course." };
  if (!hr && ids.some((id) => !team!.includes(id))) return { ok: false, error: "You can give a course only to people in your team." };
  if ((await db.user.count({ where: { id: { in: ids }, ...PEOPLE_ONLY } })) !== ids.length) return { ok: false, error: "Somebody chosen isn't one of your people." };

  const had = new Set((await db.courseAssignment.findMany({ where: { courseId: course.id, userId: { in: ids } }, select: { userId: true } })).map((a) => a.userId));
  const fresh = ids.filter((id) => !had.has(id));
  if (fresh.length > 0) {
    await db.courseAssignment.createMany({ data: fresh.map((userId) => ({ courseId: course.id, userId, dueOn, assignedById: user.id })), skipDuplicates: true });
    for (const userId of fresh) {
      if (userId === user.id) continue;
      await notifyUser({ userId, type: "COURSE_ASSIGNED", title: `New course: ${course.title}`, message: dueOn ? `Finish it by ${formatCalendarDay(dueOn)}.` : "Take it when you can.", link: PAGE });
    }
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Course", entityId: course.id, entityLabel: `Course ${course.title} given to ${fresh.length} people` });
  revalidatePath(PAGE);
  return { ok: true, data: { assigned: fresh.length } };
}

/** Marks one's own course done, with a line on what they took from it. */
export async function completeCourse(input: { assignmentId: string; note?: string }): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  const a = await db.courseAssignment.findUnique({ where: { id: String(input?.assignmentId ?? "") }, select: { id: true, userId: true, completedAt: true, course: { select: { title: true } } } });
  if (!a || a.userId !== user.id) return { ok: false, error: "That course isn't yours." };
  if (a.completedAt) return { ok: false, error: "You've finished it already." };
  const note = String(input.note ?? "").trim() || null;
  if (note && note.length > 1000) return { ok: false, error: "Keep it under 1,000 characters." };
  await db.courseAssignment.update({ where: { id: a.id }, data: { completedAt: new Date(), note } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Course", entityId: a.id, entityLabel: `Finished the course ${a.course.title}` });
  revalidatePath(PAGE);
  return { ok: true, data: null };
}
