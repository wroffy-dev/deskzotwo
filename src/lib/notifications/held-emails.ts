import { db } from "@/lib/db";
import { sendEmailNotification } from "@/lib/email";
import { notMigratedYet } from "@/lib/not-migrated";
import { inMailHours, mailHoursForChecks } from "@/lib/notifications/email-hours";
import { platformMailerReplaced } from "@/lib/platform/mailer";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Notification emails held overnight go out when the hours open (owner, 16 Nov 2026: 10:00–17:45, workspace time —
 * src/lib/notifications/email-hours.ts). From each workspace's heartbeat: every held one whose time has come, oldest
 * first, each taken off the list before it's sent, so two beats never send one twice. One the workspace has stopped
 * emailing since, or a person who has left, goes nowhere (sendEmailNotification asks again).
 */

const BATCH = 200;

export async function releaseHeldEmails(options: { now?: Date } = {}): Promise<{ sent: number; left: number }> {
  const now = options.now ?? new Date();
  const checks = mailHoursForChecks();
  const open = checks ? checks(now) : platformMailerReplaced() || inMailHours(now, await workspaceClock());
  if (!open) return { sent: 0, left: 0 };
  let rows: { id: string; userId: string; type: import("@prisma/client").NotificationType; subject: string; body: string; link: string | null }[];
  try {
    rows = await db.notificationEmailHeld.findMany({
      where: { sendAfter: { lte: now } },
      orderBy: { createdAt: "asc" },
      take: BATCH,
      select: { id: true, userId: true, type: true, subject: true, body: true, link: true },
    });
  } catch (err) {
    if (notMigratedYet(err)) return { sent: 0, left: 0 };
    throw err;
  }
  let sent = 0;
  for (const row of rows) {
    // Taken first: if two beats overlap, only the one that removes it sends it.
    const { count } = await db.notificationEmailHeld.deleteMany({ where: { id: row.id } });
    if (count !== 1) continue;
    const route = await sendEmailNotification({ userId: row.userId, type: row.type, subject: row.subject, body: row.body, link: row.link, release: true });
    if (route) sent += 1;
  }
  const left = rows.length === BATCH ? await db.notificationEmailHeld.count({ where: { sendAfter: { lte: now } } }) : 0;
  return { sent, left };
}
