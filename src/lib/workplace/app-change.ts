import { db } from "@/lib/db";
import { refuseWhileViewingAs } from "@/lib/session";

/**
 * Who may change the app people sign in with — Microsoft's directory and app, Google's or Zoho's client, the Google
 * domain sign-in is kept to (security audit, 11 Nov 2026 — SEC-02).
 *
 * "Security settings" (security.manage) was enough, and the app decides which outside directory may vouch for an address
 * here: pointed at a directory of one's own, any account — the super admin's included — could be signed into. Changing
 * it is now the super admin's alone, never while viewing as somebody else. Switching sign-in or mail on and off for an
 * app already there stays with security.manage. Null when the change may go ahead; the refusal otherwise.
 */
export async function signInAppChangeRefusal(userId: string): Promise<string | null> {
  const viewing = await refuseWhileViewingAs();
  if (viewing) return viewing;
  const me = await db.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true } });
  if (!me?.isSuperAdmin) {
    return "Only the super admin can change the app people sign in with — the directory, client ID, secret or domain. You can still switch sign-in and mail on or off.";
  }
  return null;
}
