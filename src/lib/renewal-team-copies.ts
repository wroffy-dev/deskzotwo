import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Who is copied on the team's renewal reminder emails (owner, 23 Nov 2026 — "need cc email id option here also when
 * mail goes to team member for renewal due"): Settings › Renewals' addresses, on each step of the ladder — the renewal
 * manager's "Subscription ends in 30 days", and the same step that lands with nobody, sent to the people chosen for
 * those. Once a step, however many people it goes to (src/lib/notifications/reminder-emails.ts); not on the escalations,
 * Monday's list or the lapsed notice. An address must be a person working here or at the company's own domain
 * (src/actions/renewal-settings.ts), as the customer's reminder's copies must.
 *
 * Its own file, importing nothing else of renewals: src/lib/notify.ts reads it, and src/lib/renewal-lapse.ts imports
 * notify. Read by name — the column is in NOT_YET_EVERYWHERE until every workspace has 20261223500000_renewal_team_cc;
 * before it, nobody is copied.
 */
export type TeamCopies = { emails: string[]; migrated: boolean };

export const TEAM_COPIES_MAX = 10;

export async function teamReminderCopies(): Promise<TeamCopies> {
  try {
    const row = await db.renewalSettings.findUnique({ where: { id: "default" }, select: { teamReminderCc: true } });
    return { emails: row?.teamReminderCc ?? [], migrated: true };
  } catch (err) {
    if (notMigratedYet(err)) return { emails: [], migrated: false };
    throw err;
  }
}
