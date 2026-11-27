/**
 * check:connect-guests — Deskzo Connect's guests (owner, 20 Nov 2026; src/lib/connect, src/actions/connect.ts), asked
 * the questions an outsider would try.
 *
 *   · Invited by a work email only — never a personal mail service, never a staff member's address; only by whoever may
 *     manage every list.
 *   · Signing in: the same answer for any address; eight digits, wrong ones counted, a day's lock; an invitation that
 *     ran out, a stopped guest, an access date past — no code, no session.
 *   · A session: ended by stopping the guest, by its idle time, by the access date.
 *   · What a guest sees: only their shares; the list's companies; only the columns marked for guests — never a hidden
 *     one's value — and changes only to the ones marked editable, of companies in the list. Taken back, nothing.
 *
 * Against the local database, as its super admin and one person who can't manage every list; everything made is removed.
 *
 *   npm run check:connect-guests
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "ADMIN", name: "Zz Connect", email: "zz-connect@example.invalid" };
const jar = new Map<string, string>();
const mailed: { kind: string; to: string; code?: string }[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") {
    return {
      cookies: async () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined), set: (n: string, v: string) => (v ? jar.set(n, v) : jar.delete(n)) }),
      headers: async () => new Headers(),
    };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/connect/mail" || request.endsWith("lib/connect/mail")) {
    return {
      connectLink: async () => "http://zz.localhost/connect",
      mailGuestInvite: async (g: { email: string }) => void mailed.push({ kind: "invite", to: g.email }),
      mailGuestCode: async (g: { email: string }, code: string) => void mailed.push({ kind: "code", to: g.email, code }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function main() {
  const db = directClient();
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true } });
  if (!admin) throw new Error("No super admin in the local database.");
  const { hasEffectivePermission } = await import("../src/actions/permission");
  let other: { id: string; name: string; email: string | null } | null = null;
  for (const c of await db.user.findMany({ where: { active: true, isSuperAdmin: false }, select: { id: true, name: true, email: true }, take: 60 })) {
    if (!(await hasEffectivePermission(c.id, "workspace.manageAny"))) {
      other = c;
      break;
    }
  }
  if (!other) throw new Error("No active person without workspace.manageAny in the local database.");
  const as = (u: { id: string; name: string; email: string | null }) => {
    actor = { id: u.id, role: "ADMIN", name: u.name, email: u.email ?? "zz@example.invalid" };
  };
  as(admin);

  const auth = await import("../src/lib/connect/guest-auth");
  const lists = await import("../src/lib/connect/guest-lists");
  const staff = await import("../src/actions/connect");
  const board = await import("../src/actions/smart-list-board");

  const run = Date.now().toString(36);
  const city = `Zzgcity${run}`;
  const companies: string[] = [];
  const workbooks: string[] = [];
  const connections: string[] = [];
  const guestEmail = `zz.guest.${run}@zz-brand-${run}.example`;
  const sendCode = async (email: string) => {
    const before = mailed.length;
    const r = await auth.sendGuestCode(email, async (g, code) => void mailed.push({ kind: "code", to: g.email, code }));
    return { r, code: mailed.length > before ? mailed.at(-1)!.code! : null };
  };

  try {
    const mk = async (name: string, withCity: boolean) => {
      const c = await db.company.create({ data: { name: `Zz Guest ${run} ${name}`, normalizedName: `zz guest ${run} ${name}`.toLowerCase(), createdById: admin.id }, select: { id: true } });
      companies.push(c.id);
      if (withCity) await db.companyLocation.create({ data: { companyId: c.id, label: "Head office", city, isPrimary: true } });
      return c.id;
    };
    const inList = await mk("In", true);
    const outside = await mk("Out", false);
    const wb = await db.workbook.create({ data: { name: `Zz Shared ${run}`, filters: { city: [city] }, ownerUserId: admin.id }, select: { id: true } });
    const secret = await db.workbook.create({ data: { name: `Zz Not shared ${run}`, filters: { city: [city] }, ownerUserId: admin.id }, select: { id: true } });
    const calling = await db.workbook.create({ data: { name: `Zz Calling ${run}`, filters: {}, ownerUserId: admin.id, mode: "COLD_CALLING" }, select: { id: true } });
    workbooks.push(wb.id, secret.id, calling.id);

    const col = async (name: string, kind: string, guestVisible: boolean, guestEditable: boolean) => {
      const r = await board.addListProperty({ workbookId: wb.id, name, kind });
      if (!r.ok) throw new Error(r.error);
      await board.updateListProperty({ id: r.data.id, guestVisible, guestEditable });
      return r.data.id;
    };
    const outcome = await col("Next step", "TEXT", true, true);
    const seats = await col("Seats", "NUMBER", true, false);
    const margin = await col("Our margin", "NUMBER", false, false);
    await board.setListValue({ propertyId: seats, companyId: inList, value: 25 });
    await board.setListValue({ propertyId: margin, companyId: inList, value: 14 });
    ok("a column marked editable for guests is shown to them too", (await db.workbookProperty.findUnique({ where: { id: outcome }, select: { guestVisible: true } }))?.guestVisible === true);

    section("Inviting");
    const conn = await staff.addConnection({ name: `Zz Brand ${run}`, kind: "BRAND" });
    if (conn.ok) connections.push(conn.data.id);
    ok("a connection added", conn.ok);
    const connId = conn.ok ? conn.data.id : "";
    ok("a personal mail service is refused", !(await staff.inviteGuest({ connectionId: connId, name: "Zz", email: "someone@gmail.com" })).ok);
    ok("a staff member's address is refused", !(await staff.inviteGuest({ connectionId: connId, name: "Zz", email: admin.email ?? "x" })).ok);
    as(other);
    const nope = await staff.inviteGuest({ connectionId: connId, name: "Zz", email: `x.${run}@zz-brand-${run}.example` });
    ok("somebody who can't manage every list can't invite", !nope.ok, nope.ok ? "" : nope.error);
    ok("  nor share somebody else's list", !(await staff.shareListWithGuest({ workbookId: wb.id, guestId: "nobody" })).ok);
    as(admin);
    const inv = await staff.inviteGuest({ connectionId: connId, name: "Zz Guest Arjun", email: guestEmail.toUpperCase(), workbookId: wb.id });
    ok("a work address invited, the list shared at once, the invitation mailed", inv.ok && mailed.some((m) => m.kind === "invite" && m.to === guestEmail), inv.ok ? "" : inv.error);
    const guestId = inv.ok ? inv.data.id : "";
    ok("  kept in lower case, waiting to sign in", (await db.guest.findUnique({ where: { id: guestId }, select: { email: true, status: true } }))?.status === "INVITED");
    ok("  the same address twice is refused", !(await staff.inviteGuest({ connectionId: connId, name: "Zz", email: guestEmail })).ok);
    ok("a calling activity can't be shared", !(await staff.shareListWithGuest({ workbookId: calling.id, guestId })).ok);

    section("Signing in");
    const stranger = await sendCode(`nobody.${run}@zz-brand-${run}.example`);
    ok("an address that isn't a guest gets the same answer, and no email", stranger.r.ok && stranger.r.message === auth.CHECK_INBOX && stranger.code === null);
    ok("  and a code typed for it is just 'not the code'", !(await auth.verifyGuestCode(`nobody.${run}@zz-brand-${run}.example`, "12345678")).ok);
    const first = await sendCode(guestEmail);
    ok("the guest gets an eight-digit code, and the same answer", first.r.ok && first.r.message === auth.CHECK_INBOX && /^\d{8}$/.test(first.code ?? ""));
    ok("  a wrong code is refused", !(await auth.verifyGuestCode(guestEmail, "00000000")).ok);
    const right = await auth.verifyGuestCode(guestEmail, first.code ?? "");
    ok("  the right one signs in, and the guest is now active", right.ok && jar.has(auth.GUEST_COOKIE) && (await db.guest.findUnique({ where: { id: guestId }, select: { status: true } }))?.status === "ACTIVE");
    ok("  and works only once", !(await auth.verifyGuestCode(guestEmail, first.code ?? "")).ok);
    const me = await auth.currentGuest();
    ok("the session knows who it is", me?.id === guestId, me?.email);

    section("What the guest sees");
    const shares = await lists.guestShares(guestId);
    ok("only their share", shares.length === 1 && shares[0]!.listName === `Zz Shared ${run}`);
    const view = await lists.guestListView(guestId, shares[0]!.id);
    ok("the list's companies as its builder sees them", view?.rows.some((r) => r.id === inList) === true && !view?.rows.some((r) => r.id === outside), view?.rows.map((r) => r.name));
    ok("  only the columns marked for guests", view?.columns.map((c) => c.name).join() === "Next step,Seats", view?.columns.map((c) => c.name));
    ok("  and never a hidden column's value", JSON.stringify(view?.values ?? {}).includes("25") && !JSON.stringify(view?.values ?? {}).includes("14"), view?.values);
    const shareOfSecret = await db.listShare.create({ data: { workbookId: secret.id, guestId: (await db.guest.create({ data: { connectionId: connId, name: "Zz Other", email: `zz.other.${run}@zz-brand-${run}.example`, inviteExpiresAt: new Date(Date.now() + 86_400_000) }, select: { id: true } })).id }, select: { id: true } });
    ok("somebody else's share answers nothing", (await lists.guestListView(guestId, shareOfSecret.id)) === null);
    ok("  nor a made-up id", (await lists.guestListView(guestId, "cmzzzzzzzzzzzzzzzzzzzzzzz")) === null);

    section("What the guest may change");
    ok("an editable column, for a company in the list", (await lists.setGuestValue(guestId, { shareId: shares[0]!.id, propertyId: outcome, companyId: inList, value: "Demo on Tuesday" })).ok);
    ok("  a read-only column is refused", !(await lists.setGuestValue(guestId, { shareId: shares[0]!.id, propertyId: seats, companyId: inList, value: 99 })).ok);
    ok("  a hidden column is refused", !(await lists.setGuestValue(guestId, { shareId: shares[0]!.id, propertyId: margin, companyId: inList, value: 0 })).ok);
    ok("  a company outside the list is refused", !(await lists.setGuestValue(guestId, { shareId: shares[0]!.id, propertyId: outcome, companyId: outside, value: "x" })).ok);
    ok("  and through somebody else's share, nothing", !(await lists.setGuestValue(guestId, { shareId: shareOfSecret.id, propertyId: outcome, companyId: inList, value: "x" })).ok);

    section("Taking it back");
    await staff.unshareList(shares[0]!.id);
    ok("taken back: the list answers nothing on the next look", (await lists.guestListView(guestId, shares[0]!.id)) === null && (await lists.guestShares(guestId)).length === 0);
    ok("  and takes no change", !(await lists.setGuestValue(guestId, { shareId: shares[0]!.id, propertyId: outcome, companyId: inList, value: "x" })).ok);
    await staff.shareListWithGuest({ workbookId: wb.id, guestId });
    ok("shared again, it's back", (await lists.guestShares(guestId)).length === 1);

    section("Sessions end");
    await db.guestSession.updateMany({ where: { guestId }, data: { lastSeenAt: new Date(Date.now() - 9 * 3_600_000) } });
    ok("eight hours idle signs the guest out", (await auth.currentGuest()) === null);
    await db.guestSession.updateMany({ where: { guestId }, data: { lastSeenAt: new Date() } });
    ok("  (and back within the time, still in)", (await auth.currentGuest())?.id === guestId);
    await db.guest.update({ where: { id: guestId }, data: { accessUntil: new Date(Date.now() - 1000) } });
    ok("their access date past: signed out, and no code is sent", (await auth.currentGuest()) === null && (await sendCode(guestEmail)).code === null);
    await db.guest.update({ where: { id: guestId }, data: { accessUntil: null } });
    await staff.suspendGuest(guestId);
    ok("stopped: every session ended, and no code is sent", (await auth.currentGuest()) === null && (await db.guestSession.count({ where: { guestId, revokedAt: null } })) === 0 && (await sendCode(guestEmail)).code === null);
    await staff.restoreGuest(guestId);
    ok("let back in, codes come again", (await sendCode(guestEmail)).code !== null);

    section("Codes");
    const late = await db.guest.create({ data: { connectionId: connId, name: "Zz Late", email: `zz.late.${run}@zz-brand-${run}.example`, inviteExpiresAt: new Date(Date.now() - 1000) }, select: { id: true } });
    ok("an invitation that ran out gets no code", (await sendCode(`zz.late.${run}@zz-brand-${run}.example`)).code === null && !!late.id);
    const fresh = await sendCode(guestEmail);
    for (let i = 0; i < 5; i += 1) await auth.verifyGuestCode(guestEmail, "11111111");
    ok("five wrong tries spend the code — even the right one is refused after", !(await auth.verifyGuestCode(guestEmail, fresh.code ?? "")).ok);
    await db.guestCode.create({ data: { guestId, codeHash: "x", expiresAt: new Date(Date.now() + 60_000), attempts: auth.FAILED_CODES_A_DAY, usedAt: new Date() } });
    ok("twenty wrong codes in a day: no code sent, none checked", (await sendCode(guestEmail)).code === null && /paused/.test(((await auth.verifyGuestCode(guestEmail, "12345678")) as { error?: string }).error ?? ""));
  } finally {
    await db.connection.deleteMany({ where: { id: { in: connections } } });
    await db.workbook.deleteMany({ where: { id: { in: workbooks } } });
    await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
  }

  console.log(failures === 0 ? `\nAll ${passes} Connect guest checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
