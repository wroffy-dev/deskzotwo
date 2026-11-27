"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { MONTH_NAMES, dateOnly } from "@/lib/hr/calendar";
import { notifyUser } from "@/lib/notify";
import { personPath } from "@/lib/record-links";
import { formatUserId } from "@/lib/order-id";
import { can } from "@/lib/authz/resolve";
import { actorContext, assertMayActOnTarget, AuthzError } from "@/lib/authz/guards";
import { employeeProfileSchema, exitEmployeeSchema, holidaySchema, leaveTypeSchema } from "@/lib/validation/hr";
import { offboardingChecklist, onboardingChecklist } from "@/lib/hr/onboarding";
import { applyExit, raiseOffboardingTasksFor } from "@/lib/hr/exit";
import { refuseWhileViewingAs } from "@/lib/session";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import type { ActionResult } from "@/actions/company";

/**
 * Employee records, the holiday calendar, and the leave types everything else is measured against.
 *
 * Who may see what is the whole shape of this file. An HR record holds a home address, a date of
 * birth and a bank account, so it is not something the whole company browses: you see your own, a
 * manager sees their team's, and HR sees everyone's. That rule is applied in one place — `visible`
 * below — rather than being remembered at each query.
 */

async function canManage(userId: string) {
  return hasEffectivePermission(userId, "hr.manage");
}

/**
 * The people this user may look at.
 *
 * Null means "everyone", which is how the rest of the codebase already spells an unrestricted
 * scope (see `visibleUserIds` in src/actions/visit.ts) — worth matching so the two read the same.
 */
async function visibleUserIds(userId: string): Promise<string[] | null> {
  if (await hasEffectivePermission(userId, "hr.viewAll")) return null;
  if (await canManage(userId)) return null;
  return [userId, ...(await getDownlineUserIds(userId))];
}

/** Turns a form's empty string into a null, and a date string into a date-only value. */
function orNull(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
function dateOrNull(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? dateOnly(trimmed) : null;
}

// ─── Employee records ─────────────────────────────────────────────────────────

const directorySelect = {
  id: true,
  userSeq: true,
  name: true,
  email: true,
  role: true,
  active: true,
  department: { select: { id: true, name: true } },
  manager: { select: { id: true, name: true } },
  employeeProfile: {
    select: {
      employeeCode: true,
      designation: true,
      employmentType: true,
      workLocation: true,
      joinedOn: true,
      probationEndsOn: true,
      confirmedOn: true,
      exitedOn: true,
      exitType: true,
    },
  },
} satisfies Prisma.UserSelect;

export type PeopleFilters = {
  search?: string;
  departmentId?: string;
  employmentType?: string;
  /** "active" (the default), "exited", or "all". */
  status?: string;
};

/**
 * The staff directory.
 *
 * Everyone sees everyone — a colleague's name, designation, team and work email is what a directory
 * is for, and hiding it made looking somebody up impossible for anybody outside HR. What a viewer
 * does *not* get is the rest of the record: joining dates, probation, exits and everything on the
 * detail page stay behind `visibleUserIds`, which is where the private half lives.
 *
 * Ex-employees are the exception. "Who used to work here and why did they leave" is an HR question,
 * so the exited filter is refused to anybody else rather than quietly returning nothing.
 */
export async function listPeople(filters?: PeopleFilters) {
  const user = await requireModuleAccess("hr");
  const allowed = await visibleUserIds(user.id);
  const isHr = allowed === null;

  const status = isHr ? (filters?.status ?? "active") : "active";
  const where: Prisma.UserWhereInput = {
    ...(filters?.departmentId ? { departmentId: filters.departmentId } : {}),
    ...(status === "active" ? { active: true } : status === "exited" ? { active: false } : {}),
    ...(filters?.employmentType
      ? { employeeProfile: { employmentType: filters.employmentType as never } }
      : {}),
    ...(filters?.search
      ? {
          OR: [
            { name: { contains: filters.search, mode: "insensitive" as const } },
            { email: { contains: filters.search, mode: "insensitive" as const } },
            { employeeProfile: { employeeCode: { contains: filters.search, mode: "insensitive" as const } } },
            { employeeProfile: { designation: { contains: filters.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const rows = await db.user.findMany({ where, orderBy: [{ active: "desc" }, { name: "asc" }], select: directorySelect });
  // `openable`: whether the viewer may open the person's page (getPerson) — the list links only those, so a colleague
  // listed in the directory is never a link to a "Page not found" (owner, 1 Nov 2026).
  if (isHr) return toPlain(rows.map((row) => ({ ...row, openable: true })));

  // Trimmed on the way out rather than by a second query: one shape keeps the table component
  // simple, and blanking the private half here means there is exactly one place to check that a
  // joining date never reaches somebody who should not have it.
  return toPlain(
    rows.map((row) =>
      allowed.includes(row.id)
        ? { ...row, openable: true }
        : {
            openable: false,
            ...row,
            employeeProfile: row.employeeProfile
              ? {
                  ...row.employeeProfile,
                  joinedOn: null,
                  probationEndsOn: null,
                  confirmedOn: null,
                  exitedOn: null,
                  exitType: null,
                  employeeCode: null,
                }
              : null,
          },
    ),
  );
}

/**
 * One person's full record.
 *
 * Refuses rather than filtering when it is somebody you have no business reading: a half-populated
 * record is worse than a clear "not yours", because it looks like the data is missing.
 */
export async function getPerson(userId: string) {
  const user = await requireModuleAccess("hr");
  const allowed = await visibleUserIds(user.id);
  if (allowed && !allowed.includes(userId)) return null;

  const person = await db.user.findUnique({
    where: { id: userId },
    select: {
      ...directorySelect,
      createdAt: true,
      // Their work number — HR sets it on the record (saveEmployeeProfile).
      phone: true,
      // The short reference — USR-000123 — which is what the person's URL canonicalises to.
      userSeq: true,
      employeeProfile: true,
      directReports: { where: { active: true }, select: { id: true, userSeq: true, name: true }, orderBy: { name: "asc" } },
    },
  });
  return person ? toPlain(person) : null;
}

/**
 * What somebody may change on their own record without HR (security audit, 11 Nov 2026 — SEC-20): how to reach them,
 * where they live and who to call. The rest feeds pay — date of birth and gender (PF, ESI, tax), the state (the
 * professional-tax slab), PAN, the statutory numbers and the bank account salary is paid into — and changing those
 * on your own, with nobody seeing, is changing your own payslip. HR (or payroll) changes them.
 */
const SELF_EDITABLE = [
  "bloodGroup",
  "maritalStatus",
  "personalEmail",
  "personalPhone",
  "addressLine1",
  "addressLine2",
  "city",
  "pincode",
  "emergencyContactName",
  "emergencyContactPhone",
  "emergencyContactRelation",
] as const;

/** The pay inputs by name, for the refusal (SEC-20). */
const PAY_INPUT_WORDS: Record<string, string> = {
  dateOfBirth: "date of birth",
  gender: "gender",
  state: "state",
  panNumber: "PAN",
  aadhaarLast4: "Aadhaar",
  uanNumber: "UAN",
  pfNumber: "PF number",
  esicNumber: "ESIC number",
  bankName: "bank",
  bankAccountNumber: "account number",
  bankIfsc: "IFSC",
};

/** The account salary is paid into (R3-11). */
const BANK_FIELDS = ["bankName", "bankAccountNumber", "bankIfsc"] as const;

/** Every field by name, for the audit trail's "changed: …" (R3-11) — the names only, never what they hold. */
const FIELD_WORDS: Record<string, string> = {
  ...PAY_INPUT_WORDS,
  bloodGroup: "blood group",
  maritalStatus: "marital status",
  personalEmail: "personal email",
  personalPhone: "personal phone",
  addressLine1: "address",
  addressLine2: "address",
  city: "city",
  pincode: "PIN code",
  emergencyContactName: "emergency contact",
  emergencyContactPhone: "emergency contact's phone",
  emergencyContactRelation: "emergency contact's relation",
  employeeCode: "employee code",
  designation: "designation",
  employmentType: "employment type",
  workLocation: "work location",
  workPhone: "work phone",
  joinedOn: "joining date",
  probationEndsOn: "probation end",
  confirmedOn: "confirmation date",
};

/**
 * Security audit round three, 14 Nov 2026 (R3-11): a changed salary account is told to the employee and to everybody
 * who runs payroll (bar whoever changed it) — the account itself is never in the message. Not exported: a "use
 * server" export is an endpoint.
 */
async function tellBankChange(userId: string, name: string, userSeq: number, actor: { id: string; name: string | null }) {
  const message = `${actor.name ?? "Somebody"} changed the bank account salary is paid into for ${name}. If that wasn't expected, tell HR straight away.`;
  await notifyUser({ userId, type: "SECURITY_ALERT", title: "Your salary bank account was changed", message, link: personPath(userSeq) });
  const people = await db.user.findMany({ where: { active: true, id: { notIn: [userId, actor.id] } }, select: { id: true } });
  for (const person of people) {
    // `can`, not hasEffectivePermission: whoever saved the record needn't be allowed to review others' permissions.
    if (await can(person.id, "payroll.manage")) {
      await notifyUser({ userId: person.id, type: "SECURITY_ALERT", title: `Bank account changed — ${name}`, message, link: personPath(userSeq) });
    }
  }
}

export async function saveEmployeeProfile(input: unknown): Promise<ActionResult<{ userId: string }>> {
  const user = await requireModuleAccess("hr");
  // Security audit, 11 Nov 2026 (SEC-19): viewing as somebody, "your own record" was the borrowed person's — an admin
  // could change their bank account as them. A record is only ever changed as yourself.
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const parsed = employeeProfileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;
  // SEC-20: a field the post leaves out keeps what is stored. Every absent key used to be written as null, so a post
  // carrying only a phone number wiped the bank account, the PAN and the rest.
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const sent = (key: string) => Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined;
  const onlySent = <T extends Record<string, unknown>>(fields: T): Partial<T> =>
    Object.fromEntries(Object.entries(fields).filter(([key]) => sent(key))) as Partial<T>;

  // Editing your own record is not the same as editing anyone else's: people should be able to keep
  // their own address and emergency contact current without an HR ticket. Everything else is HR's.
  const isSelf = data.userId === user.id;
  const manager = await canManage(user.id);
  if (!isSelf && !manager) {
    return { ok: false, error: "You can't edit someone else's employee record." };
  }
  // Pay's inputs on your own record: HR's or payroll's to change (SEC-20).
  const mayEditPayInputs = manager || (await hasEffectivePermission(user.id, "payroll.manage"));

  const target = await db.user.findUnique({ where: { id: data.userId }, select: { id: true, name: true, userSeq: true, phone: true, isSuperAdmin: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };

  // The work number (owner, 25 Nov 2026 — "work phone number option in user profile which HR can add"): on the account,
  // not the HR record, so it is the one Edit profile and their own Profile set. HR's here; anybody else's post of it is
  // dropped — their own is on their Profile. Only a super admin changes the super admin's, as everywhere.
  const workPhone = manager && sent("workPhone") ? orNull(data.workPhone) : undefined;
  const phoneChanged = workPhone !== undefined && workPhone !== (target.phone ?? null);
  if (phoneChanged) {
    try {
      assertMayActOnTarget(await actorContext(user.id), target);
    } catch (err) {
      if (err instanceof AuthzError) return { ok: false, error: err.message };
      throw err;
    }
  }

  if (data.employeeCode) {
    const clash = await db.employeeProfile.findFirst({
      where: { employeeCode: data.employeeCode, userId: { not: data.userId } },
      select: { user: { select: { name: true, userSeq: true, active: true, kind: true } } },
    });
    // Who has it (owner, 18 Nov 2026: "this doesn't belong to any one"): the holder is often somebody People doesn't
    // list — switched off after they left, or a second account from an import — so the message says whose it is and
    // where to find them, rather than "somebody else".
    if (clash) {
      const holder = clash.user;
      const state = holder.kind !== "MEMBER" ? "a support or system account" : holder.active ? "" : "their account is switched off: People lists them under Exited";
      return {
        ok: false,
        error: `Employee code ${data.employeeCode} is already on ${holder.name}'s record (${formatUserId(holder.userSeq)}${state ? ` — ${state}` : ""}). Clear it there first, or give this person another code.`,
      };
    }
  }

  const personal = {
    dateOfBirth: dateOrNull(data.dateOfBirth),
    gender: orNull(data.gender) as never,
    bloodGroup: orNull(data.bloodGroup),
    maritalStatus: orNull(data.maritalStatus),
    personalEmail: orNull(data.personalEmail),
    personalPhone: orNull(data.personalPhone),
    addressLine1: orNull(data.addressLine1),
    addressLine2: orNull(data.addressLine2),
    city: orNull(data.city),
    state: orNull(data.state),
    pincode: orNull(data.pincode),
    emergencyContactName: orNull(data.emergencyContactName),
    emergencyContactPhone: orNull(data.emergencyContactPhone),
    emergencyContactRelation: orNull(data.emergencyContactRelation),
    panNumber: orNull(data.panNumber),
    aadhaarLast4: orNull(data.aadhaarLast4),
    uanNumber: orNull(data.uanNumber),
    pfNumber: orNull(data.pfNumber),
    esicNumber: orNull(data.esicNumber),
    bankName: orNull(data.bankName),
    bankAccountNumber: orNull(data.bankAccountNumber),
    bankIfsc: orNull(data.bankIfsc),
  };

  // Employment terms are HR's to set. Someone editing their own record keeps their existing dates
  // and designation rather than being able to award themselves a promotion.
  const employment = {
    employeeCode: orNull(data.employeeCode),
    designation: orNull(data.designation),
    employmentType: data.employmentType,
    workLocation: orNull(data.workLocation),
    joinedOn: dateOrNull(data.joinedOn),
    probationEndsOn: dateOrNull(data.probationEndsOn),
    confirmedOn: dateOrNull(data.confirmedOn),
  };

  // SEC-20: on your own record without HR's or payroll's rights, only the contact details. A pay input sent unchanged
  // (a form that posts every field) is let through as nothing; one changed is refused, saying who changes it.
  let ownFields: Partial<typeof personal> = personal;
  if (isSelf && !mayEditPayInputs) {
    const stored = await db.employeeProfile.findUnique({ where: { userId: data.userId } });
    const asStored = (key: keyof typeof personal) => {
      const value = stored?.[key as keyof typeof stored];
      return value instanceof Date ? dateOnly(value).getTime() : (value ?? null);
    };
    const asSent = (key: keyof typeof personal) => {
      const value = personal[key];
      return value instanceof Date ? value.getTime() : (value ?? null);
    };
    const changed = (Object.keys(personal) as (keyof typeof personal)[]).filter(
      (key) => !(SELF_EDITABLE as readonly string[]).includes(key) && sent(key) && asSent(key) !== asStored(key),
    );
    if (changed.length > 0) {
      return { ok: false, error: `Ask HR to change this — ${changed.map((key) => PAY_INPUT_WORDS[key] ?? key).join(", ")} feed${changed.length === 1 ? "s" : ""} your pay, so HR changes ${changed.length === 1 ? "it" : "them"}.` };
    }
    ownFields = Object.fromEntries(SELF_EDITABLE.map((key) => [key, personal[key]]));
  }

  const writable = onlySent(isSelf && !manager ? ownFields : { ...personal, ...employment });

  // Security audit round three, 14 Nov 2026 (R3-11): which fields this save actually changes — named in the audit
  // (never their values), and the bank account told to the employee and to payroll, so a change between a run's lock
  // and its transfer is seen by somebody besides whoever made it.
  const before = await db.employeeProfile.findUnique({ where: { userId: data.userId } });
  const comparable = (value: unknown) => (value instanceof Date ? dateOnly(value).getTime() : (value ?? null));
  const changedFields = Object.keys(writable).filter(
    (key) => comparable(before?.[key as keyof typeof before]) !== comparable((writable as Record<string, unknown>)[key]),
  );
  const bankChanged = changedFields.some((key) => (BANK_FIELDS as readonly string[]).includes(key));
  if (bankChanged) {
    // A locked run pays them into the account on the payslips; changing it now is for the next month, once this one
    // is paid — or reopen the run, and lock it again with the new account.
    const locked = await db.payslip.findFirst({ where: { userId: data.userId, run: { status: "LOCKED" } }, select: { run: { select: { month: true, year: true } } } });
    if (locked) {
      const month = `${MONTH_NAMES[locked.run.month - 1]} ${locked.run.year}`;
      return { ok: false, error: `${month}'s payroll is locked and pays ${target.name} into the account on file. Change the bank details once it's marked paid, or reopen the run first.` };
    }
  }

  // A new record too (security review, 23 Oct 2026): somebody HR hadn't set up yet wrote their own joining date and
  // designation here, which leave accrual, gratuity and letters read. HR fills those in.
  await db.$transaction(async (tx) => {
    await tx.employeeProfile.upsert({
      where: { userId: data.userId },
      create: { userId: data.userId, ...writable },
      update: writable,
    });
    if (phoneChanged) await tx.user.update({ where: { id: data.userId }, data: { phone: workPhone }, select: { id: true } });
  });
  if (phoneChanged) changedFields.push("workPhone");

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "EmployeeProfile",
    entityId: data.userId,
    entityLabel: `Employee record for ${target.name}${changedFields.length ? ` — changed: ${changedFields.map((key) => FIELD_WORDS[key] ?? key).join(", ")}` : " — nothing changed"}`,
  });
  if (bankChanged) await tellBankChange(data.userId, target.name, target.userSeq, user);
  if (phoneChanged) {
    revalidatePath("/settings", "layout");
    revalidatePath("/cards");
  }
  revalidatePath("/people");
  revalidatePath(`/people/${data.userId}`);
  return { ok: true, data: { userId: data.userId } };
}

/**
 * Recording that someone has left.
 *
 * Deactivating the login is on by default and separately visible, because an ex-employee who still
 * has access is the single most common failure of an HR system — and the one nobody notices until
 * it matters.
 */
export async function recordExit(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  if (!(await canManage(user.id))) return { ok: false, error: "You can't record an exit." };
  // SEC-19: "your own exit" below compares the real person, never one being viewed as.
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };

  const parsed = exitEmployeeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  if (data.userId === user.id) {
    return { ok: false, error: "You can't record your own exit — somebody else has to." };
  }

  const written = await applyExit(user.id, { ...data, exitReason: orNull(data.exitReason) });
  return written.ok ? { ok: true, data: null } : written;
}

// ─── Holidays ─────────────────────────────────────────────────────────────────

export async function listHolidays(year?: number) {
  await requireModuleAccess("hr");
  const where = year
    ? { date: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) } }
    : {};
  return toPlain(await db.holiday.findMany({ where, orderBy: { date: "asc" } }));
}

export async function saveHoliday(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleAccess("hr");
  if (!(await canManage(user.id))) return { ok: false, error: "You can't edit the holiday calendar." };

  const parsed = holidaySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, name, date, optional, note } = parsed.data;

  const payload = { name: name.trim(), date: dateOnly(date), optional, note: orNull(note) };
  try {
    const row = id
      ? await db.holiday.update({ where: { id }, data: payload, select: { id: true } })
      : await db.holiday.create({ data: payload, select: { id: true } });
    await recordAudit({
      userId: user.id,
      action: id ? "UPDATE" : "CREATE",
      entityType: "Holiday",
      entityId: row.id,
      entityLabel: `${payload.name} on ${date}`,
    });
    revalidatePath("/people/holidays");
    return { ok: true, data: row };
  } catch {
    return { ok: false, error: "There's already a holiday with that name on that date." };
  }
}

export async function deleteHoliday(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  if (!(await canManage(user.id))) return { ok: false, error: "You can't edit the holiday calendar." };
  const holiday = await db.holiday.findUnique({ where: { id }, select: { name: true, date: true } });
  if (!holiday) return { ok: false, error: "That holiday no longer exists." };

  await db.holiday.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "Holiday",
    entityId: id,
    entityLabel: `${holiday.name} removed from the calendar`,
  });
  revalidatePath("/people/holidays");
  return { ok: true, data: null };
}

// ─── Leave types ──────────────────────────────────────────────────────────────

export async function listLeaveTypes(includeInactive = false) {
  await requireModuleUser("hr");
  return toPlain(
    await db.leaveType.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    }),
  );
}

export async function saveLeaveType(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleAccess("hr");
  if (!(await canManage(user.id))) return { ok: false, error: "You can't edit leave types." };

  const parsed = leaveTypeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, maxCarryForward, proofAfterDays, ...rest } = parsed.data;
  // Changing one already there is the super admin's (owner, 26 Nov 2026 — "delete / edit option of leaves type for super
  // admin"): its days, credit and pay apply to every balance and request of that type. Adding one stays HR's.
  if (id && !(await actingAsSuperAdmin(user.id))) return { ok: false, error: "Only the workspace's super admin can change a leave type." };
  const before = id ? await db.leaveType.findUnique({ where: { id }, select: { code: true, name: true, annualQuota: true, active: true } }) : null;
  if (id && !before) return { ok: false, error: "That leave type isn't there any more." };

  const payload = {
    ...rest,
    maxCarryForward: rest.carryForward && maxCarryForward ? new Prisma.Decimal(maxCarryForward) : null,
    // Left as it is when the form doesn't send it — the edit form has no such field, and shouldn't clear it.
    ...(proofAfterDays === undefined && id ? {} : { proofAfterDays: proofAfterDays && proofAfterDays > 0 ? proofAfterDays : null }),
    annualQuota: new Prisma.Decimal(rest.annualQuota),
  };

  try {
    const row = id
      ? await db.leaveType.update({ where: { id }, data: payload, select: { id: true } })
      : await db.leaveType.create({ data: payload, select: { id: true } });
    const changed = before
      ? [
          before.code !== payload.code && `code ${before.code} → ${payload.code}`,
          before.name !== payload.name && `name “${before.name}” → “${payload.name}”`,
          Number(before.annualQuota) !== rest.annualQuota && `${Number(before.annualQuota)} → ${rest.annualQuota} days a year`,
          before.active !== payload.active && (payload.active ? "switched on" : "switched off"),
        ].filter(Boolean)
      : [];
    await recordAudit({
      userId: user.id,
      action: id ? "UPDATE" : "CREATE",
      entityType: "LeaveType",
      entityId: row.id,
      entityLabel: `${payload.code} — ${payload.name}${changed.length ? ` (${changed.join(", ")})` : ""}`,
    });
    revalidatePath("/people/leave");
    revalidatePath("/people/holidays");
    return { ok: true, data: row };
  } catch {
    return { ok: false, error: `The code ${payload.code} is already used by another leave type.` };
  }
}

/**
 * Deleting a leave type (owner, 26 Nov 2026): the super admin's alone, as themselves. Only one nobody has applied for —
 * a request keeps its type, so one with requests is refused, with switching it off as the way to stop it being offered.
 * The balances credited for it go with it.
 */
export async function deleteLeaveType(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  if (!(await actingAsSuperAdmin(user.id))) return { ok: false, error: "Only the workspace's super admin can delete a leave type." };
  if (typeof id !== "string" || !id) return { ok: false, error: "That leave type isn't there any more." };
  const type = await db.leaveType.findUnique({ where: { id }, select: { id: true, code: true, name: true, _count: { select: { requests: true } } } });
  if (!type) return { ok: false, error: "That leave type isn't there any more." };
  const used = type._count.requests;
  const refusal = `${type.name} has ${used} leave ${used === 1 ? "request, which keeps its" : "requests, which keep their"} type, so it can't be deleted. Edit it and untick “Offered to people” to stop it being used.`;
  if (used > 0) return { ok: false, error: refusal };
  try {
    await db.leaveType.delete({ where: { id } });
  } catch (err) {
    // A request made since the count: the foreign key is the backstop.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") return { ok: false, error: refusal };
    throw err;
  }
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "LeaveType", entityId: id, entityLabel: `Deleted leave type ${type.code} — ${type.name}` });
  revalidatePath("/people/holidays");
  revalidatePath("/people/leave");
  return { ok: true, data: null };
}

/** Whether the signed-in user may act as HR — drives what the pages offer. */
export async function hrCapabilities() {
  const user = await requireModuleUser("hr");
  const [manage, viewAll, approveAnyLeave, payroll, handover, printAttendance] = await Promise.all([
    hasEffectivePermission(user.id, "hr.manage"),
    hasEffectivePermission(user.id, "hr.viewAll"),
    hasEffectivePermission(user.id, "hr.approveLeave"),
    hasEffectivePermission(user.id, "payroll.manage"),
    // Its own key rather than folded into hr.manage: reassigning a book of business is a different
    // job from editing a joining date, and the people who do them are not always the same.
    hasEffectivePermission(user.id, "people.handover"),
    hasEffectivePermission(user.id, "hr.printAttendance"),
  ]);
  return { userId: user.id, manage, viewAll, approveAnyLeave, payroll, handover, printAttendance };
}

// ─── Onboarding & offboarding checklists ──────────────────────────────────────

/**
 * What is still outstanding for one person, joining or leaving.
 *
 * Every item reads the real record rather than a stored tick — see src/lib/hr/onboarding.ts. Which
 * checklist applies is decided by whether an exit has been recorded, because those are the two
 * states a person can be in and nobody needs both at once.
 */
export async function personChecklist(userId: string) {
  const user = await requireModuleAccess("hr");
  const allowed = await visibleUserIds(user.id);
  if (allowed && !allowed.includes(userId)) return null;

  const [person, structures, letters, documents, tasks, settlement, assets] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { active: true, userSeq: true, employeeProfile: true },
    }),
    db.salaryStructure.count({ where: { userId } }),
    db.employeeLetter.findMany({ where: { userId, status: "ISSUED" }, select: { type: true } }),
    db.employeeDocument.findMany({ where: { userId }, select: { type: true } }),
    db.task.count({ where: { aboutUserId: userId, done: false } }),
    db.finalSettlement.findUnique({ where: { userId }, select: { status: true, netPayable: true } }),
    // What they are actually holding, from the register rather than from a ticked box.
    db.asset.findMany({
      where: { custodianUserId: userId, status: { notIn: ["RETIRED", "LOST"] } },
      select: {
        id: true,
        movements: {
          where: { type: "ASSIGNED", toUserId: userId },
          orderBy: { occurredAt: "desc" },
          take: 1,
          select: { acknowledgedAt: true },
        },
      },
    }),
  ]);
  if (!person) return null;

  const profile = person.employeeProfile;
  const letterTypes = letters.map((l) => l.type);

  if (profile?.exitedOn) {
    return {
      stage: "OFFBOARDING" as const,
      items: offboardingChecklist({
        userId,
        userSeq: person.userSeq,
        exitedOn: profile.exitedOn,
        loginActive: person.active,
        hasSettlement: !!settlement,
        settlementStatus: settlement?.status ?? null,
        netPayable: Number(settlement?.netPayable ?? 0),
        letterTypes,
        openTasks: tasks,
        assetsHeld: assets.length,
      }),
    };
  }

  return {
    stage: "ONBOARDING" as const,
    items: onboardingChecklist({
      userId,
      userSeq: person.userSeq,
      joinedOn: profile?.joinedOn ?? null,
      employeeCode: profile?.employeeCode ?? null,
      designation: profile?.designation ?? null,
      panNumber: profile?.panNumber ?? null,
      bankAccountNumber: profile?.bankAccountNumber ?? null,
      bankIfsc: profile?.bankIfsc ?? null,
      personalPhone: profile?.personalPhone ?? null,
      emergencyContactPhone: profile?.emergencyContactPhone ?? null,
      state: profile?.state ?? null,
      biometricId: profile?.biometricId ?? null,
      hasSalaryStructure: structures > 0,
      hasAppointmentLetter: letterTypes.includes("APPOINTMENT"),
      documentTypes: documents.map((d) => d.type),
      openTasks: tasks,
      assetsHeld: assets.length,
      assetsUnconfirmed: assets.filter((a) => a.movements[0] && !a.movements[0].acknowledgedAt).length,
    }),
  };
}

/**
 * Raises the offboarding tasks when somebody's exit is recorded.
 *
 * Separate from `recordExit` so that re-recording an exit does not raise a second set, and so the
 * tasks can be raised by hand for somebody whose exit was entered before this existed.
 */
export async function raiseOffboardingTasks(userId: string): Promise<ActionResult<{ tasks: number }>> {
  const user = await requireModuleAccess("hr");
  if (!(await canManage(user.id))) return { ok: false, error: "Only HR can raise offboarding tasks." };
  return raiseOffboardingTasksFor(user.id, userId);
}

/** The tasks raised for somebody joining or leaving, for the checklist card. */
export async function hrTasksFor(userId: string) {
  const user = await requireModuleAccess("hr");
  const allowed = await visibleUserIds(user.id);
  if (allowed && !allowed.includes(userId)) return [];
  return toPlain(
    await db.task.findMany({
      where: { aboutUserId: userId },
      orderBy: [{ done: "asc" }, { dueDate: "asc" }],
      select: {
        id: true, title: true, done: true, dueDate: true, hrStage: true,
        assignedTo: { select: { id: true, name: true } },
      },
    }),
  );
}
