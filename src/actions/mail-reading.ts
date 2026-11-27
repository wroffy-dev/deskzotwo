"use server";

import { revalidatePath } from "next/cache";
import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import type { ActionResult } from "@/actions/company";
import { MAIL_READERS, isMailReader, type MailReader } from "@/lib/mail-reading/agents";
import { mailReadingView, myMailReading, setMailReaders, setMailReading, type MailReadingView } from "@/lib/mail-reading/server";

/**
 * Settings › Deskzo AI › Reading mailboxes (owner, 23 Nov 2026: "lets give agent access to read mails ! this will be admin
 * based if he wants to give access or not" — src/lib/mail-reading). Whoever may change the workspace's settings
 * (settings.manage) turns reading on and chooses, mailbox by mailbox, which agent may read it. Every change is audited.
 */

const ADMINS_ONLY = "Only whoever manages the workspace's settings can change this.";

export async function getMailReading(): Promise<MailReadingView | null> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return null;
  return mailReadingView();
}

export async function setMailReadingOn(on: boolean): Promise<ActionResult<null>> {
  const user = await requireUser();
  await refuseWhileViewingAs();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: ADMINS_ONLY };
  await setMailReading(on === true, user.id);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "MailReadSettings", entityId: "default", entityLabel: on ? "Let the AI teammates read connected mailboxes" : "Stopped the AI teammates reading mailboxes" });
  revalidatePath("/settings/copilot");
  return { ok: true, data: null };
}

export async function setPersonMailReaders(personId: string, agents: string[]): Promise<ActionResult<null>> {
  const user = await requireUser();
  await refuseWhileViewingAs();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: ADMINS_ONLY };
  const person = typeof personId === "string" ? await db.user.findUnique({ where: { id: personId }, select: { id: true, name: true, mailConnection: { select: { mailbox: true } } } }) : null;
  if (!person?.mailConnection) return { ok: false, error: "That person hasn't connected a mailbox." };
  const picked = (Array.isArray(agents) ? agents : []).filter(isMailReader) as MailReader[];
  await setMailReaders(person.id, picked, user.id);
  const names = picked.map((k) => MAIL_READERS.find((r) => r.key === k)!.name);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "MailReadGrant", entityId: person.id, entityLabel: `${person.name}'s mailbox (${person.mailConnection.mailbox}): ${names.length ? `read by ${names.join(", ")}` : "not read"}` });
  revalidatePath("/settings/copilot");
  return { ok: true, data: null };
}

/** For the person's own Profile: who reads their mailbox, and whether they still need to reconnect to allow it. */
export async function getMyMailReading(): Promise<{ readers: string[]; needsReconnect: boolean } | null> {
  const user = await requireUser();
  const mine = await myMailReading(user.id);
  return mine ? { readers: mine.readers.map((k) => MAIL_READERS.find((r) => r.key === k)!.name), needsReconnect: mine.needsReconnect } : null;
}
