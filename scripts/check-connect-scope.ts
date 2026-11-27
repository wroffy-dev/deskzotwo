/**
 * check:connect-scope — which of a shared list's rows a Deskzo Connect guest sees (owner, 20 Nov 2026: "only accounts
 * nominated by our sales team will be shown to lc team. also external users record view by their territory";
 * src/lib/connect/row-scope.ts).
 *
 *   · A share narrowed to a Checkbox column shows only the rows ticked in it; untick one and it's gone.
 *   · A guest's territory shows only companies with an address in those states — any case.
 *   · Both together: ticked AND in the territory. A guest with neither sees every row.
 *   · Outside it, a row is as absent as one outside the list: no row page, no comment, no cell change, no correction.
 *   · A comment on a row they can't see emails them nothing.
 *   · The tick column deleted shows nothing — never everything.
 *   · Only a Checkbox column of the list may narrow; only whoever may edit the list sets it.
 *   · A share may show only some of the guest columns — chosen by whoever may edit the list; a column added later
 *     stays hidden from it until chosen; a column not theirs takes no change.
 *   · Comments stay with their team: a guest's with their own team, a staff one to every guest or to one team.
 *   · An admin who manages guests sees exactly a guest's view, changing nothing; nobody else sees it.
 *
 * Against the local database, as its super admin; the mailers stand in; everything made is removed.
 *
 *   npm run check:connect-scope
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "ADMIN", name: "Zz Scope", email: "zz-scope@example.invalid" };
const sent: { kind: string; to: string }[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/notify" || request.endsWith("lib/notify")) return { notifyUser: async () => undefined };
  if (request === "@/lib/connect/mail" || request.endsWith("lib/connect/mail")) {
    const rec = (kind: string) => async (g: { email: string }) => void sent.push({ kind, to: g.email });
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
  const lists = await import("../src/lib/connect/guest-lists");
  const working = await import("../src/lib/connect/working");

  const run = Date.now().toString(36);
  const city = `Zzscity${run}`;
  const companies: Record<"up" | "hr" | "br", string> = { up: "", hr: "", br: "" };
  const workbooks: string[] = [];
  let connId = "";

  try {
    for (const [key, state] of [["up", "Uttar Pradesh"], ["hr", "Haryana"], ["br", "Bihar"]] as const) {
      const c = await db.company.create({ data: { name: `Zz Scope ${run} ${state}`, normalizedName: `zz scope ${run} ${state.toLowerCase()}`, createdById: admin.id }, select: { id: true } });
      companies[key] = c.id;
      await db.companyLocation.create({ data: { companyId: c.id, label: "Head office", city, state, isPrimary: true } });
    }
    const wb = await db.workbook.create({ data: { name: `Zz Scope list ${run}`, filters: { city: [city] }, ownerUserId: admin.id }, select: { id: true } });
    workbooks.push(wb.id);
    const tick = await db.workbookProperty.create({ data: { workbookId: wb.id, name: "Nominated for LC", kind: "CHECKBOX" }, select: { id: true } });
    const note = await db.workbookProperty.create({ data: { workbookId: wb.id, name: "Their note", kind: "TEXT", guestVisible: true, guestEditable: true, sortOrder: 1 }, select: { id: true } });
    for (const k of ["up", "hr"] as const) await db.workbookValue.create({ data: { workbookId: wb.id, propertyId: tick.id, companyId: companies[k], value: true } });

    const conn = await db.connection.create({ data: { name: `Zz Scope brand ${run}` }, select: { id: true } });
    connId = conn.id;
    const mk = (name: string) => db.guest.create({ data: { connectionId: conn.id, name: `Zz ${name}`, email: `zz.${name}.${run}@zz-s-${run}.example`, status: "ACTIVE", inviteExpiresAt: new Date(Date.now() + 86_400_000) }, select: { id: true, email: true } });
    const lc = await mk("lc");
    const plain = await mk("plain");
    await staff.shareListWithGuest({ workbookId: wb.id, guestId: lc.id });
    await staff.shareListWithGuest({ workbookId: wb.id, guestId: plain.id });
    const shareOf = async (guestId: string) => (await db.listShare.findUniqueOrThrow({ where: { workbookId_guestId: { workbookId: wb.id, guestId } }, select: { id: true } })).id;
    const lcShare = await shareOf(lc.id);
    const plainShare = await shareOf(plain.id);
    const seen = async (guestId: string, shareId: string) => ((await lists.guestListView(guestId, shareId))?.rows ?? []).map((r) => r.id).sort();
    const ids = (...k: ("up" | "hr" | "br")[]) => k.map((x) => companies[x]).sort();

    section("Neither: every row");
    ok("a guest with no tick column and no territory sees all three", JSON.stringify(await seen(lc.id, lcShare)) === JSON.stringify(ids("up", "hr", "br")));

    section("Only the accounts the sales team nominated");
    ok("a column that isn't a Checkbox can't narrow", !(await staff.setShareRows(lcShare, note.id)).ok);
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
      ok("somebody who can't edit the list can't narrow a share", !(await staff.setShareRows(lcShare, tick.id)).ok);
      ok("  nor set a guest's territory", !(await staff.setGuestTerritory(lc.id, ["Bihar"])).ok);
      actor = { id: admin.id, role: "ADMIN", name: admin.name, email: admin.email ?? actor.email };
    }
    ok("whoever built it can", (await staff.setShareRows(lcShare, tick.id)).ok);
    ok("  the LC guest sees only the two ticked", JSON.stringify(await seen(lc.id, lcShare)) === JSON.stringify(ids("up", "hr")));
    ok("  the count says two, too", (await lists.guestListView(lc.id, lcShare))?.total === 2);
    ok("  the other guest still sees all three", (await seen(plain.id, plainShare)).length === 3);
    const sharing = await staff.listSharing(wb.id);
    ok("  the Share dialog offers the Checkbox column and shows the choice", sharing.tickColumns.some((c) => c.id === tick.id) && !sharing.tickColumns.some((c) => c.id === note.id) && sharing.shares.find((s) => s.id === lcShare)?.onlyPropertyId === tick.id);

    section("And only in their territory");
    const t = await staff.setGuestTerritory(lc.id, ["uttar pradesh", "Uttar Pradesh", " "]);
    ok("a territory is saved, once a state, any case", t.ok && t.data.states.length === 1, t.ok ? t.data : t.error);
    ok("  ticked AND in Uttar Pradesh: one row", JSON.stringify(await seen(lc.id, lcShare)) === JSON.stringify(ids("up")));
    ok("  the guests page shows it", (await staff.connectOverview()).connections.flatMap((c) => c.guests).find((g) => g.id === lc.id)?.territory.length === 1);

    section("Outside it, as absent as outside the list");
    ok("no row page for a ticked company in another state", (await working.guestRowDetail(lc.id, lcShare, companies.hr)) === null);
    ok("  nor one never ticked", (await working.guestRowDetail(lc.id, lcShare, companies.br)) === null);
    ok("  the one inside opens", (await working.guestRowDetail(lc.id, lcShare, companies.up)) !== null);
    ok("no comment on it", !(await working.guestAddComment(lc.id, { shareId: lcShare, companyId: companies.hr, body: "x" })).ok);
    ok("no cell change on it", !(await lists.setGuestValue(lc.id, { shareId: lcShare, propertyId: note.id, companyId: companies.br, value: "x" })).ok);
    ok("  a cell inside changes", (await lists.setGuestValue(lc.id, { shareId: lcShare, propertyId: note.id, companyId: companies.up, value: "Meeting Tuesday" })).ok);
    ok("no correction on it", !(await working.guestSuggestCorrection(lc.id, { shareId: lcShare, companyId: companies.hr, note: "x" })).ok);

    section("An admin sees what they see");
    const activityBefore = await db.guestActivity.count({ where: { guestId: lc.id } });
    const pv = await staff.previewGuestList(lc.id, lcShare);
    ok("the same rows as the guest's own page", JSON.stringify((pv?.rows ?? []).map((r) => r.id).sort()) === JSON.stringify(await seen(lc.id, lcShare)) && pv?.total === 1);
    const who = await staff.previewGuest(lc.id);
    ok("  with their territory and lists", who?.territory.length === 1 && who.shares.some((x) => x.id === lcShare));
    ok("  a row inside opens, one outside doesn't", (await staff.previewGuestRow(lc.id, lcShare, companies.up)) !== null && (await staff.previewGuestRow(lc.id, lcShare, companies.hr)) === null);
    ok("  looking leaves nothing in their activity", (await db.guestActivity.count({ where: { guestId: lc.id } })) === activityBefore);
    if (other) {
      actor = { id: other.id, role: "ADMIN", name: other.name, email: other.email ?? "zz@example.invalid" };
      ok("somebody who doesn't manage guests sees nothing of it", (await staff.previewGuest(lc.id)) === null && (await staff.previewGuestList(lc.id, lcShare)) === null && (await staff.previewGuestRow(lc.id, lcShare, companies.up)) === null);
      actor = { id: admin.id, role: "ADMIN", name: admin.name, email: admin.email ?? actor.email };
    }

    section("Each share its own columns");
    const lcCol = await db.workbookProperty.create({ data: { workbookId: wb.id, name: "LC status", kind: "TEXT", guestVisible: true, guestEditable: true, sortOrder: 2 }, select: { id: true } });
    const colsOf = async () => ((await lists.guestListView(plain.id, plainShare))?.columns ?? []).map((c) => c.id).sort();
    ok("no choice made: every column marked for guests", JSON.stringify(await colsOf()) === JSON.stringify([note.id, lcCol.id].sort()));
    ok("a column not marked for guests can't be chosen", !(await staff.setShareColumns(plainShare, [tick.id])).ok);
    if (other) {
      actor = { id: other.id, role: "ADMIN", name: other.name, email: other.email ?? "zz@example.invalid" };
      ok("  nor by somebody who can't edit the list", !(await staff.setShareColumns(plainShare, [lcCol.id])).ok);
      actor = { id: admin.id, role: "ADMIN", name: admin.name, email: admin.email ?? actor.email };
    }
    ok("only LC status for this guest", (await staff.setShareColumns(plainShare, [lcCol.id])).ok && JSON.stringify(await colsOf()) === JSON.stringify([lcCol.id]));
    ok("  the other guest still has both", ((await lists.guestListView(lc.id, lcShare))?.columns ?? []).length === 2);
    ok("  a column not theirs takes no change", !(await lists.setGuestValue(plain.id, { shareId: plainShare, propertyId: note.id, companyId: companies.br, value: "x" })).ok);
    ok("  theirs does", (await lists.setGuestValue(plain.id, { shareId: plainShare, propertyId: lcCol.id, companyId: companies.br, value: "Customer informed" })).ok);
    ok("  the Share dialog shows the choice", JSON.stringify((await staff.listSharing(wb.id)).shares.find((x) => x.id === plainShare)?.columnIds) === JSON.stringify([lcCol.id]));
    const later = await db.workbookProperty.create({ data: { workbookId: wb.id, name: "Added later", kind: "TEXT", guestVisible: true, sortOrder: 3 }, select: { id: true } });
    ok("a guest column added later isn't shown to a share that chose", !(await colsOf()).includes(later.id));
    ok("back to every column", (await staff.setShareColumns(plainShare, null)).ok && (await colsOf()).length === 3);

    section("Emails only about rows they see");
    const before = sent.filter((s) => s.to === lc.email && s.kind === "comments").length;
    await review.addRowComment({ workbookId: wb.id, companyId: companies.br, body: "Bihar plan.", shared: true });
    ok("a comment on a Bihar row emails the other guest, not the LC guest", sent.some((s) => s.to === plain.email && s.kind === "comments") && sent.filter((s) => s.to === lc.email && s.kind === "comments").length === before);
    await review.addRowComment({ workbookId: wb.id, companyId: companies.up, body: "UP plan.", shared: true });
    ok("  one on their row does", sent.filter((s) => s.to === lc.email && s.kind === "comments").length === before + 1);

    section("Comments stay with their team");
    const notices = await import("../src/lib/connect/notices");
    const lcTeam = await db.connection.create({ data: { name: `Zz Scope LC ${run}` }, select: { id: true } });
    await db.guest.update({ where: { id: lc.id }, data: { connectionId: lcTeam.id } });
    const seenBy = async (guestId: string, shareId: string) => ((await working.guestRowDetail(guestId, shareId, companies.up))?.comments ?? []).map((c) => c.body);
    await working.guestAddComment(plain.id, { shareId: plainShare, companyId: companies.up, body: `Sales only ${run}` });
    ok("a guest's comment isn't seen by another team", !(await seenBy(lc.id, lcShare)).includes(`Sales only ${run}`) && (await seenBy(plain.id, plainShare)).includes(`Sales only ${run}`));
    const staffView = await review.rowComments(wb.id, companies.up);
    ok("  staff see it, with the guest's team", !!staffView?.comments.some((c) => c.body === `Sales only ${run}` && c.team === `Zz Scope brand ${run}`) && (staffView?.teams.length ?? 0) === 2);
    ok("a team that doesn't have the list can't be written to", !(await review.addRowComment({ workbookId: wb.id, companyId: companies.up, body: "x", shared: true, to: "nope" })).ok);
    ok("a staff comment to the LC team only", (await review.addRowComment({ workbookId: wb.id, companyId: companies.up, body: `LC only ${run}`, shared: true, to: lcTeam.id })).ok);
    ok("  the LC guest sees it, the sales guest doesn't", (await seenBy(lc.id, lcShare)).includes(`LC only ${run}`) && !(await seenBy(plain.id, plainShare)).includes(`LC only ${run}`));
    await review.addRowComment({ workbookId: wb.id, companyId: companies.up, body: `Everyone ${run}`, shared: true });
    ok("  one to every guest, both see", (await seenBy(lc.id, lcShare)).includes(`Everyone ${run}`) && (await seenBy(plain.id, plainShare)).includes(`Everyone ${run}`));
    const mailed = sent.length;
    await notices.noticeComment(wb.id, admin.name, undefined, new Date(Date.now() + 2 * 3_600_000), companies.up, lcTeam.id);
    const to = sent.slice(mailed).map((m) => m.to);
    ok("  a team comment's email goes to that team only", to.includes(lc.email) && !to.includes(plain.email), to);
    await db.guest.update({ where: { id: lc.id }, data: { connectionId: conn.id } });
    await db.connection.delete({ where: { id: lcTeam.id } });

    section("Unticked, or the column gone");
    await db.workbookValue.deleteMany({ where: { propertyId: tick.id, companyId: companies.up } });
    ok("unticked: gone from the LC guest's list", (await seen(lc.id, lcShare)).length === 0);
    await db.workbookValue.create({ data: { workbookId: wb.id, propertyId: tick.id, companyId: companies.up, value: true } });
    await db.workbookProperty.delete({ where: { id: tick.id } });
    ok("the tick column deleted: nothing — never everything", (await seen(lc.id, lcShare)).length === 0);
    ok("  the dialog says so", (await staff.listSharing(wb.id)).shares.find((s) => s.id === lcShare)?.onlyPropertyId === tick.id);
    await staff.setShareRows(lcShare, null);
    ok("back to every row, inside the territory", JSON.stringify(await seen(lc.id, lcShare)) === JSON.stringify(ids("up")));
    await staff.setGuestTerritory(lc.id, []);
    ok("  no territory: every state again", (await seen(lc.id, lcShare)).length === 3);
  } finally {
    if (connId) await db.connection.deleteMany({ where: { id: connId } });
    await db.workbook.deleteMany({ where: { id: { in: workbooks } } });
    const all = Object.values(companies).filter(Boolean);
    await db.companyLocation.deleteMany({ where: { companyId: { in: all } } });
    await db.company.deleteMany({ where: { id: { in: all } } });
  }

  console.log(failures === 0 ? `\nAll ${passes} Connect row-scope checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
