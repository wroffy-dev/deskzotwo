import { db } from "@/lib/db";
import { hashDeviceToken, validDeviceToken } from "@/lib/access/device-token";
import { doorCheck } from "@/lib/access/record";
import { spendHandoffTicket } from "@/lib/platform/handoff";
import { activeSupportGrant } from "@/lib/platform/support";
import { isAutomationKind } from "@/lib/people";

/**
 * The account a one-time pass signs in at this workspace — or nobody. The "handoff" sign-in
 * (src/lib/auth.ts) is this and nothing more; it lives here so it can be checked without the rest of
 * the sign-in machinery.
 *
 * The pass is spent against the workspace the request is on, so one made for another workspace signs
 * nobody in here. Never an account with two-factor on: a pass must not be a way around it. An owner's
 * pass signs in a member, and passes the door as any sign-in would; a support pass signs in a support
 * account, and only while the workspace's grant is live.
 */
export async function handoffAccount(ticket: string, tenantId: string, presented: { deviceToken: string | null } = { deviceToken: null }) {
  const pass = await spendHandoffTicket(ticket, tenantId);
  if (!pass) return null;
  const user = await db.user.findUnique({ where: { email: pass.email } });
  if (!user || !user.active || user.twoFactorEnabledAt) return null;
  // Never the workspace's Automation account (src/lib/automation-user.ts), whatever the pass is for.
  if (isAutomationKind(user.kind)) return null;
  if (pass.purpose === "owner-signup") {
    if (user.kind !== "MEMBER" || (await doorCheck(user))) return null;
  } else if (pass.purpose === "app") {
    // The Deskzo app's pages: a member, through the door as at any sign-in (the pass only comes from a paired,
    // approved phone — src/app/api/app/web-session).
    if (user.kind !== "MEMBER" || (await doorCheck(user))) return null;
    // Only in the browser the phone opened (security audit, Nov 2026): it holds the phone's device cookie,
    // set by /api/app/web-open on the way here. Any other browser — one sent a /handoff link — is refused.
    if (!(await holdsPhoneCookie(pass.deviceId, user.id, presented.deviceToken))) return null;
  } else if (pass.purpose === "support") {
    if (user.kind !== "SUPPORT" || !(await activeSupportGrant(tenantId, true))) return null;
  } else {
    return null;
  }
  return user;
}

/** Whether the device cookie presented is the phone's: its row, the pass's account's, not revoked, with that secret. */
async function holdsPhoneCookie(deviceId: string | null, userId: string, deviceToken: string | null): Promise<boolean> {
  if (!deviceId || !validDeviceToken(deviceToken)) return false;
  const device = await db.userDevice.findUnique({ where: { id: deviceId }, select: { userId: true, tokenHash: true, status: true } });
  if (!device || device.userId !== userId || device.status === "REVOKED" || device.status === "REJECTED") return false;
  return device.tokenHash === hashDeviceToken(deviceToken);
}
