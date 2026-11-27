"use server";

import { requireUser } from "@/lib/session";
import { lookupRate, type RateLookup } from "@/lib/finance/exchange-rate";
import { rateFor } from "@/lib/finance/rates";
import { partyTerms, type PartyTerms } from "@/lib/companies/default-currency";
import { requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { db } from "@/lib/db";

/**
 * What a currency was worth in rupees on a given day — for a document raised in another currency,
 * and the converter in the side rail. In every plan: the rate is published, and not the company's.
 *
 * A `"use server"` export, so it checks a session — but nothing stronger. The outbound call happens
 * here rather than in the browser; see lib/finance/exchange-rate.ts for why.
 */
export async function lookupExchangeRate(code: string, onDate: string): Promise<RateLookup> {
  await requireUser();
  return lookupRate(code, onDate);
}

/**
 * The day's rate as the workspace keeps it (src/lib/finance/rates.ts, owner 30 Oct 2026) — the table's for that day or
 * the week before, else looked up and kept. What the document form's "Use the day's rate" asks, in the same shape as
 * `lookupExchangeRate` so the form reads either alike.
 */
export async function exchangeRateFor(code: string, onDate: string): Promise<RateLookup> {
  await requireUser();
  const known = await rateFor(code, onDate);
  if (!known) return { ok: false, reason: `Couldn't find a rate for ${code} on that date. Enter the rate you agreed.` };
  const source = known.source === "typed" ? "Your rate in Settings › Currencies" : "Daily FX reference data";
  return { ok: true, rate: known.rate, source, onDate: known.day };
}

/**
 * What a new document for this party starts in on `onDate`: its own currency at the day's rate, else the workspace's
 * (src/lib/companies/default-currency.ts). Asked by the document form when somebody picks the customer or vendor. A
 * party this person can't see answers as the workspace's currency, saying nothing about it.
 */
export async function partyCurrencyFor(companyId: string, onDate: string): Promise<PartyTerms | null> {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true, relationshipType: true } });
  if (!company || !(await canSeeCompany(user.id, company))) return null;
  return partyTerms(companyId, onDate);
}
