import type { AccessRow } from "@/actions/access-levels";

/**
 * The shapes the Roles & Permissions list and the role wizard are handed: plain and serialisable,
 * built on the server by the two pages under src/app/(dashboard)/settings/access/roles.
 */

/** A built-in starting point written for one role (src/lib/authz/presets.ts). */
export type PresetChoice = { key: string; label: string; description: string };

/** One row of the roles list. */
export type RoleListRow = {
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  active: boolean;
  /** People who hold it and can sign in — the super admin is counted apart, not as an Admin. */
  people: number;
  /** Everybody who holds it, deactivated accounts included: what decides whether it can be deleted. */
  headcount: number;
  /** How many of those are switched off. */
  switchedOff: number;
  /** The first few of those people, for the stacked initials. */
  avatars: { id: string; name: string }[];
  /** How many permissions it grants (menu sections apart), and across how many modules. */
  permissions: number;
  modules: number;
  /** The last recorded change to the role, as an ISO string, and who made it. */
  updatedAt: string | null;
  updatedBy: string | null;
  presets: PresetChoice[];
};

/** One permission as the wizard's module step lists it. */
export type WizardPermission = {
  key: string;
  label: string;
  description: string;
  tier: "standard" | "sensitive" | "critical";
  superAdminOnly: boolean;
  selfExcluded: boolean;
};

export type WizardModuleIcon =
  | "crm"
  | "sales"
  | "purchases"
  | "products"
  | "projects"
  | "finance"
  | "support"
  | "marketing"
  | "hr"
  | "performance"
  | "assets"
  | "work"
  | "data"
  | "settings";

export type WizardModule = { key: string; label: string; description: string; icon: WizardModuleIcon; permissions: WizardPermission[] };

/** What "Start from" offers a new role. */
export type WizardStart = {
  /** Roles a new one can be made as a copy of. */
  sources: { key: string; name: string }[];
  /** The built-in profiles, with the permissions each lists. */
  presets: (PresetChoice & { roleName: string; permissions: string[] })[];
};

/** A role open in the wizard, with everything its steps read and save. */
export type WizardRole = {
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  /** People who hold it and can sign in. */
  people: number;
  modules: WizardModule[];
  /** The permissions it grants now. */
  held: string[];
  /** Its record grid, and why it can't be changed when it can't (`roleAccessLevels`). */
  grid: AccessRow[];
  gridWhy: string | null;
  /** The built-in profiles written for this role. */
  presets: PresetChoice[];
};

/** Who is looking: what they may grant, and what they would lock themselves out by taking away. */
export type WizardViewer = {
  isSuperAdmin: boolean;
  role: string;
  /** The keys the viewer holds — the ones they may grant or take away. */
  holds: string[];
  /** Of the two keys that open these screens, the ones the viewer holds through their role. */
  ownAccessThroughRole: string[];
};
