"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { refuseWhileViewingAs } from "@/lib/session";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { BACK_NOTE_MAX, safeHex, type IdCardData } from "@/lib/id-cards/design";
import { fullIdCards, reissueIdCard } from "@/lib/id-cards/cards";
import { notMigratedYet } from "@/lib/not-migrated";
import type { ActionResult } from "@/actions/company";

const designSchema = z.object({
  accentColor: z.string().trim().max(7).nullable(),
  showDepartment: z.boolean(),
  showBloodGroup: z.boolean(),
  showEmergencyContact: z.boolean(),
  showJoinedOn: z.boolean(),
  showWorkPhone: z.boolean(),
  showEmail: z.boolean(),
  showSignature: z.boolean(),
  backNote: z.string().trim().max(BACK_NOTE_MAX, `Keep the line on the back to ${BACK_NOTE_MAX} characters.`).nullable(),
});

/** People › ID cards: how the workspace's cards look (owner, 31 Oct 2026 — src/lib/id-cards), for whoever manages people records. */
export async function saveIdCardDesign(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  if (!(await can(user.id, "hr.manage"))) return { ok: false, error: "Only somebody who manages people records can change the ID card." };
  const parsed = designSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the ID card's settings." };
  const raw = parsed.data.accentColor?.trim() || null;
  const accentColor = safeHex(raw);
  if (raw && !accentColor) return { ok: false, error: "Pick the colour as #RRGGBB, or leave it on the brand colour." };
  const data = { ...parsed.data, accentColor, backNote: parsed.data.backNote || null, updatedById: user.id };
  await db.idCardSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "IdCardSettings", entityId: "global", entityLabel: "ID card design" });
  revalidatePath("/people/id-cards");
  return { ok: true, data: null };
}

/**
 * A lost or stolen card (security audit, 11 Nov 2026 — SEC-66): the person gets a new card to print, and the old one's
 * QR stops checking out as valid. For whoever manages people records.
 */
export async function replaceIdCard(userId: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  if (!(await can(user.id, "hr.manage"))) return { ok: false, error: "Only somebody who manages people records can replace an ID card." };
  if (typeof userId !== "string" || userId.length > 100) return { ok: false, error: "Pick whose card to replace." };
  const person = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (!person) return { ok: false, error: "That person no longer exists." };
  try {
    await reissueIdCard(userId);
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace is being updated — try again in a few minutes." };
    throw err;
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "User", entityId: userId, entityLabel: `${person.name}'s ID card replaced — the old card no longer checks out` });
  revalidatePath("/people/id-cards");
  return { ok: true, data: null };
}

/** One person's card with every detail, for the design page's preview. */
export async function previewIdCard(userId: string): Promise<IdCardData | null> {
  const user = await requireModuleUser("hr");
  if (!(await can(user.id, "hr.manage")) || typeof userId !== "string") return null;
  return (await fullIdCards([userId]))[0] ?? null;
}
