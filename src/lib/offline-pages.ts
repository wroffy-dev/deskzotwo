import { createHash } from "node:crypto";

/**
 * What a device keeps to show offline (owner, 6 Nov 2026 — public/sw.js holds the rules, and repeats this list, which
 * check:pwa holds to it): the last copy of a person's own work pages. No dashboard, money, payroll or report is here,
 * and one shouldn't be added lightly: a copy lives on the device for up to three days.
 */
export const KEPT_PAGES = ["/today", "/tasks", "/calendar", "/visits"] as const;

/** Whose copies they are: never the person's id itself, and a workspace's person apart from another's on one device. */
export function offlineUserKey(tenantId: string, userId: string): string {
  return createHash("sha256").update(`${tenantId}:${userId}`).digest("hex").slice(0, 40);
}
