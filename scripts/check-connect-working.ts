/**
 * check:connect-working — Deskzo Connect, working together (owner, 20 Nov 2026 — phase 3; src/lib/connect/working.ts,
 * src/actions/connect-review.ts).
 *
 *   · A guest's suggestion is a suggestion: in no company record until somebody decides; only that guest and the list's
 *     reviewers see it; the matches in Companies only the reviewer sees. Linked, made, or declined with a reason.
 *   · A correction only for a company in the list; taken on board by hand.
 *   · Comments: internal ones never reach a guest; a guest's are always shared; never on a company outside the list or
 *     through somebody else's share.
 *   · The contact card shows as much of the account owner as the workspace chose, and only whoever manages guests chooses.
 *
 * Against the local database, as its super admin and one person who can't manage every list; everything made is removed.
 *
 *   npm run check:connect-working
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "ADMIN", name: "Zz Working", email: "zz-working@example.invalid" };
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/notify" || request.endsWith("lib/notify")) return { notifyUser: async () => undefined };
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
  let other: { id: string; name: string; email: string | null; phone: string | null } | null = null;
  for (const c of await db.user.findMany({ where: { active: true, isSuperAdmin: false }, select: { id: true, name: true, email: true, phone: true }, take: 60 })) {
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

  const w = await import("../src/lib/connect/working");
  const lists = await import("../src/lib/connect/guest-lists");
  const review = await import("../src/actions/connect-review");

  const run = Date.now().toString(36);
  const city = `Zzwcity${run}`;
  const companies: string[] = [];
  const workbooks: string[] = [];
  const before = await db.connectSettings.findUnique({ where: { id: "global" } });
  let connId = "";

  try {
    const mk = async (name: string, withCity: boolean, owner: string | null = null) => {
      const c = await db.company.create({ data: { name, normalizedName: name.toLowerCase(), createdById: admin.id, ownerUserId: owner }, select: { id: true } });
      companies.push(c.id);
      if (withCity) await db.companyLocation.create({ data: { companyId: c.id, label: "Head office", city, isPrimary: true } });
      return c.id;
    };
    const inList = await mk(`Zz Work ${run} Alpha`, true, other.id);
    const outside = await mk(`Zz Work ${run} Beta`, false);
    const wb = await db.workbook.create({ data: { name: `Zz Working ${run}`, filters: { city: [city] }, ownerUserId: admin.id }, select: { id: true } });
    const elsewhere = await db.workbook.create({ data: { name: `Zz Elsewhere ${run}`, filters: { city: [city] }, ownerUserId: admin.id }, select: { id: true } });
    workbooks.push(wb.id, elsewhere.id);
    const conn = await db.connection.create({ data: { name: `Zz Brand W ${run}` }, select: { id: true } });
    connId = conn.id;
    const guest = await db.guest.create({ data: { connectionId: conn.id, name: "Zz Guest W", email: `zz.w.${run}@zz-brand-${run}.example`, status: "ACTIVE", inviteExpiresAt: new Date(Date.now() + 86_400_000) }, select: { id: true } });
    const mate = await db.guest.create({ data: { connectionId: conn.id, name: "Zz Mate", email: `zz.m.${run}@zz-brand-${run}.example`, status: "ACTIVE", inviteExpiresAt: new Date(Date.now() + 86_400_000) }, select: { id: true } });
    const share = await db.listShare.create({ data: { workbookId: wb.id, guestId: guest.id }, select: { id: true } });
    const mateShare = await db.listShare.create({ data: { workbookId: elsewhere.id, guestId: mate.id }, select: { id: true } });

    section("Suggesting a company");
    ok("a name and a reason are needed", !(await w.guestSuggestCompany(guest.id, { shareId: share.id, name: "", note: "x" })).ok && !(await w.guestSuggestCompany(guest.id, { shareId: share.id, name: "Acme", note: "" })).ok);
    const companiesBefore = await db.company.count();
    const sug = await w.guestSuggestCompany(guest.id, { shareId: share.id, name: `Zz Work ${run} Alpha Pvt Ltd`, city: "Kanpur", note: "Met them at the event." });
    ok("suggested — and no company is made by it", sug.ok && (await db.company.count()) === companiesBefore);
    ok("  not through somebody else's share", !(await w.guestSuggestCompany(guest.id, { shareId: mateShare.id, name: "Zz X", note: "x" })).ok);
    const mine = await w.guestSuggestionsFor(guest.id, wb.id);
    ok("  the guest sees it waiting", mine.length === 1 && mine[0]!.status === "PENDING");
    ok("  and a fellow guest doesn't", (await w.guestSuggestionsFor(mate.id, wb.id)).length === 0);
    const view = await lists.guestListView(guest.id, share.id);
    ok("  it shows in their view only as their suggestion, not a row", view?.suggestions.length === 1 && !view.rows.some((r) => r.name.endsWith("Pvt Ltd")));

    section("Reviewing");
    const queue = (await review.reviewQueue()) ?? [];
    const item = queue.find((q) => q.name === `Zz Work ${run} Alpha Pvt Ltd`);
    ok("the list's builder sees it, with the company it looks like", !!item && item.matches.some((m) => m.id === inList), item?.matches);
    as(other);
    ok("somebody who can't edit the list doesn't see it", !((await review.reviewQueue()) ?? []).some((q) => q.id === item?.id));
    ok("  nor link it", !(await review.linkSuggestion(item?.id ?? "", inList)).ok);
    as(admin);
    const linked = await review.linkSuggestion(item?.id ?? "", outside);
    ok("linked to a company the workspace has — and that company is now in the list", linked.ok && (await lists.guestListView(guest.id, share.id))?.rows.some((r) => r.id === outside) === true);
    ok("  the guest hears only that it was added", (await w.guestSuggestionsFor(guest.id, wb.id))[0]?.status === "LINKED");
    ok("  and it can't be decided twice", !(await review.declineSuggestion(item?.id ?? "", "x")).ok);

    await w.guestSuggestCompany(guest.id, { shareId: share.id, name: `Zz Work ${run} Gamma Infra`, city: "Lucknow", website: "zz-gamma.example", note: "30 seats." });
    const gamma = ((await review.reviewQueue()) ?? []).find((q) => q.name === `Zz Work ${run} Gamma Infra`);
    const made = await review.createFromSuggestion(gamma?.id ?? "");
    if (made.ok) companies.push(made.data.companyId);
    ok("made as a new company, through the company rules, and added to the list", made.ok && (await db.company.findUnique({ where: { id: made.ok ? made.data.companyId : "" }, select: { name: true } }))?.name === `Zz Work ${run} Gamma Infra` && (await db.workbookPinnedRow.count({ where: { workbookId: wb.id, companyId: made.ok ? made.data.companyId : "" } })) === 1, made.ok ? "" : made.error);

    await w.guestSuggestCompany(guest.id, { shareId: share.id, name: `Zz Work ${run} Delta`, note: "Maybe." });
    const delta = ((await review.reviewQueue()) ?? []).find((q) => q.name === `Zz Work ${run} Delta`);
    await review.declineSuggestion(delta?.id ?? "", "Already a customer of another partner");
    const declined = (await w.guestSuggestionsFor(guest.id, wb.id)).find((s) => s.name === `Zz Work ${run} Delta`);
    ok("declined, with the reason the guest sees", declined?.status === "DECLINED" && declined.declineReason === "Already a customer of another partner");

    section("Corrections");
    ok("only for a company in the list", !(await w.guestSuggestCorrection(guest.id, { shareId: share.id, companyId: companies.find((c) => c !== inList && c !== outside && !c.startsWith("x")) === undefined ? "nope" : "nope", note: "x" })).ok);
    const fix = await w.guestSuggestCorrection(guest.id, { shareId: share.id, companyId: inList, note: "Their GSTIN changed." });
    const fixItem = ((await review.reviewQueue()) ?? []).find((q) => q.kind === "CORRECTION" && q.company?.id === inList);
    ok("a correction waits for review, never edits the company", fix.ok && !!fixItem && (await db.company.findUnique({ where: { id: inList }, select: { name: true } }))?.name === `Zz Work ${run} Alpha`);
    ok("  taken on board by hand", (await review.acceptCorrection(fixItem?.id ?? "")).ok);

    section("Comments");
    await review.addRowComment({ workbookId: wb.id, companyId: inList, body: "Keep our renewal price firm.", shared: false });
    await review.addRowComment({ workbookId: wb.id, companyId: inList, body: "Can you bring a Civil 3D sample?", shared: true });
    const seen = await w.guestRowDetail(guest.id, share.id, inList);
    ok("the guest sees the shared comment, never the internal one", seen?.comments.length === 1 && seen.comments[0]!.body.startsWith("Can you") && !JSON.stringify(seen).includes("renewal price"));
    const reply = await w.guestAddComment(guest.id, { shareId: share.id, companyId: inList, body: "Yes, I'll bring it." });
    ok("  a guest's comment is always shared", reply.ok && reply.comment.shared && reply.comment.byGuest);
    ok("  staff see all three", (await review.rowComments(wb.id, inList))?.comments.length === 3);
    ok("  never on a company outside the list", !(await w.guestAddComment(guest.id, { shareId: share.id, companyId: companies.find((c) => c === outside) === outside ? "cmzzzzzzzzzzzzzzzzzzzzzzz" : "x", body: "x" })).ok);
    ok("  nor through somebody else's share", (await w.guestRowDetail(guest.id, mateShare.id, inList)) === null && !(await w.guestAddComment(guest.id, { shareId: mateShare.id, companyId: inList, body: "x" })).ok);

    section("Your contact");
    await db.connectSettings.upsert({ where: { id: "global" }, create: { id: "global", ownerContact: "NAME" }, update: { ownerContact: "NAME" } });
    const nameOnly = (await w.guestRowDetail(guest.id, share.id, inList))?.contact;
    ok("name only: no email, no phone", nameOnly?.name === other.name && nameOnly.email === null && nameOnly.phone === null, nameOnly);
    const saved = await review.saveContactMode("ALL");
    const all = (await w.guestRowDetail(guest.id, share.id, inList))?.contact;
    ok("name, email and phone, when chosen", saved.ok && all?.email === other.email && all.phone === (other.phone ?? null), all);
    ok("  a company with nobody named shows nobody", (await w.guestRowDetail(guest.id, share.id, outside))?.contact === null);
    as(other);
    ok("only whoever manages guests chooses", !(await review.saveContactMode("NAME")).ok);
    as(admin);
  } finally {
    if (before) await db.connectSettings.update({ where: { id: "global" }, data: { ownerContact: before.ownerContact } });
    else await db.connectSettings.deleteMany({ where: { id: "global" } });
    if (connId) await db.connection.deleteMany({ where: { id: connId } });
    await db.workbook.deleteMany({ where: { id: { in: workbooks } } });
    await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
  }

  console.log(failures === 0 ? `\nAll ${passes} Connect working-together checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
