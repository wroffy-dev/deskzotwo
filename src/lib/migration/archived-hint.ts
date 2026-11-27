import { db } from "@/lib/db";

/**
 * What to do when a row names an invoice or bill Deskzo hasn't got, but the switch's archive has (owner, 29 Oct 2026):
 * last year's, still owing when the year began — "Open the ones still owing" opens it, and the row, waiting, goes
 * through once it is. Empty when the archive hasn't got it either, so the message says what it said before.
 * An invoice by its number alone; a bill by its number with its vendor, as vendors' numbers repeat.
 */
export async function archivedHint(kind: "INVOICE" | "BILL", number: string, companyId: string): Promise<string> {
  const found = await db.archivedDocument
    .findFirst({ where: { kind, number, ...(kind === "BILL" ? { companyId } : {}) }, select: { id: true } })
    .catch(() => null);
  return found ? ` It's an earlier year's, in the archive: press "Open the ones still owing" under Earlier years, then Retry waiting.` : "";
}
