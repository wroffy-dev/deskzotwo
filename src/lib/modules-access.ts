import { cache } from "react";
import { db } from "@/lib/db";
import { permissionsFor } from "@/lib/authz/resolve";
import { entitledModuleKeys, featureAvailable, moduleEntitled } from "@/lib/entitlements";
import { getModuleDefinition, type CountryFeature, type NavFact } from "@/lib/modules";
import { holdsLiveCard, onEventTeam } from "@/lib/cards/holder";
import { hiddenPagesFor } from "@/lib/staff/hidden-pages";
import { deskMenu } from "@/lib/desks/menu";
import { decideModuleAccess, openModuleKeys, simpleMenuFor, type ModuleAccess, type NavAccess } from "@/lib/navigation";
import type { PermissionKey } from "@/lib/permissions";
import { requireUser } from "@/lib/session";
import { currentTenant } from "@/lib/tenancy/resolve";
import { keptInTally } from "@/lib/tally/books";
import { NoAccessError } from "@/lib/no-access";

/**
 * Whether a module is there for this workspace, and for this person. Four answers, from the hardest
 * boundary to the softest:
 *
 *   · not-entitled   — the workspace's plan does not include it (src/lib/entitlements.ts). A line
 *                      nothing crosses: its actions refuse too (`requireModuleUser`).
 *   · switched-off   — in the plan, but the company switched it off in Settings. Its pages and
 *                      links go, and the actions only its own pages use (`requireModuleAccess`);
 *                      the actions other modules' screens use stay reachable to them.
 *   · no-permission  — on, but this person's role cannot see it (the module's `*.view`, or its
 *                      section unticked) — the same for its pages and its own actions.
 *   · available
 *
 * The plan travels with the workspace through the registry, so none of this queries plans. The
 * company's switches are read once per request, and the person's permissions resolved once.
 *
 * The rule itself is `decideModuleAccess` (src/lib/navigation.ts), so the gates here and the menus
 * built from `accessContextFor` cannot disagree about what somebody may open.
 */

export type { ModuleAccess } from "@/lib/navigation";

/** A module outside the workspace's plan, reached anyway — by a stale page or a hand-made request. */
export class ModuleNotInPlan extends NoAccessError {
  constructor(message: string) {
    super(message, "plan");
  }
}

/**
 * A module in the plan that isn't open to this person — its section unticked for their role, its view permission not
 * theirs, or the company switched it off — reached anyway, by a page left open across the change or a hand-made
 * request (owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-6). Thrown, as `ModuleNotInPlan` is. Both are a
 * `NoAccessError`, so a page that meets one while it loads says so rather than "something went wrong" (src/lib/no-access.ts).
 */
export class ModuleNotOpen extends NoAccessError {}

/** Whether this workspace's plan includes the module. */
export async function isModuleEntitled(key: string): Promise<boolean> {
  const tenant = await currentTenant();
  return moduleEntitled(tenant.entitlements, tenant.country, key);
}

/** A country-bound part of a module: e-invoices and e-way bills are India's. */
export async function countryFeatureAvailable(feature: CountryFeature): Promise<boolean> {
  return featureAvailable((await currentTenant()).country, feature);
}

/** The company's own switches, once per request. Absent means on: nobody has switched it off. */
const switches = cache(async (): Promise<Map<string, boolean>> => {
  const rows = await db.systemModule.findMany({ select: { key: true, enabled: true } });
  return new Map(rows.map((r) => [r.key, r.enabled]));
});

export async function switchedOn(key: string): Promise<boolean> {
  if (getModuleDefinition(key)?.core) return true;
  return (await switches()).get(key) ?? true;
}

/**
 * For work with nobody signed in — scheduled jobs, the public pages (forms, the portal, the visitor
 * tablet), notifications: in the plan and switched on. No person, so no permission.
 */
export async function moduleAvailableForTenant(key: string): Promise<boolean> {
  return (await isModuleEntitled(key)) && (await switchedOn(key));
}

export async function moduleAccessFor(userId: string, key: string): Promise<ModuleAccess> {
  const def = getModuleDefinition(key);
  if (!def) return "available";
  const [entitled, on, held] = await Promise.all([isModuleEntitled(key), switchedOn(key), permissionsFor(userId)]);
  return decideModuleAccess(def, { entitled, switchedOn: on }, new Set(held));
}

export type AccessContext = NavAccess & { userId: string; permissions: PermissionKey[] };

/**
 * Everything the menus, the Create menu, the side rail and the dashboard are built from — the
 * workspace's plan and switches and this person's permissions, read once for the request, then every
 * module decided in memory by the same rule `moduleAccessFor` uses. No query per link.
 *
 * Pass the id the request acts as (`requireUser().id`), so an admin viewing as somebody gets that
 * person's menu.
 */
export const accessContextFor = cache(async (userId: string): Promise<AccessContext> => {
  const [tenant, on, permissions, hiddenPages, booksInTally] = await Promise.all([currentTenant(), switches(), permissionsFor(userId), hiddenPagesFor(userId), keptInTally()]);
  const openModules = openModuleKeys(
    (def) => ({ entitled: moduleEntitled(tenant.entitlements, tenant.country, def.key), switchedOn: on.get(def.key) ?? true }),
    new Set<string>(permissions),
  );
  const facts: NavFact[] = [];
  if (openModules.includes("cards")) {
    if (await holdsLiveCard(userId)) facts.push("cardholder");
    if (permissions.includes("cards.manage") || (await onEventTeam(userId))) facts.push("eventTeam");
  }
  // The internal help desk: whether there's a desk to ask, and the desks they work at.
  const help = openModules.includes("desks") ? await deskMenu(userId) : null;
  if (help?.open) facts.push("helpDesk");
  // Only what Deskzo Pipeline sells: the simple menu (src/lib/navigation.ts `simpleMenuFor`).
  const simple = !tenant.entitlements.all && simpleMenuFor(entitledModuleKeys(tenant.entitlements, tenant.country), tenant.entitlements.plans);
  return { userId, country: tenant.country, permissions, openModules, facts, simple, hiddenPages, booksInTally, desks: help?.desks ?? [] };
});

/**
 * The first line of every action a module owns (src/lib/module-actions.ts, enforced by
 * `check:module-guards`): somebody signed in, in a workspace whose plan includes the module — or,
 * given several, any of them. Returns the same user `requireUser` does.
 *
 * Only the plan is checked here. The company's switch hides a module's pages, and nothing more: an
 * order form still looks up items with the Items module switched off, as it always has. An action
 * only the module's own pages use asks `requireModuleAccess` instead.
 */
export async function requireModuleUser(modules: string | readonly string[]) {
  const user = await requireUser();
  const keys = typeof modules === "string" ? [modules] : modules;
  const unknown = keys.find((key) => !getModuleDefinition(key));
  if (unknown || !keys.length) throw new Error(`requireModuleUser: no module "${unknown ?? ""}".`);
  const tenant = await currentTenant();
  if (!keys.some((key) => moduleEntitled(tenant.entitlements, tenant.country, key))) {
    const label = getModuleDefinition(keys[0]!)!.label;
    throw new ModuleNotInPlan(`${label} is not part of this workspace's plan.`);
  }
  return user;
}

/**
 * The first line of an action only the module's own pages use (owner, 3 Nov 2026 — Phase 2 permission fixes, audit
 * L-6): everything `requireModuleUser` asks, and then that the module — or, given several, one of them — is open to
 * this person by the rule its pages and menus use (`moduleAccessFor`, `decideModuleAccess`): switched on, its view
 * permission held, its section ticked for their role. A person whose role has Tasks unticked can't open the Tasks
 * page; now they can't post to its actions either. Returns the same user.
 *
 * Asked as whoever the request acts as (`requireUser`), so an admin viewing as somebody is refused what that person
 * would be, as their menu shows. An action another module's screens use — the order form looking up items — stays
 * on `requireModuleUser` (src/lib/module-actions.ts `SHARED_ACTIONS`), so taking a section away never breaks a page
 * the person can still open.
 *
 * Refused by throwing, as the plan is: a `ModuleNotOpen` naming the module.
 */
export async function requireModuleAccess(modules: string | readonly string[]) {
  const user = await requireModuleUser(modules);
  const keys = typeof modules === "string" ? [modules] : modules;
  const answers = await Promise.all(keys.map((key) => moduleAccessFor(user.id, key)));
  if (!answers.includes("available")) {
    // The module the person has in the plan, if several are named — that's the one they'd look for.
    const named = keys[answers.findIndex((a) => a !== "not-entitled")] ?? keys[0]!;
    throw new ModuleNotOpen(`${getModuleDefinition(named)!.label} isn't open to you.`);
  }
  return user;
}
