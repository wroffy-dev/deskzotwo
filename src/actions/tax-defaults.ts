"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { controlDb } from "@/lib/platform/control-db";
import { currentTenant } from "@/lib/tenancy/resolve";
import { forgetRegistry } from "@/lib/tenancy/registry";
import { countryPack } from "@/lib/country-pack";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Taxes › Default tax rate (owner, 23 Nov 2026: "do both... see how zoho books has" — Zoho Books' Default Tax
 * Preference, and asked in setup). The rate a new item and a new document line start with, for everybody: one of the
 * country's rates (src/lib/country-pack.ts), kept on the workspace itself (`Tenant.defaultTaxRate`, the control plane's,
 * beside its country and time zone) where every request and the browser find it without a query.
 *
 * Nothing already saved changes with it — an item keeps its own rate. Items with no rate at all (as the Zoho switch left
 * many) can be given it in one go, by somebody who asks: never an exempt, zero-rated or out-of-scope one.
 * `settings.manage`, as the rest of the organisation's settings.
 */

async function settingsAdmin() {
  const user = await requireUser();
  return (await hasEffectivePermission(user.id, "settings.manage")) ? user : null;
}

export type TaxDefaults = {
  /** "GST", "VAT", "Tax". */
  taxName: string;
  /** What new items and lines start with now. */
  rate: number;
  /** The country's own, when none is chosen. */
  countryDefault: number;
  /** Whether the workspace chose one, rather than going with its country's. */
  chosen: boolean;
  /** The rates it may pick. */
  rates: number[];
  /** False for a workspace from the server's configuration: its default is its country's. */
  changeable: boolean;
  /** Items with no rate that could be given it: not exempt, zero-rated or out of scope. */
  itemsWithoutRate: number;
};

const WITHOUT_RATE = { taxRatePercent: null, OR: [{ taxCategory: null }, { taxCategory: "STANDARD" as const }] };

/** For Settings › Taxes. Null without settings.manage. */
export async function getTaxDefaults(): Promise<TaxDefaults | null> {
  if (!(await settingsAdmin())) return null;
  const tenant = await currentTenant();
  const pack = countryPack(tenant.country);
  const chosen = tenant.defaultTaxRate != null && pack.tax.rates.includes(tenant.defaultTaxRate);
  return {
    taxName: pack.tax.name,
    rate: chosen ? tenant.defaultTaxRate! : pack.tax.defaultRate,
    countryDefault: pack.tax.defaultRate,
    chosen,
    rates: [...pack.tax.rates],
    changeable: tenant.source === "control",
    itemsWithoutRate: await db.item.count({ where: WITHOUT_RATE }),
  };
}

/** The workspace's default rate; the country's own when it's the same. Also what setup's question saves. */
export async function setDefaultTaxRate(input: unknown): Promise<ActionResult<null>> {
  const admin = await settingsAdmin();
  if (!admin) return { ok: false, error: "You can't change organisation settings." };
  const tenant = await currentTenant();
  if (tenant.source !== "control") return { ok: false, error: "This workspace's default rate is set in its server's configuration." };
  const pack = countryPack(tenant.country);
  const rate = Number((input as { rate?: unknown } | null)?.rate);
  if (!Number.isFinite(rate) || !pack.tax.rates.includes(rate)) return { ok: false, error: `Choose one of the ${pack.tax.name} rates.` };
  const before = tenant.defaultTaxRate ?? pack.tax.defaultRate;
  // The country's own is kept as none chosen, so a change to the country's default later reaches it.
  const keep = rate === pack.tax.defaultRate ? null : rate;
  if ((tenant.defaultTaxRate ?? null) === keep) return { ok: true, data: null };

  await controlDb().tenant.update({ where: { id: tenant.id }, data: { defaultTaxRate: keep } });
  // This process at once; the others within the registry's half a minute.
  forgetRegistry();
  await recordAudit({
    userId: admin.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "defaultTaxRate",
    entityLabel: `Default ${pack.tax.name} rate: ${before}% → ${rate}%`,
  });
  // New lines and items everywhere start with it.
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

/** Gives every item with no rate the default — never an exempt, zero-rated or out-of-scope one. */
export async function fillItemsWithoutRate(): Promise<ActionResult<{ filled: number; rate: number }>> {
  const admin = await settingsAdmin();
  if (!admin) return { ok: false, error: "You can't change organisation settings." };
  const tenant = await currentTenant();
  const pack = countryPack(tenant.country);
  const rate = tenant.defaultTaxRate != null && pack.tax.rates.includes(tenant.defaultTaxRate) ? tenant.defaultTaxRate : pack.tax.defaultRate;
  const { count } = await db.item.updateMany({ where: WITHOUT_RATE, data: { taxRatePercent: rate } });
  if (count) {
    await recordAudit({
      userId: admin.id,
      action: "UPDATE",
      entityType: "Item",
      entityId: "without-rate",
      entityLabel: `${count} item${count === 1 ? "" : "s"} with no ${pack.tax.name} rate given the default, ${rate}%`,
    });
  }
  revalidatePath("/settings/taxes");
  revalidatePath("/items");
  return { ok: true, data: { filled: count, rate } };
}
