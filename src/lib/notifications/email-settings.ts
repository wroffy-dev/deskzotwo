import type { NotificationType } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { NOTIFICATION_CATALOGUE } from "@/lib/notifications/catalogue";
import { DEFAULT_ON_SINCE, EMAILED_BY_DEFAULT, SWEPT_REMINDERS, canBeEmailed } from "@/lib/notifications/email-defaults";
import type { NotificationEmailFrame, NotificationEmailWords } from "@/lib/notifications/email-template";

export { EMAILED_BY_DEFAULT, IN_APP_ONLY, SWEPT_REMINDERS, canBeEmailed } from "@/lib/notifications/email-defaults";

/**
 * Which notifications this workspace emails (owner, 18 Oct 2026): an admin's choice for everyone,
 * under Settings › Email notifications. The choice is final — a person can't turn an email off, or
 * on, for themselves; what they mute in their own bell doesn't stop it. Each goes at once, one email
 * per notification, through the company's mail server when one is set up and Deskzo's otherwise
 * (src/lib/email.ts).
 *
 * A row only where an admin has chosen (`notification_email_types`); a type without one keeps its
 * default, and a workspace not migrated yet has the defaults throughout. Every query names its columns,
 * so one reading a column a workspace hasn't been migrated to yet is the only one that notices.
 */

/** What admins have chosen, type by type; empty in a workspace not migrated yet. */
async function storedChoices(): Promise<{ type: NotificationType; email: boolean; updatedAt: Date }[]> {
  try {
    return await db.notificationEmailType.findMany({ select: { type: true, email: true, updatedAt: true } });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** Every type this workspace emails now. */
export async function emailedTypes(): Promise<Set<NotificationType>> {
  const out = new Set<NotificationType>([...EMAILED_BY_DEFAULT].filter(canBeEmailed));
  for (const row of await storedChoices()) {
    if (row.email && canBeEmailed(row.type)) out.add(row.type);
    else out.delete(row.type);
  }
  return out;
}

/** Whether one type is emailed — read for each notification as it's raised. */
export async function isEmailed(type: NotificationType): Promise<boolean> {
  if (!canBeEmailed(type)) return false;
  try {
    const row = await db.notificationEmailType.findUnique({ where: { type }, select: { email: true } });
    if (row) return row.email;
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return EMAILED_BY_DEFAULT.has(type);
}

export type EmailChoice = {
  type: NotificationType;
  email: boolean;
  /** Offered with a switch: false for the ones only the bell raises. */
  switchable: boolean;
  /** Left as it came: nobody has chosen. */
  isDefault: boolean;
};

/** Every catalogued type with what this workspace does with it, for the admin's screen. */
export async function emailChoices(): Promise<EmailChoice[]> {
  const stored = new Map((await storedChoices()).map((r) => [r.type, r]));
  return NOTIFICATION_CATALOGUE.map((d) => {
    const switchable = canBeEmailed(d.type);
    const row = stored.get(d.type);
    return {
      type: d.type,
      email: switchable && (row ? row.email : EMAILED_BY_DEFAULT.has(d.type)),
      switchable,
      isDefault: !row,
    };
  });
}

/**
 * Records an admin's choice for one type. The caller checks who may, and that the type can be emailed.
 * Switched on from off, it's on from now: a swept reminder that fell due before isn't emailed.
 */
export async function setEmailed(type: NotificationType, email: boolean, byUserId: string, now: Date = new Date()): Promise<void> {
  const before = await db.notificationEmailType.findUnique({ where: { type }, select: { email: true } });
  const onSince = !email ? null : before?.email ? undefined : now;
  await db.notificationEmailType.upsert({
    where: { type },
    create: { type, email, updatedById: byUserId, onSince: email ? now : null },
    update: { email, updatedById: byUserId, ...(onSince === undefined ? {} : { onSince }) },
    select: { type: true },
  });
}

/**
 * The swept reminders this workspace emails, each with when it was switched on — what the scheduled
 * sweep looks for (src/lib/notifications/reminder-emails.ts). Empty in a workspace not migrated yet.
 */
export async function sweptReminderKinds(): Promise<Map<NotificationType, Date>> {
  try {
    // Every choice made, on or off: a reminder emailed by default is on unless an admin has switched it off.
    const rows = await db.notificationEmailType.findMany({
      where: { type: { in: [...SWEPT_REMINDERS] } },
      select: { type: true, email: true, onSince: true, updatedAt: true },
    });
    const out = new Map<NotificationType, Date>();
    for (const type of SWEPT_REMINDERS) if (EMAILED_BY_DEFAULT.has(type)) out.set(type, DEFAULT_ON_SINCE);
    for (const r of rows) {
      if (r.email) out.set(r.type, r.onSince ?? r.updatedAt);
      else out.delete(r.type);
    }
    return out;
  } catch (err) {
    if (notMigratedYet(err)) return new Map();
    throw err;
  }
}

// ─── The wording (owner, 16 Nov 2026: "make notification emails editable template") ────────────────────────────

/** One kind's own subject and body, or nothing where Deskzo's are kept (and in a workspace not migrated yet). */
export async function notificationWording(type: NotificationType): Promise<NotificationEmailWords | null> {
  try {
    return await db.notificationEmailWording.findUnique({ where: { type }, select: { subject: true, body: true } });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** Every kind's own wording, for the admin's screen. */
export async function notificationWordings(): Promise<Partial<Record<NotificationType, NotificationEmailWords>>> {
  try {
    const rows = await db.notificationEmailWording.findMany({ select: { type: true, subject: true, body: true } });
    return Object.fromEntries(rows.map((r) => [r.type, { subject: r.subject, body: r.body }]));
  } catch (err) {
    if (notMigratedYet(err)) return {};
    throw err;
  }
}

/** The frame every notification email goes in, or nothing where Deskzo's is kept. */
export async function notificationFrame(): Promise<NotificationEmailFrame | null> {
  try {
    return await db.notificationEmailLayout.findUnique({ where: { id: "global" }, select: { subject: true, body: true, greeting: true, signOff: true, footer: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  // A workspace with the subject but not yet the frame's message (20261218100000) keeps the rest.
  try {
    return await db.notificationEmailLayout.findUnique({ where: { id: "global" }, select: { subject: true, greeting: true, signOff: true, footer: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  // A workspace with the frame but not yet its subject (20261215620000) keeps the rest.
  try {
    return await db.notificationEmailLayout.findUnique({ where: { id: "global" }, select: { greeting: true, signOff: true, footer: true } });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

const blankToNull = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);

/** Saves one kind's wording; both blank removes it, back to Deskzo's. The caller checks who may, and the text. */
export async function saveNotificationWording(type: NotificationType, words: NotificationEmailWords, byUserId: string): Promise<void> {
  const subject = blankToNull(words.subject);
  const body = blankToNull(words.body);
  if (!subject && !body) {
    await db.notificationEmailWording.deleteMany({ where: { type } });
    return;
  }
  await db.notificationEmailWording.upsert({
    where: { type },
    create: { type, subject, body, updatedById: byUserId },
    update: { subject, body, updatedById: byUserId },
    select: { type: true },
  });
}

/** Saves the frame; all blank removes it, back to Deskzo's. The caller checks who may, and the text. */
export async function saveNotificationFrame(frame: NotificationEmailFrame, byUserId: string): Promise<void> {
  const subject = blankToNull(frame.subject);
  const body = blankToNull(frame.body);
  const greeting = blankToNull(frame.greeting);
  const signOff = blankToNull(frame.signOff);
  const footer = blankToNull(frame.footer);
  if (!subject && !body && !greeting && !signOff && !footer) {
    await db.notificationEmailLayout.deleteMany({});
    return;
  }
  await db.notificationEmailLayout.upsert({
    where: { id: "global" },
    create: { id: "global", subject, body, greeting, signOff, footer, updatedById: byUserId },
    update: { subject, body, greeting, signOff, footer, updatedById: byUserId },
    select: { id: true },
  });
}

// ─── Held until the hours open (owner, 16 Nov 2026: 10:00–17:45) ──────────────────────────────────────────────

export type HeldNotificationEmail = { userId: string; type: NotificationType; subject: string; body: string; link: string | null; sendAfter: Date };

/** Keeps one email to send when the hours open; false where the workspace can't hold one yet, so it goes now. */
export async function holdNotificationEmail(mail: HeldNotificationEmail): Promise<boolean> {
  try {
    await db.notificationEmailHeld.create({ data: mail, select: { id: true } });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}
