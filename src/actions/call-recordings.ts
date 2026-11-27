"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/authz/resolve";
import { requireModuleUser } from "@/lib/modules-access";
import { RETENTION_CHOICES, recordingSettings, recordingStore, recordingTotals } from "@/lib/calls/recordings";
import type { ActionResult } from "@/actions/company";

/**
 * Call recordings, set up (owner, 9 Nov 2026 — src/lib/calls/recordings.ts): whether the Deskzo app sends the phone
 * recorder's files, and how long they're kept. On Settings › Deskzo app, for whoever may change settings.
 */

export type RecordingSetup = { enabled: boolean; retentionDays: number | null; storeReady: boolean; count: number; bytes: number };

export async function getRecordingSetup(): Promise<RecordingSetup | null> {
  const user = await requireModuleUser("calls");
  if (!(await can(user.id, "settings.manage"))) return null;
  const [settings, store, totals] = await Promise.all([recordingSettings(), recordingStore().catch(() => null), recordingTotals()]);
  return { ...settings, storeReady: store !== null, count: totals.count, bytes: totals.bytes };
}

/** On or off, and the days kept (one of the choices, or null for good). A new retention applies to recordings from now on. */
export async function saveRecordingSettings(input: { enabled: boolean; retentionDays: number | null }): Promise<ActionResult<null>> {
  const user = await requireModuleUser("calls");
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "You can't change settings." };
  const retentionDays = input.retentionDays === null ? null : Number(input.retentionDays);
  if (retentionDays !== null && !(RETENTION_CHOICES as readonly number[]).includes(retentionDays)) return { ok: false, error: "Choose how long they're kept from the list." };
  if (input.enabled && !(await recordingStore().catch(() => null))) return { ok: false, error: "This server has nowhere to keep recordings yet: Deskzo's Azure Blob container isn't set up for it." };
  const data = { enabled: !!input.enabled, retentionDays, updatedById: user.id };
  await db.callRecordingSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "CallRecordingSettings", entityId: "default", entityLabel: `Call recordings ${data.enabled ? "on" : "off"}, kept ${retentionDays === null ? "for good" : `${retentionDays} days`}` });
  revalidatePath("/settings/phone");
  return { ok: true, data: null };
}
