import { acPath } from "@/lib/access-control/nav";

/**
 * Where a role and a person open.
 *
 * A role opens in Settings › Access Control: its permissions on the Module Matrix, its record reach
 * on Data Scope, its masked fields on Field Permissions. A person's account — profile, sign-in,
 * activity — stays on Users; what they may do opens on their Access Control profile. The old tab
 * names are still understood, so a link written before the move lands in the right place.
 */
export const rolePath = (key: string, tab?: string) =>
  tab === "records" ? acPath.scope({ role: key }) : tab === "fields" ? acPath.fields({ role: key }) : tab === "users" ? `${acPath.employees()}?role=${encodeURIComponent(key)}` : acPath.modules({ role: key });

const ACCESS_TABS: Record<string, string> = { permissions: "overrides", records: "scope", fields: "fields", rules: "pii" };

export const userPath = (id: string, tab?: string) =>
  tab && tab in ACCESS_TABS ? acPath.employee(id, ACCESS_TABS[tab]) : `/settings/users?user=${encodeURIComponent(id)}${tab ? `&tab=${tab}` : ""}`;

/** One person's access — permissions, exceptions, reach, masked fields and their daily limit. */
export const userAccessPath = (id: string, tab?: string) => acPath.employee(id, tab);
