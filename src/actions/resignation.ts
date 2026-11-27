"use server";

import { revalidatePath } from "next/cache";
import type { ResignationStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { toPlain } from "@/lib/serialize";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { personPath } from "@/lib/record-links";
import { peopleHolding } from "@/lib/orders/handoff";
import { applyExit } from "@/lib/hr/exit";
import { refuseWhileViewingAs } from "@/lib/session";
import { lastDayForNotice, lastDayProblem, noticeShortfall } from "@/lib/hr/resignation-rules";
import type { ActionResult } from "@/actions/company";
import { clipOrNull, TEXT_MAX } from "@/lib/text/bounded";

/**
 * Resignations (owner, 31 Oct 2026: Deskzo People as a complete HRMS — "apply for resignation", as Kredily's E-Exit).
 *
 * The employee hands it in from My HR, with a reason and the last working day they ask for — by default the day their
 * notice ends — and may withdraw it while it waits. Whoever they report to, at any level, or HR (`hr.manage`) accepts
 * it for a last working day, which records the exit exactly as HR recording it does (src/lib/hr/exit.ts: the profile,
 * the offboarding tasks — the login stays on until then), or turns it down with a reason. Never their own.
 */

const DAY_ISO = /^\d{4}-\d{2}-\d{2}$/;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

const select = {
  id: true,
  status: true,
  reason: true,
  submittedOn: true,
  noticeDays: true,
  requestedLastDay: true,
  acceptedLastDay: true,
  decidedAt: true,
  decisionNote: true,
  withdrawnAt: true,
  createdAt: true,
  decidedBy: { select: { id: true, name: true } },
  user: { select: { id: true, name: true, userSeq: true, managerId: true } },
} as const;

export type ResignationView = {
  id: string;
  status: ResignationStatus;
  reason: string;
  submittedOn: string;
  noticeDays: number;
  requestedLastDay: string;
  acceptedLastDay: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  decidedBy: { id: string; name: string } | null;
  person: { id: string; name: string; userSeq: number };
  /** Days of notice not served on the day asked for (or accepted). */
  shortfall: number;
};

type Row = { status: ResignationStatus; reason: string; submittedOn: Date; noticeDays: number; requestedLastDay: Date; acceptedLastDay: Date | null; decidedAt: Date | null; decisionNote: string | null; id: string; decidedBy: { id: string; name: string } | null; user: { id: string; name: string; userSeq: number } };
function view(r: Row): ResignationView {
  const last = r.acceptedLastDay ?? r.requestedLastDay;
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    submittedOn: iso(r.submittedOn),
    noticeDays: r.noticeDays,
    requestedLastDay: iso(r.requestedLastDay),
    acceptedLastDay: r.acceptedLastDay ? iso(r.acceptedLastDay) : null,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    decidedBy: r.decidedBy,
    person: { id: r.user.id, name: r.user.name, userSeq: r.user.userSeq },
    shortfall: noticeShortfall(r.submittedOn, r.noticeDays, last),
  };
}

/** Whether `deciderId` may accept or turn down `userId`'s resignation: HR, or anybody they report to — never their own. */
async function mayDecide(deciderId: string, userId: string): Promise<boolean> {
  if (deciderId === userId) return false;
  if (await hasEffectivePermission(deciderId, "hr.manage")) return true;
  return (await getDownlineUserIds(deciderId)).includes(userId);
}

/** My HR's card: my latest resignation, and what my notice would make the last working day if I handed one in today. */
export async function myResignation(): Promise<{ latest: ResignationView | null; noticeDays: number; today: string; suggestedLastDay: string; exited: boolean }> {
  const user = await requireModuleAccess("hr");
  const [latest, profile, clock] = await Promise.all([
    db.resignation.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, select }),
    db.employeeProfile.findUnique({ where: { userId: user.id }, select: { noticePeriodDays: true, exitedOn: true } }),
    workspaceClock(),
  ]);
  const today = clock.calendarDate(new Date());
  const noticeDays = profile?.noticePeriodDays ?? 30;
  return toPlain({ latest: latest ? view(latest) : null, noticeDays, today: iso(today), suggestedLastDay: iso(lastDayForNotice(today, noticeDays)), exited: !!profile?.exitedOn });
}

export async function submitResignation(input: { reason: string; lastDay: string }): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleAccess("hr");
  const reason = String(input?.reason ?? "").trim();
  if (reason.length < 3) return { ok: false, error: "Say why you're leaving — a line is enough." };
  if (reason.length > 2000) return { ok: false, error: "Keep the reason under 2,000 characters." };
  if (!DAY_ISO.test(String(input?.lastDay ?? ""))) return { ok: false, error: "Choose your last working day." };

  const [profile, waiting, clock] = await Promise.all([
    db.employeeProfile.findUnique({ where: { userId: user.id }, select: { noticePeriodDays: true, exitedOn: true } }),
    db.resignation.count({ where: { userId: user.id, status: "PENDING" } }),
    workspaceClock(),
  ]);
  if (profile?.exitedOn) return { ok: false, error: "Your exit is already recorded — HR has it in hand." };
  if (waiting > 0) return { ok: false, error: "You've already handed in a resignation — withdraw it first to change it." };
  const submittedOn = clock.calendarDate(new Date());
  const lastDay = day(input.lastDay);
  const problem = lastDayProblem(submittedOn, lastDay);
  if (problem) return { ok: false, error: problem };

  const created = await db.resignation.create({
    data: { userId: user.id, reason, submittedOn, noticeDays: profile?.noticePeriodDays ?? 30, requestedLastDay: lastDay },
    select: { id: true, user: { select: { name: true, userSeq: true, managerId: true } } },
  });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Resignation", entityId: created.id, entityLabel: `${created.user.name} resigned — last working day asked for ${input.lastDay}` });

  // Their manager, and HR — whoever can act on it.
  const tell = new Set<string>([...(created.user.managerId ? [created.user.managerId] : []), ...(await peopleHolding("hr.manage"))]);
  tell.delete(user.id);
  for (const id of tell) {
    await notifyUser({
      userId: id,
      type: "RESIGNATION_SUBMITTED",
      title: `${created.user.name} has resigned`,
      message: `Last working day asked for: ${formatCalendarDay(lastDay)}. Accept it or talk to them.`,
      link: personPath(created.user.userSeq),
    });
  }
  revalidatePath("/people/me");
  revalidatePath("/people");
  return { ok: true, data: { id: created.id } };
}

export async function withdrawResignation(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  const r = await db.resignation.findUnique({ where: { id: String(id ?? "") }, select: { userId: true, status: true, user: { select: { name: true } } } });
  if (!r || r.userId !== user.id) return { ok: false, error: "That resignation isn't yours." };
  if (r.status !== "PENDING") return { ok: false, error: "It has been decided already — talk to HR to undo it." };
  // SEC-31: not over an acceptance that landed in between.
  const claim = await db.resignation.updateMany({ where: { id, status: "PENDING" }, data: { status: "WITHDRAWN", withdrawnAt: new Date() } });
  if (claim.count === 0) return { ok: false, error: "It has been decided already — talk to HR to undo it." };
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Resignation", entityId: id, entityLabel: `${r.user.name} withdrew their resignation` });
  revalidatePath("/people/me");
  revalidatePath("/people");
  return { ok: true, data: null };
}

/** The resignations waiting for this person to decide — HR's every one, a manager's team's. */
export async function resignationsToDecide(): Promise<ResignationView[]> {
  const user = await requireModuleAccess("hr");
  const hr = await hasEffectivePermission(user.id, "hr.manage");
  const scope = hr ? { userId: { not: user.id } } : { userId: { in: await getDownlineUserIds(user.id) } };
  const rows = await db.resignation.findMany({ where: { status: "PENDING", ...scope }, orderBy: { submittedOn: "asc" }, select });
  return toPlain(rows.map(view));
}

/** A person's latest resignation, for their record — to them, and to whoever may decide it. */
export async function resignationFor(userId: string): Promise<{ resignation: ResignationView | null; canDecide: boolean }> {
  const user = await requireModuleAccess("hr");
  const canDecide = await mayDecide(user.id, userId);
  if (user.id !== userId && !canDecide) return { resignation: null, canDecide: false };
  const latest = await db.resignation.findFirst({ where: { userId }, orderBy: { createdAt: "desc" }, select });
  return toPlain({ resignation: latest ? view(latest) : null, canDecide });
}

export async function decideResignation(input: { id: string; accept: boolean; lastDay?: string; note?: string }): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  // Security audit, 11 Nov 2026 (SEC-19): "never your own" compared the borrowed person while viewing as somebody.
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const r = await db.resignation.findUnique({ where: { id: String(input?.id ?? "") }, select });
  if (!r) return { ok: false, error: "That resignation no longer exists." };
  if (!(await mayDecide(user.id, r.user.id))) return { ok: false, error: "Only their manager or HR can decide this — and never your own." };
  if (r.status !== "PENDING") return { ok: false, error: "It has been decided or withdrawn already." };
  // Typed text is capped before it is stored (owner, 15 Nov 2026 — input bounds).
  const note = clipOrNull(input.note, TEXT_MAX.paragraph);

  if (!input.accept) {
    if (!note) return { ok: false, error: "Say why it isn't accepted — they'll see it." };
    // SEC-31: decided only while still pending — two decisions at once land once.
    const claim = await db.resignation.updateMany({ where: { id: r.id, status: "PENDING" }, data: { status: "REJECTED", decidedById: user.id, decidedAt: new Date(), decisionNote: note } });
    if (claim.count === 0) return { ok: false, error: "It has been decided or withdrawn a moment ago." };
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Resignation", entityId: r.id, entityLabel: `${r.user.name}'s resignation not accepted` });
    await notifyUser({ userId: r.user.id, type: "RESIGNATION_DECIDED", title: "Your resignation wasn't accepted", message: note, link: "/people/me" });
  } else {
    const lastDayIso = input.lastDay && DAY_ISO.test(input.lastDay) ? input.lastDay : iso(r.requestedLastDay);
    const lastDay = day(lastDayIso);
    const problem = lastDayProblem(r.submittedOn, lastDay);
    if (problem) return { ok: false, error: problem };
    // SEC-31: claimed first, so two acceptances at once record the exit — and its offboarding tasks — once.
    const claim = await db.resignation.updateMany({ where: { id: r.id, status: "PENDING" }, data: { status: "ACCEPTED", acceptedLastDay: lastDay, decidedById: user.id, decidedAt: new Date(), decisionNote: note } });
    if (claim.count === 0) return { ok: false, error: "It has been decided or withdrawn a moment ago." };
    // The exit, as HR recording it does — the profile and the offboarding tasks. The login stays on until then.
    const written = await applyExit(user.id, { userId: r.user.id, exitedOn: lastDayIso, exitType: "RESIGNED", exitReason: r.reason, deactivateLogin: false });
    if (!written.ok) {
      // The exit was refused: the resignation waits again, as it did before anybody pressed.
      await db.resignation.updateMany({ where: { id: r.id, status: "ACCEPTED" }, data: { status: "PENDING", acceptedLastDay: null, decidedById: null, decidedAt: null, decisionNote: null } });
      return written;
    }
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Resignation", entityId: r.id, entityLabel: `${r.user.name}'s resignation accepted — last working day ${lastDayIso}` });
    await notifyUser({
      userId: r.user.id,
      type: "RESIGNATION_DECIDED",
      title: "Your resignation is accepted",
      message: `Your last working day is ${formatCalendarDay(lastDay)}.${note ? ` ${note}` : ""}`,
      link: "/people/me",
    });
  }
  revalidatePath("/people");
  revalidatePath("/people/me");
  revalidatePath(personPath(r.user.userSeq));
  return { ok: true, data: null };
}
