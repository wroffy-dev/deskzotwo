import { requireModuleUser } from "@/lib/modules-access";
import { viewerHas } from "@/actions/permission";
import { workspaceClock } from "@/lib/time/workspace";
import { unwatchedServices, type UnwatchedService } from "@/lib/renewals-unwatched-rules";

/**
 * Items › Services that renew, for the person asking (owner, 11 Nov 2026): the rule and its reasons are in
 * src/lib/renewals-unwatched-rules.ts, kept free of the session so the bell can ask it too. Anyone who opens Renewals
 * and may see orders sees the list; it names services and counts their orders, never whose they are.
 */

export type { UnwatchedService };

async function viewer(): Promise<boolean> {
  await requireModuleUser("renewals");
  return viewerHas("renewals.view");
}

/** How many there are — for the link on Renewals. */
export async function unwatchedServiceCount(): Promise<number> {
  if (!(await viewer())) return 0;
  const today = (await workspaceClock()).calendarDate(new Date());
  return (await unwatchedServices(today)).length;
}

/** Them, the ones with the most running terms first. */
export async function listUnwatchedServices(): Promise<UnwatchedService[]> {
  if (!(await viewer())) return [];
  const today = (await workspaceClock()).calendarDate(new Date());
  return unwatchedServices(today);
}
