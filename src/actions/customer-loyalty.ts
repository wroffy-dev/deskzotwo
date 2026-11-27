"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { refuseWhileViewingAs } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { DEFAULT_LOYALTY_RULES, RULE_BOUNDS, RULE_LABELS, type LoyaltyRules } from "@/lib/customers/loyalty-rules";
import { loyaltyRules, refreshCustomerStats } from "@/lib/customers/stats";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Customer loyalty (owner, 31 Oct 2026 — src/lib/customers/loyalty-rules.ts): the numbers each tier is
 * decided by, and "Refresh now". `settings.manage`, as the catalogue gates the page. Saving refreshes every customer's
 * figures and tier, so the lists show the new rules at once rather than tomorrow.
 */

const DENIED = "Only somebody who manages settings can change the loyalty tiers.";

export type LoyaltyView = { rules: LoyaltyRules; migrated: boolean; refreshedAt: string | null; refreshMs: number | null; customers: number };

export async function loyaltySettingsView(): Promise<ActionResult<LoyaltyView>> {
  const user = await requireModuleUser("companies");
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: DENIED };
  const { rules, migrated, refreshedAt, refreshMs } = await loyaltyRules();
  const customers = migrated ? await db.customerStats.count() : 0;
  return { ok: true, data: { rules, migrated, refreshedAt: refreshedAt?.toISOString() ?? null, refreshMs, customers } };
}

const schema = z.object(
  Object.fromEntries(
    (Object.keys(DEFAULT_LOYALTY_RULES) as (keyof LoyaltyRules)[]).map((k) => [k, z.number().int("Whole numbers only.").min(RULE_BOUNDS[k].min).max(RULE_BOUNDS[k].max)]),
  ) as Record<keyof LoyaltyRules, z.ZodNumber>,
);

export async function saveLoyaltySettings(input: unknown): Promise<ActionResult<{ customers: number }>> {
  const user = await requireModuleUser("companies");
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: DENIED };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const key = parsed.error.issues[0]?.path[0] as keyof typeof RULE_BOUNDS | undefined;
    const bounds = key ? RULE_BOUNDS[key] : undefined;
    return { ok: false, error: key && bounds ? `"${RULE_LABELS[key]}" must be between ${bounds.min} and ${bounds.max}.` : "Check the numbers — one is out of range." };
  }
  if (!(await loyaltyRules()).migrated) return { ok: false, error: "This workspace is still being updated for loyalty tiers. Try again in a few minutes." };
  const rules = parsed.data as LoyaltyRules;
  if (rules.atRiskFromMonths >= rules.lapsedAfterMonths) return { ok: false, error: "At risk has to start before Lapsed does." };
  await db.loyaltySettings.upsert({
    where: { id: "default" },
    create: { id: "default", ...rules, updatedById: user.id },
    update: { ...rules, updatedById: user.id },
    select: { id: true },
  });
  const changed = (Object.keys(rules) as (keyof LoyaltyRules)[]).filter((k) => rules[k] !== DEFAULT_LOYALTY_RULES[k]);
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "LoyaltySettings",
    entityId: "default",
    entityLabel: `Customer loyalty: ${changed.length ? changed.map((k) => `${k} ${rules[k]}`).join(", ") : "the defaults"}`,
  });
  const run = await refreshCustomerStats();
  revalidatePath("/settings/customer-loyalty");
  return { ok: true, data: { customers: run.customers } };
}

/** Works every customer's figures out now, rather than at tonight's refresh. */
export async function refreshCustomerStatsNow(): Promise<ActionResult<{ customers: number; ms: number }>> {
  const user = await requireModuleUser("companies");
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: DENIED };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const run = await refreshCustomerStats();
  if (!run.migrated) return { ok: false, error: "This workspace is still being updated for loyalty tiers. Try again in a few minutes." };
  revalidatePath("/settings/customer-loyalty");
  revalidatePath("/customers");
  return { ok: true, data: { customers: run.customers, ms: run.ms } };
}
