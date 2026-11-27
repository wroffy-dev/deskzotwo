"use server";

import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { profitAndLoss } from "@/actions/ledger-reports";
import { workspacePack } from "@/lib/country-pack";
import { fyDays, fyLabel } from "@/lib/india-time";
import type { ActionResult } from "@/actions/company";

/**
 * Accounting › Corporate Tax (owner, 14 Nov 2026 — src/lib/corporate-tax.ts): a UAE workspace's revenue and accounting
 * profit for a tax period — its financial year — from the ledger, as the P&L reads them. The working itself (the
 * adjustments, the relief, the tax) is done on the page from these two figures; nothing is stored or filed. For whoever
 * manages payments, as the VAT return is.
 */
export type CorporateTaxBase = { year: number; label: string; from: string; to: string; revenue: number; accountingProfit: number };

export async function corporateTaxBase(year: number): Promise<ActionResult<CorporateTaxBase>> {
  const user = await requireModuleAccess("accounting");
  if (!(await hasEffectivePermission(user.id, "payments.manage"))) return { ok: false, error: "The Corporate Tax working needs the right to manage payments." };
  if (workspacePack().country !== "AE") return { ok: false, error: "The Corporate Tax working is for a UAE workspace." };
  if (!Number.isInteger(year) || year < 2023 || year > 2100) return { ok: false, error: "Pick a tax period." };
  const { first, last } = fyDays(year);
  const from = first.toISOString().slice(0, 10);
  const to = last.toISOString().slice(0, 10);
  const pl = await profitAndLoss({ from, to });
  return { ok: true, data: { year, label: fyLabel(year), from, to, revenue: pl.totalIncome, accountingProfit: pl.netProfit } };
}
