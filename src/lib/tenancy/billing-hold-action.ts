import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { actionRefusedForHold } from "@/lib/tenancy/hold";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";

/**
 * Security audit round two, 13 Nov 2026 (R2-05): the action-layer half of the billing hold.
 *
 * Whether this request is running a server action right now — Next's own request store says so with
 * its `phase` ("action" while the action runs, "render" for the page it re-renders afterwards). Only
 * the action itself is refused: the billing page re-rendered after paying still reads what it needs.
 * The store is the one `headers()` reads (as src/lib/tenancy/workspace-country.ts does). Outside a
 * request — a script, a background job — this is never an action.
 */
export function inActionPhase(): boolean {
  const store = workUnitAsyncStorage.getStore() as { type?: string; phase?: string } | undefined;
  return store?.type === "request" && store.phase === "action";
}

/** True when the action running now must be refused because its workspace is held for billing. */
export async function heldForBillingInAction(billingAction: boolean): Promise<boolean> {
  if (billingAction || !inActionPhase()) return false;
  const tenant = await currentTenantOrNull().catch(() => null);
  return !!tenant && actionRefusedForHold(tenant, { inAction: true, billingAction });
}
