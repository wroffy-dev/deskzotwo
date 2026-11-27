import type { Clock } from "@/lib/time/zone";

/**
 * When notification emails go out (owner, 16 Nov 2026: "these notifications comes at night on mail instead they
 * should come in day time around 10:00 am - 5:45 pm"): between 10:00 and 17:45 on the workspace's own clock. A
 * reminder that falls due outside those hours is emailed when they open (src/lib/notifications/reminder-emails.ts);
 * a notification raised outside them is held and sent then (src/lib/notifications/held-emails.ts). The bell is
 * never held — only the email waits. Pure.
 */

/** Minutes after midnight, workspace time: from 10:00 up to, not including, 17:45. */
export const MAIL_HOURS = { from: 10 * 60, to: 17 * 60 + 45 } as const;

/** "10:00 am – 5:45 pm", for the settings screen. */
export const MAIL_HOURS_WORDS = "10:00 am – 5:45 pm";

/** Whether an instant is inside the hours on this clock. */
export function inMailHours(at: Date, clock: Clock): boolean {
  const p = clock.parts(at);
  const minute = p.hour * 60 + p.minute;
  return minute >= MAIL_HOURS.from && minute < MAIL_HOURS.to;
}

/** The next moment the hours open, from an instant: today's 10:00 if it's still to come, else tomorrow's. */
export function nextMailHoursOpen(at: Date, clock: Clock): Date {
  const p = clock.parts(at);
  const today = clock.at(p.year, p.month, p.day, Math.floor(MAIL_HOURS.from / 60), MAIL_HOURS.from % 60);
  return at.getTime() < today.getTime() ? today : clock.at(p.year, p.month, p.day + 1, Math.floor(MAIL_HOURS.from / 60), MAIL_HOURS.from % 60);
}

/**
 * While a check has replaced Deskzo's mailer, its emails go at once whatever the hour — a suite run at night would
 * otherwise find nothing sent — unless the check sets the hours itself here, to test them.
 */
const HOLDER = Symbol.for("deskzo.notification-mail-hours");
type Holder = { forChecks?: ((at: Date) => boolean) | null };
const holder = (): Holder => ((globalThis as { [HOLDER]?: Holder })[HOLDER] ??= {});

export function setMailHoursForChecks(open: ((at: Date) => boolean) | null): void {
  holder().forChecks = open;
}

export function mailHoursForChecks(): ((at: Date) => boolean) | null {
  return holder().forChecks ?? null;
}
