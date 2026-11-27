"use server";

import { revalidatePath } from "next/cache";
import { tooLong } from "@/lib/validation/text";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { workspaceClock } from "@/lib/time/workspace";
import { baseCurrency, CURRENCIES } from "@/lib/currency";
import { currenciesInUse, dayDate, fetchRatesInUse, foreignCurrency, ratesHere, storedRateFor, storeRate, type KnownRate } from "@/lib/finance/rates";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Currencies (owner, 30 Oct 2026): the workspace's exchange-rate table (src/lib/finance/rates.ts) — the day's
 * rate per currency in use, a rate typed for a day, a fetch now, and what was kept lately. `payments.manage`, the
 * finance function's key (the catalogue's gate), where sales or purchase documents are on.
 */

const DENIED = "Only somebody who manages finance records can change exchange rates.";

async function ratesUser() {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await can(user.id, "payments.manage"))) return { user, error: DENIED };
  return { user, error: null };
}

export type CurrenciesView = {
  base: string;
  today: string;
  /** False where the workspace isn't migrated to 20261201100000_currency_defaults_and_rates yet. */
  migrated: boolean;
  /** The currencies in use, with the rate a document dated today would start at (none: null). */
  inUse: { code: string; label: string; rate: KnownRate | null }[];
  /** Every foreign currency, for typing a rate for one not in use yet. */
  choices: { code: string; label: string }[];
  history: { day: string; currency: string; rate: number; source: string; setBy: string | null; updatedAt: string }[];
};

export async function currenciesView(): Promise<ActionResult<CurrenciesView>> {
  const { error } = await ratesUser();
  if (error) return { ok: false, error };
  const today = (await workspaceClock()).today();
  const base = baseCurrency();
  const choices = CURRENCIES.filter((c) => c.code !== base).map((c) => ({ code: c.code, label: c.label }));
  const migrated = await ratesHere();
  if (!migrated) return { ok: true, data: { base, today, migrated, inUse: [], choices, history: [] } };

  const codes = await currenciesInUse(today);
  // Read from the table only: opening the page never reaches the provider — "Fetch now" does.
  const inUse = await Promise.all(
    codes.map(async (code) => ({ code, label: CURRENCIES.find((c) => c.code === code)?.label ?? code, rate: await storedRateFor(code, today) })),
  );
  const rows = await db.exchangeRate.findMany({ orderBy: [{ day: "desc" }, { currency: "asc" }], take: 60 });
  const people = await db.user.findMany({
    where: { id: { in: [...new Set(rows.flatMap((r) => (r.setById ? [r.setById] : [])))] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  return {
    ok: true,
    data: {
      base,
      today,
      migrated,
      inUse,
      choices,
      history: rows.map((r) => ({
        day: r.day.toISOString().slice(0, 10),
        currency: r.currency,
        rate: Number(r.rate),
        source: r.source,
        setBy: r.setById ? (nameOf.get(r.setById) ?? "Somebody since removed") : null,
        updatedAt: r.updatedAt.toISOString(),
      })),
    },
  };
}

const typedRateSchema = z.object({
  currency: z.string().max(100, tooLong(100)).refine((v) => foreignCurrency(v), "Choose a currency from the list."),
  day: z.string().max(100, tooLong(100)).regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the day the rate is for."),
  rate: z.coerce.number().positive("The rate must be more than zero").max(100000),
});

/** A rate somebody types for a day — the bank's, the one agreed. Replaces whatever the day had; a fetch never replaces it. */
export async function setTypedRate(input: unknown): Promise<ActionResult<null>> {
  const { user, error } = await ratesUser();
  if (error) return { ok: false, error };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const parsed = typedRateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid rate" };
  if (!(await ratesHere())) return { ok: false, error: "Exchange rates arrive with the next update of this workspace." };
  const { currency, day, rate } = parsed.data;
  if (Number.isNaN(dayDate(day).getTime())) return { ok: false, error: "Choose the day the rate is for." };
  const before = await db.exchangeRate.findUnique({ where: { day_currency: { day: dayDate(day), currency } }, select: { id: true, rate: true } });
  await storeRate({ currency, day, rate, source: "typed", setById: user.id });
  const row = await db.exchangeRate.findUnique({ where: { day_currency: { day: dayDate(day), currency } }, select: { id: true } });
  await recordAudit({
    userId: user.id,
    action: before ? "UPDATE" : "CREATE",
    entityType: "ExchangeRate",
    entityId: row?.id ?? `${day}:${currency}`,
    entityLabel: `1 ${currency} = ${rate} ${baseCurrency()} on ${day}${before ? ` (was ${Number(before.rate)})` : ""}`,
  });
  revalidatePath("/settings/currencies");
  return { ok: true, data: null };
}

/** Fetches today's rate for every currency in use now, rather than waiting for the heartbeat. Typed rates stand. */
export async function fetchRatesNow(): Promise<ActionResult<{ fetched: number; failed: string[] }>> {
  const { error } = await ratesUser();
  if (error) return { ok: false, error };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await ratesHere())) return { ok: false, error: "Exchange rates arrive with the next update of this workspace." };
  const result = await fetchRatesInUse({ force: true });
  revalidatePath("/settings/currencies");
  return { ok: true, data: { fetched: result.fetched, failed: result.failed } };
}
