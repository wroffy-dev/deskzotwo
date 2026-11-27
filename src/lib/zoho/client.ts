import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Zoho Books' API, read-only, through the workspace's own Zoho app (owner, 26 Oct 2026). The workspace's admin makes
 * a "Server-based application" in Zoho's API console, gives Deskzo its client id and secret, and registers the
 * callback address Deskzo shows; Deskzo then asks Zoho for read access to the organisation and keeps the refresh
 * token, encrypted. Zoho holds an organisation in one data centre — India's by default here.
 *
 *   · **Limits:** 100 calls a minute for an organisation, and 1,000 to 10,000 a day by its plan. Calls here are
 *     spaced and counted; a 429 waits and says so rather than failing the pull.
 *   · **Tokens:** an access token lasts an hour and is refreshed as it runs out.
 */

export const DATA_CENTRES = [
  { value: "in", label: "India (zoho.in)" },
  { value: "com", label: "United States (zoho.com)" },
  { value: "eu", label: "Europe (zoho.eu)" },
  { value: "com.au", label: "Australia (zoho.com.au)" },
  { value: "jp", label: "Japan (zoho.jp)" },
  { value: "ca", label: "Canada (zohocloud.ca)" },
  { value: "sa", label: "Saudi Arabia (zoho.sa)" },
  { value: "ae", label: "UAE (zoho.ae)" },
] as const;
export type DataCentre = (typeof DATA_CENTRES)[number]["value"];
export const isDataCentre = (v: unknown): v is DataCentre => DATA_CENTRES.some((d) => d.value === v);

/** Where a data centre's sign-in and API live. Canada's accounts server is zohocloud.ca. */
export function zohoHosts(dc: DataCentre) {
  return {
    accounts: dc === "ca" ? "https://accounts.zohocloud.ca" : `https://accounts.zoho.${dc}`,
    api: `https://www.zohoapis.${dc}/books/v3`,
  };
}

/** Read access to everything the pull brings, and nothing it could change. */
export const ZOHO_SCOPES = [
  "ZohoBooks.settings.READ",
  "ZohoBooks.contacts.READ",
  "ZohoBooks.invoices.READ",
  "ZohoBooks.creditnotes.READ",
  "ZohoBooks.customerpayments.READ",
  "ZohoBooks.estimates.READ",
  "ZohoBooks.salesorders.READ",
  "ZohoBooks.purchaseorders.READ",
  "ZohoBooks.bills.READ",
  "ZohoBooks.debitnotes.READ",
  "ZohoBooks.vendorpayments.READ",
  "ZohoBooks.expenses.READ",
  "ZohoBooks.banking.READ",
  "ZohoBooks.accountants.READ",
].join(",");

/** The callback Zoho sends the workspace back to, on its own address. */
export const callbackPath = "/api/zoho/callback";

/** Zoho's calls a day by its plan name, as Zoho publishes them. */
export function planDailyLimit(planName: string | null | undefined): number {
  const p = (planName ?? "").toLowerCase();
  return /premium|elite|ultimate|enterprise/.test(p) ? 10_000 : /professional/.test(p) ? 5_000 : /standard/.test(p) ? 2_000 : /free/.test(p) ? 1_000 : 2_000;
}

/**
 * The daily allowance, a little under Zoho's limit so the organisation's own use keeps some: the limit its admin typed
 * (`dailyCallLimit` — Zoho can raise it past the plan's; owner, 29 Oct 2026), else the plan's.
 */
export function dailyAllowance(planName: string | null | undefined, typedLimit?: number | null): number {
  return Math.floor((typedLimit && typedLimit > 0 ? typedLimit : planDailyLimit(planName)) * 0.9);
}

export type Allowance = { allowance: number; limit: number; planLimit: number; typed: boolean };

/** The connection's allowance, for the pull and the page; the plan's where the workspace isn't migrated yet. */
export async function zohoAllowance(): Promise<Allowance> {
  let row: { planName: string | null; dailyCallLimit?: number | null } | null;
  try {
    row = await db.zohoConnection.findUnique({ where: { id: "default" }, select: { planName: true, dailyCallLimit: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    row = await db.zohoConnection.findUnique({ where: { id: "default" }, select: { planName: true } });
  }
  const planLimit = planDailyLimit(row?.planName);
  const typed = !!row?.dailyCallLimit && row.dailyCallLimit > 0;
  return { allowance: dailyAllowance(row?.planName, row?.dailyCallLimit), limit: typed ? row!.dailyCallLimit! : planLimit, planLimit, typed };
}

export class ZohoRefused extends Error {}
/** Zoho said wait: the minute's or the day's calls are used. */
export class ZohoBusy extends Error {
  constructor(
    message: string,
    readonly daily: boolean,
  ) {
    super(message);
  }
}

export type Connection = { dataCentre: DataCentre; clientId: string; clientSecret: string; refreshToken: string | null; organizationId: string | null; organizationName: string | null; planName: string | null; connectedAt: Date | null };

export async function loadConnection(): Promise<Connection | null> {
  const row = await db.zohoConnection.findUnique({ where: { id: "default" } });
  if (!row) return null;
  return {
    dataCentre: isDataCentre(row.dataCentre) ? row.dataCentre : "in",
    clientId: row.clientId,
    clientSecret: await decryptSecret(row.clientSecret),
    refreshToken: row.refreshToken ? await decryptSecret(row.refreshToken) : null,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    planName: row.planName,
    connectedAt: row.connectedAt,
  };
}

/** Zoho's sign-in page for the app, asking for read access and a refresh token. */
export function authorizeUrl(c: { dataCentre: DataCentre; clientId: string }, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ scope: ZOHO_SCOPES, client_id: c.clientId, response_type: "code", redirect_uri: redirectUri, access_type: "offline", prompt: "consent", state });
  return `${zohoHosts(c.dataCentre).accounts}/oauth/v2/auth?${q}`;
}

type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };

async function tokenCall(dc: DataCentre, params: Record<string, string>): Promise<TokenReply> {
  const res = await fetch(`${zohoHosts(dc).accounts}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const body = (await res.json().catch(() => ({}))) as TokenReply;
  if (!res.ok || body.error) throw new ZohoRefused(`Zoho refused the sign-in: ${body.error ?? res.status}. Check the app's client id, secret and callback address in Zoho's API console.`);
  return body;
}

/**
 * The data centre Zoho says the account is in, from what it sends back with the code (its "location", and the
 * "accounts-server" to exchange the code at) — trusted only when it names one of Zoho's own accounts servers.
 */
export function dataCentreOfCallback(location: string | null, accountsServer: string | null): DataCentre | null {
  const byLocation: Record<string, DataCentre> = { in: "in", us: "com", com: "com", eu: "eu", au: "com.au", jp: "jp", ca: "ca", sa: "sa", ae: "ae" };
  const fromLocation = location ? byLocation[location.toLowerCase()] : undefined;
  if (fromLocation) return fromLocation;
  const host = accountsServer ? /^https:\/\/accounts\.(?:zoho\.(in|com|eu|com\.au|jp|sa|ae)|zohocloud\.(ca))\/?$/.exec(accountsServer) : null;
  return host ? ((host[1] ?? host[2]) as DataCentre) : null;
}

/** The code Zoho sent back, exchanged for tokens at the data centre the account is in; kept encrypted. */
export async function finishSignIn(code: string, redirectUri: string, userId: string, returnedCentre: DataCentre | null = null): Promise<void> {
  const c = await loadConnection();
  if (!c) throw new ZohoRefused("Give the Zoho app's client id and secret first.");
  // Zoho names the account's own data centre on the way back; a different one chosen on the form gives way to it.
  if (returnedCentre && returnedCentre !== c.dataCentre) {
    await db.zohoConnection.update({ where: { id: "default" }, data: { dataCentre: returnedCentre } });
    c.dataCentre = returnedCentre;
  }
  const t = await tokenCall(c.dataCentre, { grant_type: "authorization_code", client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri, code });
  if (!t.refresh_token || !t.access_token) throw new ZohoRefused("Zoho didn't give a refresh token. Connect again — Deskzo asks for one each time.");
  await db.zohoConnection.update({
    where: { id: "default" },
    data: {
      refreshToken: await encryptSecret(t.refresh_token),
      accessToken: await encryptSecret(t.access_token),
      accessExpiresAt: new Date(Date.now() + ((t.expires_in ?? 3600) - 120) * 1000),
      connectedById: userId,
      connectedAt: new Date(),
      organizationId: null,
      organizationName: null,
    },
  });
}

async function accessToken(): Promise<{ token: string; dc: DataCentre }> {
  const row = await db.zohoConnection.findUnique({ where: { id: "default" } });
  if (!row?.refreshToken) throw new ZohoRefused("Deskzo isn't connected to Zoho. Connect first.");
  const dc = isDataCentre(row.dataCentre) ? row.dataCentre : "in";
  if (row.accessToken && row.accessExpiresAt && row.accessExpiresAt > new Date()) return { token: await decryptSecret(row.accessToken), dc };
  const t = await tokenCall(dc, { grant_type: "refresh_token", client_id: row.clientId, client_secret: await decryptSecret(row.clientSecret), refresh_token: await decryptSecret(row.refreshToken) });
  if (!t.access_token) throw new ZohoRefused("Zoho didn't renew the access. Connect again.");
  await db.zohoConnection.update({ where: { id: "default" }, data: { accessToken: await encryptSecret(t.access_token), accessExpiresAt: new Date(Date.now() + ((t.expires_in ?? 3600) - 120) * 1000) } });
  return { token: t.access_token, dc };
}

/** Spaced so a pull stays under Zoho's 100 calls a minute with room to spare. */
const SPACING_MS = 700;
let lastCall = 0;

export type ZohoReply = Record<string, unknown> & { code?: number; message?: string; page_context?: { has_more_page?: boolean } };

/** One GET against the organisation; JSON, or the bytes for a PDF. */
export async function zohoGet(path: string, query: Record<string, string | number> = {}, as: "json" | "pdf" = "json"): Promise<ZohoReply | Buffer> {
  const { token, dc } = await accessToken();
  const row = await db.zohoConnection.findUnique({ where: { id: "default" }, select: { organizationId: true } });
  const q = new URLSearchParams(Object.fromEntries(Object.entries({ ...(row?.organizationId && path !== "/organizations" ? { organization_id: row.organizationId } : {}), ...query, ...(as === "pdf" ? { accept: "pdf" } : {}) }).map(([k, v]) => [k, String(v)])));
  const wait = lastCall + SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await fetch(`${zohoHosts(dc).api}${path}?${q}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as ZohoReply;
    // Zoho's code for a day's allowance used up is 45; anything else is the minute's or too many at once.
    const daily = body.code === 45 || /day|daily/i.test(body.message ?? "");
    throw new ZohoBusy(daily ? "Zoho's calls for today are used up — the pull carries on tomorrow." : "Zoho asked Deskzo to slow down — carrying on in a minute.", daily);
  }
  if (as === "pdf") {
    if (!res.ok) throw new ZohoRefused(`Zoho didn't give the PDF (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }
  const body = (await res.json().catch(() => ({}))) as ZohoReply;
  if (res.status === 401) throw new ZohoRefused("Zoho no longer accepts Deskzo's access — connect again.");
  if (!res.ok || (body.code !== undefined && body.code !== 0)) throw new ZohoRefused(`Zoho refused ${path}: ${body.message ?? res.status}`);
  return body;
}

/** The organisations the signed-in Zoho user can see. */
export async function listOrganisations(): Promise<{ id: string; name: string; plan: string | null }[]> {
  const body = (await zohoGet("/organizations")) as ZohoReply;
  const orgs = (body.organizations as { organization_id: string; name: string; plan_name?: string }[] | undefined) ?? [];
  return orgs.map((o) => ({ id: String(o.organization_id), name: o.name, plan: o.plan_name ?? null }));
}
