"use server";

import { revalidatePath } from "next/cache";
import type { GoalStatus, PerformanceReviewStatus, ReviewCycleStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { toPlain } from "@/lib/serialize";
import { PEOPLE_ONLY } from "@/lib/people";
import { peopleHolding } from "@/lib/orders/handoff";
import { cycleProblem, goalProblem, goalScore, isRating, weightNote } from "@/lib/hr/review-rules";
import type { ActionResult } from "@/actions/company";

/**
 * Goals and performance reviews (owner, 31 Oct 2026: Deskzo People as a complete HRMS — Kredily's Performance).
 *
 * HR (`hr.manage`) opens a review cycle for a period, taking in everybody working — or one department's people — and
 * each gets a review, with the person they report to as its reviewer. The employee and their manager set the goals,
 * weighted if they like; the employee rates themselves (each goal and overall, 1–5) and sends it; their reviewer —
 * or anybody above them, or HR — rates them and so completes it, and the employee sees it and acknowledges. A reviewer
 * may go ahead without a self-assessment that never came. HR closes the cycle, and nothing in it changes after.
 * Nobody reviews themselves.
 */

const DAY_ISO = /^\d{4}-\d{2}-\d{2}$/;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const PAGE = "/people/reviews";
const reviewHref = (id: string) => `${PAGE}/${id}`;

async function isHr(userId: string) {
  return hasEffectivePermission(userId, "hr.manage");
}

/** Whether `actorId` may rate `review`: its reviewer, anybody the person reports to at any level, or HR — never their own. */
async function mayReview(actorId: string, review: { userId: string; reviewerId: string | null }): Promise<boolean> {
  if (actorId === review.userId) return false;
  if (actorId === review.reviewerId) return true;
  if (await isHr(actorId)) return true;
  return (await getDownlineUserIds(actorId)).includes(review.userId);
}

// ─── Cycles (HR) ──────────────────────────────────────────────────────────────

export type CycleRow = {
  id: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  selfDueOn: string | null;
  managerDueOn: string | null;
  status: ReviewCycleStatus;
  people: number;
  completed: number;
  selfSent: number;
};

async function cycleRows(where: { id?: string } = {}): Promise<CycleRow[]> {
  const cycles = await db.reviewCycle.findMany({
    where,
    orderBy: [{ status: "asc" }, { periodEnd: "desc" }],
    select: { id: true, name: true, periodStart: true, periodEnd: true, selfDueOn: true, managerDueOn: true, status: true, reviews: { select: { status: true } } },
  });
  return cycles.map((c) => ({
    id: c.id,
    name: c.name,
    periodStart: iso(c.periodStart)!,
    periodEnd: iso(c.periodEnd)!,
    selfDueOn: iso(c.selfDueOn),
    managerDueOn: iso(c.managerDueOn),
    status: c.status,
    people: c.reviews.length,
    completed: c.reviews.filter((r) => r.status === "COMPLETED").length,
    selfSent: c.reviews.filter((r) => r.status !== "AWAITING_SELF").length,
  }));
}

/** Everybody a cycle takes in: working, a person (not a portal login), in the department if one is chosen. */
async function participants(departmentId: string | null) {
  return db.user.findMany({
    where: {
      ...PEOPLE_ONLY,
      active: true,
      ...(departmentId ? { departmentId } : {}),
      OR: [{ employeeProfile: { is: null } }, { employeeProfile: { exitedOn: null } }],
    },
    select: { id: true, managerId: true },
  });
}

async function takeIn(cycleId: string, cycleName: string, departmentId: string | null): Promise<number> {
  const [people, already] = await Promise.all([participants(departmentId), db.performanceReview.findMany({ where: { cycleId }, select: { userId: true } })]);
  const have = new Set(already.map((r) => r.userId));
  const fresh = people.filter((p) => !have.has(p.id));
  if (fresh.length === 0) return 0;
  await db.performanceReview.createMany({ data: fresh.map((p) => ({ cycleId, userId: p.id, reviewerId: p.managerId })), skipDuplicates: true });
  const made = await db.performanceReview.findMany({ where: { cycleId, userId: { in: fresh.map((p) => p.id) } }, select: { id: true, userId: true } });
  for (const r of made) {
    await notifyUser({ userId: r.userId, type: "REVIEW_STARTED", title: `${cycleName} has started`, message: "Set your goals for it with your manager.", link: reviewHref(r.id) });
  }
  return made.length;
}

export async function createReviewCycle(input: { name: string; periodStart: string; periodEnd: string; selfDueOn?: string; managerDueOn?: string; departmentId?: string }): Promise<ActionResult<{ id: string; people: number }>> {
  const user = await requireModuleAccess("hr");
  if (!(await isHr(user.id))) return { ok: false, error: "Only HR can start a review cycle." };
  const name = String(input?.name ?? "").trim();
  if (name.length < 3 || name.length > 120) return { ok: false, error: "Name the cycle — for example “Annual review 2026–27”." };
  if (!DAY_ISO.test(String(input.periodStart)) || !DAY_ISO.test(String(input.periodEnd))) return { ok: false, error: "Choose the period's first and last day." };
  const selfDue = input.selfDueOn && DAY_ISO.test(input.selfDueOn) ? day(input.selfDueOn) : null;
  const managerDue = input.managerDueOn && DAY_ISO.test(input.managerDueOn) ? day(input.managerDueOn) : null;
  const problem = cycleProblem(day(input.periodStart), day(input.periodEnd), selfDue, managerDue);
  if (problem) return { ok: false, error: problem };
  const departmentId = input.departmentId ? String(input.departmentId) : null;

  const cycle = await db.reviewCycle.create({
    data: { name, periodStart: day(input.periodStart), periodEnd: day(input.periodEnd), selfDueOn: selfDue, managerDueOn: managerDue, createdById: user.id },
    select: { id: true },
  });
  const people = await takeIn(cycle.id, name, departmentId);
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "ReviewCycle", entityId: cycle.id, entityLabel: `Review cycle “${name}” started for ${people} people` });
  revalidatePath(PAGE);
  return { ok: true, data: { id: cycle.id, people } };
}

/** Takes into an open cycle anybody working who isn't in it yet — somebody who joined after it started. */
export async function addPeopleToCycle(cycleId: string, departmentId?: string): Promise<ActionResult<{ added: number }>> {
  const user = await requireModuleAccess("hr");
  if (!(await isHr(user.id))) return { ok: false, error: "Only HR can change a review cycle." };
  const cycle = await db.reviewCycle.findUnique({ where: { id: String(cycleId ?? "") }, select: { id: true, name: true, status: true } });
  if (!cycle) return { ok: false, error: "That cycle no longer exists." };
  if (cycle.status !== "OPEN") return { ok: false, error: "The cycle is closed." };
  const added = await takeIn(cycle.id, cycle.name, departmentId ? String(departmentId) : null);
  if (added > 0) await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ReviewCycle", entityId: cycle.id, entityLabel: `${added} people added to “${cycle.name}”` });
  revalidatePath(PAGE);
  revalidatePath(`${PAGE}/cycles/${cycle.id}`);
  return { ok: true, data: { added } };
}

export async function setReviewCycleStatus(cycleId: string, status: ReviewCycleStatus): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  if (!(await isHr(user.id))) return { ok: false, error: "Only HR can close or reopen a review cycle." };
  if (status !== "OPEN" && status !== "CLOSED") return { ok: false, error: "Open or closed." };
  const cycle = await db.reviewCycle.findUnique({ where: { id: String(cycleId ?? "") }, select: { id: true, name: true } });
  if (!cycle) return { ok: false, error: "That cycle no longer exists." };
  await db.reviewCycle.update({ where: { id: cycle.id }, data: { status, closedAt: status === "CLOSED" ? new Date() : null } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ReviewCycle", entityId: cycle.id, entityLabel: `Review cycle “${cycle.name}” ${status === "CLOSED" ? "closed" : "reopened"}` });
  revalidatePath(PAGE);
  revalidatePath(`${PAGE}/cycles/${cycle.id}`);
  return { ok: true, data: null };
}

export type CyclePersonRow = {
  reviewId: string;
  name: string;
  department: string | null;
  reviewer: string | null;
  status: PerformanceReviewStatus;
  goals: number;
  selfRating: number | null;
  managerRating: number | null;
  goalScore: number | null;
  acknowledged: boolean;
};

/** A cycle's every review, for HR. Null for anybody else. */
export async function reviewCycle(cycleId: string): Promise<{ cycle: CycleRow; rows: CyclePersonRow[] } | null> {
  const user = await requireModuleAccess("hr");
  if (!(await isHr(user.id))) return null;
  const [cycle] = await cycleRows({ id: String(cycleId ?? "") });
  if (!cycle) return null;
  const reviews = await db.performanceReview.findMany({
    where: { cycleId: cycle.id },
    orderBy: { user: { name: "asc" } },
    select: {
      id: true,
      userId: true,
      status: true,
      selfRating: true,
      managerRating: true,
      acknowledgedAt: true,
      user: { select: { name: true, department: { select: { name: true } } } },
      reviewer: { select: { name: true } },
    },
  });
  const goals = await db.goal.findMany({ where: { cycleId: cycle.id }, select: { userId: true, weight: true, status: true, managerRating: true } });
  const rows = reviews.map((r) => {
    const mine = goals.filter((g) => g.userId === r.userId);
    return {
      reviewId: r.id,
      name: r.user.name,
      department: r.user.department?.name ?? null,
      reviewer: r.reviewer?.name ?? null,
      status: r.status,
      goals: mine.filter((g) => g.status !== "DROPPED").length,
      selfRating: r.selfRating,
      managerRating: r.managerRating,
      goalScore: goalScore(mine.map((g) => ({ weight: g.weight, status: g.status, rating: g.managerRating }))),
      acknowledged: !!r.acknowledgedAt,
    };
  });
  return toPlain({ cycle, rows });
}

// ─── The page ─────────────────────────────────────────────────────────────────

export type ReviewListRow = { id: string; cycle: string; cycleStatus: ReviewCycleStatus; periodEnd: string; dueOn: string | null; name: string; status: PerformanceReviewStatus; managerRating: number | null; acknowledged: boolean };

const listSelect = {
  id: true,
  status: true,
  managerRating: true,
  acknowledgedAt: true,
  user: { select: { name: true } },
  cycle: { select: { name: true, status: true, periodEnd: true, selfDueOn: true, managerDueOn: true } },
} as const;
type ListRow = { id: string; status: PerformanceReviewStatus; managerRating: number | null; acknowledgedAt: Date | null; user: { name: string }; cycle: { name: string; status: ReviewCycleStatus; periodEnd: Date; selfDueOn: Date | null; managerDueOn: Date | null } };
const listRow = (r: ListRow): ReviewListRow => ({
  id: r.id,
  cycle: r.cycle.name,
  cycleStatus: r.cycle.status,
  periodEnd: iso(r.cycle.periodEnd)!,
  dueOn: iso(r.status === "AWAITING_SELF" ? r.cycle.selfDueOn : r.status === "AWAITING_MANAGER" ? r.cycle.managerDueOn : null),
  name: r.user.name,
  status: r.status,
  managerRating: r.managerRating,
  acknowledged: !!r.acknowledgedAt,
});

/** People › Goals & reviews: my own reviews, the ones waiting on me, and — for HR — the cycles. */
export async function reviewsHome(): Promise<{ mine: ReviewListRow[]; toReview: ReviewListRow[]; hr: boolean; cycles: CycleRow[]; departments: { id: string; name: string }[] }> {
  const user = await requireModuleAccess("hr");
  const hr = await isHr(user.id);
  const downline = hr ? [] : await getDownlineUserIds(user.id);
  const [mine, toReview, cycles, departments] = await Promise.all([
    db.performanceReview.findMany({ where: { userId: user.id }, orderBy: { cycle: { periodEnd: "desc" } }, select: listSelect }),
    db.performanceReview.findMany({
      where: {
        userId: { not: user.id },
        status: { not: "COMPLETED" },
        cycle: { status: "OPEN" },
        // Their reviewer, anybody above them; HR sees the cycles' own pages for everyone, and here only those it is reviewer of.
        OR: [{ reviewerId: user.id }, ...(downline.length ? [{ userId: { in: downline } }] : [])],
      },
      orderBy: [{ status: "desc" }, { user: { name: "asc" } }],
      select: listSelect,
    }),
    hr ? cycleRows() : Promise.resolve([]),
    hr ? db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  return toPlain({ mine: mine.map(listRow), toReview: toReview.map(listRow), hr, cycles, departments });
}

// ─── One review ───────────────────────────────────────────────────────────────

export type GoalView = { id: string; title: string; details: string | null; weight: number; progress: number; status: GoalStatus; selfRating: number | null; managerRating: number | null; setBy: string | null };

export type ReviewView = {
  id: string;
  cycle: { id: string; name: string; periodStart: string; periodEnd: string; selfDueOn: string | null; managerDueOn: string | null; status: ReviewCycleStatus };
  person: { id: string; name: string };
  reviewer: { id: string; name: string } | null;
  reviewedBy: { id: string; name: string } | null;
  status: PerformanceReviewStatus;
  self: { rating: number | null; comments: string | null; submittedAt: Date | null } | null;
  manager: { rating: number | null; comments: string | null; submittedAt: Date | null } | null;
  acknowledgedAt: Date | null;
  goals: GoalView[];
  selfScore: number | null;
  managerScore: number | null;
  weightNote: string | null;
  can: { editGoals: boolean; self: boolean; review: boolean; acknowledge: boolean };
  viewer: "self" | "reviewer";
};

/** One review — to the person, and to whoever may review them. Null for anybody else. */
export async function getReview(id: string): Promise<ReviewView | null> {
  const user = await requireModuleAccess("hr");
  const r = await db.performanceReview.findUnique({
    where: { id: String(id ?? "") },
    select: {
      id: true,
      userId: true,
      reviewerId: true,
      status: true,
      selfRating: true,
      selfComments: true,
      selfSubmittedAt: true,
      managerRating: true,
      managerComments: true,
      managerSubmittedAt: true,
      acknowledgedAt: true,
      user: { select: { id: true, name: true } },
      reviewer: { select: { id: true, name: true } },
      reviewedBy: { select: { id: true, name: true } },
      cycle: { select: { id: true, name: true, periodStart: true, periodEnd: true, selfDueOn: true, managerDueOn: true, status: true } },
    },
  });
  if (!r) return null;
  const isSelf = r.userId === user.id;
  const reviewer = !isSelf && (await mayReview(user.id, r));
  if (!isSelf && !reviewer) return null;

  const goals = await db.goal.findMany({
    where: { cycleId: r.cycle.id, userId: r.userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, details: true, weight: true, progress: true, status: true, selfRating: true, managerRating: true, setBy: { select: { name: true } } },
  });
  const open = r.cycle.status === "OPEN";
  const done = r.status === "COMPLETED";
  // The reviewer sees the self-assessment once sent; the person sees the reviewer's rating once completed.
  const showSelf = isSelf || r.status !== "AWAITING_SELF";
  const showManager = !isSelf || done;
  return toPlain({
    id: r.id,
    cycle: { id: r.cycle.id, name: r.cycle.name, periodStart: iso(r.cycle.periodStart)!, periodEnd: iso(r.cycle.periodEnd)!, selfDueOn: iso(r.cycle.selfDueOn), managerDueOn: iso(r.cycle.managerDueOn), status: r.cycle.status },
    person: r.user,
    reviewer: r.reviewer,
    reviewedBy: r.reviewedBy,
    status: r.status,
    self: showSelf ? { rating: r.selfRating, comments: r.selfComments, submittedAt: r.selfSubmittedAt } : null,
    manager: showManager ? { rating: r.managerRating, comments: r.managerComments, submittedAt: r.managerSubmittedAt } : null,
    acknowledgedAt: r.acknowledgedAt,
    goals: goals.map((g) => ({
      id: g.id,
      title: g.title,
      details: g.details,
      weight: g.weight,
      progress: g.progress,
      status: g.status,
      selfRating: showSelf ? g.selfRating : null,
      managerRating: showManager ? g.managerRating : null,
      setBy: g.setBy?.name ?? null,
    })),
    selfScore: showSelf ? goalScore(goals.map((g) => ({ weight: g.weight, status: g.status, rating: g.selfRating }))) : null,
    managerScore: showManager ? goalScore(goals.map((g) => ({ weight: g.weight, status: g.status, rating: g.managerRating }))) : null,
    weightNote: weightNote(goals),
    can: {
      editGoals: open && !done && (isSelf ? r.status === "AWAITING_SELF" : true),
      self: open && isSelf && r.status === "AWAITING_SELF",
      review: open && reviewer && !done,
      acknowledge: isSelf && done && !r.acknowledgedAt,
    },
    viewer: isSelf ? "self" : "reviewer",
  });
}

/** The review a goal change is for, and whether this person may make it now. */
async function goalGate(actorId: string, reviewId: string): Promise<{ ok: true; review: { id: string; userId: string; cycleId: string } } | { ok: false; error: string }> {
  const r = await db.performanceReview.findUnique({ where: { id: reviewId }, select: { id: true, userId: true, reviewerId: true, cycleId: true, status: true, cycle: { select: { status: true } } } });
  if (!r) return { ok: false, error: "That review no longer exists." };
  if (r.cycle.status !== "OPEN") return { ok: false, error: "The review cycle is closed." };
  if (r.status === "COMPLETED") return { ok: false, error: "The review is complete — its goals are as they were rated." };
  if (r.userId === actorId) {
    if (r.status !== "AWAITING_SELF") return { ok: false, error: "You've sent your self-assessment — ask your manager to change a goal." };
  } else if (!(await mayReview(actorId, r))) {
    return { ok: false, error: "Only they, their manager or HR can change their goals." };
  }
  return { ok: true, review: r };
}

export async function saveGoal(input: { id?: string; reviewId: string; title: string; details?: string; weight?: number; progress?: number; status?: GoalStatus }): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleAccess("hr");
  const gate = await goalGate(user.id, String(input?.reviewId ?? ""));
  if (!gate.ok) return gate;
  const title = String(input.title ?? "").trim();
  const details = String(input.details ?? "").trim() || null;
  const weight = Number(input.weight ?? 0);
  const progress = Number(input.progress ?? 0);
  const status: GoalStatus = input.status === "ACHIEVED" || input.status === "DROPPED" ? input.status : "ACTIVE";
  const problem = goalProblem({ title, weight, progress });
  if (problem) return { ok: false, error: problem };
  if (details && details.length > 2000) return { ok: false, error: "Keep the details under 2,000 characters." };
  const data = { title, details, weight, progress, status };

  let id: string;
  if (input.id) {
    const g = await db.goal.findUnique({ where: { id: String(input.id) }, select: { userId: true, cycleId: true } });
    if (!g || g.userId !== gate.review.userId || g.cycleId !== gate.review.cycleId) return { ok: false, error: "That goal isn't on this review." };
    await db.goal.update({ where: { id: String(input.id) }, data });
    id = String(input.id);
  } else {
    const made = await db.goal.create({ data: { ...data, cycleId: gate.review.cycleId, userId: gate.review.userId, setById: user.id }, select: { id: true } });
    id = made.id;
  }
  revalidatePath(reviewHref(gate.review.id));
  return { ok: true, data: { id } };
}

export async function deleteGoal(input: { id: string; reviewId: string }): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  const gate = await goalGate(user.id, String(input?.reviewId ?? ""));
  if (!gate.ok) return gate;
  const g = await db.goal.findUnique({ where: { id: String(input.id ?? "") }, select: { userId: true, cycleId: true } });
  if (!g || g.userId !== gate.review.userId || g.cycleId !== gate.review.cycleId) return { ok: false, error: "That goal isn't on this review." };
  await db.goal.delete({ where: { id: String(input.id) } });
  revalidatePath(reviewHref(gate.review.id));
  return { ok: true, data: null };
}

type Assessment = { reviewId: string; rating: number; comments: string; goalRatings: Record<string, number> };

/** The ratings given each goal, checked against the review's own live goals: every one rated, 1–5. */
async function goalRatingsFor(cycleId: string, userId: string, given: Record<string, number>): Promise<{ ok: true; ratings: [string, number][] } | { ok: false; error: string }> {
  const goals = await db.goal.findMany({ where: { cycleId, userId, status: { not: "DROPPED" } }, select: { id: true, title: true } });
  const ratings: [string, number][] = [];
  for (const g of goals) {
    const r = Number(given?.[g.id]);
    if (!isRating(r)) return { ok: false, error: `Rate “${g.title}” from 1 to 5.` };
    ratings.push([g.id, r]);
  }
  return { ok: true, ratings };
}

export async function submitSelfAssessment(input: Assessment): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  const r = await db.performanceReview.findUnique({ where: { id: String(input?.reviewId ?? "") }, select: { id: true, userId: true, reviewerId: true, cycleId: true, status: true, cycle: { select: { name: true, status: true } }, user: { select: { name: true } } } });
  if (!r || r.userId !== user.id) return { ok: false, error: "That review isn't yours." };
  if (r.cycle.status !== "OPEN") return { ok: false, error: "The review cycle is closed." };
  if (r.status !== "AWAITING_SELF") return { ok: false, error: "You've sent it already." };
  if (!isRating(Number(input.rating))) return { ok: false, error: "Rate yourself overall, 1 to 5." };
  const comments = String(input.comments ?? "").trim();
  if (comments.length < 3) return { ok: false, error: "Say a few words on how the period went." };
  if (comments.length > 5000) return { ok: false, error: "Keep it under 5,000 characters." };
  const rated = await goalRatingsFor(r.cycleId, r.userId, input.goalRatings);
  if (!rated.ok) return rated;

  await db.$transaction(async (tx) => {
    for (const [id, rating] of rated.ratings) await tx.goal.update({ where: { id }, data: { selfRating: rating } });
    await tx.performanceReview.update({ where: { id: r.id }, data: { status: "AWAITING_MANAGER", selfRating: Number(input.rating), selfComments: comments, selfSubmittedAt: new Date() } });
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "PerformanceReview", entityId: r.id, entityLabel: `${r.user.name} sent their self-assessment for “${r.cycle.name}”` });
  // Their reviewer — or, with nobody to report to, HR.
  const tell = r.reviewerId ? [r.reviewerId] : await peopleHolding("hr.manage", [user.id]);
  for (const id of tell) {
    await notifyUser({ userId: id, type: "REVIEW_SELF_SUBMITTED", title: `${r.user.name} has sent their self-assessment`, message: `${r.cycle.name} — your turn to rate them.`, link: reviewHref(r.id) });
  }
  revalidatePath(PAGE);
  revalidatePath(reviewHref(r.id));
  return { ok: true, data: null };
}

export async function submitManagerReview(input: Assessment): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  const r = await db.performanceReview.findUnique({ where: { id: String(input?.reviewId ?? "") }, select: { id: true, userId: true, reviewerId: true, cycleId: true, status: true, cycle: { select: { name: true, status: true } }, user: { select: { name: true } } } });
  if (!r) return { ok: false, error: "That review no longer exists." };
  if (!(await mayReview(user.id, r))) return { ok: false, error: "Only their manager, somebody above them, or HR can rate them — and never yourself." };
  if (r.cycle.status !== "OPEN") return { ok: false, error: "The review cycle is closed." };
  if (r.status === "COMPLETED") return { ok: false, error: "The review is complete already." };
  if (!isRating(Number(input.rating))) return { ok: false, error: "Give an overall rating, 1 to 5." };
  const comments = String(input.comments ?? "").trim();
  if (comments.length < 3) return { ok: false, error: "Say a few words they'll read with the rating." };
  if (comments.length > 5000) return { ok: false, error: "Keep it under 5,000 characters." };
  const rated = await goalRatingsFor(r.cycleId, r.userId, input.goalRatings);
  if (!rated.ok) return rated;

  await db.$transaction(async (tx) => {
    for (const [id, rating] of rated.ratings) await tx.goal.update({ where: { id }, data: { managerRating: rating } });
    await tx.performanceReview.update({ where: { id: r.id }, data: { status: "COMPLETED", managerRating: Number(input.rating), managerComments: comments, managerSubmittedAt: new Date(), reviewedById: user.id } });
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "PerformanceReview", entityId: r.id, entityLabel: `${r.user.name}'s review for “${r.cycle.name}” completed` });
  await notifyUser({ userId: r.userId, type: "REVIEW_COMPLETED", title: "Your review is ready", message: `${r.cycle.name} — read it and acknowledge it.`, link: reviewHref(r.id) });
  revalidatePath(PAGE);
  revalidatePath(reviewHref(r.id));
  return { ok: true, data: null };
}

export async function acknowledgeReview(reviewId: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  const r = await db.performanceReview.findUnique({ where: { id: String(reviewId ?? "") }, select: { id: true, userId: true, status: true, acknowledgedAt: true } });
  if (!r || r.userId !== user.id) return { ok: false, error: "That review isn't yours." };
  if (r.status !== "COMPLETED") return { ok: false, error: "It isn't complete yet." };
  if (!r.acknowledgedAt) await db.performanceReview.update({ where: { id: r.id }, data: { acknowledgedAt: new Date() } });
  revalidatePath(PAGE);
  revalidatePath(reviewHref(r.id));
  return { ok: true, data: null };
}
