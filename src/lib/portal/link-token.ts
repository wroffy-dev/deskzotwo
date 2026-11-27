import { createHash, randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Bearer links staff hand out and copy again — customer portal links, reception-desk (kiosk) links.
 *
 * Security audit round two, 13 Nov 2026 (O6): they were stored as written, so a copy of the database (a backup, a
 * dump, a read replica) held every working link. Now a link is found by the SHA-256 of its token (`tokenHash`), and
 * the token itself is kept only encrypted with the workspace's key (`tokenCipher`, src/lib/crypto.ts), for the
 * screens that show it again. Rows made before 20261213210000_token_hashes still have the plain `token`, and their
 * hash was filled in by that migration; a workspace the migration hasn't reached yet has neither new column, and
 * keeps using the plain token (`withTokenColumns` falls back) — so no link stops working on either side of it.
 */

export const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** A new link's token, and what is stored for it: its hash and its sealed copy — never the token in clear. */
export async function newLinkToken(bytes: number): Promise<{ token: string; stored: { tokenHash: string; tokenCipher: string } }> {
  const token = randomBytes(bytes).toString("base64url");
  return { token, stored: { tokenHash: tokenHash(token), tokenCipher: await encryptSecret(token) } };
}

/** The token to show again: the sealed copy opened, or the plain one an older row still has; null when neither opens. */
export async function shownToken(row: { token?: string | null; tokenCipher?: string | null }): Promise<string | null> {
  if (row.tokenCipher) {
    const opened = await decryptSecret(row.tokenCipher).catch(() => null);
    if (opened) return opened;
  }
  return row.token ?? null;
}

/**
 * Runs `migrated` (which names the new columns), or `legacy` (which doesn't) when this workspace hasn't the columns
 * yet. Only a missing column falls back; any other failure is thrown.
 */
export async function withTokenColumns<T>(migrated: () => Promise<T>, legacy: () => Promise<T>): Promise<T> {
  try {
    return await migrated();
  } catch (err) {
    if (notMigratedYet(err)) return legacy();
    throw err;
  }
}
