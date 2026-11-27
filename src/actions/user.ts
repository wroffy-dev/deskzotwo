"use server";

import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { wouldCreateCycle } from "@/lib/org-chart";
import { hasEffectivePermission } from "@/actions/permission";
import { can } from "@/lib/authz/resolve";
import { actorContext, assertMayActOnTarget, assertMayChangeManager, assertMayStartInRole, assertNotSelf, assertRoleAssignable, assertSuperAdminRemains, AuthzError } from "@/lib/authz/guards";
import { recordPermissionChange } from "@/lib/authz/audit";
import { accountEmail, updateUserAssignmentSchema, createUserSchema, updateWorkProfileSchema } from "@/lib/validation/user";
import type { ActionResult } from "@/actions/company";
import { SeatsFull, claimSeats, seatProblem, seatsInUse } from "@/lib/seats";
import { gapsIfSwitchedOff } from "@/lib/documents/approval-gaps";
import { accountsChanged } from "@/lib/platform/account-hooks";
import { awaitingSetup, mayPassOnSetupLink, sendSetupInvitation, type SetupInvitation } from "@/lib/account-setup";
import { AWAITING_SETUP, noPasswordYet } from "@/lib/no-password";
import { clearFailures, lockoutState, MAX_FAILURES, recordFailure } from "@/lib/security/lockout";
import { endSignInsFor } from "@/lib/security/end-sign-ins";
import { clearAccessCache } from "@/lib/access/gate";
import { tenantKey } from "@/lib/tenancy/cache";
import { credentialLinkOrigin, currentTenant } from "@/lib/tenancy/resolve";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { templateMail } from "@/lib/platform/mail/templates";
import { recordAudit } from "@/lib/audit";
import { logActivity } from "@/lib/activity";
import { signInPolicyFor } from "@/lib/workplace/sign-in-rules-server";
import { lockedOut, waysIn } from "@/lib/workplace/sign-in-rules";
import { ADMIN_RESET_LINK_TTL_MS, temporaryPassword } from "@/lib/admin-password";
import { emitPersonJoined } from "@/lib/automate/emit-people";
import { holdingsText, removeAccount, userHoldings, type Holding } from "@/lib/user-delete";

function refuse(err: unknown): ActionResult<never> {
  if (err instanceof AuthzError) return { ok: false, error: err.message };
  throw err;
}

/**
 * `setupPending`: nobody has chosen a password for the account yet — "Invitation pending" (src/lib/account-setup.ts).
 * `setupLinkIssued`: a setup or password link has been issued for it before, so the list offers to resend one.
 *
 * Everybody's role, manager, 2FA and setup state, so only for whoever may review access — `permissions.view`, the key
 * both its pages (Settings › Users, and Add staff) open with; anybody else gets nobody, as `accessRoster` answers
 * (owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-1: it was open to anybody signed in).
 */
export async function listUsers() {
  const session = await requireUser();
  if (!(await can(session.id, "permissions.view"))) return [];
  const [users, pending] = await Promise.all([
    db.user.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        mustChangePassword: true,
        twoFactorEnabledAt: true,
        departmentId: true,
        department: { select: { id: true, name: true } },
        managerId: true,
        manager: { select: { id: true, name: true } },
      },
    }),
    db.user.findMany({ where: AWAITING_SETUP, select: { id: true, _count: { select: { passwordResetTokens: true } } } }),
  ]);
  const issued = new Map(pending.map((p) => [p.id, p._count.passwordResetTokens > 0]));
  return users.map((user) => ({ ...user, setupPending: issued.has(user.id), setupLinkIssued: issued.get(user.id) ?? false }));
}

type Actor = Awaited<ReturnType<typeof actorContext>>;

export async function updateUserAssignment(input: unknown): Promise<ActionResult<null>> {
  const session = await requireUser();
  const admin = await actorContext(session.id);
  const result = await assignUser(admin, input);
  if (!result.ok) return result;
  revalidatePath("/settings", "layout");
  revalidatePath("/", "layout");
  return result;
}

/**
 * One person's role, department and manager, with every rule — the single edit and the bulk bar
 * (`bulkUpdateUsers`) both come through here, so a bulk change can never be looser than one at a time
 * (owner, 31 Oct 2026). Not exported: a "use server" export is an endpoint.
 */
async function assignUser(admin: Actor, input: unknown): Promise<ActionResult<null>> {
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) {
    return { ok: false, error: "You can't change roles, departments or reporting lines." };
  }
  const parsed = updateUserAssignmentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, role, departmentId, managerId } = parsed.data;

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, name: true, role: true, isSuperAdmin: true, managerId: true, departmentId: true },
  });
  if (!target) return { ok: false, error: "That user no longer exists." };

  /**
   * A role change is not the same act as a department change, and lumping them under one
   * permission would make `users.assignRole` decorative — somebody with `users.manage` could
   * simply promote themselves through this form instead. So the stricter key is required only
   * when the role is actually moving.
   */
  /**
   * Re-parenting somebody is an access decision, and was priced as an org-chart edit.
   *
   * A manager no longer inherits their reports' permissions (src/lib/authz/resolve.ts) — when they did,
   * an HR administrator holding `users.manage` could set herself as the accounts executive's manager in
   * two clicks and hold `payments.record` on her next request. What the reporting line still decides is
   * "Team": every record a role reaches at Team level is its holder's and their reports'. So moving a
   * person under a new manager still widens what that manager sees — their accounts, leads, visits,
   * expenses — on a form that reads like an HR field.
   *
   * The same reasoning the role branch below already applies: the stricter key is required only
   * when the thing that confers access actually moves.
   */
  if (managerId !== target.managerId) {
    if (!(await hasEffectivePermission(admin.id, "permissions.manage"))) {
      return {
        ok: false,
        error:
          "Changing who somebody reports to also changes whose records their manager sees, so it needs permission to manage access.",
      };
    }
  }

  if (role !== target.role) {
    if (!(await hasEffectivePermission(admin.id, "users.assignRole"))) {
      return { ok: false, error: "Changing somebody's role is the super admin's, or whoever they let do it." };
    }
    try {
      assertNotSelf(admin.id, id, "role");
      await assertRoleAssignable(role);
      // Nobody moves somebody into a role holding more than they hold themselves — the rule creating an
      // account already applied, and the one the role change lacked (owner, 2 Nov 2026 — "Phase 1 security
      // fixes", audit H-1). Without it `users.assignRole` was a way to Admin in two steps.
      await assertMayStartInRole(admin, role, { name: target.name });
    } catch (err) {
      return refuse(err);
    }
  }

  try {
    assertMayActOnTarget(admin, target);
  } catch (err) {
    return refuse(err);
  }

  if (managerId) {
    if (managerId === id) {
      return { ok: false, error: "A user can't be their own reporting manager." };
    }
    // Walks *up* from the proposed manager rather than down from the user. Two reasons: it is
    // O(depth) instead of O(subtree), and — the one that matters — it terminates even when the
    // chart is already corrupt. The previous check walked the downline, which is the same traversal
    // that hangs on a cycle, so the only screen able to repair a bad reporting line was itself
    // taken out by the bad reporting line.
    if (await wouldCreateCycle(id, managerId)) {
      return { ok: false, error: "That would create a reporting loop — the selected manager already reports up through this user." };
    }
  }

  // `permissions.manage` above says who may change a reporting line at all; this says which changes: none that
  // brings somebody into your own line, and none that gives anybody Team reach wider than yours (owner, 2 Nov
  // 2026 — "Phase 1 security fixes", audit M-5; src/lib/authz/guards.ts `assertMayChangeManager`).
  if (managerId !== target.managerId) {
    try {
      await assertMayChangeManager(admin, target, managerId);
    } catch (err) {
      return refuse(err);
    }
  }

  try {
    await db.$transaction(async (tx) => {
      // Demoting a super admin out of ADMIN would violate the CHECK constraint and, before that,
      // leave nobody able to administer anything. Checked inside the transaction so two admins
      // demoting each other cannot both see 'one other remains'.
      if (target.isSuperAdmin && role !== "ADMIN") await assertSuperAdminRemains(tx, id);
      await tx.user.update({ where: { id }, data: { role, departmentId, managerId } });
    });
  } catch (err) {
    return refuse(err);
  }
  await recordAssignment(admin, target, { role, departmentId, managerId });
  return { ok: true, data: null };
}

/**
 * One entry in the access history for each of role, department and manager that actually moved — the single
 * edit and the bulk bar alike, since both come through `assignUser` (owner, 2 Nov 2026 — "Phase 1 security
 * fixes", audit M-9). A role decides what somebody can do and a reporting line whose records their manager
 * sees, and neither change was written down anywhere; the bulk bar's own audit entry stays as it was.
 */
async function recordAssignment(
  admin: Actor,
  target: { id: string; name: string; role: string; managerId: string | null; departmentId: string | null },
  next: { role: string; departmentId: string | null; managerId: string | null },
) {
  const entry = { actorUserId: admin.id, subjectType: "USER" as const, subjectUserId: target.id };
  if (next.role !== target.role) {
    await recordPermissionChange({ ...entry, changeKind: "ROLE_ASSIGNED", detail: `${admin.name} changed ${target.name}'s role: ${target.role} → ${next.role}` });
  }
  if (next.departmentId !== target.departmentId) {
    const name = async (deptId: string | null) => (deptId ? ((await db.department.findUnique({ where: { id: deptId }, select: { name: true } }))?.name ?? "a removed department") : "no department");
    await recordPermissionChange({ ...entry, changeKind: "DEPARTMENT_CHANGED", detail: `${admin.name} changed ${target.name}'s department: ${await name(target.departmentId)} → ${await name(next.departmentId)}` });
  }
  if (next.managerId !== target.managerId) {
    const name = async (userId: string | null) => (userId ? ((await db.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "a removed account") : "nobody");
    await recordPermissionChange({ ...entry, changeKind: "MANAGER_CHANGED", detail: `${admin.name} changed who ${target.name} reports to: ${await name(target.managerId)} → ${await name(next.managerId)}` });
  }
}

/**
 * Somebody's job title and work phone, from Staff & roles — what their digital card, their email
 * signature and a printed quote show. Neither confers anything, so `users.manage` is the whole rule,
 * with the usual one that only a super admin edits a super admin.
 *
 * The title is the HR record's designation: a person without an HR record gets one holding only that,
 * which People fills in the rest of later. Clearing the title of somebody without a record writes nothing.
 */
export async function updateWorkProfile(input: unknown): Promise<ActionResult<null>> {
  const session = await requireUser();
  const admin = await actorContext(session.id);
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) {
    return { ok: false, error: "You can't change somebody's job title or work phone." };
  }
  const parsed = updateWorkProfileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, jobTitle, phone } = parsed.data;

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, isSuperAdmin: true, employeeProfile: { select: { id: true } } },
  });
  if (!target) return { ok: false, error: "That user no longer exists." };
  try {
    assertMayActOnTarget(admin, target);
  } catch (err) {
    return refuse(err);
  }

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { phone: phone || null } });
    if (target.employeeProfile) {
      await tx.employeeProfile.update({ where: { userId: id }, data: { designation: jobTitle || null } });
    } else if (jobTitle) {
      await tx.employeeProfile.create({ data: { userId: id, designation: jobTitle } });
    }
  });

  revalidatePath("/settings", "layout");
  revalidatePath("/cards");
  return { ok: true, data: null };
}

/**
 * A new account, and its setup email: the person chooses their own password from a one-time link
 * (src/lib/account-setup.ts). Until then the account has no usable password, and nobody can sign in as it.
 *
 * With "This person already uses another workspace on this platform" ticked, the email is the one-step
 * invite of linked sign-in: the same link with `&link=1`, whose page also offers to link the two.
 *
 * `emailed: false` comes with the link itself (`setupUrl`) for the admin to pass on — shown once, never
 * stored — unless the link couldn't be issued either, when "Resend setup email" tries again.
 *
 * Optional, from Staff & roles' Add staff form: a job title (the HR record's designation), a work phone, and
 * `active: false` for an account made switched off — no seat and no email until somebody switches it on,
 * answered with `startsSwitchedOff`. Everything else about the account is as without them.
 */
export async function createUser(
  input: unknown,
): Promise<ActionResult<{ id: string } & SetupInvitation & { startsSwitchedOff?: true }>> {
  const session = await requireUser();
  const admin = await actorContext(session.id);
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) {
    return { ok: false, error: "You can't create users." };
  }
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, email, role, departmentId, usesAnotherWorkspace, jobTitle, phone, active } = parsed.data;

  // The role picker already leaves ADMIN out (see the access page), but the form is not the
  // authority — this action is. Creating a fresh admin is the same escalation as promoting an
  // existing user, so it wants the same key.
  if (role === "ADMIN" && !(await hasEffectivePermission(admin.id, "users.assignRole"))) {
    return { ok: false, error: "Only a super admin can create an admin account." };
  }

  /**
   * The same rule for every other role, for the same reason.
   *
   * The comment above already argues that minting an admin is the escalation that promoting one is.
   * It stopped at ADMIN — but MANAGEMENT carries 47 of the 74 keys by default, and the creator can
   * end up choosing the account's password: when the setup email can't be sent, the setup link comes
   * back to them to pass on. So somebody holding only `users.manage` could create a MANAGEMENT
   * account, set it up themselves, sign in as it, and hold far more than they were given. (This was
   * true of the temporary password the creator chose before, which `mustChangePassword` didn't help:
   * they were the one who would be asked to change it.)
   *
   * So the creator must already hold everything the new account would start with — the role as it
   * stands, its stored answers over its defaults, not the registry's defaults alone, which let a custom
   * role through unchecked (`assertMayStartInRole`) — and the role must be switched on.
   */
  try {
    await assertRoleAssignable(role);
    await assertMayStartInRole(admin, role);
  } catch (err) {
    return refuse(err);
  }

  // A switched-off account takes no seat (src/lib/seats.ts) — it asks for one when it is switched on.
  const startsActive = active !== false;
  if (startsActive) {
    const seats = await seatProblem();
    if (seats) return { ok: false, error: seats };
  }

  let user: { id: string; name: string; email: string };
  try {
    user = await db.$transaction(async (tx) => {
      if (startsActive) await claimSeats(tx);
      const made = await tx.user.create({
        data: {
          name: name.trim(),
          email: email.trim().toLowerCase(),
          role,
          departmentId: departmentId || null,
          phone: phone?.trim() || null,
          active: startsActive,
          // No usable password until they choose one from the setup link.
          passwordHash: noPasswordYet(),
        },
        select: { id: true, name: true, email: true },
      });
      // A job title is the HR record's designation, made with the account as converting a candidate does.
      if (jobTitle?.trim()) {
        await tx.employeeProfile.create({ data: { userId: made.id, designation: jobTitle.trim() } });
      }
      // For Deskzo Automate: somebody has joined (an onboarding workflow starts from it).
      await emitPersonJoined(tx, made.id, admin.id);
      return made;
    });
  } catch (err) {
    if (err instanceof SeatsFull) return { ok: false, error: err.message };
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A user with this email already exists." };
    }
    throw err;
  }
  await accountsChanged([user.id], { by: `admin:${admin.id}` });
  revalidatePath("/settings", "layout");
  // Switched off: no email yet. "Send setup email" offers it once somebody switches them on — the same
  // rule as resending, which refuses a switched-off account.
  if (!startsActive) return { ok: true, data: { id: user.id, emailed: false, startsSwitchedOff: true } };
  // With the tick, the one-step invite: set up here, and link it to the workspace they already use. The account
  // is made exactly as without it — the role chosen here — and the admin never learns which workspace.
  const invitation = await sendSetupInvitation(user, { by: admin, linking: usesAnotherWorkspace === true });
  return { ok: true, data: { id: user.id, ...invitation } };
}

/**
 * "Resend setup email", for somebody who hasn't chosen a password yet: a new link replaces the unused one
 * (the earlier email's link stops working), mailed as when they were added. Always the plain setup email —
 * linking to another workspace can be done from Profile once they're in.
 *
 * The rules of any re-issued password link: `users.manage`, an ordinary admin can't act on a super admin,
 * not for a switched-off account, and asks for one address share one limit with "Forgot your password?"
 * (src/actions/password-reset.ts). Somebody who has set a password gets a reset instead
 * (`sendPasswordResetEmail`, `resetPasswordToTemporary` below).
 */
export async function resendSetupEmail(id: string): Promise<ActionResult<SetupInvitation>> {
  const session = await requireUser();
  const admin = await actorContext(session.id);
  const result = await resendSetupFor(admin, id);
  if (result.ok) revalidatePath("/settings", "layout");
  return result;
}

/** One person's setup email, with every rule — shared with the bulk bar (owner, 31 Oct 2026). */
async function resendSetupFor(admin: Actor, id: string): Promise<ActionResult<SetupInvitation>> {
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) {
    return { ok: false, error: "You can't send setup emails." };
  }
  const target = await db.user.findUnique({
    where: { id: String(id ?? "") },
    select: { id: true, name: true, email: true, active: true, kind: true, isSuperAdmin: true },
  });
  if (!target || target.kind !== "MEMBER") return { ok: false, error: "That user no longer exists." };
  try {
    assertMayActOnTarget(admin, target);
  } catch (err) {
    return refuse(err);
  }
  if (!target.active) return { ok: false, error: "Activate them first — a switched-off account can't be set up." };
  if (!(await awaitingSetup(target.id))) {
    return { ok: false, error: "They've already chosen a password. To reset it, send them a password reset email." };
  }

  // The address's reset counter across callers is 3 × MAX_FAILURES since RL-07 (src/actions/password-reset.ts): counted at the
  // same threshold here, or an admin's send would lock self-service reset early (security review, 15 Nov 2026).
  const keys = [{ key: `${await tenantKey()}|reset:${target.email.trim().toLowerCase()}`, max: 3 * MAX_FAILURES }];
  const limit = lockoutState(keys);
  if (limit.lockedOut) {
    return { ok: false, error: `Too many setup emails for this address. Try again in ${Math.ceil(limit.retryInSeconds / 60)} minutes.` };
  }
  recordFailure(keys);

  const invitation = await sendSetupInvitation(target, { by: admin });
  if (!invitation.emailed && !invitation.setupUrl) return { ok: false, error: "The setup email couldn't be sent. Try again in a while." };
  return { ok: true, data: invitation };
}

export async function setUserActive(id: string, active: boolean): Promise<ActionResult<{ approvalGaps: string[] }>> {
  const session = await requireUser();
  const admin = await actorContext(session.id);
  // Asked before they go (owner, 9 Nov 2026): the approval rules this leaves with nobody to sign off.
  const gaps = active ? [] : await gapsIfSwitchedOff(String(id ?? "")).catch(() => []);
  const result = await switchUser(admin, id, active);
  if (!result.ok) return result;
  revalidatePath("/settings", "layout");
  revalidatePath("/", "layout");
  return { ok: true, data: { approvalGaps: gaps.map((g) => g.why) } };
}

/**
 * Deleting an account outright — the super admin only (owner, 31 Oct 2026), and only one that owns nothing
 * (src/lib/user-delete.ts): for somebody added by mistake. Anybody who did any work is switched off instead,
 * and the refusal says what they hold. Never yourself, never the super admin, never while viewing as somebody.
 */
export async function deleteUser(id: string): Promise<ActionResult<null>> {
  const session = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const admin = await actorContext(session.id);
  if (!admin.isSuperAdmin) return { ok: false, error: "Only the super admin can delete an account. Switch them off instead." };
  if (id === admin.id) return { ok: false, error: "You can't delete your own account." };
  const target = await db.user.findUnique({ where: { id: String(id ?? "") }, select: { id: true, name: true, email: true, isSuperAdmin: true, kind: true } });
  if (!target || target.kind !== "MEMBER") return { ok: false, error: "That user no longer exists." };
  if (target.isSuperAdmin) return { ok: false, error: "The super admin's account can't be deleted." };

  try {
    await db.$transaction(async (tx) => {
      // Asked again inside the transaction, so a record made a moment ago still stops it.
      const holdings = await userHoldings(target.id, tx);
      if (holdings.length) throw new HeldRecords(holdings);
      await removeAccount(tx, target.id);
    });
  } catch (err) {
    if (err instanceof HeldRecords) {
      return { ok: false, error: `${target.name} has records — ${holdingsText(err.holdings)} — so the account can't be deleted. Switch them off instead; everything stays under their name.` };
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2003" || err.code === "P2014")) {
      return { ok: false, error: `${target.name} is still linked to other records, so the account can't be deleted. Switch them off instead.` };
    }
    throw err;
  }

  await recordAudit({ userId: admin.id, action: "DELETE", entityType: "User", entityId: target.id, entityLabel: `Deleted the account of ${target.name} (${target.email})` });
  await accountsChanged([target.id], { revoke: "deleted", by: `admin:${admin.id}` });
  revalidatePath("/settings", "layout");
  return { ok: true, data: null };
}

class HeldRecords extends Error {
  constructor(readonly holdings: Holding[]) {
    super("held records");
  }
}

/**
 * Switches one person on or off, with every rule — yourself, the super admin, a seat claimed under the
 * lock — shared with the bulk bar (owner, 31 Oct 2026). Each person claims their own seat in their own
 * transaction, so a bulk switch-on fills the free seats and refuses the rest one by one.
 */
async function switchUser(admin: Actor, id: string, active: boolean): Promise<ActionResult<null>> {
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) {
    return { ok: false, error: "You can't activate or deactivate users." };
  }
  if (id === admin.id && !active) {
    return { ok: false, error: "You can't deactivate your own account." };
  }

  const target = await db.user.findUnique({ where: { id }, select: { id: true, name: true, isSuperAdmin: true, active: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };
  // Switching somebody back on takes a seat again.
  if (active && !target.active) {
    const seats = await seatProblem();
    if (seats) return { ok: false, error: seats };
  }

  try {
    assertMayActOnTarget(admin, target);
    await db.$transaction(async (tx) => {
      // Deactivating is a demotion in everything but name: the resolver denies an inactive account
      // every permission, so switching off the last super admin leaves nobody who can switch them
      // back on.
      if (target.isSuperAdmin && !active) await assertSuperAdminRemains(tx, id);
      if (active && !target.active) await claimSeats(tx);
      await tx.user.update({ where: { id }, data: { active } });
      // Security audit, 11 Nov 2026 (SEC-25, SEC-26): switched off ends their sign-ins, API keys and phone pushes
      // too — not only refused while it lasts, so switching them back on doesn't bring an old key or session back.
      if (!active && target.active) await endSignInsFor(id, { tx, byId: admin.id });
    });
    if (!active && target.active) clearAccessCache();
  } catch (err) {
    if (err instanceof SeatsFull) return { ok: false, error: err.message };
    return refuse(err);
  }

  await accountsChanged([id], { revoke: active ? undefined : "deactivated", by: `admin:${admin.id}` });
  // Who switched whom on or off, in the access history — one at a time and from the bulk bar alike; nothing
  // when it was so already (owner, 2 Nov 2026 — "Phase 1 security fixes", audit M-9).
  if (active !== target.active) {
    await recordPermissionChange({
      actorUserId: admin.id,
      subjectType: "USER",
      subjectUserId: id,
      changeKind: active ? "USER_ACTIVATED" : "USER_DEACTIVATED",
      detail: `${admin.name} switched ${target.name}'s account ${active ? "on" : "off"}`,
    });
  }
  return { ok: true, data: null };
}

// ─── Bulk changes from the Users list (owner, 31 Oct 2026) ─────────────────────────────────────────

export type BulkUserOp = "role" | "activate" | "deactivate" | "department" | "manager" | "resendSetup";

export type BulkUserResult = {
  done: { id: string; name: string; note?: string }[];
  /** Already so — nothing changed and nothing recorded. */
  unchanged: { id: string; name: string }[];
  refused: { id: string; name: string; reason: string }[];
  /** Seats left after a switch-on, when the plan counts them — said with the refusals it caused. */
  seatsLeft?: number | null;
};

const BULK_LIMIT = 500;

/**
 * "Select people, then change them all" — role, Mark active / inactive, department, manager, setup email.
 *
 * For admins only — role ADMIN or the super admin (owner, 31 Oct 2026: "this bulk select should be for
 * admin only") — and never while viewing as somebody, since the changes would be recorded as theirs. That
 * is on top of, not instead of, the per-person rules: each person goes through the very helper the single
 * action uses (`assignUser`, `switchUser`, `resendSetupFor`), one after another, so whatever one change
 * at a time would refuse — your own role or status, the super admin, a switched-off role, a seat that
 * isn't free, a reporting loop the earlier people in the batch just made — is refused here too, for that
 * person only. The rest go ahead. Each person changed gets their own audit entry.
 */
export async function bulkUpdateUsers(input: { ids: string[]; op: BulkUserOp; value?: string | null }): Promise<ActionResult<BulkUserResult>> {
  const session = await requireUser();
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const admin = await actorContext(session.id);
  // The role, not a key (kept in Phase 2, audit L-7): the owner's rule names the admins, no key says "an admin", and
  // `users.manage` reaches below them — each change is still held to its own key in `assignUser`/`switchUser`.
  if (!(admin.isSuperAdmin || admin.role === "ADMIN")) return { ok: false, error: "Only admins can change users in bulk." };

  const ids = [...new Set((Array.isArray(input?.ids) ? input.ids : []).filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return { ok: false, error: "Choose somebody first." };
  if (ids.length > BULK_LIMIT) return { ok: false, error: `Up to ${BULK_LIMIT} people at a time.` };
  const op = input.op;
  if (!["role", "activate", "deactivate", "department", "manager", "resendSetup"].includes(op)) return { ok: false, error: "Unknown change." };
  const value = typeof input.value === "string" && input.value ? input.value : null;
  if (op === "role" && !value) return { ok: false, error: "Choose the role to give them." };
  if (op === "department" && value && !(await db.department.findUnique({ where: { id: value }, select: { id: true } }))) {
    return { ok: false, error: "That department no longer exists." };
  }
  if (op === "manager" && value && !(await db.user.findUnique({ where: { id: value }, select: { id: true } }))) {
    return { ok: false, error: "That manager no longer exists." };
  }

  const targets = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, role: true, active: true, departmentId: true, managerId: true },
  });
  const byId = new Map(targets.map((t) => [t.id, t]));
  const out: BulkUserResult = { done: [], unchanged: [], refused: [] };
  const departmentName = op === "department" && value ? (await db.department.findUnique({ where: { id: value }, select: { name: true } }))?.name : null;
  const managerName = op === "manager" && value ? (await db.user.findUnique({ where: { id: value }, select: { name: true } }))?.name : null;

  for (const id of ids) {
    const t = byId.get(id);
    if (!t) {
      out.refused.push({ id, name: "Unknown", reason: "That user no longer exists." });
      continue;
    }
    // Nothing to do is not a refusal, and not a change to record.
    const unchanged =
      (op === "role" && t.role === value) ||
      (op === "activate" && t.active) ||
      (op === "deactivate" && !t.active) ||
      (op === "department" && t.departmentId === value) ||
      (op === "manager" && t.managerId === value);
    if (unchanged) {
      out.unchanged.push({ id, name: t.name });
      continue;
    }

    let result: ActionResult<unknown>;
    let label: string;
    if (op === "activate" || op === "deactivate") {
      result = await switchUser(admin, id, op === "activate");
      label = op === "activate" ? "switched on (bulk)" : "switched off (bulk)";
    } else if (op === "resendSetup") {
      result = await resendSetupFor(admin, id);
      label = "setup email sent again (bulk)";
    } else {
      // The single edit sends all three; the two not being changed go as they stand, so only the one moving is checked.
      result = await assignUser(admin, {
        id,
        role: op === "role" ? value : t.role,
        departmentId: op === "department" ? value : t.departmentId,
        managerId: op === "manager" ? value : t.managerId,
      });
      label =
        op === "role"
          ? `role changed from ${t.role} to ${value} (bulk)`
          : op === "department"
            ? `department set to ${departmentName ?? "none"} (bulk)`
            : `reporting manager set to ${managerName ?? "none"} (bulk)`;
    }

    if (!result.ok) {
      out.refused.push({ id, name: t.name, reason: result.error });
      continue;
    }
    // The link comes back to whoever sent one only from the person's own page, where it is shown once.
    const invitation = op === "resendSetup" ? (result.data as SetupInvitation) : null;
    out.done.push({ id, name: t.name, ...(invitation && !invitation.emailed ? { note: "the email couldn't be sent; send it again from their page for the link" } : {}) });
    await recordAudit({ userId: admin.id, action: "UPDATE", entityType: "User", entityId: id, entityLabel: `${t.name} — ${label}` });
  }

  if (op === "activate" && out.refused.length > 0) {
    const { entitlements } = await currentTenant();
    out.seatsLeft = entitlements.seats === null ? null : Math.max(0, entitlements.seats - (await seatsInUse()));
  }
  if (out.done.length > 0) {
    revalidatePath("/settings", "layout");
    revalidatePath("/", "layout");
  }
  return { ok: true, data: out };
}

/**
 * Clearing somebody's second factor, so they can enrol a new one.
 *
 * Never while viewing as somebody — it would weaken an account under another person's name, as the password
 * resets below refuse to — and never your own: that is Profile's "Switch off", which asks for your password
 * (owner, 2 Nov 2026 — "Phase 1 security fixes", audit L-5/M-9). Written to the access history.
 */
export async function resetUserTwoFactor(id: string): Promise<ActionResult<null>> {
  const session = await requireUser();
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const admin = await actorContext(session.id);
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) {
    return { ok: false, error: "You can't reset two-factor authentication." };
  }
  if (id === admin.id) return { ok: false, error: "That's you. Switch two-factor off from your profile, where it asks for your password." };

  // Clearing somebody's second factor is a way to take their account, so a super admin's can only
  // be cleared by another super admin.
  const target = await db.user.findUnique({ where: { id }, select: { id: true, name: true, isSuperAdmin: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };
  try {
    assertMayActOnTarget(admin, target);
  } catch (err) {
    return refuse(err);
  }

  await db.user.update({ where: { id }, data: { twoFactorSecretCipher: null, twoFactorEnabledAt: null } });
  // Security audit, 11 Nov 2026 (SEC-22): a lost phone is the usual reason, so whatever was signed in on it ends too.
  // API keys stay: two-factor never guarded them.
  await endSignInsFor(id, { byId: admin.id, keepApiKeys: true });
  await accountsChanged([id], { revoke: "two-factor-reset", by: `admin:${admin.id}` });
  await recordPermissionChange({
    actorUserId: admin.id,
    subjectType: "USER",
    subjectUserId: id,
    changeKind: "TWO_FACTOR_RESET",
    detail: `${admin.name} reset ${target.name}'s two-factor authentication`,
  });
  revalidatePath("/settings", "layout");
  return { ok: true, data: null };
}

// ─── The super admin changing somebody's sign-in email ─────────────────────────────────────────────

export type EmailChanged = {
  email: string;
  /** Not set up yet: their setup email went to the new address — or its link, when it couldn't be sent. */
  setup: SetupInvitation | null;
};

/**
 * The address somebody signs in with, changed by the super admin alone (owner, 25 Nov 2026 — "let super admin edit
 * user email id"): a typo, a new surname, a new domain. Everything they own stays theirs — records hold the account,
 * never its address. Never your own (a stolen session could move the workspace's one unconditional account to its own
 * mailbox), never while viewing as somebody.
 *
 * The address is how they get in, so what hung on the old one ends with it:
 *
 *   · signed out everywhere — and their linked workspaces unlinked — but API keys, password and two-factor stay;
 *   · any unused setup or reset link, which went to the old mailbox;
 *   · the Microsoft, Google or Zoho identity held for them (src/lib/workplace/sign-in.ts): the new address is another
 *     identity there, and would be refused as "a different account" for ever.
 *
 * Both addresses are told; the old one never learns the new. Somebody still to set up gets their setup email again,
 * at the new address.
 */
export async function changeUserEmail(id: string, input: string): Promise<ActionResult<EmailChanged>> {
  const session = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const admin = await actorContext(session.id);
  if (!admin.isSuperAdmin) return { ok: false, error: "Only the super admin can change the email somebody signs in with." };
  const parsed = accountEmail.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Enter a valid email" };
  const email = parsed.data;
  const target = await db.user.findUnique({ where: { id: String(id ?? "") }, select: { id: true, name: true, email: true, active: true, kind: true } });
  if (!target || target.kind !== "MEMBER") return { ok: false, error: "That user no longer exists." };
  if (target.id === admin.id) return { ok: false, error: "You can't change your own sign-in email here." };
  if (target.email.trim().toLowerCase() === email) return { ok: false, error: "That's already their email." };
  const TAKEN = "Somebody here already has that email.";
  if (await db.user.findFirst({ where: { email: { equals: email, mode: "insensitive" }, NOT: { id: target.id } }, select: { id: true } })) return { ok: false, error: TAKEN };

  const waiting = await awaitingSetup(target.id);
  try {
    await db.$transaction(async (tx) => {
      // Only from the address read above: two changes at once don't both tell the same old address.
      const changed = await tx.user.updateMany({ where: { id: target.id, email: target.email }, data: { email } });
      if (changed.count !== 1) throw new EmailMoved();
      await tx.passwordResetToken.deleteMany({ where: { userId: target.id, usedAt: null } });
      await tx.userSsoIdentity.deleteMany({ where: { userId: target.id } });
      await endSignInsFor(target.id, { tx, byId: admin.id, keepApiKeys: true });
    });
  } catch (err) {
    if (err instanceof EmailMoved) return { ok: false, error: "Their email was changed just now. Reload the page and look again." };
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, error: TAKEN };
    throw err;
  }
  clearAccessCache();
  await accountsChanged([target.id], { revoke: "credentials", by: `admin:${admin.id}` });
  await recordAudit({ userId: admin.id, action: "UPDATE", entityType: "User", entityId: target.id, entityLabel: `${target.name} — sign-in email changed from ${target.email} to ${email}` });

  let setup: SetupInvitation | null = null;
  if (target.active && waiting) {
    setup = await sendSetupInvitation({ id: target.id, name: target.name, email }, { by: admin });
  } else if (target.active) {
    const workspace = (await currentTenant()).name;
    const tell = async (to: string, template: string, fields: Record<string, string>) => {
      try {
        await sendPlatformMail({ type: "ACCOUNT", to, ...(await templateMail(template, { name: target.name, workspace, admin: admin.name, ...fields }, { workspace })) });
      } catch {
        // A courtesy: the change has happened, and the super admin knows the new address.
      }
    };
    await tell(email, "account.email-changed", { email });
    await tell(target.email, "account.email-removed", {});
  }
  revalidatePath("/settings", "layout");
  return { ok: true, data: { email, setup } };
}

class EmailMoved extends Error {}

// ─── An admin resetting somebody's password ────────────────────────────────────────────────────────

/**
 * Who an admin may reset a password for, and the account, or why not. Both ways share it:
 *
 *   · `users.manage`, as themselves (never while viewing as somebody), and never their own (Profile is
 *     for that);
 *   · an ordinary admin can't act on the super admin, and a switched-off account can't sign in anyway;
 *   · somebody who hasn't chosen a password yet needs their setup email, not a reset;
 *   · somebody whose sign-in rule is single sign-on only would get a password that lets them in nowhere.
 */
async function passwordTarget(id: string): Promise<
  | { ok: true; admin: Awaited<ReturnType<typeof actorContext>>; target: { id: string; name: string; email: string; role: string; isSuperAdmin: boolean } }
  | { ok: false; error: string }
> {
  const session = await requireUser();
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const admin = await actorContext(session.id);
  if (!(await hasEffectivePermission(admin.id, "users.manage"))) return { ok: false, error: "You can't reset passwords." };
  const target = await db.user.findUnique({
    where: { id: String(id ?? "") },
    select: { id: true, name: true, email: true, role: true, active: true, kind: true, isSuperAdmin: true },
  });
  if (!target || target.kind !== "MEMBER") return { ok: false, error: "That user no longer exists." };
  if (target.id === admin.id) return { ok: false, error: "That's you. Change your own password from your profile." };
  try {
    assertMayActOnTarget(admin, target);
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.message };
    throw err;
  }
  if (!target.active) return { ok: false, error: "Switch them on first. A switched-off account can't sign in." };
  if (await awaitingSetup(target.id)) {
    return { ok: false, error: "They haven't chosen a password yet. Send their setup email instead." };
  }
  const policy = await signInPolicyFor(target);
  if (!policy.password) {
    return {
      ok: false,
      error: lockedOut(policy)
        ? "Their sign-in rule names a sign-in that's switched off, so nothing lets them in. Change how they sign in first."
        : `They sign in with ${waysIn(policy)} only, so a password wouldn't let them in.`,
    };
  }
  return { ok: true, admin, target };
}

/**
 * The one-click reset email: a link to the person's own address to choose a new password, for 24 hours,
 * once. Their current password keeps working until they use it, so a click on the wrong row locks nobody
 * out. It replaces any unused link they have, and shares the per-address limit of "Forgot your password?".
 * When the email can't be sent the link comes back, once, to an admin who holds everything the person
 * holds (`mayPassOnSetupLink`); anybody else is told to try again.
 */
export async function sendPasswordResetEmail(id: string): Promise<ActionResult<{ emailed: true } | { emailed: false; resetUrl: string }>> {
  const checked = await passwordTarget(id);
  if (!checked.ok) return checked;
  const { admin, target } = checked;

  // The address's reset counter across callers is 3 × MAX_FAILURES since RL-07 (src/actions/password-reset.ts): counted at the
  // same threshold here, or an admin's send would lock self-service reset early (security review, 15 Nov 2026).
  const keys = [{ key: `${await tenantKey()}|reset:${target.email.trim().toLowerCase()}`, max: 3 * MAX_FAILURES }];
  const limit = lockoutState(keys);
  if (limit.lockedOut) {
    return { ok: false, error: `Too many password emails for this address. Try again in ${Math.ceil(limit.retryInSeconds / 60)} minutes.` };
  }
  recordFailure(keys);

  const tenant = await currentTenant();
  const token = randomBytes(32).toString("base64url");
  await db.$transaction(async (tx) => {
    await tx.passwordResetToken.deleteMany({ where: { userId: target.id, usedAt: null } });
    await tx.passwordResetToken.create({
      data: { tokenHash: createHash("sha256").update(token).digest("hex"), userId: target.id, expiresAt: new Date(Date.now() + ADMIN_RESET_LINK_TTL_MS) },
    });
  });
  const url = `${await credentialLinkOrigin(tenant)}/reset-password?t=${encodeURIComponent(token)}`;
  await recordAudit({ userId: admin.id, action: "UPDATE", entityType: "User", entityId: target.id, entityLabel: `${target.name} — sent a password reset email` });

  try {
    await sendPlatformMail({
      type: "ACCOUNT",
      to: target.email,
      ...(await templateMail("account.admin-reset", { name: target.name, workspace: tenant.name, admin: admin.name, url }, { workspace: tenant.name })),
    });
    return { ok: true, data: { emailed: true } };
  } catch {
    if (await mayPassOnSetupLink(admin, target.id)) return { ok: true, data: { emailed: false, resetUrl: url } };
    return { ok: false, error: "The email couldn't be sent. Try again in a while." };
  }
}

/**
 * The direct reset: a temporary password the app makes up (`temporaryPassword`), shown to the admin
 * once and never stored but as its hash. The person is signed out everywhere, any password link they
 * had stops working, their lockouts are cleared, and they must choose their own at next sign-in.
 * Two-factor stays on.
 *
 * Only for an admin who holds everything the person holds (`mayPassOnSetupLink`): the password is the
 * power to sign in as them, which must never be more than the admin could already do. The person is
 * emailed that it happened, without the password.
 */
export async function resetPasswordToTemporary(id: string): Promise<ActionResult<{ password: string }>> {
  const checked = await passwordTarget(id);
  if (!checked.ok) return checked;
  const { admin, target } = checked;
  if (!(await mayPassOnSetupLink(admin, target.id))) {
    return {
      ok: false,
      error: "They hold access you don't, so only the super admin can reset their password. You can still send them a reset email.",
    };
  }

  const password = temporaryPassword();
  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: target.id }, data: { passwordHash, mustChangePassword: true } });
    await tx.passwordResetToken.deleteMany({ where: { userId: target.id, usedAt: null } });
    // Security audit, 11 Nov 2026 (SEC-25, SEC-26): their API keys and phone push addresses end with the sign-ins.
    await endSignInsFor(target.id, { tx, now, byId: admin.id });
  });
  clearAccessCache();
  await accountsChanged([target.id], { revoke: "credentials", by: `admin:${admin.id}` });
  const workspace = await tenantKey();
  const email = target.email.trim().toLowerCase();
  clearFailures([`${workspace}|account:${email}`, `${workspace}|reset:${email}`]);

  await recordAudit({ userId: admin.id, action: "UPDATE", entityType: "User", entityId: target.id, entityLabel: `${target.name} — password reset to a temporary one` });
  await logActivity({
    kind: "PASSWORD_CHANGED",
    userId: target.id,
    userName: target.name,
    userEmail: target.email,
    summary: `${target.name}'s password was reset to a temporary one by ${admin.name}`,
  });
  try {
    const tenantName = (await currentTenant()).name;
    await sendPlatformMail({
      type: "ACCOUNT",
      to: target.email,
      ...(await templateMail("account.temporary-reset", { name: target.name, workspace: tenantName, admin: admin.name }, { workspace: tenantName })),
    });
  } catch {
    // The notice is a courtesy: the reset has happened, and the admin is passing the password on.
  }
  revalidatePath("/settings", "layout");
  return { ok: true, data: { password } };
}
