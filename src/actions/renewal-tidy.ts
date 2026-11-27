"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { refuseWhileViewingAs } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { formatOrderId } from "@/lib/order-id";
import { applyRenewalTidy, planRenewalTidy } from "@/lib/renewal-tidy";
import type { ActionResult } from "@/actions/company";

/**
 * Renewals › Clean up old renewals (owner, 31 Oct 2026 — src/lib/renewal-tidy.ts): see, then do. Thousands of rows
 * change at once, so it is whoever changes the workspace's settings, never while viewing as somebody else.
 */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

async function gate(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const user = await requireModuleAccess("renewals");
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return { ok: false, error: "Only somebody who can change the workspace's settings can clean up renewals." };
  return { ok: true, userId: user.id };
}

function dayOf(raw: unknown): Date | null {
  const key = String(raw ?? "");
  return DAY_KEY.test(key) ? new Date(`${key}T00:00:00Z`) : null;
}

export type TidyPreview = {
  linked: number;
  closed: number;
  /** A few of each, to see what it means. */
  sampleLinks: { company: string; product: string; ended: Date; renewedBy: string }[];
  sampleClosed: { company: string; product: string; ended: Date }[];
};

export async function previewRenewalTidy(endedBefore: string): Promise<ActionResult<TidyPreview>> {
  const who = await gate();
  if (!who.ok) return who;
  const before = dayOf(endedBefore);
  if (!before) return { ok: false, error: "Pick the day: subscriptions that ended before it are cleaned up." };
  const plan = await planRenewalTidy(before);
  const ids = [...plan.links.slice(0, 8).flatMap((l) => [l.fromId, l.toId]), ...plan.close.slice(0, 8)];
  const rows = await db.companyProduct.findMany({
    where: { id: { in: ids } },
    select: { id: true, orderSeq: true, endDate: true, item: { select: { name: true } }, company: { select: { name: true } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    ok: true,
    data: {
      linked: plan.links.length,
      closed: plan.close.length,
      sampleLinks: plan.links.slice(0, 8).flatMap((l) => {
        const from = byId.get(l.fromId);
        const to = byId.get(l.toId);
        return from && to ? [{ company: from.company.name, product: from.item.name, ended: from.endDate!, renewedBy: formatOrderId(to.orderSeq) }] : [];
      }),
      sampleClosed: plan.close.slice(0, 8).flatMap((id) => {
        const r = byId.get(id);
        return r ? [{ company: r.company.name, product: r.item.name, ended: r.endDate! }] : [];
      }),
    },
  };
}

export async function runRenewalTidy(endedBefore: string): Promise<ActionResult<{ linked: number; closed: number }>> {
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const who = await gate();
  if (!who.ok) return who;
  const before = dayOf(endedBefore);
  if (!before) return { ok: false, error: "Pick the day: subscriptions that ended before it are cleaned up." };
  // Planned again now: what was previewed may have changed since.
  const done = await applyRenewalTidy(await planRenewalTidy(before), who.userId);
  await recordAudit({
    userId: who.userId,
    action: "UPDATE",
    entityType: "CompanyProduct",
    entityId: "renewal-tidy",
    entityLabel: `Cleaned up renewals that ended before ${endedBefore}: ${done.linked} linked to their renewal, ${done.closed} closed as ended before Deskzo`,
  });
  revalidatePath("/renewals");
  return { ok: true, data: done };
}
