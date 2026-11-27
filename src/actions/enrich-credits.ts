"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { PEOPLE_ONLY } from "@/lib/people";
import { EVERYBODY, creditsView, limitFor, setLimit, usedThisMonth, type CreditsView, type Provider } from "@/lib/enrich/credits";
import type { ActionResult } from "@/actions/company";
import type { ApolloCompany } from "@/lib/apollo/client";
import { apolloSetup } from "@/lib/apollo/server";
import { lushaSetup } from "@/lib/lusha/server";
import { previewByWebsite } from "@/lib/enrich/preview";

/**
 * Credits per person for Apollo and Lusha (owner, 15 Nov 2026 — src/lib/enrich/credits.ts). Set on Settings › Apollo and
 * Settings › Lusha by whoever changes the workspace's settings; each person sees their own on the company panel.
 */

const provider = (v: unknown): Provider | null => (v === "APOLLO" || v === "LUSHA" ? v : null);
const SETTINGS_ONLY = "Only somebody who can change the workspace's settings can set credits.";

/** Settings' table: everybody's limit, and each person who may enrich, with their own limit and what they've used. */
export async function enrichCredits(which: string): Promise<ActionResult<CreditsView>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: SETTINGS_ONLY };
  const p = provider(which);
  if (!p) return { ok: false, error: "Apollo or Lusha." };
  const people = await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 });
  // Only those who may look anything up at all.
  const may: { id: string; name: string }[] = [];
  for (const person of people) if (await can(person.id, "companies.enrich")) may.push(person);
  return { ok: true, data: await creditsView(p, may) };
}

/** Sets a monthly limit — for everybody (`userId` "*") or one person; blank clears it (no limit, or everybody's). */
export async function setEnrichCredits(which: string, userId: string, credits: number | null): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: SETTINGS_ONLY };
  const p = provider(which);
  if (!p) return { ok: false, error: "Apollo or Lusha." };
  if (typeof userId !== "string" || !userId) return { ok: false, error: "Pick somebody." };
  if (userId !== EVERYBODY && !(await db.user.findUnique({ where: { id: userId }, select: { id: true } }))) return { ok: false, error: "That person isn't here." };
  if (credits !== null && (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0)) return { ok: false, error: "Credits are a whole number, 0 or more — or blank for no limit." };
  await setLimit(p, userId, credits, user.id);
  const who = userId === EVERYBODY ? "everybody" : ((await db.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "somebody");
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "EnrichmentAllowance", entityId: `${p}:${userId}`, entityLabel: `${p === "LUSHA" ? "Lusha" : "Apollo"} credits for ${who}: ${credits === null ? "no limit" : `${credits} a month`}` });
  revalidatePath(p === "LUSHA" ? "/settings/lusha" : "/settings/apollo");
  return { ok: true, data: null };
}

/** The person's own credits this month, for the company panel: used, and the limit (null: none). */
export async function myEnrichCredits(): Promise<Record<Provider, { used: number; limit: number | null }>> {
  const user = await requireUser();
  const [aUsed, aLimit, lUsed, lLimit] = await Promise.all([usedThisMonth(user.id, "APOLLO"), limitFor(user.id, "APOLLO"), usedThisMonth(user.id, "LUSHA"), limitFor(user.id, "LUSHA")]);
  return { APOLLO: { used: aUsed, limit: aLimit }, LUSHA: { used: lUsed, limit: lLimit } };
}

/** "Fill from website" on a new company's form: what Apollo or Lusha knows of the company at that website (src/lib/enrich/preview.ts). */
export async function companyFromWebsite(which: string, website: string): Promise<ActionResult<ApolloCompany>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.enrich"))) return { ok: false, error: "Looking up needs the \"Enrich from Apollo or Lusha\" permission." };
  const p = provider(which);
  if (!p) return { ok: false, error: "Apollo or Lusha." };
  if (typeof website !== "string" || website.length > 2000) return { ok: false, error: "Type the company's website first." };
  const r = await previewByWebsite(p, website, user.id);
  if (!r.found) return { ok: false, error: r.error ?? "Nothing found." };
  return { ok: true, data: r.found };
}

/** Which of Apollo and Lusha this person may look up with — for the new company form. */
export async function myEnrichProviders(): Promise<("apollo" | "lusha")[]> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.enrich"))) return [];
  const [a, l] = await Promise.all([apolloSetup(), lushaSetup()]);
  return [a.connected ? "apollo" : null, l.connected ? "lusha" : null].filter((x): x is "apollo" | "lusha" => x !== null);
}
