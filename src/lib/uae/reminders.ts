import { workspacePack } from "@/lib/country-pack";
import { can } from "@/lib/authz/resolve";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { notMigratedYet } from "@/lib/not-migrated";
import type { Clock } from "@/lib/time/zone";
import { uaeExpiries } from "@/lib/uae/payroll";

/**
 * UAE document expiries as reminders (owner, 15 Nov 2026): a passport, residence visa, Emirates ID, labour card or
 * health insurance 60, 30 and 7 days before it expires, and once when it has — to whoever runs payroll in a UAE
 * workspace. Raised by the notification sweep (src/lib/notify.ts syncSystemNotifications), as stored logins' expiries
 * are, under "Renewal expiring": the bell, and the email where the workspace emails that kind. Each step is keyed, so
 * it is raised once, and one missed while nobody opened Deskzo comes late rather than not at all.
 */

const DAY_MS = 86_400_000;
export const STEPS = [60, 30, 7] as const;

/** The step a document is in: "expired", 7, 30, 60 — or null, further off than 60 days. */
export function expiryStep(daysLeft: number): "expired" | (typeof STEPS)[number] | null {
  if (daysLeft < 0) return "expired";
  for (const step of [...STEPS].reverse()) if (daysLeft <= step) return step;
  return null;
}

export type ExpiryCandidate = { title: string; message: string; link: string; dedupeKey: string; at: Date };

export async function uaeExpiryCandidates(userId: string, now: Date, clock: Clock): Promise<ExpiryCandidate[]> {
  if (workspacePack().country !== "AE") return [];
  if (!(await moduleAvailableForTenant("payroll"))) return [];
  if (!(await can(userId, "payroll.manage"))) return [];
  let expiring;
  try {
    expiring = await uaeExpiries(clock.today(now), STEPS[0]);
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
  const out: ExpiryCandidate[] = [];
  for (const e of expiring) {
    const step = expiryStep(e.daysLeft);
    if (step === null) continue;
    const day = e.on.toISOString().slice(0, 10);
    out.push({
      title: step === "expired" ? `${e.name}'s ${e.document.toLowerCase()} has expired` : `${e.name}'s ${e.document.toLowerCase()} expires in ${e.daysLeft} day${e.daysLeft === 1 ? "" : "s"}`,
      message: step === "expired" ? `It expired on ${day}. Renew it, then update the date on Payroll › People.` : `It expires on ${day}.`,
      link: "/people/payroll",
      // The date is in the key: a renewed document, with its new date, is reminded of afresh.
      dedupeKey: `uae-doc:${e.userId}:${e.document}:${day}:${step}`,
      at: step === "expired" ? e.on : new Date(e.on.getTime() - step * DAY_MS),
    });
  }
  return out;
}
