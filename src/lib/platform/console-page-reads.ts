import { BUILTIN_PAGE_SLUGS } from "@/lib/cms/types";
import { controlDb } from "@/lib/platform/control-db";
import { getSecret, type SecretKey } from "@/lib/platform/settings";

/**
 * Small reads some console pages made inline, moved here so the separate admin app can ask for them
 * through the internal API (src/lib/internal-api/ops.ts) as it does for every other loader. Each is
 * what the page did before, unchanged.
 */

/** Paid INR invoices still waiting for a tax invoice number (Settings › Invoicing). */
export async function waitingTaxInvoices(): Promise<number> {
  return controlDb().invoice.count({ where: { taxNumber: null, currency: "INR", status: "PAID" } });
}

/** Every active owner's email, alphabetically — who the alerts go to when nobody is named (Settings). */
export async function ownerEmails(): Promise<string[]> {
  return (await controlDb().platformUser.findMany({ where: { role: "OWNER", active: true }, select: { email: true }, orderBy: { email: "asc" } })).map((o) => o.email);
}

/** A staff member's name by id, or null when there is no such row. */
export async function staffNameById(id: string): Promise<string | null> {
  return (await controlDb().platformUser.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
}

/** Staff names for several ids (unknown ids left out). */
export async function staffNamesByIds(ids: string[]): Promise<{ id: string; name: string }[]> {
  if (!ids.length) return [];
  return controlDb().platformUser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
}

/** The countries workspaces are in (Settings › AI teammates). */
export async function workspaceCountries(): Promise<{ country: string }[]> {
  return controlDb().tenant.findMany({ distinct: ["country"], select: { country: true } });
}

/** The Website CMS page's counts. */
export async function websiteCounts(now = new Date()) {
  const control = controlDb();
  const [pagesPublished, builtinsPublished, postsLive, leadsNew] = await Promise.all([
    control.sitePage.count({ where: { status: "PUBLISHED", archivedAt: null } }),
    control.sitePage.count({ where: { status: "PUBLISHED", archivedAt: null, slug: { in: [...BUILTIN_PAGE_SLUGS] } } }),
    control.sitePost.count({ where: { status: { in: ["PUBLISHED", "SCHEDULED"] }, archivedAt: null, publishAt: { lte: now } } }),
    control.siteLead.count({ where: { status: "NEW" } }),
  ]);
  // Built-in pages nobody has published still show their default content on the site.
  return { pages: pagesPublished + (BUILTIN_PAGE_SLUGS.length - builtinsPublished), pagesFromCms: pagesPublished, postsLive, leadsNew };
}

/**
 * Whether a platform secret is saved — never the secret. The admin app asks this instead of
 * getSecret (src/lib/platform/settings.ts), which is never reachable through the internal API.
 */
export async function secretIsSet(key: SecretKey): Promise<boolean> {
  return !!(await getSecret(key).catch(() => null));
}
