import type { NotificationType } from "@prisma/client";
import { NOTIFICATION_CATALOGUE } from "@/lib/notifications/catalogue";

/**
 * What a workspace emails before its admins choose (src/lib/notifications/email-settings.ts) — kept
 * apart from the database so the settings screen can read it in the browser.
 */

/**
 * Emailed until an admin says otherwise: the two that went by email before the setting existed, and renewals (owner,
 * 11 Nov 2026) — a renewal reminder that waits in the bell for somebody to open Deskzo is how a renewal gets missed.
 * And a letter or document HR issues somebody (owner, 18 Nov 2026): it's theirs, so they hear of it by email. And Arjun's
 * Monday note (19 Nov 2026): an admin chose who gets it, by name — a weekly note is read in the inbox.
 * And a help desk's answer (owner, 25 Nov 2026): whoever asked may not have Deskzo open all day.
 */
export const EMAILED_BY_DEFAULT: ReadonlySet<NotificationType> = new Set<NotificationType>(["PROFORMA_ISSUED", "AI_CREDITS", "RENEWAL_EXPIRING", "LETTER_ISSUED", "COLLECTIONS_WEEKLY", "SMART_LIST_REMINDER", "DESK_REQUEST_UPDATE"]);

/**
 * Since when a swept reminder that is emailed by default counts as switched on, where no admin has chosen: the day
 * it became a default. The sweep emails only what fell due after that — and never anything older than its own two days.
 */
export const DEFAULT_ON_SINCE = new Date("2026-11-11T00:00:00.000Z");

/**
 * Reminders the bell's own sweep raises (`syncSystemNotifications`) — something falling due rather than
 * somebody doing something. Emailed by a scheduled sweep every five minutes, for everyone, not when the
 * person next opens Deskzo (src/lib/notifications/reminder-emails.ts) — and only what falls due after
 * the kind was switched on (owner, 18 Oct 2026).
 */
export const SWEPT_REMINDERS: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "TASK_DUE",
  "TASK_OVERDUE",
  "TASK_REMINDER",
  "CALLBACK_DUE",
  "NOTE_REMINDER",
  "MEETING_SOON",
  "TICKET_SLA_OVERDUE",
  "RENEWAL_EXPIRING",
]);

/**
 * The sweep's notices about other people and the calendar: a colleague's birthday or anniversary, a
 * holiday coming. Raised for everyone in the company, so one would email every employee — kept to the
 * bell, without a switch (owner, 18 Oct 2026). A person's own wishes are emailable (WISHES).
 * check:notification-emails holds this list and the one above to every kind the sweep raises.
 */
export const IN_APP_ONLY: ReadonlySet<NotificationType> = new Set<NotificationType>(["BIRTHDAY_TODAY", "WORK_ANNIVERSARY", "HOLIDAY_UPCOMING"]);

/** Whether a type can be emailed at all: catalogued, and not one kept to the bell. */
export function canBeEmailed(type: NotificationType): boolean {
  return !IN_APP_ONLY.has(type) && NOTIFICATION_CATALOGUE.some((d) => d.type === type);
}
