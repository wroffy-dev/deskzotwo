import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * The template a notice sent by itself uses (owner, 13 Nov 2026): the automatic renewal reminder went out in the
 * built-in wording whatever the workspace had designed. An admin picks one of Marketing › Templates on Settings ›
 * Renewals — the same list a hand-sent reminder offers (an active email template on the Renewals topic) — or the
 * built-in wording. A template since switched off, deleted or moved off email is the built-in wording again, so a
 * reminder never fails for want of one.
 */

export type AutoNoticeKind = "RENEWAL";

export type TemplateOption = { id: string; name: string; designed: boolean };

/** The templates a renewal reminder may use: active, email, the Renewals topic — as the send dialog lists them. */
export async function renewalTemplateOptions(): Promise<TemplateOption[]> {
  const rows = await db.marketingTemplate.findMany({
    where: { active: true, channel: "EMAIL", topic: "RENEWALS" },
    orderBy: { name: "asc" },
    select: { id: true, name: true, format: true },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, designed: r.format === "HTML" }));
}

/** The template chosen for a kind, as stored — null for the built-in wording, or before the table exists. */
export async function chosenAutoTemplate(kind: AutoNoticeKind): Promise<string | null> {
  try {
    return (await db.autoNoticeTemplate.findUnique({ where: { kind }, select: { templateId: true } }))?.templateId ?? null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** The template a notice sent by itself goes in now: the one chosen while it can still be used, else none. */
export async function autoTemplateFor(kind: AutoNoticeKind): Promise<string | undefined> {
  const id = await chosenAutoTemplate(kind);
  if (!id) return undefined;
  const usable = await db.marketingTemplate.findFirst({ where: { id, active: true, channel: "EMAIL", topic: "RENEWALS" }, select: { id: true } });
  return usable?.id;
}

export async function setAutoTemplate(kind: AutoNoticeKind, templateId: string | null, byUserId: string): Promise<void> {
  await db.autoNoticeTemplate.upsert({
    where: { kind },
    create: { kind, templateId, updatedById: byUserId },
    update: { templateId, updatedById: byUserId },
    select: { kind: true },
  });
}
