import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { createEInvoiceProvider, type ProviderConfig } from "@/lib/einvoice/provider";
import { countryFeatureAvailable } from "@/lib/modules-access";
import { isGstinStatus, lookupReady, normalizeGstin, type GstinCheckView } from "./notes";

/**
 * Asking the GST system about a customer's or vendor's GSTIN (owner, 25 Oct 2026): is it real, is it active,
 * whose is it, where is it registered.
 *
 * Through the e-invoice system's "Get GSTIN details", with the login the workspace already keeps for
 * e-invoicing — its head office's GSTIN first, else any of its GSTINs that has one. No other way is open:
 * the GST portal's own taxpayer search asks for a captcha. A workspace with no e-invoice login is told
 * where to add one.
 *
 * What comes back is kept (GstinCheck), so the company's page shows it without asking again; a check younger
 * than 30 days is reused unless somebody asks afresh, and even then not within 10 minutes. A person makes at
 * most 60 fresh lookups an hour — the workspace's e-invoice login is shared, and the portal limits it.
 */

export const REUSE_FOR_DAYS = 30;
const AGAIN_AFTER_MINUTES = 10;
export const LOOKUPS_PER_HOUR = 60;

export class GstinLookupRefused extends Error {}

type CheckRow = {
  gstin: string;
  status: string;
  legalName: string | null;
  tradeName: string | null;
  address: string | null;
  stateCode: string | null;
  pincode: string | null;
  taxpayerType: string | null;
  blocked: boolean;
  source: string;
  checkedAt: Date;
};

export function viewOf(row: CheckRow): GstinCheckView {
  return {
    gstin: row.gstin,
    status: isGstinStatus(row.status) ? row.status : "INA",
    legalName: row.legalName,
    tradeName: row.tradeName,
    address: row.address,
    stateCode: row.stateCode,
    pincode: row.pincode,
    taxpayerType: row.taxpayerType,
    blocked: row.blocked,
    source: row.source,
    checkedAt: row.checkedAt.toISOString(),
  };
}

/** The e-invoice login a lookup goes through: the head office GSTIN's, else the first active one set up. */
async function connection(): Promise<ProviderConfig> {
  const [headOffice, registrations] = await Promise.all([
    db.branch.findFirst({ where: { isHeadOffice: true }, select: { gstRegistrationId: true } }),
    db.gstRegistration.findMany({
      where: { active: true, einvoiceProvider: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { id: true, gstin: true, einvoiceProvider: true, einvoiceUsername: true, einvoicePasswordCipher: true, einvoiceClientId: true, einvoiceClientSecretCipher: true },
    }),
  ]);
  const registration = registrations.find((r) => r.id === headOffice?.gstRegistrationId) ?? registrations[0];
  if (!registration?.einvoiceProvider) {
    throw new GstinLookupRefused("Checking with the GST system uses your e-invoice login. Add one for any of your GSTINs under Settings → e-Invoicing.");
  }
  const open = async (cipher: string | null) => (cipher ? await decryptSecret(cipher).catch(() => null) : null);
  return {
    provider: registration.einvoiceProvider,
    username: registration.einvoiceUsername,
    password: await open(registration.einvoicePasswordCipher),
    clientId: registration.einvoiceClientId,
    clientSecret: await open(registration.einvoiceClientSecretCipher),
    gstin: registration.gstin,
  };
}

/** The checks already made for these GSTINs, by GSTIN — for a page to show. Empty on a workspace not yet migrated. */
export async function savedGstinChecks(gstins: (string | null | undefined)[]): Promise<Record<string, GstinCheckView>> {
  const wanted = [...new Set(gstins.map(normalizeGstin).filter(Boolean))];
  if (wanted.length === 0) return {};
  try {
    const rows = await db.gstinCheck.findMany({ where: { gstin: { in: wanted } } });
    return Object.fromEntries(rows.map((r) => [r.gstin, viewOf(r)]));
  } catch {
    return {};
  }
}

/**
 * The GST system's answer for a GSTIN: the saved one while it's recent enough, else a fresh lookup, saved.
 * Refuses (GstinLookupRefused, with what to do) a GSTIN that can't be one, a person over the hour's limit,
 * and a workspace with no e-invoice login; a portal that fails is refused with its own message.
 */
export async function lookupGstin(raw: string, userId: string, opts: { fresh?: boolean; now?: Date } = {}): Promise<{ check: GstinCheckView; reused: boolean }> {
  if (!(await countryFeatureAvailable("einvoice"))) throw new GstinLookupRefused("GSTINs are India's, and this workspace is set up for another country.");
  const gstin = normalizeGstin(raw);
  if (!lookupReady(gstin)) throw new GstinLookupRefused("That isn't a GSTIN yet: check each character first. Its last one is a check over the others.");
  const now = opts.now ?? new Date();

  const saved = await db.gstinCheck.findUnique({ where: { gstin } });
  if (saved) {
    const age = now.getTime() - saved.checkedAt.getTime();
    const reuse = opts.fresh ? age < AGAIN_AFTER_MINUTES * 60_000 : age < REUSE_FOR_DAYS * 86_400_000;
    if (reuse) return { check: viewOf(saved), reused: true };
  }

  const recent = await db.gstinCheck.count({ where: { checkedById: userId, checkedAt: { gt: new Date(now.getTime() - 3_600_000) } } });
  if (recent >= LOOKUPS_PER_HOUR) throw new GstinLookupRefused(`You've checked ${LOOKUPS_PER_HOUR} GSTINs in the last hour, which is the limit. Try again later.`);

  const config = await connection();
  const provider = createEInvoiceProvider(config);
  const answer = await provider.gstinDetails(gstin);
  if (!answer.ok && !answer.notFound) throw new GstinLookupRefused(answer.error);

  const details = answer.ok ? answer.details : null;
  const data = {
    // Kept as the portal says it; a status it hasn't documented is shown as inactive (viewOf).
    status: details ? details.status.slice(0, 12) : "NOT_FOUND",
    legalName: details?.legalName?.slice(0, 200) ?? null,
    tradeName: details?.tradeName?.slice(0, 200) ?? null,
    address: details?.address?.slice(0, 500) ?? null,
    stateCode: details?.stateCode?.slice(0, 2) ?? null,
    pincode: details?.pincode?.slice(0, 10) ?? null,
    taxpayerType: details?.taxpayerType?.slice(0, 20) ?? null,
    blocked: details?.blocked ?? false,
    source: provider.name,
    checkedAt: now,
    checkedById: userId,
  };
  const row = await db.gstinCheck.upsert({ where: { gstin }, create: { gstin, ...data }, update: data });
  return { check: viewOf(row), reused: false };
}
