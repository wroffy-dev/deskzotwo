"use server";

import { currentGuest, sendGuestCode, signOutGuest, verifyGuestCode } from "@/lib/connect/guest-auth";
import { mailGuestCode } from "@/lib/connect/mail";
import { setGuestValue } from "@/lib/connect/guest-lists";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { guestAddComment, guestRowDetail, guestSuggestCompany, guestSuggestCorrection, type GuestRowDetail } from "@/lib/connect/working";

/**
 * Deskzo Connect's guest-facing actions (owner, 20 Nov 2026 — src/lib/connect). Reached by somebody with no staff
 * session: each one signs the guest in from their own cookie first (`currentGuest`), and does nothing for anybody else.
 * What a guest may read or change is src/lib/connect/guest-lists.ts's rule, from the guest's id alone.
 */

/** Smart Lists in the workspace's plan and switched on — Connect shares them, so without it nothing here opens. */
async function doorOpen(): Promise<boolean> {
  return moduleAvailableForTenant("workspace");
}
const CLOSED = "Sign-in isn't open here right now.";

export async function sendConnectCode(email: string): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (!(await doorOpen())) return { ok: false, error: CLOSED };
  return sendGuestCode(email, (guest, code, minutes) => mailGuestCode(guest, code, minutes));
}

export async function verifyConnectCode(email: string, code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await doorOpen())) return { ok: false, error: CLOSED };
  return verifyGuestCode(email, code);
}

export async function signOutConnect(): Promise<void> {
  // Signing out is always allowed; asked only so the door's rule reads the same in every action.
  await doorOpen();
  await signOutGuest();
}

const SIGNED_OUT = "You've been signed out. Sign in again to carry on.";

/** A row's page for the guest: their contact at the workspace, and the shared comments. */
export async function guestRow(shareId: string, companyId: string): Promise<GuestRowDetail | null> {
  if (!(await doorOpen())) return null;
  const guest = await currentGuest();
  return guest ? guestRowDetail(guest.id, shareId, companyId) : null;
}

export async function guestComment(input: { shareId: string; companyId: string; body: string }) {
  if (!(await doorOpen())) return { ok: false as const, error: CLOSED };
  const guest = await currentGuest();
  if (!guest) return { ok: false as const, error: SIGNED_OUT };
  return guestAddComment(guest.id, input);
}

export async function guestSuggest(input: { shareId: string; name: string; city?: string; website?: string; gstin?: string; contactName?: string; note: string }) {
  if (!(await doorOpen())) return { ok: false as const, error: CLOSED };
  const guest = await currentGuest();
  if (!guest) return { ok: false as const, error: SIGNED_OUT };
  return guestSuggestCompany(guest.id, input);
}

export async function guestCorrect(input: { shareId: string; companyId: string; note: string }) {
  if (!(await doorOpen())) return { ok: false as const, error: CLOSED };
  const guest = await currentGuest();
  if (!guest) return { ok: false as const, error: SIGNED_OUT };
  return guestSuggestCorrection(guest.id, input);
}

export async function guestSetCell(input: { shareId: string; propertyId: string; companyId: string; value: unknown }): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  if (!(await doorOpen())) return { ok: false, error: CLOSED };
  const guest = await currentGuest();
  if (!guest) return { ok: false, error: "You've been signed out. Sign in again to carry on." };
  return setGuestValue(guest.id, input);
}
