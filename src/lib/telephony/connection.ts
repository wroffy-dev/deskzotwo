import type { TelephonyProvider } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * The cloud telephony account a workspace has connected (owner, 26 Oct 2026 — src/lib/telephony): at most one a
 * provider, its key kept encrypted with the workspace's own key and decrypted only for the call about to be made.
 */

export type LiveConnection = { id: string; provider: TelephonyProvider; deskphone: string; missedCallsUserId: string | null; syncedThrough: Date | null; connectedAt: Date };

const SELECT = { id: true, provider: true, deskphone: true, missedCallsUserId: true, syncedThrough: true, connectedAt: true } as const;

/** The connected account, switched on — null where there's none, or the workspace isn't migrated yet. */
export async function activeConnection(): Promise<LiveConnection | null> {
  try {
    return await db.telephonyConnection.findFirst({ where: { active: true }, orderBy: { connectedAt: "asc" }, select: SELECT });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/**
 * Whether the workspace has ever connected one — Calls › Business line is shown, its history kept after a
 * disconnect. Asked by the Calls page itself, so any failure here is only a missing tab, never a broken page.
 */
export async function hasTelephony(): Promise<boolean> {
  try {
    return (await db.telephonyConnection.count()) > 0;
  } catch (err) {
    if (!notMigratedYet(err)) console.error("telephony: couldn't tell whether cloud calling is connected", err);
    return false;
  }
}

/** Its key, for the call about to be made — never kept. */
export async function connectionKey(connectionId: string): Promise<string | null> {
  const row = await db.telephonyConnection.findUnique({ where: { id: connectionId }, select: { authCodeEnc: true, active: true } });
  if (!row?.active || !row.authCodeEnc) return null;
  return decryptSecret(row.authCodeEnc);
}
