import type { StaffRole } from "@deskzo/control-client";
import { ALL_ROLES, SELLERS } from "@/lib/console-shared/roles";
import { PAGE_ROLES } from "@/lib/console-shared/nav";

import * as consoleActions from "@/actions/platform/console";
import * as consoleAi from "@/actions/platform/console-ai";
import * as consoleAdmin from "@/actions/platform/console-admin";
import * as consoleBilling from "@/actions/platform/console-billing";
import * as consoleDirectory from "@/actions/platform/console-directory";
import * as consoleDomains from "@/actions/platform/console-domains";
import * as consoleOffline from "@/actions/platform/console-offline";
import * as consolePartners from "@/actions/platform/console-partners";
import * as consoleShell from "@/actions/platform/console-shell";
import * as consoleSupport from "@/actions/platform/console-support";
import * as consoleWorkspace from "@/actions/platform/console-workspace";

import * as aiCredits from "@/lib/ai/credits";
import * as bundleData from "@/lib/bundle/console-data";
import * as partnersData from "@/lib/partners/console-data";
import * as adoptionView from "@/lib/platform/adoption-view";
import * as alerts from "@/lib/platform/alerts";
import { consoleZone } from "@/lib/platform/console-clock";
import * as navCountsMod from "@/lib/platform/nav-counts";
import { workspaceMigrationNames } from "@/lib/platform/schema-info";
import * as supportData from "@/lib/support/console";
import * as workspaceData from "@/lib/platform/workspace-data";
import * as workspaceDirectory from "@/lib/platform/workspace-directory";

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

/**
 * The named read functions of a loader module, under `load.<function>`, with the role set of the page
 * they serve. Named one by one: these modules also hold writers (chargeTurn, auditAttachmentOpen) and
 * file access, which are never reachable this way.
 */
function loadersOf(mod: Record<string, unknown>, names: readonly string[], roles: readonly StaffRole[], overrides: Record<string, readonly StaffRole[]> = {}): [string, Op][] {
  return names.map((name) => {
    const fn = mod[name];
    if (typeof fn !== "function") throw new Error(`internal API: ${name} is not a function`);
    return [`load.${name}`, loader(fn as AnyFn, overrides[name] ?? roles)];
  });
}

const sync = (fn: (...a: never[]) => unknown): AnyFn => (async (...a: never[]) => fn(...a)) as AnyFn;

export const OPS: ReadonlyMap<string, Op> = new Map<string, Op>([
  // The console's actions: each checks its own roles.
  ...actionsOf("console", consoleActions),
  ...actionsOf("console-ai", consoleAi),
  ...actionsOf("console-admin", consoleAdmin),
  ...actionsOf("console-billing", consoleBilling),
  ...actionsOf("console-directory", consoleDirectory),
  ...actionsOf("console-domains", consoleDomains),
  ...actionsOf("console-offline", consoleOffline),
  ...actionsOf("console-partners", consolePartners),
  ...actionsOf("console-shell", consoleShell),
  ...actionsOf("console-support", consoleSupport),
  ...actionsOf("console-workspace", consoleWorkspace),

  // What the pages read, with their pages' roles.
  ...loadersOf(workspaceDirectory, ["workspaceDirectory", "directoryFacets", "workspacesCsv", "closedWorkspaces"], page("workspaces")),
  ...loadersOf(workspaceData, ["workspaceNotes", "workspaceHeader", "workspacePlan", "workspaceBilling", "workspaceUsage", "workspaceSupport", "workspaceOps", "workspaceTimeline"], page("workspaces"), { workspaceBilling: SELLERS as readonly StaffRole[] }),
  ...loadersOf(adoptionView, ["workspaceAdoption"], page("workspaces")),
  ...loadersOf(alerts, ["alerts", "alertCounts", "alertsForTenant"], page("alerts")),
  ...loadersOf(aiCredits, ["consoleCreditView"], page("workspaces")),
  ...loadersOf(partnersData, ["workspaceAttribution", "partnerPicker"], page("partners")),
  ...loadersOf(supportData, ["supportRequestsForTenant"], page("support")),
  ...loadersOf(bundleData, ["backupCountFor"], page("backups")),
  ...loadersOf(navCountsMod, ["navCounts"], every),
  ["load.consoleZone", loader(consoleZone as AnyFn, every)],
  ["load.workspaceMigrationNames", loader(sync(workspaceMigrationNames), every)],
]);
