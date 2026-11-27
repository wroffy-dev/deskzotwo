/**
 * Settings › Access Control: where each screen lives and what the sidebar lists.
 *
 * One place for the paths, so a screen links to another by name (`acPath.modules(role)`) rather than
 * by a string that goes stale when a route moves. Icons are named, not imported: this file is read by
 * server pages and the client sidebar alike, and the sidebar maps the names to lucide components.
 */

export const AC_ROOT = "/settings/access";

const q = (params: Record<string, string | null | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
};

export const acPath = {
  overview: () => AC_ROOT,
  roles: () => `${AC_ROOT}/roles`,
  /** The create wizard; with a role, the same wizard editing it. */
  wizard: (role?: string) => `${AC_ROOT}/roles/wizard${q({ role })}`,
  modules: (subject?: { role?: string; user?: string }) => `${AC_ROOT}/modules${q({ role: subject?.role, user: subject?.user })}`,
  fields: (subject?: { role?: string; user?: string; entity?: string }) => `${AC_ROOT}/fields${q({ role: subject?.role, user: subject?.user, entity: subject?.entity })}`,
  documents: (subject?: { role?: string; user?: string }) => `${AC_ROOT}/documents${q({ role: subject?.role, user: subject?.user })}`,
  employees: () => `${AC_ROOT}/employees`,
  employee: (id: string, tab?: string) => `${AC_ROOT}/employees/${encodeURIComponent(id)}${q({ tab })}`,
  scope: (subject?: { role?: string; user?: string }) => `${AC_ROOT}/scope${q({ role: subject?.role, user: subject?.user })}`,
  sensitive: () => `${AC_ROOT}/sensitive`,
  masking: () => `${AC_ROOT}/sensitive/masking`,
  limits: () => `${AC_ROOT}/sensitive/limits`,
  importExport: (role?: string) => `${AC_ROOT}/import-export${q({ role })}`,
  audit: (params?: { category?: "pii"; user?: string; role?: string }) => `${AC_ROOT}/audit${q({ category: params?.category, user: params?.user, role: params?.role })}`,
  security: () => `${AC_ROOT}/security`,
  simulator: (user?: string) => `${AC_ROOT}/simulator${q({ user })}`,
  compare: (a?: string, b?: string) => `${AC_ROOT}/compare${q({ a, b })}`,
};

export type AcIcon =
  | "overview"
  | "roles"
  | "modules"
  | "fields"
  | "documents"
  | "employees"
  | "scope"
  | "sensitive"
  | "io"
  | "audit"
  | "security"
  | "simulator"
  | "compare";

export type AcNavItem = {
  key: string;
  label: string;
  icon: AcIcon;
  href: string;
  /** Paths (prefixes) that light this item, besides its own href. */
  also?: string[];
  /** Lit only when the URL carries (or lacks) this search param — Audit Logs and Unmasking Activity share a page. */
  param?: { name: string; value: string | null };
  children?: Omit<AcNavItem, "icon" | "children">[];
};

export const AC_NAV: AcNavItem[] = [
  { key: "overview", label: "Overview", icon: "overview", href: acPath.overview() },
  { key: "roles", label: "Roles & Permissions", icon: "roles", href: acPath.roles() },
  { key: "modules", label: "Module Matrix", icon: "modules", href: acPath.modules() },
  { key: "fields", label: "Field Permissions", icon: "fields", href: acPath.fields() },
  { key: "documents", label: "Document Permissions", icon: "documents", href: acPath.documents() },
  { key: "employees", label: "Employee Permissions", icon: "employees", href: acPath.employees() },
  { key: "scope", label: "Data Scope", icon: "scope", href: acPath.scope() },
  {
    key: "sensitive",
    label: "Sensitive Data",
    icon: "sensitive",
    href: acPath.sensitive(),
    children: [
      { key: "masking", label: "Global PII Masking", href: acPath.masking() },
      { key: "limits", label: "Unmasking Limits", href: acPath.limits() },
      { key: "unmasking", label: "Unmasking Activity", href: acPath.audit({ category: "pii" }), param: { name: "category", value: "pii" } },
    ],
  },
  { key: "io", label: "Import & Export", icon: "io", href: acPath.importExport() },
  { key: "audit", label: "Audit Logs", icon: "audit", href: acPath.audit(), param: { name: "category", value: null } },
  { key: "security", label: "Security Settings", icon: "security", href: acPath.security() },
];

export const AC_TOOLS: AcNavItem[] = [
  { key: "simulator", label: "Permission Simulator", icon: "simulator", href: acPath.simulator() },
  { key: "compare", label: "Compare", icon: "compare", href: acPath.compare() },
];
