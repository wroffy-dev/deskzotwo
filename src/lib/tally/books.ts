import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Whether Tally keeps this workspace's books (Settings › Tally — src/lib/tally): Deskzo's ledger pages then say "Kept in
 * Tally" and leave the menu. Its own small file, read by the menu on every request, so it pulls in nothing else.
 */
export async function keptInTally(): Promise<boolean> {
  try {
    return (await db.tallySettings.findUnique({ where: { id: "global" }, select: { booksIn: true } }))?.booksIn === "TALLY";
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}
