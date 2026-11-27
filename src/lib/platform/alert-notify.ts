import { alerts, type Alert } from "@/lib/platform/alerts";
import { controlDb } from "@/lib/platform/control-db";
import { getSetting } from "@/lib/platform/settings";
import { queuePlatformMail } from "@/lib/platform/mail/queue";
import { consoleOrigin } from "@/lib/platform/staff";

/**
 * The console's alerts, told to a person (owner, 30 Oct 2026 — docs: Deskzo at scale, Part 3): until now they were
 * worked out only when somebody opened the console. Every minute the platform worker (scripts/platform-worker.ts)
 * asks here what is open; what is new, still open past its reminder, or cleared since goes out in ONE email of the
 * ALERTS type to the people on call — the console setting `alerts.emails`, else every active owner.
 *
 *   · new — critical and warning alerts, the first time each is open (info ones stay on the console);
 *   · again — a critical one still open after 2 hours, a warning after a day: it isn't forgotten;
 *   · cleared — fixed, or acknowledged on the console: said once, so nobody chases what's done.
 *
 * Acknowledging an alert on the console stops its reminders (an acknowledged alert isn't open). What was told is
 * kept per alert (PlatformAlertNotice), so a restart never sends the same news twice. When the worker itself stops,
 * this can't say so — the outside uptime check on /api/platform/health does.
 */

export const REMIND_AFTER_MS = { critical: 2 * 3_600_000, warning: 24 * 3_600_000 } as const;
const TOLD = new Set(["critical", "warning"]);

export type AlertNews = { fresh: Alert[]; again: Alert[]; cleared: { key: string; title: string; severity: string }[] };

/** Who the alerts go to: the setting's addresses, else every active owner's. */
export async function alertRecipients(): Promise<string[]> {
  const set = (await getSetting("alerts.emails")) ?? "";
  const listed = set
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (listed.length) return [...new Set(listed)].slice(0, 20);
  const owners = await controlDb().platformUser.findMany({ where: { role: "OWNER", active: true }, select: { email: true } });
  return owners.map((o) => o.email.toLowerCase());
}

/** What there is to tell now, against what was told before. Pure but for the reads; writes nothing. */
export async function alertNews(now = new Date()): Promise<AlertNews> {
  const open = (await alerts("OWNER", now)).open.filter((a) => TOLD.has(a.severity));
  const notices = await controlDb().platformAlertNotice.findMany();
  const byKey = new Map(notices.map((n) => [n.key, n]));
  const fresh: Alert[] = [];
  const again: Alert[] = [];
  for (const a of open) {
    const n = byKey.get(a.key);
    if (!n || n.clearedAt) fresh.push(a);
    else if (now.getTime() - n.lastSentAt.getTime() >= REMIND_AFTER_MS[a.severity as "critical" | "warning"]) again.push(a);
  }
  const openKeys = new Set(open.map((a) => a.key));
  const cleared = notices.filter((n) => !n.clearedAt && !openKeys.has(n.key)).map((n) => ({ key: n.key, title: n.title, severity: n.severity }));
  return { fresh, again, cleared };
}

const line = (a: Alert, origin: string) => `• ${a.severity === "critical" ? "CRITICAL" : "Warning"}: ${a.title}\n  ${a.detail}\n  ${origin}${a.href}`;

/** The email: the worst news first in the subject, every item in the body with its link on the console. */
export function alertEmail(news: AlertNews, origin: string): { subject: string; text: string } {
  const critical = [...news.fresh, ...news.again].filter((a) => a.severity === "critical");
  const first = critical[0] ?? news.fresh[0] ?? news.again[0];
  const counts = [news.fresh.length && `${news.fresh.length} new`, news.again.length && `${news.again.length} still open`, news.cleared.length && `${news.cleared.length} cleared`].filter(Boolean).join(", ");
  const subject = first ? `${first.severity === "critical" ? "[CRITICAL] " : ""}Deskzo: ${first.title}${counts.includes(",") || news.fresh.length + news.again.length > 1 ? ` (${counts})` : ""}` : `Deskzo: ${news.cleared.length} alert${news.cleared.length === 1 ? "" : "s"} cleared`;
  const parts: string[] = [];
  if (news.fresh.length) parts.push(`New:\n\n${news.fresh.map((a) => line(a, origin)).join("\n\n")}`);
  if (news.again.length) parts.push(`Still open — acknowledge on the console to stop these reminders:\n\n${news.again.map((a) => line(a, origin)).join("\n\n")}`);
  if (news.cleared.length) parts.push(`Cleared (fixed, or acknowledged):\n\n${news.cleared.map((c) => `• ${c.title}`).join("\n")}`);
  parts.push(`All alerts: ${origin}/alerts`);
  return { subject: subject.slice(0, 200), text: parts.join("\n\n\n") };
}

/** One turn: works out the news, emails it, and records what was told. Nothing to tell, nothing sent. */
export async function notifyAlerts(now = new Date()): Promise<{ sent: boolean; fresh: number; again: number; cleared: number; to: number }> {
  const news = await alertNews(now);
  const total = news.fresh.length + news.again.length + news.cleared.length;
  if (!total) return { sent: false, fresh: 0, again: 0, cleared: 0, to: 0 };
  const to = await alertRecipients();
  const result = { fresh: news.fresh.length, again: news.again.length, cleared: news.cleared.length, to: to.length };
  if (!to.length) return { sent: false, ...result };
  const { subject, text } = alertEmail(news, consoleOrigin());
  // One email, everybody on call in it: they see who else was told.
  // Queued (src/lib/platform/mail/queue.ts), so a provider hiccup delays the news instead of losing it.
  await queuePlatformMail({ type: "ALERTS", to: to[0]!, cc: to.slice(1), subject, text });
  const db = controlDb();
  for (const a of news.fresh) {
    await db.platformAlertNotice.upsert({
      where: { key: a.key },
      create: { key: a.key, severity: a.severity, title: a.title.slice(0, 300), firstSentAt: now, lastSentAt: now },
      update: { severity: a.severity, title: a.title.slice(0, 300), firstSentAt: now, lastSentAt: now, sends: 1, clearedAt: null },
    });
  }
  for (const a of news.again) await db.platformAlertNotice.update({ where: { key: a.key }, data: { lastSentAt: now, sends: { increment: 1 }, title: a.title.slice(0, 300) } });
  if (news.cleared.length) await db.platformAlertNotice.updateMany({ where: { key: { in: news.cleared.map((c) => c.key) } }, data: { clearedAt: now } });
  return { sent: true, ...result };
}
