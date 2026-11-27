import { createHash, randomBytes } from "node:crypto";
import { callerKeyIp } from "@/lib/client-ip";
import { db } from "@/lib/db";
import { emitBookingMade } from "@/lib/automate/emit-records";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/custom-fields/server";
import { scheduleMeeting } from "@/lib/calendar/meetings";
import { bookingInvitesOn } from "@/lib/customer-email-settings";
import { busyFor } from "@/lib/calendar/busy";
import { intakeLead, leadPayloadSchema } from "@/lib/lead-capture/intake";
import { companyPath, leadPath } from "@/lib/record-links";
import { workspaceClock } from "@/lib/time/workspace";
import { getOrganisation } from "@/lib/organisation";
import type { Clock } from "@/lib/time/zone";
import { currentTenant, tenantOrigin } from "@/lib/tenancy/resolve";
import { BOOKING_LIMITS, openSlots, pageSlots, parseHours, pickHost, type Busy, type SlotRules } from "@/lib/booking/rules";
import { answerLines, bookingQuestions, checkBookingAnswers, type Question } from "@/lib/booking/questions";
import { tokenOfBookingRef } from "@/lib/nurture/replies";
import { bookedFromNurture, nurtureForBooking } from "@/lib/nurture/server";

/**
 * Booking pages, against the database (src/lib/booking/rules.ts has the rules). A page's hosts are the
 * company's people. With a calendar connected, the meeting is made in it and the provider sends the
 * invitation; without one, it is a meeting in Deskzo's own calendar and Deskzo emails the invitation
 * (src/lib/calendar/native.ts, owner 17 Oct 2026). Their busy times come from both (a connected calendar as
 * synced, so up to a few minutes old) and from bookings already taken. A
 * booking opens a lead, its company and contact as a website enquiry would (`intakeLead`), in the page's
 * pipeline, owned by the host it went to — or, where the plan has no leads, only the company and contact.
 */

const DAY = 86_400_000;

/**
 * People who can host: active, with an address for the invitation's replies — a meeting goes into their
 * connected calendar, or into Deskzo's own when they have none.
 */
export async function possibleHosts(): Promise<{ id: string; name: string }[]> {
  const people = await db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, take: 1000, select: { id: true, name: true, email: true } });
  return people.filter((p) => !!p.email?.trim()).map((p) => ({ id: p.id, name: p.name }));
}

/** What each host is busy with between two moments: their calendar's busy events, Deskzo's meetings, and bookings taken. */
async function busyOf(userIds: string[], from: Date, to: Date, except?: string): Promise<Map<string, Busy[]>> {
  const [people, bookings] = await Promise.all([
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }),
    db.booking.findMany({
      where: { hostUserId: { in: userIds }, status: "CONFIRMED", startsAt: { lt: to }, endsAt: { gt: from }, ...(except ? { id: { not: except } } : {}) },
      select: { hostUserId: true, startsAt: true, endsAt: true },
    }),
  ]);
  const busy = await busyFor(people, from, to);
  const out = new Map<string, Busy[]>(userIds.map((id) => [id, [...(busy.get(id) ?? [])]]));
  for (const b of bookings) out.get(b.hostUserId)?.push({ start: b.startsAt, end: b.endsAt });
  return out;
}

const PAGE_SELECT = {
  id: true,
  slug: true,
  title: true,
  description: true,
  durationMinutes: true,
  hostUserIds: true,
  hours: true,
  daysAhead: true,
  minNoticeHours: true,
  bufferMinutes: true,
  online: true,
  pipelineId: true,
  active: true,
  createdById: true,
} as const;

/** A page in use, by its address — null for anything else, a workspace without the tables included. */
export async function pageBySlug(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(slug)) return null;
  try {
    const page = await db.bookingPage.findUnique({ where: { slug }, select: PAGE_SELECT });
    return page?.active ? page : null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export type Page = NonNullable<Awaited<ReturnType<typeof pageBySlug>>>;

/** A page's own questions (src/lib/booking/questions.ts) — none before the table is there. */
export async function questionsOf(pageId: string): Promise<Question[]> {
  try {
    const form = await db.bookingPageForm.findUnique({ where: { pageId }, select: { questions: true } });
    return bookingQuestions(form?.questions);
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/**
 * Each host still able to host, with the times they can be booked and how many bookings they have coming up. `only`:
 * one host alone (a reschedule stays with its host); `except`: a booking whose own time isn't busy (the one moving).
 */
export async function hostSlots(page: Page, clock: Clock, now: Date, only?: { hostId: string; except: string }) {
  const hours = parseHours(page.hours);
  if (!hours.ok) return [];
  const able = new Set((await possibleHosts()).map((h) => h.id));
  const hosts = page.hostUserIds.filter((id) => able.has(id) && (!only || id === only.hostId));
  if (!hosts.length) return [];
  const rules: SlotRules = { hours: hours.hours, durationMinutes: page.durationMinutes, bufferMinutes: page.bufferMinutes, minNoticeHours: page.minNoticeHours, daysAhead: page.daysAhead };
  const until = new Date(now.getTime() + (page.daysAhead + 2) * DAY);
  const [busy, upcoming] = await Promise.all([
    busyOf(hosts, new Date(now.getTime() - DAY), until, only?.except),
    db.booking.groupBy({ by: ["hostUserId"], where: { hostUserId: { in: hosts }, status: "CONFIRMED", startsAt: { gte: now } }, _count: { _all: true } }),
  ]);
  return hosts.map((id) => ({
    id,
    slots: openSlots(rules, busy.get(id) ?? [], clock, now),
    upcoming: upcoming.find((u) => u.hostUserId === id)?._count._all ?? 0,
  }));
}

/**
 * Who the guest is booking with, as the page says it: the company's trading name, else its legal name, else the
 * workspace's own name (owner, 18 Nov 2026 — a workspace with no company profile yet showed "us"). Empty only when
 * there is none at all, and then the page leaves the line out.
 */
export async function bookingCompanyName(): Promise<string> {
  const org = await getOrganisation();
  const own = org.tradeName?.trim() || org.legalName?.trim();
  if (own) return own;
  return (await currentTenant().catch(() => null))?.name?.trim() ?? "";
}

export type PublicBookingPage = {
  slug: string;
  /** Who the customer is booking with — the workspace's trading name. */
  ourName: string;
  title: string;
  description: string | null;
  durationMinutes: number;
  online: boolean;
  zone: string;
  /** The times it can be booked, by day ("yyyy-mm-dd" in the workspace's zone): each an ISO instant. */
  days: { day: string; slots: string[] }[];
  /** The page's own questions, asked after the guest's name and email. */
  questions: Question[];
};

/** What the public page shows: the page and its open times. Null when there is no such page in use. */
export async function publicBookingPage(slug: string, now = new Date()): Promise<PublicBookingPage | null> {
  const page = await pageBySlug(slug);
  if (!page) return null;
  const [clock, ourName, questions] = await Promise.all([workspaceClock(), bookingCompanyName(), questionsOf(page.id)]);
  const slots = pageSlots(await hostSlots(page, clock, now));
  const days = new Map<string, string[]>();
  for (const s of slots) {
    const key = clock.dateKey(s);
    days.set(key, [...(days.get(key) ?? []), s.toISOString()]);
  }
  return {
    slug: page.slug,
    ourName,
    title: page.title,
    description: page.description,
    durationMinutes: page.durationMinutes,
    online: page.online,
    zone: clock.zone,
    days: [...days].map(([day, s]) => ({ day, slots: s })),
    questions,
  };
}

export type BookingInput = {
  start: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  notes?: string;
  answers?: unknown;
  zone?: string;
  /** A nurture email's link (`?ref=n-…`, src/lib/nurture/replies.ts): booked on that lead, not a new one. */
  ref?: string;
};

/** What the confirmation shows, and the manage page after it. */
export type BookedView = {
  when: string;
  host: string;
  invited: boolean;
  invites: boolean;
  /** The secret part of the reschedule-or-cancel link — the guest's alone, never stored as it is. */
  manage?: string;
  startsAt?: string;
  endsAt?: string;
  joinUrl?: string | null;
};

/** A zone name the browser gave, if this runtime knows it; anything else is dropped. */
export function knownZone(zone: unknown): string | null {
  const z = typeof zone === "string" ? zone.trim().slice(0, 64) : "";
  if (!z) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

export const hashManageToken = (token: string) => createHash("sha256").update(`booking-manage:${token}`).digest("hex");

/** The reschedule-or-cancel address for a booking, on this workspace's own address. */
export async function manageUrl(token: string): Promise<string> {
  return `${await tenantOrigin()}/book/manage/${token}`;
}

/**
 * How many bookings one address may make, and one page take, before it waits a while. Security audit, 11 Nov 2026
 * (SEC-48): the page-wide cap was 30, which six addresses could use up and close the page to everybody; the
 * per-address cap is what holds a caller, and the page-wide one now only bounds a flood.
 */
const RATE = { perSource: 5, perPage: 120, windowMs: 60 * 60_000 } as const;

/**
 * Security review, 15 Nov 2026 — RL-03: the page-wide cap was still one caller's to fill (from many guest emails),
 * closing the page for everybody. Past it a caller whose address is known and is under its own cap (5 an hour from
 * its address or IPv6 /64; 2 a day per guest email) may still book, up to this many times the page-wide cap; only a
 * caller whose address isn't known is refused past the page-wide cap. Callers without a known address no longer
 * share one "unknown" per-source bucket that any one of them could fill.
 */
const HELD_CEILING_FACTOR = 10;

const TOO_MANY = "Too many bookings just now. Try again in a little while.";

const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, max);

/**
 * Security audit round two, 13 Nov 2026 (R2-15): the page sends an invitation from the host's own calendar to
 * whatever address is typed, so it mustn't carry the typer's words — a link, a message — to a stranger. One
 * address books one page at most this many times a day.
 */
export const GUEST_BOOKINGS_PER_DAY = 2;

/**
 * The name as the invitation shows it: letters, spaces and the few marks names have, at most 40 characters — never
 * a link or a sentence. "Guest" when nothing is left.
 */
export function inviteName(name: string): string {
  const kept = name
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/[^\p{L}\p{M} .'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
  return kept.length >= 2 ? kept : "Guest";
}

/**
 * Books a time on a page: checked again now (the time must still be open), given to the host free then
 * with fewest bookings coming up, held for them under a lock so two people can't take one slot, then
 * opened as a lead and made a meeting in the host's calendar — their connected one, or Deskzo's own. `source` is where the request came from —
 * only its hash is kept, to count how many one place makes.
 */
export async function bookSlot(
  slug: string,
  input: BookingInput,
  source: string | null,
  now = new Date(),
): Promise<({ ok: true } & BookedView) | { ok: false; error: string; errors?: Record<string, string> }> {
  const page = await pageBySlug(slug);
  if (!page) return { ok: false, error: "This booking page isn't taking bookings." };
  // The page's own questions, answered as they were asked (owner, 18 Nov 2026).
  const questions = await questionsOf(page.id);
  const checked = checkBookingAnswers(questions, input.answers);
  if (!checked.ok) return { ok: false, error: checked.error, errors: checked.errors };
  const answered = answerLines(questions, checked.answers);
  const zone = knownZone(input.zone);
  const name = clean(input.name, BOOKING_LIMITS.name);
  const email = clean(input.email, BOOKING_LIMITS.email).toLowerCase();
  const phone = clean(input.phone, BOOKING_LIMITS.phone);
  const company = clean(input.company, BOOKING_LIMITS.company);
  const notes = clean(input.notes, BOOKING_LIMITS.notes);
  if (!name) return { ok: false, error: "Enter your name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter your email address — the invitation goes to it." };
  const start = new Date(String(input.start ?? ""));
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Choose a time." };

  // RL-03: an IPv6 caller by its /64 (src/lib/client-ip.ts callerKeyIp), so a fresh address per try is the same caller.
  const callerKnown = !!source;
  const sourceHash = createHash("sha256").update(`${source ? callerKeyIp(source) : "unknown"}:${page.id}`).digest("hex").slice(0, 32);
  // Counted by when the requests came, whatever moment the times are worked out for.
  const since = new Date(Date.now() - RATE.windowMs);
  const tooMany = async (client: Pick<typeof db, "booking">) => {
    if (callerKnown && (await client.booking.count({ where: { pageId: page.id, sourceHash, createdAt: { gte: since } } })) >= RATE.perSource) return true;
    const onPage = await client.booking.count({ where: { pageId: page.id, createdAt: { gte: since } } });
    if (onPage < RATE.perPage) return false;
    return !callerKnown || onPage >= RATE.perPage * HELD_CEILING_FACTOR;
  };
  // A quick answer for somebody plainly over; the count that decides is taken again under the page's lock, below.
  if (await tooMany(db)) return { ok: false, error: TOO_MANY };
  // R2-15: one address, this page, a day — however many places it is typed from.
  const byGuest = await db.booking.count({ where: { pageId: page.id, email, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } } });
  if (byGuest >= GUEST_BOOKINGS_PER_DAY) return { ok: false, error: "This email address has booked this page as often as it can today. Try again tomorrow, or reply to the invitation you have." };

  const clock = await workspaceClock();
  const hosts = await hostSlots(page, clock, now);
  const hostId = pickHost(start, hosts);
  if (!hostId) return { ok: false, error: "That time has just been taken. Choose another." };
  const end = new Date(start.getTime() + page.durationMinutes * 60_000);

  /**
   * Held for the host under a lock: whoever comes second finds the time taken. And counted under the page's lock first,
   * in the same transaction (owner, 12 Nov 2026 — Phase 4, audit M-17): bookings sent at once queue there, so a burst
   * can't all read "under the limit" and all be made. The page's lock is always taken before a host's.
   */
  const booking = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking-rate:${page.id}`}))`;
    if (await tooMany(tx)) return "busy" as const;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${hostId}`}))`;
    const clash = await tx.booking.count({ where: { hostUserId: hostId, status: "CONFIRMED", startsAt: { lt: end }, endsAt: { gt: start } } });
    if (clash > 0) return null;
    return tx.booking.create({
      data: { pageId: page.id, hostUserId: hostId, startsAt: start, endsAt: end, name, email, phone: phone || null, companyName: company || null, notes: notes || null, sourceHash },
      select: { id: true },
    });
  });
  if (booking === "busy") return { ok: false, error: TOO_MANY };
  if (!booking) return { ok: false, error: "That time has just been taken. Choose another." };

  const host = await db.user.findUniqueOrThrow({ where: { id: hostId }, select: { id: true, name: true } });
  // The guest's own link to move or cancel it, kept only as a hash.
  const token = randomBytes(24).toString("base64url");
  let manage: string | undefined;
  try {
    await db.bookingDetail.create({ data: { bookingId: booking.id, answers: checked.answers, zone, tokenHash: hashManageToken(token) } });
    manage = token;
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const manageLink = manage ? await manageUrl(manage) : null;
  // The lead, its company and contact — as a website enquiry would be — owned by the host.
  let links = { companyId: null as string | null, contactId: null as string | null, leadId: null as string | null };
  let leadSeq: number | null = null;
  let companySeq: number | null = null;
  const message = [notes, answered.length ? answered.join("\n") : null].filter(Boolean).join("\n\n");
  const payload = leadPayloadSchema.safeParse({ name, email, phone: phone || undefined, company: company || undefined, message: message || undefined, source: "WEBSITE" });
  // From a nurture email's link (owner, 20 Nov 2026 — phase 4): the lead it was for, its company and contact — no new lead.
  const nurtureToken = tokenOfBookingRef(input.ref);
  const fromNurture = nurtureToken ? await nurtureForBooking(nurtureToken).catch(() => null) : null;
  if (fromNurture) {
    links = { companyId: fromNurture.companyId, contactId: fromNurture.contactId, leadId: fromNurture.leadId };
    leadSeq = fromNurture.leadSeq;
  } else if (payload.success) {
    try {
      const made = await intakeLead(
        { id: null, name: `Booking page “${page.title}”`, sourceLabel: `Booking page: ${page.title}`, createdById: page.createdById },
        payload.data,
        // R2-14: a booker naming a company we already have is unconfirmed there until staff say otherwise.
        // The host at their lead limit: the lead is made with nobody and the managers told (src/lib/leads/intake-owner.ts);
        // the plan's cap leaves the booking without a lead, logged below — the meeting stands either way.
        { ownerUserId: hostId, leadTitle: `${page.title} — ${company || name}`, notifyTitle: `${name} booked ${page.title}`, notify: false, pipelineId: page.pipelineId, raisedBy: null, path: "booking", unconfirmedFrom: "BOOKING" },
      );
      if (made.status === "contact") {
        links = { companyId: made.companyId, contactId: made.contactId, leadId: null };
        companySeq = made.companySeq;
      } else if (made.status !== "reseller") {
        const lead = await db.lead.findUnique({ where: { id: made.leadId }, select: { id: true, leadSeq: true, companyId: true, contactId: true } });
        if (lead) {
          links = { companyId: lead.companyId, contactId: lead.contactId, leadId: lead.id };
          leadSeq = lead.leadSeq;
        }
      }
    } catch (err) {
      console.error(`[booking] ${slug}: the booking's lead could not be made`, err);
    }
  }

  // The guest is emailed an invitation unless the workspace turned that off (Settings › Customer emails —
  // owner, 18 Oct 2026): then the time goes in the host's calendar with the guest's details, nobody invited.
  const invites = await bookingInvitesOn();
  // R2-15: an invitation goes to the guest from the host's own calendar, so it carries only the page's own words and a
  // cleaned name — never the company or notes typed in, which wait for the host on the lead and in Deskzo's calendar.
  const meeting = await scheduleMeeting(
    hostId,
    {
      title: invites ? `${page.title} — ${inviteName(name)}` : `${page.title} — ${name}${company ? `, ${company}` : ""}`,
      // R2-15 still: the page's own words and our own link only — the answers wait on the lead.
      description: invites
        ? [`Booked on the booking page “${page.title}”.`, manageLink ? `To reschedule or cancel: ${manageLink}` : null].filter(Boolean).join("\n\n")
        : [notes ? `From ${name}: ${notes}` : null, ...answered, phone ? `Phone: ${phone}` : null, `Guest: ${name} <${email}> — not emailed an invitation.`, `Booked on your booking page “${page.title}”.`].filter(Boolean).join("\n\n"),
      location: "",
      startsAt: start,
      endsAt: end,
      online: page.online,
      attendees: invites ? [{ email, name }] : [],
    },
    { ...links, ticketId: null, visitId: null },
    `Booking page ${page.title}`,
  );
  await db.$transaction(async (tx) => {
    await tx.booking.update({ where: { id: booking.id }, data: { ...links, calendarEventId: meeting.ok ? meeting.eventId : null } });
    // For Automate's workflows (src/lib/automate): once the booking knows its lead.
    await emitBookingMade(tx, { id: booking.id, pageId: page.id, pageTitle: page.title, hostUserId: hostId, startsAt: start, endsAt: end }, links);
  });
  // Booked from a nurture email: the nurture ends, its owner given a task to get ready (src/lib/nurture/server.ts).
  if (fromNurture) await bookedFromNurture(fromNurture.enrolmentId, name, clock.dateTime(start)).catch((err) => console.error("[booking] ending the nurture failed", err instanceof Error ? err.message : err));

  await notifyUser({
    userId: hostId,
    type: links.leadId ? "LEAD_ASSIGNED" : "FORM_RESPONSE",
    title: `${name} booked ${page.title}`,
    message: `${clock.dateTime(start)}${company ? ` · ${company}` : ""}${notes ? ` · “${notes.slice(0, 200)}”` : ""}${answered.length ? ` · ${answered.join(" · ").slice(0, 300)}` : ""}${meeting.ok ? (meeting.warning ? ` — ${meeting.warning}` : "") : ` — the meeting couldn't be added to your calendar (${meeting.error}); send them an invitation yourself.`}`,
    link: leadSeq ? leadPath(leadSeq) : companySeq ? companyPath(companySeq) : "/calendar",
  });
  await recordAudit({ userId: page.createdById, action: "CREATE", entityType: "Booking", entityId: booking.id, entityLabel: `${page.title}: ${name} with ${host.name}, ${clock.dateTime(start)}` });
  const joinUrl = meeting.ok ? ((await db.calendarEvent.findUnique({ where: { id: meeting.eventId }, select: { joinUrl: true } }))?.joinUrl ?? null) : null;
  return { ok: true, when: clock.dateTime(start), host: host.name, invited: invites && meeting.ok, invites, manage, startsAt: start.toISOString(), endsAt: end.toISOString(), joinUrl };
}
