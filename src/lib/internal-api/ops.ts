import type { StaffRole } from "@deskzo/control-client";
import { ALL_ROLES, SELLERS } from "@/lib/console-shared/roles";
import { PAGE_ROLES } from "@/lib/console-shared/nav";

import * as consoleActions from "@/actions/platform/console";
import * as consoleAdmin from "@/actions/platform/console-admin";
import * as consoleBilling from "@/actions/platform/console-billing";
import * as consoleDirectory from "@/actions/platform/console-directory";
import * as consoleShell from "@/actions/platform/console-shell";
import * as consoleSupport from "@/actions/platform/console-support";
import * as consoleWorkspace from "@/actions/platform/console-workspace";

import { navCounts } from "@/lib/platform/nav-counts";
import { closedWorkspaces, directoryFacets, workspaceDirectory } from "@/lib/platform/workspace-directory";
import { workspaceBilling, workspaceHeader, workspaceNotes, workspaceOps, workspacePlan, workspaceSupport, workspaceTimeline, workspaceUsage } from "@/lib/platform/workspace-data";

/**
 * What the admin app may ask the CRM to do, by name. Nothing outside this table can be called.
 *
 * ## Actions
 * The console's own server actions, called as they are: each one starts with `requireStaff(roles)`,
 * which inside an internal call answers with the admin app's staff member (src/lib/internal-api/actor.ts),
 * so the roles, refusals and audit entries are the ones the console always had. Named
 * `<module>.<function>`, e.g. `console.consoleSuspend`.
 *
 * Not here, on purpose: anything about staff accounts, staff sign-in, sessions and authenticators. The
 * admin app owns those in its own database; the CRM keeps only the staff id it is told, for the audit log.
 *
 * ## Loaders
 * What a console page reads. The pages checked the role themselves (`consoleStaff(PAGE_ROLES.x)`), so
 * each loader here carries the same role set, checked before it runs. Named `load.<function>`.
 *
 * The table grows one console area at a time (docs/internal-api.md lists what is in and what is next).
 */

type AnyFn = (...args: never[]) => Promise<unknown>;
export type Op = { kind: "action"; fn: AnyFn } | { kind: "loader"; fn: AnyFn; roles: readonly StaffRole[] };

/** Staff-account actions the admin app does itself; never callable here. */
const STAFF_ACCOUNT_ACTIONS = new Set([
  "consoleAddStaff",
  "consoleSetStaffRole",
  "consoleDeactivateStaff",
  "consoleEndStaffSessions",
  "consoleResetStaffTwoFactor",
  "consoleNewSetupLink",
  "consoleSetStaffTwoFactor",
  "consoleEndStaffSession",
  "consoleEndMySession",
  "consoleEndMyOtherSessions",
  "consoleReactivateStaff",
  "consoleMyPasswordLink",
  "consoleTouch",
]);

function actionsOf(prefix: string, mod: Record<string, unknown>): [string, Op][] {
  return Object.entries(mod)
    .filter(([name, fn]) => typeof fn === "function" && !STAFF_ACCOUNT_ACTIONS.has(name))
    .map(([name, fn]) => [`${prefix}.${name}`, { kind: "action", fn: fn as AnyFn }]);
}

const every = ALL_ROLES as readonly StaffRole[];
const page = (key: keyof typeof PAGE_ROLES): readonly StaffRole[] => (PAGE_ROLES[key] as readonly StaffRole[] | undefined) ?? every;

function loader(fn: AnyFn, roles: readonly StaffRole[]): Op {
  return { kind: "loader", fn, roles };
}

export const OPS: ReadonlyMap<string, Op> = new Map<string, Op>([
  // Phase 1: workspaces (directory, Workspace 360, hold/reopen/close, plans, billing, support entry, admin reset).
  ...actionsOf("console", consoleActions),
  ...actionsOf("console-admin", consoleAdmin),
  ...actionsOf("console-billing", consoleBilling),
  ...actionsOf("console-directory", consoleDirectory),
  ...actionsOf("console-shell", consoleShell),
  ...actionsOf("console-support", consoleSupport),
  ...actionsOf("console-workspace", consoleWorkspace),

  ["load.navCounts", loader(navCounts as AnyFn, every)],
  ["load.workspaceDirectory", loader(workspaceDirectory as AnyFn, page("workspaces"))],
  ["load.directoryFacets", loader(directoryFacets as AnyFn, page("workspaces"))],
  ["load.closedWorkspaces", loader(closedWorkspaces as AnyFn, page("workspaces"))],
  ["load.workspaceHeader", loader(workspaceHeader as AnyFn, page("workspaces"))],
  ["load.workspaceNotes", loader(workspaceNotes as AnyFn, page("workspaces"))],
  ["load.workspacePlan", loader(workspacePlan as AnyFn, page("workspaces"))],
  ["load.workspaceBilling", loader(workspaceBilling as AnyFn, SELLERS as readonly StaffRole[])],
  ["load.workspaceUsage", loader(workspaceUsage as AnyFn, page("workspaces"))],
  ["load.workspaceSupport", loader(workspaceSupport as AnyFn, page("workspaces"))],
  ["load.workspaceOps", loader(workspaceOps as AnyFn, page("workspaces"))],
  ["load.workspaceTimeline", loader(workspaceTimeline as AnyFn, page("workspaces"))],
]);
