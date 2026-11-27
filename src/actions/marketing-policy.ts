"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { refuseWhileViewingAs } from "@/lib/session";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { SUNSET_CHOICES } from "@/lib/marketing/policy";
import type { ActionResult } from "@/actions/company";

/**
 * The sunset rule (owner, 1 Nov 2026 — src/lib/marketing/policy.ts): stop marketing to anybody sent several emails in the
 * last 90, 180 or 365 days who opened none; null switches it off. Settings › Mail & messaging, for whoever configures mail.
 */
export async function saveSunset(days: number | null): Promise<ActionResult<null>> {
  const user = await requireModuleUser("marketing");
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return { ok: false, error: "You can't change the marketing rules." };
  if (days !== null && !(SUNSET_CHOICES as readonly number[]).includes(days)) return { ok: false, error: "Pick 90, 180 or 365 days — or off." };
  await db.marketingPolicy.upsert({ where: { id: "global" }, create: { id: "global", sunsetDays: days }, update: { sunsetDays: days } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "MarketingPolicy", entityId: "global", entityLabel: days ? `Sunset rule: stop marketing after ${days} days without an open` : "Sunset rule off" });
  revalidatePath("/settings/messaging");
  return { ok: true, data: null };
}

/**
 * Whether marketing goes only to people who opted in to its topic (owner, 2 Nov 2026 — src/lib/marketing/policy.ts).
 * Off by default; an opt-out holds a person back either way. For whoever configures mail.
 */
export async function saveRequireOptIn(on: boolean): Promise<ActionResult<null>> {
  const user = await requireModuleUser("marketing");
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return { ok: false, error: "You can't change the marketing rules." };
  const value = on === true;
  await db.marketingPolicy.upsert({ where: { id: "global" }, create: { id: "global", requireOptIn: value }, update: { requireOptIn: value }, select: { id: true } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "MarketingPolicy", entityId: "global", entityLabel: value ? "Marketing only to people who opted in" : "Marketing without asking for an opt-in" });
  revalidatePath("/settings/messaging");
  return { ok: true, data: null };
}
