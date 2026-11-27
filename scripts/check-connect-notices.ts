/**
 * check:connect-notices — Deskzo Connect's guests told when something changes for them (owner, 20 Nov 2026;
 * src/lib/connect/notices.ts).
 *
 *   · A list newly shared tells the guest; changing its end date doesn't; one shared back after being taken does.
 *   · A shared comment tells each guest of the list — at most once a list an hour; an internal one tells nobody.
 *   · A suggestion decided tells its guest what became of it: added, not added, taken on board.
 *   · Never a guest who couldn't act on it: stopped, access over, or the list no longer theirs.
 *   · No email names a customer: the mailers are given the guest, the list's name and who — never a company.
 *   · The list's own say: turned off by whoever may edit it, none of these go — and nobody else can turn it.
 *
 * Against the local database, as its super admin; the mailers stand in, nothing is sent; everything made is removed.
 *
 *   npm run check:connect-notices
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "ADMIN", name: "Zz Notices", email: "zz-notices@example.invalid" };
const sent: { kind: string; to: string; args: string[] }[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/notify" || request.endsWith("lib/notify")) return { notifyUser: async () => undefined };
  if (request === "@/lib/connect/mail" || request.endsWith("lib/connect/mail")) {
    const rec = (kind: string) => async (g: { email: string }, ...args: string[]) => void sent.push({ kind, to: g.email, args });
    return {
      connectLink: async () => "http://zz.localhost/connect",
      mailGuestInvite: rec("invite"),
      mailGuestCode: rec("code"),
      mailGuestListShared: rec("listShared"),
      mailGuestComments: rec("comments"),
      mailGuestSuggestionDecided: rec("decided"),
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
  actor = { id: admin.id, role: "ADMIN", name: admin.name, email: admin.email ?? actor.email };

  const staff = await import("../src/actions/connect");
  const review = await import("../src/actions/connect-review");
  const working = await import("../src/lib/connect/working");
  const notices = await import("../src/lib/connect/notices");

  const run = Date.now().toString(36);
  const city = `Zzncity${run}`;
  const companies: string[] = [];
  const workbooks: string[] = [];
  let connId = "";
  const of = (kind: string, to: string) => sent.filter((s) => s.kind === kind && s.to === to);

  try {
    const c = await db.company.create({ data: { name: `Zz Notice ${run} Secret Customer`, normalizedName: `zz notice ${run} secret customer`, createdById: admin.id }, select: { id: true } });
    companies.push(c.id);
    await db.companyLocation.create({ data: { companyId: c.id, label: "Head office", city, isPrimary: true } });
    const wb = await db.workbook.create({ data: { name: `Zz Notice list ${run}`, filters: { city: [city] }, ownerUserId: admin.id }, select: { id: true } });
    workbooks.push(wb.id);
    const conn = await db.connection.create({ data: { name: `Zz Notice brand ${run}` }, select: { id: true } });
    connId = conn.id;
    const mk = (name: string, data: object = {}) =>
      db.guest.create({ data: { connectionId: conn.id, name: `Zz ${name}`, email: `zz.${name}.${run}@zz-n-${run}.example`, status: "ACTIVE", inviteExpiresAt: new Date(Date.now() + 86_400_000), ...data }, select: { id: true, email: true } });
    const arjun = await mk("arjun");
    const priya = await mk("priya");
    const stopped = await mk("stopped", { status: "SUSPENDED" });

    section("A list shared");
    await staff.shareListWithGuest({ workbookId: wb.id, guestId: arjun.id });
    ok("newly shared: the guest is told, with the list's name", of("listShared", arjun.email).length === 1 && of("listShared", arjun.email)[0]!.args[0] === `Zz Notice list ${run}`);
    await staff.shareListWithGuest({ workbookId: wb.id, guestId: arjun.id, until: "2099-12-31" });
    ok("  a new end date alone tells them nothing", of("listShared", arjun.email).length === 1);
    const share = await db.listShare.findUniqueOrThrow({ where: { workbookId_guestId: { workbookId: wb.id, guestId: arjun.id } }, select: { id: true } });
    await staff.unshareList(share.id);
    await staff.shareListWithGuest({ workbookId: wb.id, guestId: arjun.id });
    ok("  taken back and shared again: told again", of("listShared", arjun.email).length === 2);
    await db.listShare.create({ data: { workbookId: wb.id, guestId: priya.id } });
    await db.listShare.create({ data: { workbookId: wb.id, guestId: stopped.id } });

    section("Comments");
    await review.addRowComment({ workbookId: wb.id, companyId: c.id, body: "Keep our price firm.", shared: false });
    ok("an internal comment tells nobody", sent.filter((s) => s.kind === "comments").length === 0);
    await review.addRowComment({ workbookId: wb.id, companyId: c.id, body: "Can you join Tuesday?", shared: true });
    ok("a shared one tells each guest of the list", of("comments", arjun.email).length === 1 && of("comments", priya.email).length === 1);
    ok("  never a stopped guest", of("comments", stopped.email).length === 0);
    await review.addRowComment({ workbookId: wb.id, companyId: c.id, body: "And bring the sample.", shared: true });
    ok("  a second within the hour: no second email", of("comments", arjun.email).length === 1);
    ok("  after the hour, one again", (await notices.noticeComment(wb.id, admin.name, undefined, new Date(Date.now() + 61 * 60_000))) >= 2);
    const mailsBefore = sent.filter((s) => s.kind === "comments").length;
    await working.guestAddComment(arjun.id, { shareId: share.id, companyId: c.id, body: "Yes." });
    ok("a guest's own comment emails no guest", sent.filter((s) => s.kind === "comments").length === mailsBefore);

    section("Suggestions decided");
    await working.guestSuggestCompany(arjun.id, { shareId: share.id, name: `Zz Notice ${run} Prospect`, note: "Fits." });
    await working.guestSuggestCompany(arjun.id, { shareId: share.id, name: `Zz Notice ${run} Another`, note: "Maybe." });
    const [one, two] = await db.listSuggestion.findMany({ where: { guestId: arjun.id }, orderBy: { createdAt: "asc" }, select: { id: true } });
    await review.linkSuggestion(one!.id, c.id);
    await review.declineSuggestion(two!.id, "Not for now");
    const decided = of("decided", arjun.email).map((s) => s.args[1]);
    ok("the guest hears what became of each: added, and not added", decided.includes("was added to the list") && decided.includes("wasn't added"), decided);

    section("The list's own say");
    const { setListGuestEmails } = staff;
    const { hasEffectivePermission } = await import("../src/actions/permission");
    let other: { id: string; name: string; email: string | null } | null = null;
    for (const u of await db.user.findMany({ where: { active: true, isSuperAdmin: false }, select: { id: true, name: true, email: true }, take: 60 })) {
      if (!(await hasEffectivePermission(u.id, "workspace.manageAny"))) {
        other = u;
        break;
      }
    }
    if (other) {
      actor = { id: other.id, role: "ADMIN", name: other.name, email: other.email ?? "zz@example.invalid" };
      ok("somebody who can't edit the list can't turn its emails off", !(await setListGuestEmails(wb.id, false)).ok);
      actor = { id: admin.id, role: "ADMIN", name: admin.name, email: admin.email ?? actor.email };
    }
    ok("whoever built it can", (await setListGuestEmails(wb.id, false)).ok && (await staff.listSharing(wb.id)).emailGuests === false);
    const quiet = sent.length;
    await notices.noticeComment(wb.id, admin.name, undefined, new Date(Date.now() + 5 * 3_600_000));
    await working.guestSuggestCompany(arjun.id, { shareId: share.id, name: `Zz Notice ${run} Quiet`, note: "x" });
    const quietOne = await db.listSuggestion.findFirst({ where: { guestId: arjun.id, status: "PENDING" }, select: { id: true } });
    if (quietOne) await review.declineSuggestion(quietOne.id, "x");
    ok("  turned off: no comment email, no decision email", sent.length === quiet, sent.slice(quiet));
    await setListGuestEmails(wb.id, true);
    ok("  turned on again, they go", (await notices.noticeComment(wb.id, admin.name, undefined, new Date(Date.now() + 7 * 3_600_000))) >= 1);

    section("Never a guest who couldn't act on it");
    await db.guest.update({ where: { id: priya.id }, data: { accessUntil: new Date(Date.now() - 1000) } });
    const before = of("comments", priya.email).length;
    await notices.noticeComment(wb.id, admin.name, undefined, new Date(Date.now() + 3 * 3_600_000));
    ok("access over: no more emails", of("comments", priya.email).length === before);
    await staff.unshareList(share.id);
    await working.guestSuggestCompany(arjun.id, { shareId: share.id, name: "Zz late", note: "x" }).catch(() => null);
    ok("  the list taken back: no list email for it", (await notices.noticeListShared(arjun.id, wb.id, admin.name)) === false);

    section("No customer in any email");
    ok("no email was given a company's name", !JSON.stringify(sent).includes("Secret Customer") && !JSON.stringify(sent).includes(`Zz Notice ${run} Prospect`), sent.length);
  } finally {
    if (connId) await db.connection.deleteMany({ where: { id: connId } });
    await db.workbook.deleteMany({ where: { id: { in: workbooks } } });
    await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
  }

  console.log(failures === 0 ? `\nAll ${passes} Connect notice checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
