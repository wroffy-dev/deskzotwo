import type { ModuleState } from "@/lib/staff/permission-modules";

/**
 * What the Module Permission Matrix page hands its client components: plain and serialisable, built on
 * the server by src/app/(dashboard)/settings/access/modules/page.tsx from the actions that always
 * answered these questions.
 */

/** A stored answer: nothing stored (the default decides), or an Allow or Deny somebody set. */
export type Answer = "default" | "allow" | "deny";

/** One permission as the matrix shows it for the open role or person. */
export type MatrixPermission = {
  key: string;
  label: string;
  description: string;
  tier: string;
  superAdminOnly: boolean;
  adminOnly: boolean;
  selfExcluded: boolean;
  /** The company modules it depends on (src/lib/staff/permission-modules.ts); none for the core of the app. */
  modules: string[];
  /** What is stored on the role, or for the person alone (a lapsed exception reads as Default). */
  state: Answer;
  /** What Default gives: the registry's answer for the role; for a person, what their role gives. */
  base: boolean;
  /** The answer that applies now. */
  held: boolean;
  /** A person's only: where the answer comes from, in the resolver's words. */
  why: string | null;
  /** A person's only: their own exception, with its reason and end. */
  own: { allowed: boolean; reason: string | null; expiresAt: string | null; /** The last day it applies, in the workspace's words. */ until: string | null; expired: boolean } | null;
};

export type MatrixSubject =
  | { kind: "role"; key: string; name: string; isSystem: boolean; active: boolean; people: number }
  | { kind: "user"; id: string; name: string; roleKey: string; roleName: string; isSuperAdmin: boolean; active: boolean };

/** Who is looking, and what they may hand out. */
export type MatrixViewer = {
  id: string;
  mayManage: boolean;
  isSuperAdmin: boolean;
  role: string;
  /** The keys the viewer holds — the ones they may grant or take away. */
  holds: string[];
  /** Of the two keys that open these screens, the ones the viewer holds through their role. */
  ownAccessThroughRole: string[];
};

/** How far a module's records reach for View, one line per record type. */
export type ModuleScope = { record: string; level: string }[];

export type SubjectOption = { id: string; name: string };

export type MatrixData = {
  subject: MatrixSubject;
  roles: SubjectOption[];
  people: SubjectOption[];
  permissions: MatrixPermission[];
  moduleStates: Record<string, ModuleState>;
  /** By access module (src/lib/staff/access-modules.ts). */
  scopes: Record<string, ModuleScope>;
  /** A role's only: the menu pages it has unticked (src/lib/staff/hidden-pages.ts). */
  hiddenPages: string[];
  /** The workspace's country: a page only another country has (e-way bills outside India) isn't offered as a tick. */
  country: string;
  viewer: MatrixViewer;
};
