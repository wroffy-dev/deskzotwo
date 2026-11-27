import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { cancelMeeting, rescheduleMeeting } from "@/lib/calendar/meetings";
import { workspaceClock } from "@/lib/time/workspace";
import { bookingInvitesOn } from "@/lib/customer-email-settings";
import { companyPath, leadPath } from "@/lib/record-links";
import { pageSlots } from "@/lib/booking/rules";
import { bookingCompanyName, hashManageToken, hostSlots, inviteName, pageBySlug, type BookedView } from "@/lib/booking/server";

/**
 * The guest's own link to a booking (owner, 18 Nov 2026 — Dreamteam's Reschedule and Invite Guest): /book/manage/<token>.
 * The token is the link's secret, kept only as a hash on BookingDetail. With it the guest may see the booking, move it to
 * another time the same host is free, cancel it, or invite up to three colleagues — until the meeting's end. Each change
 * goes to the host's calendar and tells the host.
 */

export const MAX_GUESTS = 3;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ManagedBooking = BookedView & {
  title: string;
  ourName: string;
  durationMinutes: number;
  online: boolean;
  zone: string;
  /** The guest's own zone, as they booked in — the workspace's when they gave none. */
  guestZone: string;
  status: "CONFIRMED" | "CANCELLED";
  past: boolean;
  guestName: string;
  guestEmail: string;
  guests: { email: string; name: string | null }[];
  /** Other times the same host is free, by day in the workspace's zone — for moving it. */
  days: { day: string; slots: string[] }[];
  slug: string;
};

async function rowFor(token: string) {
  const t = String(token ?? "").trim();
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return null;
  try {
    return await db.bookingDetail.findUnique({
      where: { tokenHash: hashManageToken(t) },
      select: {
        zone: true,
        guests: true,
        booking: {
          select: {
            id: true,
            status: true,
            startsAt: true,
            endsAt: true,
            name: true,
            email: true,
            hostUserId: true,
            calendarEventId: true,
            leadId: true,
            lead: { select: { leadSeq: true } },
            company: { select: { companySeq: true } },
            host: { select: { name: true } },
            page: { select: { slug: true } },
          },
        },
      },
    });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

type Row = NonNullable<Awaited<ReturnType<typeof rowFor>>>;

const guestsOf = (value: unknown): { email: string; name: string | null }[] =>
  (Array.isArray(value) ? value : []).flatMap((g) => {
    const email = typeof (g as { email?: unknown })?.email === "string" ? (g as { email: string }).email : "";
    const name = typeof (g as { name?: unknown })?.name === "string" ? (g as { name: string }).name : null;
    return email ? [{ email, name }] : [];
  });

/** The booking behind a manage link, for its page — null for a link that names none. */
export async function managedBooking(token: string, now = new Date()): Promise<ManagedBooking | null> {
  const row = await rowFor(token);
  if (!row) return null;
  const b = row.booking;
  const page = await pageBySlug(b.page.slug);
  const [clock, ourName, invites] = await Promise.all([workspaceClock(), bookingCompanyName(), bookingInvitesOn()]);
  const past = b.endsAt.getTime() <= now.getTime();
  const canMove = !!page && b.status === "CONFIRMED" && !past;
  const slots = canMove ? pageSlots(await hostSlots(page, clock, now, { hostId: b.hostUserId, except: b.id })) : [];
  const days = new Map<string, string[]>();
  for (const s of slots) {
    const key = clock.dateKey(s);
    days.set(key, [...(days.get(key) ?? []), s.toISOString()]);
  }
  const event = b.calendarEventId ? await db.calendarEvent.findUnique({ where: { id: b.calendarEventId }, select: { joinUrl: true } }) : null;
  return {
    when: clock.dateTime(b.startsAt),
    host: b.host.name,
    invited: invites,
    invites,
    manage: String(token),
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    joinUrl: b.status === "CONFIRMED" ? (event?.joinUrl ?? null) : null,
    title: page?.title ?? "Meeting",
    ourName,
    durationMinutes: Math.round((b.endsAt.getTime() - b.startsAt.getTime()) / 60_000),
    online: page?.online ?? false,
    zone: clock.zone,
    guestZone: row.zone || clock.zone,
    status: b.status,
    past,
    guestName: b.name,
    guestEmail: b.email,
    guests: guestsOf(row.guests),
    days: [...days].map(([day, s]) => ({ day, slots: s })),
    slug: b.page.slug,
  };
}

/** The draft the host's calendar holds for it now, moved or with its attendees changed. */
async function draftOf(row: Row, change: { startsAt?: Date; endsAt?: Date; attendees?: { email: string; name: string | null }[] }) {
  const b = row.booking;
  const event = b.calendarEventId
    ? await db.calendarEvent.findUnique({ where: { id: b.calendarEventId }, select: { title: true, description: true, location: true, attendees: true, joinUrl: true } })
    : null;
  if (!event) return null;
  const attendees = change.attendees ?? guestsOf(event.attendees).map((a) => ({ email: a.email, name: a.name }));
  return {
    title: event.title,
    description: event.description,
    location: event.location,
    startsAt: change.startsAt ?? b.startsAt,
    endsAt: change.endsAt ?? b.endsAt,
    online: !!event.joinUrl,
    attendees,
  };
}

function linkFor(row: Row) {
  const b = row.booking;
  return b.lead?.leadSeq ? leadPath(b.lead.leadSeq) : b.company?.companySeq ? companyPath(b.company.companySeq) : "/calendar";
}

function closedReason(row: Row, now: Date): string | null {
  if (row.booking.status !== "CONFIRMED") return "This booking was cancelled.";
  if (row.booking.endsAt.getTime() <= now.getTime()) return "This meeting has already happened.";
  return null;
}

/** Moves it to another time its host is free — checked again now, held under the host's lock as a booking is. */
export async function rescheduleBooking(token: string, startIso: string, now = new Date()): Promise<{ ok: true; when: string } | { ok: false; error: string }> {
  const row = await rowFor(token);
  if (!row) return { ok: false, error: "This link doesn't name a booking." };
  const closed = closedReason(row, now);
  if (closed) return { ok: false, error: closed };
  const b = row.booking;
  const page = await pageBySlug(b.page.slug);
  if (!page) return { ok: false, error: "This booking page isn't taking bookings any more. Reply to the invitation to move it." };
  const start = new Date(String(startIso ?? ""));
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Choose a time." };
  const clock = await workspaceClock();
  const free = pageSlots(await hostSlots(page, clock, now, { hostId: b.hostUserId, except: b.id }));
  if (!free.some((s) => s.getTime() === start.getTime())) return { ok: false, error: "That time has just been taken. Choose another." };
  const end = new Date(start.getTime() + (b.endsAt.getTime() - b.startsAt.getTime()));

  const moved = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${b.hostUserId}`}))`;
    const clash = await tx.booking.count({ where: { hostUserId: b.hostUserId, status: "CONFIRMED", id: { not: b.id }, startsAt: { lt: end }, endsAt: { gt: start } } });
    if (clash > 0) return false;
    await tx.booking.update({ where: { id: b.id }, data: { startsAt: start, endsAt: end } });
    await tx.bookingDetail.update({ where: { bookingId: b.id }, data: { rescheduledAt: new Date() } });
    return true;
  });
  if (!moved) return { ok: false, error: "That time has just been taken. Choose another." };

  const draft = await draftOf(row, { startsAt: start, endsAt: end });
  const calendar = draft && b.calendarEventId ? await rescheduleMeeting(b.hostUserId, b.calendarEventId, draft) : null;
  await notifyUser({
    userId: b.hostUserId,
    type: "FORM_RESPONSE",
    title: `${b.name} moved their booking`,
    message: `${clock.dateTime(b.startsAt)} → ${clock.dateTime(start)}${calendar && !calendar.ok ? ` — your calendar couldn't be changed (${calendar.error}); move it there yourself.` : ""}`,
    link: linkFor(row),
  });
  await recordAudit({ userId: b.hostUserId, action: "UPDATE", entityType: "Booking", entityId: b.id, entityLabel: `Moved by the guest: ${b.name}, ${clock.dateTime(b.startsAt)} → ${clock.dateTime(start)}` });
  return { ok: true, when: clock.dateTime(start) };
}

/** Cancels it: the host's meeting is cancelled with it, and the host told. */
export async function cancelBooking(token: string, reason: string, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await rowFor(token);
  if (!row) return { ok: false, error: "This link doesn't name a booking." };
  const closed = closedReason(row, now);
  if (closed) return { ok: false, error: closed };
  const b = row.booking;
  const why = String(reason ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300);
  await db.$transaction(async (tx) => {
    await tx.booking.update({ where: { id: b.id }, data: { status: "CANCELLED" } });
    await tx.bookingDetail.update({ where: { bookingId: b.id }, data: { cancelledAt: new Date() } });
  });
  const calendar = b.calendarEventId ? await cancelMeeting(b.hostUserId, b.calendarEventId, null) : null;
  const clock = await workspaceClock();
  await notifyUser({
    userId: b.hostUserId,
    type: "FORM_RESPONSE",
    title: `${b.name} cancelled their booking`,
    message: `${clock.dateTime(b.startsAt)}${why ? ` · “${why}”` : ""}${calendar && !calendar.ok ? ` — your calendar couldn't be changed (${calendar.error}); cancel it there yourself.` : ""}`,
    link: linkFor(row),
  });
  await recordAudit({ userId: b.hostUserId, action: "UPDATE", entityType: "Booking", entityId: b.id, entityLabel: `Cancelled by the guest: ${b.name}, ${clock.dateTime(b.startsAt)}${why ? ` — ${why}` : ""}` });
  return { ok: true };
}

/**
 * A colleague added to the meeting — at most three. The invitation is the host's calendar's, carrying the page's own
 * words (R2-15), never a message from whoever typed the address.
 */
export async function addBookingGuest(token: string, input: { email: string; name?: string }, now = new Date()): Promise<{ ok: true; guests: { email: string; name: string | null }[] } | { ok: false; error: string }> {
  const row = await rowFor(token);
  if (!row) return { ok: false, error: "This link doesn't name a booking." };
  const closed = closedReason(row, now);
  if (closed) return { ok: false, error: closed };
  const email = String(input?.email ?? "").trim().toLowerCase().slice(0, 254);
  if (!EMAIL.test(email)) return { ok: false, error: "Enter their email address." };
  const name = inviteName(String(input?.name ?? ""));
  const b = row.booking;
  const guests = guestsOf(row.guests);
  if (email === b.email.toLowerCase() || guests.some((g) => g.email === email)) return { ok: false, error: "They're already invited." };
  if (guests.length >= MAX_GUESTS) return { ok: false, error: `${MAX_GUESTS} colleagues can be invited at most. Reply to the invitation for more.` };
  const next = [...guests, { email, name: name === "Guest" ? null : name }];

  const draft = await draftOf(row, {});
  if (!draft || !b.calendarEventId) return { ok: false, error: "This meeting can't take more people from here. Reply to the invitation instead." };
  const attendees = [...draft.attendees.filter((a) => a.email.toLowerCase() !== email), { email, name: name === "Guest" ? null : name }];
  const calendar = await rescheduleMeeting(b.hostUserId, b.calendarEventId, { ...draft, attendees });
  if (!calendar.ok) return { ok: false, error: calendar.lasting ? calendar.error : "They couldn't be invited just now. Try again in a little while." };
  await db.bookingDetail.update({ where: { bookingId: b.id }, data: { guests: next } });
  const clock = await workspaceClock();
  await notifyUser({ userId: b.hostUserId, type: "FORM_RESPONSE", title: `${b.name} invited a colleague`, message: `${email} — ${clock.dateTime(b.startsAt)}`, link: linkFor(row) });
  return { ok: true, guests: next };
}
