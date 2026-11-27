import { getBranding } from "@/actions/branding";
import { formatValue, isSealedType, type CustomFieldValues } from "@/lib/custom-fields/rules";
import { clientDef, definitionsFor, portalKeys } from "@/lib/custom-fields/server";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { getOrganisation } from "@/lib/organisation";
import { verifyDesign, type VerifyDesign } from "@/lib/verifiable/design";
import { numberKeyOf, publicFacts } from "@/lib/verifiable/rules";

/**
 * The public pages' facts, and the public search (owner, 7 Nov 2026 — src/app/(public)/verify): somebody types a certificate number or, if the workspace allows
 * it, a company's name. Built so that it answers "is this one real?" and not "who are your clients?":
 *
 *   · By number: the whole number, whatever its spaces, dashes or case. "ABC" doesn't find "ABC123".
 *   · By name: off until the workspace turns it on, four letters at least, ten results at most, the nearest first. Never a person,
 *     whose training certificate would otherwise say where they trained to anybody typing their name.
 *   · A document marked to stay out of search is found only by its QR code.
 *   · Withdrawn and expired ones are found too: that's the point of checking.
 */

/** The settings row as stored; null where there's none or the workspace isn't migrated yet. */
export async function verifiableSettingsRow() {
  try {
    return await db.verifiableSettings.findUnique({ where: { id: "global" } });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** The public pages' look, as they're drawn. */
export async function publicDesign(): Promise<VerifyDesign> {
  const [row, branding, org] = await Promise.all([verifiableSettingsRow(), getBranding(), getOrganisation()]);
  return verifyDesign({ ...row, issuer: org.tradeName?.trim() || org.legalName.trim() || branding.appName, brandLogo: branding.logoDataUrl ?? null, brandColor: branding.primaryColor ?? null });
}

/**
 * The workspace's own fields it marked for the public, in words, with a value. Only those: no customer record, nothing restricted, no
 * secret or file (a certificate's fields don't take them), and never a person's name.
 */
export async function publicExtraFields(values: unknown): Promise<{ label: string; text: string }[]> {
  const [defs, keys] = await Promise.all([definitionsFor("VERIFIABLE"), portalKeys("VERIFIABLE")]);
  const stored = (values && typeof values === "object" ? values : {}) as CustomFieldValues;
  return defs
    .filter((d) => keys.has(d.key) && !d.archived && !d.restricted && d.type !== "USER" && !isSealedType(d.type))
    .flatMap((d) => {
      const text = formatValue(clientDef(d), stored[d.key]);
      return text ? [{ label: d.label, text }] : [];
    });
}

export const NAME_SEARCH_MIN = 4;
export const NAME_SEARCH_MAX = 10;

export type VerifiableSearchSettings = { searchOn: boolean; nameSearch: boolean };

export async function verifiableSearchSettings(): Promise<VerifiableSearchSettings> {
  try {
    const row = await db.verifiableSettings.findUnique({ where: { id: "global" }, select: { searchOn: true, nameSearch: true } });
    return { searchOn: row?.searchOn ?? false, nameSearch: row?.nameSearch ?? false };
  } catch (err) {
    if (notMigratedYet(err)) return { searchOn: false, nameSearch: false };
    throw err;
  }
}

const SELECT = { token: true, docType: true, number: true, title: true, holderName: true, holderIsPerson: true, scope: true, issuedOn: true, expiresOn: true, withdrawnAt: true } as const;

/**
 * Security audit, 11 Nov 2026 (SEC-33): a person's certificate found by its number says it's real and in force,
 * but not whose it is, and gives no link to its page — that takes its QR code. Typing numbers one after another
 * would otherwise read out the names of everybody a workspace has certified.
 */
export type VerifiableHit = Omit<ReturnType<typeof publicFacts>, "holderName"> & { holderName: string | null; token: string | null };

/** Number lookups one address may make: in ten minutes, and in a day (SEC-33). Name searches stay tighter. */
export const NUMBER_SEARCH_LIMITS = { perTenMinutes: 20, perDay: 100 } as const;

/** Whether a search by this text would be a search by name: it decides how tight its allowance is. */
export const usesNameSearch = (text: string, settings: VerifiableSearchSettings) => settings.nameSearch && text.trim().length >= NAME_SEARCH_MIN;

export async function searchVerifiable(text: string, settings: VerifiableSearchSettings, today: Date): Promise<VerifiableHit[]> {
  const q = text.trim().slice(0, 120);
  const key = numberKeyOf(q);
  if (!key) return [];
  const byNumber = await db.verifiableDocument.findMany({ where: { numberKey: key, inSearch: true }, take: NAME_SEARCH_MAX, select: SELECT });
  const named = byNumber.length === 0 && usesNameSearch(q, settings);
  const rows = named
    ? await db.verifiableDocument.findMany({
        where: { inSearch: true, holderIsPerson: false, holderName: { contains: q, mode: "insensitive" } },
        orderBy: { holderName: "asc" },
        take: NAME_SEARCH_MAX,
        select: SELECT,
      })
    : byNumber;
  return rows.map((row) => {
    const facts = publicFacts(row, today);
    return row.holderIsPerson ? { ...facts, holderName: null, token: null } : { ...facts, token: row.token };
  });
}
