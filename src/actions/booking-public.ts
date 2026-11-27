"use server";

import { headers } from "next/headers";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { clientIpFrom } from "@/lib/client-ip";
import { bookSlot, publicBookingPage, type BookedView, type PublicBookingPage } from "@/lib/booking/server";
import { addBookingGuest, cancelBooking, managedBooking, rescheduleBooking, type ManagedBooking } from "@/lib/booking/manage";
import type { ActionResult } from "@/actions/company";

/**
 * A booking page's own actions, for somebody with no account here: the times still open, and booking
 * one (src/lib/booking/server.ts). Open while the workspace's plan has booking pages and they are on.
 * No CAPTCHA, as the forms have none: a field a person never sees, and a page answered too fast, are
 * thanked and dropped; how many bookings one address and one page may make an hour is counted.
 *
 * And the guest's own link afterwards (src/lib/booking/manage.ts): see it, move it, cancel it, invite a colleague —
 * the link's secret is what lets them.
 */

const CLOSED = "This booking page isn't taking bookings.";

export async function bookingTimes(slug: string): Promise<PublicBookingPage | null> {
  if (!(await moduleAvailableForTenant("booking"))) return null;
  return publicBookingPage(String(slug ?? ""));
}

export async function makeBooking(
  slug: string,
  input: { start: string; name: string; email: string; phone?: string; company?: string; notes?: string; website?: string; elapsedMs?: number; answers?: unknown; zone?: string; ref?: string },
): Promise<ActionResult<BookedView> & { errors?: Record<string, string> }> {
  if (!(await moduleAvailableForTenant("booking"))) return { ok: false, error: CLOSED };
  const given = input && typeof input === "object" ? input : ({} as typeof input);
  // A field no person sees, filled in; or the page answered faster than anybody reads it.
  if (given.website || (typeof given.elapsedMs === "number" && given.elapsedMs < 2000)) {
    return { ok: true, data: { when: "", host: "", invited: true, invites: true } };
  }
  // Security review, 15 Nov 2026 — RL-03: no shared "unknown" caller — bookSlot holds a caller without a known address
  // to the page-wide cap alone, and lets a known one under its own cap book past it (up to 10 times).
  const source = clientIpFrom(await headers());
  const made = await bookSlot(String(slug ?? ""), given, source);
  if (!made.ok) return made;
  const { ok: _ok, ...view } = made;
  void _ok;
  return { ok: true, data: view };
}

export async function managedBookingFor(token: string): Promise<ManagedBooking | null> {
  if (!(await moduleAvailableForTenant("booking"))) return null;
  return managedBooking(String(token ?? ""));
}

export async function moveMyBooking(token: string, start: string): Promise<ActionResult<{ when: string }>> {
  if (!(await moduleAvailableForTenant("booking"))) return { ok: false, error: CLOSED };
  const moved = await rescheduleBooking(String(token ?? ""), String(start ?? ""));
  return moved.ok ? { ok: true, data: { when: moved.when } } : moved;
}

export async function cancelMyBooking(token: string, reason?: string): Promise<ActionResult<null>> {
  if (!(await moduleAvailableForTenant("booking"))) return { ok: false, error: CLOSED };
  const done = await cancelBooking(String(token ?? ""), String(reason ?? ""));
  return done.ok ? { ok: true, data: null } : done;
}

export async function inviteToMyBooking(token: string, guest: { email: string; name?: string }): Promise<ActionResult<{ guests: { email: string; name: string | null }[] }>> {
  if (!(await moduleAvailableForTenant("booking"))) return { ok: false, error: CLOSED };
  const added = await addBookingGuest(String(token ?? ""), guest);
  return added.ok ? { ok: true, data: { guests: added.guests } } : added;
}
