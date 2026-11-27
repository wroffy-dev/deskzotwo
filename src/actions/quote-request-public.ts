"use server";

import { headers } from "next/headers";
import { callerKeyIp, clientIpFrom } from "@/lib/client-ip";
import { withinCallerBudget } from "@/lib/security/caller-budget";
import { tenantKey } from "@/lib/tenancy/cache";
import { getOrganisation } from "@/lib/organisation";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { workspaceClock } from "@/lib/time/workspace";
import { checkRequest, linkForToken, submitRequest } from "@/lib/quote-requests";

/**
 * The reseller's side of a quote request (/rfq/<token>, src/lib/quote-requests.ts). No account: the link is the
 * authentication, for asking this one workspace for quotations as this one reseller, and grants nothing else. Every way a
 * link can be wrong reads the same.
 */

const GONE = "This link isn't working any more. Ask your account manager for a new one.";
const BUSY = "That's a lot of requests at once — wait a few minutes and try again.";

async function withinBudget(): Promise<boolean> {
  let ip: string | null = null;
  try {
    ip = clientIpFrom(await headers());
  } catch {
    ip = null;
  }
  if (!ip) return true;
  return withinCallerBudget([{ key: `${await tenantKey()}|rfq:${callerKeyIp(ip)}`, max: 60 }], 10 * 60_000);
}

export type QuoteRequestPage = { ourName: string; resellerName: string; contactName: string; contactEmail: string; contactPhone: string; today: string };

export async function getQuoteRequestPage(token: string): Promise<QuoteRequestPage | null> {
  // Only while the workspace has Resellers (src/lib/module-actions.ts): the link also asks, as every way in does.
  if (!(await moduleAvailableForTenant("resellers"))) return null;
  const found = await linkForToken(token);
  if (!found) return null;
  const org = await getOrganisation();
  return {
    ourName: org.tradeName || org.legalName || "",
    resellerName: found.reseller.name,
    contactName: found.contact.name,
    contactEmail: found.contact.email ?? "",
    contactPhone: found.contact.phone ?? "",
    today: (await workspaceClock()).today(),
  };
}

/** The form: `token`, `request` (JSON) and, optionally, `file`. */
export async function sendQuoteRequest(form: FormData): Promise<{ ok: true; reference: string } | { ok: false; error: string; errors?: Record<string, string> }> {
  if (!(await withinBudget())) return { ok: false, error: BUSY };
  if (!(await moduleAvailableForTenant("resellers"))) return { ok: false, error: GONE };
  const found = await linkForToken(form.get("token"));
  if (!found) return { ok: false, error: GONE };
  let raw: unknown = null;
  try {
    raw = JSON.parse(String(form.get("request") ?? "null"));
  } catch {
    raw = null;
  }
  const checked = checkRequest(raw, (await workspaceClock()).today());
  if (!checked.ok) return checked;
  const file = form.get("file");
  const upload = file instanceof File && file.size > 0 ? { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) } : null;
  return submitRequest(found.link, checked.value, upload);
}
