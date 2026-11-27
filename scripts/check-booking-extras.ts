/**
 * check:booking-extras — booking pages' own questions, the guest's time zone and manage link, rescheduling, cancelling,
 * inviting a colleague, and the website pop-up's script (owner, 18 Nov 2026 — Dreamteam's scheduler).
 *
 *   1. The question rules: no file questions, at most 15, answers checked, answers as lines.
 *   2. A real booking on a probe page: a required question unanswered is refused; answered, the booking keeps the
 *      answers and zone, the lead's message carries them, and a manage link comes back.
 *   3. The link: it shows the booking; moving it to a time the host is free moves it; a colleague is invited, a fourth
 *      refused; a cancel cancels it, and nothing more can be done with it.
 *   4. The pop-up script: it names its own origin and page, and opens /book/<page>?embed=1.
 *
 * The calendar is stubbed (no invitation goes anywhere) and so are notices. Probes are …@zzprobe-booking.invalid and the
 * page zz-probe-booking, all removed in a finally.
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
const calls: string[] = [];
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/notify" || request.endsWith("lib/notify")) return { notifyUser: async () => {}, notifyUsers: async () => {} };
  if (request === "@/lib/calendar/meetings" || request.endsWith("lib/calendar/meetings")) {
    return {
      // A meeting row of Deskzo's own, as the native calendar makes one, so moving it has something to move.
      scheduleMeeting: async (userId: string, draft: { title: string; startsAt: Date; endsAt: Date; attendees: unknown[] }) => {
        calls.push("schedule");
        const row = await db.calendarEvent.create({ data: { userId, title: draft.title, startsAt: draft.startsAt, endsAt: draft.endsAt, attendees: draft.attendees as object[], fromDeskzo: true, isOrganizer: true } });
        return { ok: true, eventId: row.id };
      },
      rescheduleMeeting: async (_u: string, _e: string, draft: { attendees: unknown[] }) => (calls.push(`reschedule:${draft.attendees.length}`), { ok: true, eventId: "zz-event" }),
      cancelMeeting: async () => (calls.push("cancel"), { ok: true, eventId: "zz-event" }),
    };
  }
  if (request === "@/lib/tenancy/resolve" || request.endsWith("lib/tenancy/resolve")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, tenantOrigin: async () => "https://probe.example" };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const MAIL = "@zzprobe-booking.invalid";
const SLUG = "zz-probe-booking";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  await db.bookingPage.deleteMany({ where: { slug: SLUG } });
  await db.calendarEvent.deleteMany({ where: { title: { startsWith: "ZZ probe booking" } } });
  const contacts = await db.contact.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true, companyId: true } });
  await db.lead.deleteMany({ where: { OR: [{ contactId: { in: contacts.map((c) => c.id) } }, { title: { startsWith: "ZZ probe booking" } }] } });
  await db.contact.deleteMany({ where: { id: { in: contacts.map((c) => c.id) } } });
  await db.company.deleteMany({ where: { name: { startsWith: "Zzprobe Booking" } } });
  await db.auditLog.deleteMany({ where: { entityType: "Booking", entityLabel: { startsWith: "ZZ probe booking" } } });
  await db.user.deleteMany({ where: { email: { endsWith: MAIL } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const q = require("../src/lib/booking/questions") as typeof import("../src/lib/booking/questions");
  const server = require("../src/lib/booking/server") as typeof import("../src/lib/booking/server");
  const manage = require("../src/lib/booking/manage") as typeof import("../src/lib/booking/manage");
  const { BOOKING_SCRIPT, bookingEmbedSnippet } = require("../src/lib/booking/embed") as typeof import("../src/lib/booking/embed");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("1. The question rules");
  const sellTo = { key: "sell_to", label: "Who do you sell to?", type: "SELECT", required: true, options: ["B2B", "B2C", "Both"], help: null };
  ok("a file question is refused", !q.checkBookingQuestions([{ ...sellTo, type: "FILE" }]).ok);
  ok("sixteen are too many", !q.checkBookingQuestions(Array.from({ length: 16 }, (_, i) => ({ ...sellTo, key: undefined, label: `Q${i}` }))).ok);
  const saved = q.checkBookingQuestions([sellTo, { key: undefined, label: "Number of employees", type: "NUMBER", required: false, options: [], help: null }]);
  ok("two ordinary ones are kept, keys made", saved.ok && saved.questions.length === 2 && saved.questions[1]!.key === "number_of_employees", saved.ok ? saved.questions.map((x) => x.key).join(",") : saved.error);
  const questions = saved.ok ? saved.questions : [];
  ok("a required one unanswered: refused, naming it", !q.checkBookingAnswers(questions, {}).ok && (q.checkBookingAnswers(questions, {}) as { error: string }).error.startsWith("Who do you sell to?"));
  ok("an option not offered: refused", !q.checkBookingAnswers(questions, { sell_to: "Govt" }).ok);
  const answered = q.checkBookingAnswers(questions, { sell_to: "B2B", number_of_employees: "40", sneaky: "x" });
  ok("answered: kept, what wasn't asked dropped", answered.ok && answered.answers.sell_to === "B2B" && !("sneaky" in answered.answers));
  ok("as lines", q.answerLines(questions, { sell_to: "B2B", number_of_employees: "40" }).join(" | ") === "Who do you sell to?: B2B | Number of employees: 40");
  ok("a zone the runtime knows is kept, anything else dropped", server.knownZone("Asia/Dubai") === "Asia/Dubai" && server.knownZone("Mars/Base") === null && server.knownZone(42) === null);

  section("2. A booking");
  await cleanup();
  try {
    const host = await db.user.create({ data: { name: "Zzprobe Host", email: `host${MAIL}`, role: "SALES", passwordHash: "x".repeat(60), active: true } });
    const all: [string, string][] = [["00:00", "23:59"]];
    const page = await db.bookingPage.create({
      data: { slug: SLUG, title: "ZZ probe booking", durationMinutes: 30, hostUserIds: [host.id], hours: { "1": all, "2": all, "3": all, "4": all, "5": all, "6": all, "7": all }, daysAhead: 7, minNoticeHours: 1, online: true, createdById: host.id },
    });
    await db.bookingPageForm.create({ data: { pageId: page.id, questions: questions as unknown as object } });

    const shown = await server.publicBookingPage(SLUG);
    ok("the public page carries its questions", shown?.questions.length === 2);
    const slots = (shown?.days ?? []).flatMap((d) => d.slots);
    ok("and has free times", slots.length > 3, slots.length);
    const guest = { start: slots[0]!, name: "Zz Guest", email: `guest${MAIL}`, company: "Zzprobe Booking Pvt Ltd", zone: "Asia/Dubai" };

    const refused = await server.bookSlot(SLUG, { ...guest, answers: {} }, "203.0.113.7");
    ok("the required question unanswered: refused", !refused.ok && !!refused.errors?.sell_to, refused.ok ? "" : refused.error);

    const made = await server.bookSlot(SLUG, { ...guest, answers: { sell_to: "B2B", number_of_employees: "40" } }, "203.0.113.7");
    ok("answered: booked, with a manage link", made.ok && !!made.manage && made.startsAt === slots[0], made.ok ? made.manage : made.error);
    if (!made.ok || !made.manage) throw new Error("no booking to go on with");
    const booking = await db.booking.findFirstOrThrow({ where: { pageId: page.id }, include: { detail: true, lead: true } });
    ok("the booking keeps the answers and the guest's zone", (booking.detail?.answers as Record<string, string>)?.sell_to === "B2B" && booking.detail?.zone === "Asia/Dubai");
    ok("only the link's hash is kept", !!booking.detail?.tokenHash && booking.detail.tokenHash !== made.manage && booking.detail.tokenHash === server.hashManageToken(made.manage));
    const lead = booking.leadId ? await db.lead.findUnique({ where: { id: booking.leadId } }) : null;
    const leadText = JSON.stringify(lead ?? {});
    ok("the lead carries the answers", leadText.includes("Who do you sell to?: B2B"), leadText.slice(0, 160));

    section("3. The guest's link");
    const view = await manage.managedBooking(made.manage);
    ok("it opens the booking, in the guest's zone", view?.guestName === "Zz Guest" && view.guestZone === "Asia/Dubai" && view.status === "CONFIRMED");
    ok("a wrong link opens nothing", (await manage.managedBooking("x".repeat(32))) === null && (await manage.managedBooking("../etc")) === null);
    const other = view!.days.flatMap((d) => d.slots).find((s) => s !== slots[0]);
    ok("other times the host is free are offered", !!other);
    const taken = await manage.rescheduleBooking(made.manage, "2001-01-01T00:00:00.000Z");
    ok("a time that isn't free: refused", !taken.ok);
    const moved = await manage.rescheduleBooking(made.manage, other!);
    const after = await db.booking.findUniqueOrThrow({ where: { id: booking.id }, include: { detail: true } });
    ok("moved: the booking and the calendar follow", moved.ok && after.startsAt.toISOString() === other && !!after.detail?.rescheduledAt && calls.some((c) => c.startsWith("reschedule:")), calls.join(","));

    for (const n of [1, 2, 3]) await manage.addBookingGuest(made.manage, { email: `colleague${n}${MAIL}` });
    const fourth = await manage.addBookingGuest(made.manage, { email: `colleague4${MAIL}` });
    const withGuests = await db.bookingDetail.findUniqueOrThrow({ where: { bookingId: booking.id } });
    ok("three colleagues invited, a fourth refused", (withGuests.guests as unknown[]).length === 3 && !fourth.ok, fourth.ok ? "" : fourth.error);
    ok("  the same address twice is refused", !(await manage.addBookingGuest(made.manage, { email: `colleague1${MAIL}` })).ok);

    const cancelled = await manage.cancelBooking(made.manage, "Something came up");
    const gone = await db.booking.findUniqueOrThrow({ where: { id: booking.id }, include: { detail: true } });
    ok("cancelled: the booking, its detail and the calendar", cancelled.ok && gone.status === "CANCELLED" && !!gone.detail?.cancelledAt && calls.includes("cancel"));
    ok("  and nothing more can be done with it", !(await manage.rescheduleBooking(made.manage, other!)).ok && !(await manage.cancelBooking(made.manage, "")).ok);

    section("4. The pop-up");
    ok("the script reads its own origin and page and opens the page framed", BOOKING_SCRIPT.includes("data-page") && BOOKING_SCRIPT.includes('"/book/" + which + q') && BOOKING_SCRIPT.includes("?embed=1"));
    ok("the snippet names the page", bookingEmbedSnippet("https://acme.deskzo.com", "demo").includes('src="https://acme.deskzo.com/api/booking/public/book.js" data-page="demo"'));
  } finally {
    await cleanup();
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll booking-extras checks passed.");
    process.exitCode = failures ? 1 : 0;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
