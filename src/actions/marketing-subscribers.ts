"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { refuseWhileViewingAs } from "@/lib/session";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { TOPICS } from "@/lib/marketing/topics";
import type { ActionResult } from "@/actions/company";

/**
 * A subscriber who asked somebody on the team to stop (owner, 1 Nov 2026 — Marketing › Subscribers): every email topic
 * opted out, their address suppressed, any journey they were on ended — as the unsubscribe link does, with whoever
 * pressed it and their note as the evidence.
 */
export async function unsubscribeSubscriber(input: { contactId: string; note?: string }): Promise<ActionResult<null>> {
  const user = await requireModuleUser("marketing");
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  if (!(await hasEffectivePermission(user.id, "marketing.manage"))) return { ok: false, error: "You can't change who hears from us." };
  const contact = await db.contact.findUnique({ where: { id: String(input?.contactId ?? "") }, select: { id: true, name: true, email: true } });
  if (!contact) return { ok: false, error: "That person isn't here any more." };
  const now = new Date();
  const evidence = (input.note?.trim() || "Asked us to stop").slice(0, 500);
  for (const t of TOPICS) {
    await db.contactConsent.upsert({
      where: { contactId_channel_topic: { contactId: contact.id, channel: "EMAIL", topic: t.key } },
      create: { contactId: contact.id, channel: "EMAIL", topic: t.key, status: "UNSUBSCRIBED", source: "VERBAL", evidence, capturedById: user.id, withdrawnAt: now },
      update: { status: "UNSUBSCRIBED", evidence, capturedById: user.id, withdrawnAt: now },
    });
  }
  if (contact.email) {
    const address = contact.email.trim().toLowerCase();
    await db.suppression.upsert({
      where: { scope_value: { scope: "EMAIL", value: address } },
      create: { scope: "EMAIL", value: address, reason: "UNSUBSCRIBED", note: evidence, createdById: user.id },
      update: { reason: "UNSUBSCRIBED" },
    });
  }
  await db.journeyEnrolment.updateMany({ where: { contactId: contact.id, status: "ACTIVE" }, data: { status: "EXITED", exitedAt: now, exitReason: "They unsubscribed", nextRunAt: null } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ContactConsent", entityId: contact.id, entityLabel: `${contact.name} unsubscribed from all email — ${evidence}` });
  revalidatePath("/marketing/subscribers");
  revalidatePath("/marketing/suppressions");
  return { ok: true, data: null };
}
