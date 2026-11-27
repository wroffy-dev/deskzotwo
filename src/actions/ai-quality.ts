"use server";

import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { houseStyle, saveHouseStyle, type HouseStyle } from "@/lib/ai/house-style";
import { scorecard, setFeedback, type TeammateScore } from "@/lib/ai/drafts";
import { isTeammateKey } from "@/lib/ai/teammates";
import type { ActionResult } from "@/actions/company";

/**
 * Upgrading the AI teammates, step 2 (owner, 20 Nov 2026): the workspace's house style and each teammate's scorecard
 * (whoever may change the workspace's settings), and a thumbs up or down on a teammate's work (whoever it was for).
 */

export async function getHouseStyle(): Promise<HouseStyle | null> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return null;
  return houseStyle();
}

export async function saveHouseStyleAction(input: HouseStyle): Promise<ActionResult<HouseStyle>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "Only somebody who can change the workspace's settings can change this." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  await saveHouseStyle({ tone: text(input?.tone), signOff: text(input?.signOff), alwaysMention: text(input?.alwaysMention), neverSay: text(input?.neverSay), notes: text(input?.notes) }, user.id);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "AiHouseStyle", entityId: "global", entityLabel: "Changed the AI teammates' house style" });
  return { ok: true, data: await houseStyle() };
}

export async function getTeamScorecard(): Promise<TeammateScore[] | null> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return null;
  return scorecard();
}

/** Whether this person was who a teammate's draft or answer was for — only they rate it. */
async function wasFor(userId: string, kind: string, ref: string): Promise<boolean> {
  if (kind === "nurture.email") return (await db.nurtureTouch.count({ where: { id: ref, enrolment: { ownerId: userId } } })) > 0;
  if (kind === "nurture.answer") return (await db.nurtureReply.count({ where: { id: ref, enrolment: { ownerId: userId } } })) > 0;
  if (kind === "reengage.email") return (await db.reengageEmail.count({ where: { id: ref, ownerId: userId } })) > 0;
  if (kind === "collections.chase") return (await db.collectionChase.count({ where: { id: ref, OR: [{ createdById: userId }, { sentById: userId }] } })) > 0;
  if (kind === "hr.answer") return (await db.hrDeskQuestion.count({ where: { id: ref, askerId: userId } })) > 0;
  return false;
}

/** A thumbs up or down on a teammate's work, with an optional reason; `good: null` takes it back. */
export async function rateAiWork(input: { teammate: string; kind: string; ref: string; good: boolean | null; reason?: string }): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const teammate = String(input?.teammate ?? "");
  if (!isTeammateKey(teammate)) return { ok: false, error: "Unknown teammate." };
  const kind = String(input?.kind ?? "");
  const ref = String(input?.ref ?? "");
  if (!(await wasFor(user.id, kind, ref))) return { ok: false, error: "Only the person it was for can rate it." };
  await setFeedback({ teammate, kind, ref, userId: user.id, good: input?.good === null ? null : input?.good === true, reason: input?.reason ?? null });
  return { ok: true, data: null };
}
