import type { PermissionChangeKind } from "@prisma/client";
import type { PillTone } from "@/components/access-control/ui";

/**
 * How a permission change is named, everywhere the audit log names one: the table's pill, the Action
 * filter, the drawer and the CSV. The wording is Settings › Staff's change history's
 * (src/components/settings/change-history.tsx), with the five role kinds it never listed.
 *
 * A plain module, read by the server action and the client table alike — a `"use server"` file can
 * only export functions, so the list of kinds cannot live beside the query that checks against it.
 */
export const PERMISSION_CHANGE_KIND_LABEL: Record<PermissionChangeKind, string> = {
  GRANT: "Granted",
  REVOKE: "Revoked",
  RESET_TO_DEFAULT: "Reset to default",
  PRESET_APPLIED: "Preset applied",
  ROLE_ASSIGNED: "Role changed",
  MANAGER_CHANGED: "Reporting line changed",
  DEPARTMENT_CHANGED: "Department changed",
  USER_CREATED: "User created",
  USER_ACTIVATED: "Account reactivated",
  USER_DEACTIVATED: "Account deactivated",
  TWO_FACTOR_RESET: "Two-factor reset",
  SUPER_ADMIN_GRANTED: "Made super admin",
  SUPER_ADMIN_REVOKED: "Super admin removed",
  ROLE_CREATED: "Role created",
  ROLE_RENAMED: "Role renamed",
  ROLE_DELETED: "Role deleted",
  ROLE_DEACTIVATED: "Role deactivated",
  ROLE_ACTIVATED: "Role reactivated",
};

export const PERMISSION_CHANGE_KINDS = Object.keys(PERMISSION_CHANGE_KIND_LABEL) as PermissionChangeKind[];

export function isPermissionChangeKind(value: unknown): value is PermissionChangeKind {
  return typeof value === "string" && (PERMISSION_CHANGE_KINDS as string[]).includes(value);
}

/** Green for what opens access, red for what closes it, amber for what reaches further than one key. */
export const PERMISSION_CHANGE_KIND_TONE: Partial<Record<PermissionChangeKind, PillTone>> = {
  GRANT: "green",
  USER_ACTIVATED: "green",
  ROLE_ACTIVATED: "green",
  REVOKE: "red",
  USER_DEACTIVATED: "red",
  SUPER_ADMIN_REVOKED: "red",
  ROLE_DELETED: "red",
  ROLE_DEACTIVATED: "red",
  SUPER_ADMIN_GRANTED: "amber",
  PRESET_APPLIED: "amber",
  MANAGER_CHANGED: "amber",
  RESET_TO_DEFAULT: "brand",
  ROLE_ASSIGNED: "brand",
};

/** A stored answer in the words the matrix uses: nothing written is the role's own default. */
export function answerWord(allowed: boolean | null): "ALLOW" | "DENY" | "DEFAULT" {
  return allowed === true ? "ALLOW" : allowed === false ? "DENY" : "DEFAULT";
}

/** The audit page's search params, named once so the filters, the links and the Clear button agree. */
export const AUDIT_FILTER_PARAMS = ["q", "actor", "user", "role", "kind", "module", "result", "record", "from", "to"] as const;
