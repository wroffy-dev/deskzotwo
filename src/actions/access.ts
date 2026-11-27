"use server";

import { clipOrNull, TEXT_MAX } from "@/lib/text/bounded";
import { revalidatePath } from "next/cache";
import type { Role } from "@/lib/roles";
import { db } from "@/lib/db";
import { roleDefault, rolePermits } from "@/lib/authz/role-permission";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import {
  actorContext,
  assertGrantWithinOwnAuthority,
  assertKeepsOwnAccessAdmin,
  assertMayActOnTarget,
  assertNotSelf,
  AuthzError,
  OWN_ACCESS_KEYS,
} from "@/lib/authz/guards";
import { recordPermissionChange } from "@/lib/authz/audit";
import { getPermissionDefinition, PERMISSIONS, type PermissionKey } from "@/lib/permissions";
import { getPreset, presetDiff } from "@/lib/authz/presets";
import { workspaceClock } from "@/lib/time/workspace";

import type { ActionResult } from "@/actions/company";

/**
 * Per-user grants, role presets, and the super-admin flag.
 *
 * Kept apart from `src/actions/permission.ts`, which answers questions; everything here changes
 * who can do what. All of it runs through the guards in src/lib/authz/guards.ts — the rules that
 * are code rather than configuration, because a control you can switch off from inside the
 * application is one that eventually gets switched off.
 */

function refuse(err: unknown): ActionResult<never> {
  if (err instanceof AuthzError) return { ok: false, error: err.message };
  throw err;
}

async function mayAdminister() {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  const allowed = actor.isSuperAdmin || (await can(actor.id, "permissions.manage"));
  return { actor, allowed };
}

// ─── Per-user grants ──────────────────────────────────────────────────────────────────────────

/**
 * Gives or denies one person one permission, regardless of their role.
 *
 * This is what makes the whole model usable in a real office: somebody covering maternity leave,
 * an accountant who also sells, a new joiner who should not touch payroll for a month. Without it
 * the only way to give one person one capability is to widen the entire role, which is how a
 * permission system quietly becomes decorative.
 */
/**
 * The moment a dated grant stops applying: the end of that day on the workspace's clock — the
 * midnight that begins the next one, so a reader names the day before it (`describeSource`).
 *
 * Not by appending \`T23:59:59.999Z\`, which is UTC — in India that is half past five the following
 * morning, so a grant given "until 30 Nov" quietly ran into the 1st. Nor the server's own midnight,
 * which it was until workspaces had zones: on a server in UTC, the same five and a half hours.
 */
async function expiryFromDate(date: string | null | undefined): Promise<Date | null> {
  if (!date) return null;
  return (await workspaceClock()).endOfDay(date);
}

/**
 * The expiry a grant was sent, or why it can't be used (security review, 15 Nov 2026): a date that didn't read as one
 * came back null — and null means permanent, so a garbage date made a temporary grant last for ever. Only nothing at
 * all means permanent now; anything else must be a real YYYY-MM-DD day.
 */
async function readExpiry(date: unknown): Promise<{ ok: true; at: Date | null; day: string | null } | { ok: false; error: string }> {
  if (date === null || date === undefined || date === "") return { ok: true, at: null, day: null };
  const day = typeof date === "string" ? date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: "Give the end date as a day — YYYY-MM-DD." };
  const at = await expiryFromDate(day);
  if (!at || Number.isNaN(at.getTime())) return { ok: false, error: "That end date isn't a real day." };
  return { ok: true, at, day };
}

export async function setUserPermission(input: {
  userId: string;
  permission: PermissionKey | string;
  allowed: boolean;
  reason?: string;
  expiresAt?: string | null;
}): Promise<ActionResult<null>> {
  const { actor, allowed: mayManage } = await mayAdminister();
  if (!mayManage) return { ok: false, error: "You can't change permissions." };

  const def = getPermissionDefinition(input.permission);
  if (!def) return { ok: false, error: "Unknown permission." };

  const target = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, name: true, isSuperAdmin: true },
  });
  if (!target) return { ok: false, error: "That user no longer exists." };

  try {
    assertMayActOnTarget(actor, target);
    /**
     * Nobody writes an exception for themselves, allow or deny (owner, 2 Nov 2026 — Phase 1 security
     * fixes, audit M-2). Allowing yourself a key you already hold looks harmless, but it is how a
     * temporary grant becomes permanent — re-saved with no end date by the person holding it — and a
     * personal row outlives a later narrowing of the role. The person screens already refuse it
     * (src/actions/person-access.ts `checkedTarget`); this action is reachable on its own.
     */
    assertNotSelf(actor.id, input.userId, "permission exceptions");
    // The rule that stops delegation from becoming escalation: you may only hand out what you hold.
    await assertGrantWithinOwnAuthority(actor, input.permission);
  } catch (err) {
    return refuse(err);
  }

  // A super admin already holds everything, so a row for them would be a lie that somebody later
  // reads as meaningful.
  if (target.isSuperAdmin) {
    return { ok: false, error: `${target.name} is a super admin and already holds every permission.` };
  }

  const existing = await db.userPermission.findUnique({
    where: { user_permission: { userId: input.userId, permission: input.permission } },
    select: { allowed: true },
  });

  const expiry = await readExpiry(input.expiresAt);
  if (!expiry.ok) return { ok: false, error: expiry.error };
  const expiresAt = expiry.at;
  // The reason, capped (owner, 15 Nov 2026 — input bounds).
  const reason = clipOrNull(input.reason, TEXT_MAX.paragraph);
  await db.userPermission.upsert({
    where: { user_permission: { userId: input.userId, permission: input.permission } },
    update: {
      allowed: input.allowed,
      reason,
      grantedById: actor.id,
      expiresAt,
    },
    create: {
      userId: input.userId,
      permission: input.permission,
      allowed: input.allowed,
      reason,
      grantedById: actor.id,
      expiresAt,
    },
  });

  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "USER",
    subjectUserId: input.userId,
    permission: input.permission,
    fromAllowed: existing?.allowed ?? null,
    toAllowed: input.allowed,
    changeKind: input.allowed ? "GRANT" : "REVOKE",
    detail: `${def.label} ${input.allowed ? "granted to" : "denied to"} ${target.name}${reason ? ` — ${reason}` : ""}`,
  });

  revalidatePath("/settings", "layout");
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

/** Removes a personal exception, returning the person to whatever their role gives them. */
export async function clearUserPermission(userId: string, permission: string): Promise<ActionResult<null>> {
  const { actor, allowed } = await mayAdminister();
  if (!allowed) return { ok: false, error: "You can't change permissions." };

  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, isSuperAdmin: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };

  const existing = await db.userPermission.findUnique({
    where: { user_permission: { userId, permission } },
    select: { allowed: true },
  });

  try {
    assertMayActOnTarget(actor, target);

    /**
     * Removing an exception is granting or revoking, depending on which way it pointed — and this
     * path checked neither.
     *
     * The dangerous half is a **deny**. A super admin who denies an ordinary admin `payments.delete`
     * writes a UserPermission row; that admin could then call this and remove it, because
     * `assertMayActOnTarget` only asks whether the *target* is a super admin and the target was
     * themselves. The deny evaporated and `adminDefault` handed the key straight back.
     */
    if (existing && !existing.allowed) {
      assertNotSelf(actor.id, userId, "own permission exceptions");
    }
    // And you may not restore, by deletion, a capability you could not have granted outright.
    await assertGrantWithinOwnAuthority(actor, permission);
  } catch (err) {
    return refuse(err);
  }

  await db.userPermission.deleteMany({ where: { userId, permission } });
  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "USER",
    subjectUserId: userId,
    permission,
    changeKind: "RESET_TO_DEFAULT",
    detail: `${permission} for ${target.name} returned to their role default`,
  });
  revalidatePath("/settings", "layout");
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

/** Every personal exception on one account, for the review drawer. */
export async function userPermissionOverrides(userId: string) {
  const session = await requireUser();
  if (userId !== session.id && !(await can(session.id, "permissions.view"))) return [];

  const rows = await db.userPermission.findMany({
    where: { userId },
    select: {
      permission: true,
      allowed: true,
      reason: true,
      expiresAt: true,
      createdAt: true,
      grantedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  /**
   * Whether each row is still in force, worked out here.
   *
   * The resolver filters expired rows and this query did not, so the drawer listed a grant that
   * lapsed last year in success-green — directly contradicting the resolved row a few inches below
   * saying the person does not hold it. Deciding it here also keeps the clock out of render, where
   * reading it makes two renders disagree.
   */
  const now = Date.now();
  return rows.map((row) => ({
    ...row,
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
  }));
}

// ─── Presets ──────────────────────────────────────────────────────────────────────────────────

/** What applying this preset would change, so the click is informed rather than a gamble. */
export async function previewPreset(presetKey: string) {
  const { allowed } = await mayAdminister();
  if (!allowed) return null;

  const preset = getPreset(presetKey);
  if (!preset) return null;

  const rows = await db.rolePermission.findMany({ where: { role: preset.role } });
  const overrides = new Map(rows.map((r) => [r.permission, r.allowed]));
  const current: Record<string, boolean> = {};
  for (const def of PERMISSIONS) {
    // An admin preset starts from everything but the super-admin-only keys, as the resolver reads an
    // admin. What `applyPreset` leaves the role holding is exactly the preset's list, so this diff is
    // what it does (audit M-3).
    current[def.key] = overrides.get(def.key) ?? roleDefault(def, preset.role);
  }

  return { preset, ...presetDiff(preset, current) };
}

/**
 * Applies a preset to a role, in one transaction.
 *
 * Afterwards the role holds exactly what the preset lists, as `previewPreset` said it would: a key the
 * preset grants gets an allow row, a key it leaves out that the role would hold by default gets a deny
 * row, and any other row is cleared (see below for why not a deny everywhere). Menu sections are left
 * alone.
 */
export async function applyPreset(presetKey: string): Promise<ActionResult<{ granted: number; revoked: number }>> {
  const { actor, allowed } = await mayAdminister();
  if (!allowed) return { ok: false, error: "You can't change permissions." };

  const preset = getPreset(presetKey);
  if (!preset) return { ok: false, error: "Unknown preset." };
  if (preset.role === "ADMIN" && !actor.isSuperAdmin) {
    return { ok: false, error: "Only a super admin can change what admins can do." };
  }

  const wanted = new Set<string>(preset.permissions);

  // A preset may not hand out anything the person applying it does not hold.
  if (!actor.isSuperAdmin) {
    for (const key of preset.permissions) {
      try {
        await assertGrantWithinOwnAuthority(actor, key);
      } catch (err) {
        return refuse(err);
      }
    }
  }

  // Nor take away, from the applier's own role, their way back into these screens. A key the preset
  // leaves out is switched off below, whatever its default, so the role holds it afterwards only if
  // the preset lists it.
  try {
    for (const key of OWN_ACCESS_KEYS) {
      await assertKeepsOwnAccessAdmin(actor, preset.role, key, wanted.has(key));
    }
  } catch (err) {
    return refuse(err);
  }

  let granted = 0;
  let revoked = 0;

  /**
   * A preset states what a role *has*, not what it is forbidden.
   *
   * This used to write an explicit row for all seventy-four keys — `allowed: false` for every key
   * the preset did not mention. An explicit deny outranks both the registry default and what was then
   * downline inheritance (since retired), so a single preset click permanently severed both: a sales manager
   * who reached `expenses.approve` by managing an accounts executive lost it, with no row anywhere
   * saying why, and no amount of re-granting the report's access brought it back.
   *
   * Keys the preset grants get a row; keys it does not are *cleared*, so absence goes on meaning
   * "fall through to the default" — which is what makes a registry default useful at all.
   *
   * But not a key the role holds by default (owner, 2 Nov 2026 — Phase 1 security fixes, audit M-3).
   * Clearing *that* row put the default back: a key somebody had switched off for the role returned
   * the moment anybody applied a preset — somebody who didn't hold it themselves, on their own role
   * too — while the preview had listed it as taken away. "Anything not listed is explicitly switched
   * off" (src/lib/authz/presets.ts) is now what happens: such a key gets a deny row, which only takes
   * away, so it needs no authority; a key with no default is cleared as before, and off either way.
   */
  await db.$transaction(async (tx) => {
    for (const def of PERMISSIONS) {
      // Which sections the role sees is left as it is (src/lib/permissions.ts `everyone`).
      if (def.everyone) continue;
      const shouldHave = wanted.has(def.key);
      const was = await rolePermits(preset.role, def.key);
      if (was !== shouldHave) {
        if (shouldHave) granted += 1;
        else revoked += 1;
      }

      if (shouldHave || roleDefault(def, preset.role)) {
        await tx.rolePermission.upsert({
          where: { role_permission: { role: preset.role, permission: def.key } },
          update: { allowed: shouldHave },
          create: { role: preset.role, permission: def.key, allowed: shouldHave },
        });
      } else {
        await tx.rolePermission.deleteMany({ where: { role: preset.role, permission: def.key } });
      }
    }
  });

  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "ROLE",
    subjectRole: preset.role,
    changeKind: "PRESET_APPLIED",
    detail: `Applied "${preset.label}" to ${preset.role}: ${granted} granted, ${revoked} revoked`,
  });

  revalidatePath("/settings", "layout");
  revalidatePath("/", "layout");
  return { ok: true, data: { granted, revoked } };
}

// ─── The super-admin flag ─────────────────────────────────────────────────────────────────────

/**
 * There is no action here that grants super admin, and that is the design.
 *
 * `setSuperAdmin` used to live at this point in the file: an existing super admin could promote
 * anybody from the access drawer. It is gone, along with its two buttons, because the account it
 * creates is the one account every permission check short-circuits for — it holds everything
 * unconditionally, no permission row is consulted for it, and it cannot be impersonated. One
 * account being outside the permission system is a decision somebody made once. A button that
 * makes more of them turns that decision into a habit, and the permission system stops describing
 * who can do what.
 *
 * So the rule is now enforced in two places that do not depend on this file being read:
 *
 *   · `users_one_super_admin`, a partial unique index, refuses to create a second.
 *   · `users_require_remaining_super_admin`, a trigger, refuses to remove the last.
 *
 * Exactly one, always. Moving it needs database access —
 * `npx tsx scripts/grant-super-admin.ts <email>` transfers it — which is the right bar for an
 * account that can do everything, and the same bar as restoring a backup or reading a dump.
 *
 * What a super admin *can* still do from the app is make somebody an **admin**: that is
 * `users.assignRole`, which is `superAdminOnly` in the registry, so only a super admin can hand it
 * out. An admin is inside the permission system and can be reviewed, narrowed and revoked, which is
 * precisely the difference.
 */

/** The authorization change history, for the access-review screen. */
export async function permissionChangeHistory(params: { userId?: string; role?: Role; limit?: number } = {}) {
  const session = await requireUser();
  if (!(await can(session.id, "permissions.view"))) return [];

  return db.permissionChange.findMany({
    where: {
      ...(params.userId ? { subjectUserId: params.userId } : {}),
      ...(params.role ? { subjectRole: params.role } : {}),
    },
    select: {
      id: true,
      changeKind: true,
      permission: true,
      fromAllowed: true,
      toAllowed: true,
      detail: true,
      createdAt: true,
      subjectType: true,
      subjectRole: true,
      actor: { select: { id: true, name: true } },
      subjectUser: { select: { id: true, name: true } },
      impersonatedByUserId: true,
    },
    orderBy: { createdAt: "desc" },
    take: params.limit ?? 100,
  });
}

/**
 * Every personal exception in the company, in one list.
 *
 * The screen an auditor opens first, and the one question the app could not answer without opening
 * thirty drawers one at a time: what temporary access is live right now, and what has quietly
 * lapsed. Sorted so the two things worth acting on are at the top — rows that have already expired,
 * then rows expiring soonest — with permanent exceptions last.
 *
 * A single query. No resolution: an exception is a stored fact, not a derived one.
 */
const EXCEPTION_PAGE = 100;

export async function listPermissionExceptions(params: { scope?: "dated" | "all"; limit?: number } = {}) {
  const session = await requireUser();
  if (!(await can(session.id, "permissions.view"))) {
    return { rows: [], total: 0, lapsed: 0, endingSoon: 0, shown: 0 };
  }

  const rows = await db.userPermission.findMany({
    select: {
      permission: true,
      allowed: true,
      reason: true,
      expiresAt: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true, role: true, active: true } },
      grantedBy: { select: { id: true, name: true } },
    },
  });

  const now = Date.now();

  const mapped = rows
    .map((row) => {
      const def = getPermissionDefinition(row.permission);
      return {
        userId: row.user.id,
        userName: row.user.name,
        userEmail: row.user.email,
        userRole: row.user.role,
        userActive: row.user.active,
        permission: row.permission,
        // A key removed from the registry leaves its rows behind; say so rather than showing blank.
        label: def?.label ?? `${row.permission} (no longer a permission)`,
        tier: def?.tier ?? "standard",
        allowed: row.allowed,
        reason: row.reason,
        grantedById: row.grantedBy?.id ?? null,
        grantedByName: row.grantedBy?.name ?? null,
        grantedOn: row.createdAt,
        expiresAt: row.expiresAt,
        expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
      };
    })
    .sort((a, b) => {
      // Lapsed first, then soonest to lapse, then the permanent ones.
      const rank = (r: typeof a) => (r.expired ? 0 : r.expiresAt ? 1 : 2);
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      if (a.expiresAt && b.expiresAt) return a.expiresAt.getTime() - b.expiresAt.getTime();
      return a.userName.localeCompare(b.userName);
    });

  const week = now + 7 * 86_400_000;
  const lapsed = mapped.filter((r) => r.expired).length;
  const endingSoon = mapped.filter((r) => !r.expired && r.expiresAt && r.expiresAt.getTime() <= week).length;

  /**
   * Capped, and the cap is stated.
   *
   * A company with a tidy permission story has a handful of these; this database has 737, and
   * rendering every one of them with its own row of buttons made the tab take nine seconds. The
   * sort above already puts what needs acting on first, so a cap costs nothing an administrator was
   * going to do — but a silently truncated list reads as "that is all of them", so the count comes
   * back with it.
   */
  /**
   * Everything, unless asked to narrow it.
   *
   * An earlier version of this defaulted to rows that carry an expiry, on the theory that dated
   * grants are the ones needing attention. That hid every permanent exception — which is to say it
   * hid the ones an audit most wants: a salesperson permanently granted payroll is a far worse fact
   * than a cover-for-leave grant that ends on Friday. The sort already puts what is urgent first.
   */
  const scoped = params.scope === "dated" ? mapped.filter((r) => r.expiresAt !== null) : mapped;
  const limit = params.limit ?? EXCEPTION_PAGE;

  return {
    rows: scoped.slice(0, limit),
    shown: Math.min(scoped.length, limit),
    total: mapped.length,
    lapsed,
    endingSoon,
  };
}

/**
 * Extends a live exception without re-stating it.
 *
 * "This cover is running another fortnight" should not require re-typing the reason and re-picking
 * the permission, which is how a temporary grant gets made permanent by accident.
 */
export async function extendUserPermission(input: {
  userId: string;
  permission: string;
  /** A date, or null to make it permanent. */
  expiresAt: string | null;
}): Promise<ActionResult<null>> {
  const { actor, allowed: mayManage } = await mayAdminister();
  if (!mayManage) return { ok: false, error: "You can't change permissions." };

  const row = await db.userPermission.findUnique({
    where: { user_permission: { userId: input.userId, permission: input.permission } },
    select: { allowed: true },
  });
  if (!row) return { ok: false, error: "That exception no longer exists." };

  const target = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, name: true, isSuperAdmin: true },
  });
  if (!target) return { ok: false, error: "That user no longer exists." };

  try {
    assertMayActOnTarget(actor, target);
    // Extending a grant is granting; extending a deny is not, but shortening one is — so the
    // authority check applies either way rather than being reasoned about per case.
    await assertGrantWithinOwnAuthority(actor, input.permission);
    // Nor on your own row, whichever way it points (audit M-2, 2 Nov 2026): it was refused only for a
    // deny, so the holder of a temporary grant could make it permanent themselves.
    assertNotSelf(actor.id, input.userId, "permission exceptions");
  } catch (err) {
    return refuse(err);
  }

  const expiry = await readExpiry(input.expiresAt);
  if (!expiry.ok) return { ok: false, error: expiry.error };
  await db.userPermission.update({
    where: { user_permission: { userId: input.userId, permission: input.permission } },
    data: { expiresAt: expiry.at },
  });

  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "USER",
    subjectUserId: input.userId,
    permission: input.permission,
    changeKind: row.allowed ? "GRANT" : "REVOKE",
    detail: expiry.day
      ? `${input.permission} for ${target.name} now runs until ${expiry.day}`
      : `${input.permission} for ${target.name} made permanent`,
  });

  revalidatePath("/settings", "layout");
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}
