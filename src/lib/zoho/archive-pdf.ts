import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Which archived documents Zoho has a PDF of, and where (25 Nov 2026). Kept light — a company's Earlier years tab reads
 * it for its links (src/components/companies/archived-history.tsx); the fetching is in ./open-archived-pdf.ts.
 */

/** Zoho's PDFs of the archive, by kind: where Zoho keeps each. */
export const PDF_PATHS: Record<string, string> = { INVOICE: "/invoices", CREDIT_NOTE: "/creditnotes", QUOTE: "/estimates", SALES_ORDER: "/salesorders", DELIVERY_CHALLAN: "/deliverychallans", PURCHASE_ORDER: "/purchaseorders" };

/**
 * Where Zoho keeps an archived document's PDF; null for a kind it gives none of, or a document without Zoho's id. The id
 * came in with a file, so it is taken only as an id — never as more of a path.
 */
export function zohoPdfPath(doc: { kind: string; oldId: string | null }): string | null {
  const path = Object.hasOwn(PDF_PATHS, doc.kind) ? PDF_PATHS[doc.kind] : undefined;
  return path && doc.oldId && /^[A-Za-z0-9_-]{1,100}$/.test(doc.oldId) ? `${path}/${doc.oldId}` : null;
}

/** Whether the workspace is connected to a Zoho Books organisation, so a PDF can still be asked for. */
export async function zohoConnected(): Promise<boolean> {
  try {
    const row = await db.zohoConnection.findUnique({ where: { id: "default" }, select: { refreshToken: true, organizationId: true } });
    return !!row?.refreshToken && !!row.organizationId;
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return false;
  }
}

/**
 * The calls spent opening one PDF at a time: a MigrationRecord each, its key the day and an id of its own, kept for that
 * day only. Not in a pull's own count — a pull at work writes that back whole, and there may be no pull at all.
 */
export const OPENED_CALL = "zoho-pdf-call";

/** How many of the day's calls went to PDFs opened one at a time (`callDay`, ./pull.ts). */
export const openedCalls = (day: string): Promise<number> => db.migrationRecord.count({ where: { kind: OPENED_CALL, key: { startsWith: `${day}:` } } });
