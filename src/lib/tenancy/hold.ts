import type { Tenant } from "@/lib/tenancy/state";

/** What a workspace held for billing still answers: signing in, and its billing page. */
const BILLING_HOLD_OPEN = /^\/(login|forgot-password|reset-password|handoff|settings\/billing)(\/|$)|^\/api\/auth(\/|$)/;

/**
 * What the proxy does with a request to a workspace (src/proxy.ts):
 *
 *   · "open"            — served as usual: it is open, or it is held for billing and this is signing
 *                         in or the billing page, so its owner can pay and open it again;
 *   · "billing-notice"  — held for billing, anything else: a page saying so, and where to pay;
 *   · "unavailable"     — being set up, held by staff, mid-migration, closed.
 */
/** What a held workspace's person is told when an action other than billing's is refused (R2-05). */
export const BILLING_HOLD_ACTION_MESSAGE = "This workspace is on hold until its plan is paid. Only Plan & billing works until then.";

/**
 * Security audit round two, 13 Nov 2026 (R2-05): whether a server action must be refused because its
 * workspace is held for billing. The proxy keeps every page but sign-in and /settings/billing shut, but
 * a server action can be posted to any open page, whichever page it was written for, so the billing
 * page's own path let global search, the onboarding wizard and the copilot run. Billing's own actions
 * (src/actions/billing.ts) say so and are let through; signing in and out don't ask (they never call
 * `requireUser`). Pure, for the proxy-free check suite; src/lib/tenancy/billing-hold-action.ts asks it.
 */
export function actionRefusedForHold(tenant: Pick<Tenant, "status" | "holdReason">, opts: { inAction: boolean; billingAction: boolean }): boolean {
  if (!opts.inAction || opts.billingAction) return false;
  return tenant.status === "SUSPENDED" && tenant.holdReason === "BILLING";
}

export function holdFor(tenant: Pick<Tenant, "status" | "holdReason">, pathname: string): "open" | "billing-notice" | "unavailable" {
  if (tenant.status === "ACTIVE") return "open";
  if (tenant.status === "SUSPENDED" && tenant.holdReason === "BILLING") return BILLING_HOLD_OPEN.test(pathname) ? "open" : "billing-notice";
  return "unavailable";
}
