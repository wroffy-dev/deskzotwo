/**
 * check:connect-plan — Deskzo Connect as an add-on, and its activity report (owner, 20 Nov 2026 — phase 4:
 * "₹999/mo per 10 guests", "3 guests in Deskzo One"; src/lib/platform/entitlements.ts `connectGuestsFrom`,
 * src/lib/connect/activity.ts, src/actions/connect.ts `guestActivityReport`).
 *
 *   · The allowance: 10 active guests a unit of the add-on, 3 on Deskzo One (its trial too), no limit on an internal
 *     plan, none on any other — and read back from a workspace's cached entitlements as it was written.
 *   · Who counts: signed in or invited and still able to; never a stopped guest, one whose access is over, or an
 *     invitation that ran out.
 *   · The refusals say what to do: add it, or add 10 more.
 *   · The catalogue sells it at ₹999 a month, ₹9,990 a year, for the workspace.
 *   · What guests do is recorded, and the report counts it.
 *
 * Against the local database, as its super admin; everything made is removed.
 *
 *   npm run check:connect-plan
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "ADMIN", name: "Zz Plan", email: "zz-plan@example.invalid" };
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
  const ent = await import("../src/lib/platform/entitlements");
  const parse = await import("../src/lib/entitlements");
  const act = await import("../src/lib/connect/activity");
  const catalogue = await import("../src/lib/platform/product-plans");
  const book = await import("../src/lib/platform/price-book");

  section("The allowance");
  const plan = (key: string, kind: "EDITION" | "ADDON" | "INTERNAL", allModules = false) => ({ key, kind, allModules });
  ok("one unit of the add-on: 10", ent.connectGuestsFrom([{ quantity: 1, plan: plan("addon-connect", "ADDON") }]) === 10);
  ok("  two units: 20", ent.connectGuestsFrom([{ quantity: 2, plan: plan("addon-connect", "ADDON") }]) === 20);
  ok("Deskzo One alone: 3", ent.connectGuestsFrom([{ quantity: 5, plan: plan("deskzo-one", "EDITION", true) }]) === 3);
  ok("  One and a unit: 13", ent.connectGuestsFrom([{ quantity: 1, plan: plan("deskzo-one", "EDITION", true) }, { quantity: 1, plan: plan("addon-connect", "ADDON") }]) === 13);
  ok("another product alone: none", ent.connectGuestsFrom([{ quantity: 1, plan: plan("deskzo-crm", "EDITION") }]) === 0);
  ok("an internal plan: no limit", ent.connectGuestsFrom([{ quantity: 1, plan: plan("internal-everything", "INTERNAL", true) }]) === null);
  const worked = ent.entitlementsFrom(
    { country: "IN", seatOverride: null, copilotTokenOverride: null, customDomainOverride: null, automationWorkflowOverride: null, automationStepOverride: null, automationHistoryOverride: null, automationConnectorOverride: null },
    [{ quantity: 1, plan: { ...plan("deskzo-crm", "EDITION"), seats: null, copilotTokens: null, customDomains: 0, modules: [] } }, { quantity: 1, plan: { ...plan("addon-connect", "ADDON"), seats: null, copilotTokens: null, customDomains: null, modules: [] } }],
    [],
  );
  ok("a workspace's entitlements carry it", worked.connectGuests === 10, worked.connectGuests);
  ok("  read back as written", parse.parseEntitlements(JSON.parse(JSON.stringify(worked))).connectGuests === 10);
  ok("  a cached answer from before has none — no limit until worked out again", parse.parseEntitlements({ ...worked, connectGuests: undefined }).connectGuests === undefined);
  ok("  a malformed one is dropped", parse.parseEntitlements({ ...worked, connectGuests: -3 }).connectGuests === undefined);

  section("The refusals");
  ok("not in the plan: says how to add it", /isn't in your plan/.test(act.allowanceRefusal({ limit: 0, used: 0 }) ?? ""));
  ok("full: says how many, and to add 10 more", /room for 10 active guests, and 10 are in/.test(act.allowanceRefusal({ limit: 10, used: 10 }) ?? ""));
  ok("room left, or no limit: nothing", act.allowanceRefusal({ limit: 10, used: 9 }) === null && act.allowanceRefusal({ limit: null, used: 99 }) === null);

  section("For sale");
  const addOn = catalogue.productCatalogue().find((p) => p.key === "addon-connect");
  ok("the catalogue makes the add-on, for no module of its own", addOn?.kind === "ADDON" && addOn.modules.length === 0 && addOn.countries.length === 0);
  const price = book.INDIA_LAUNCH_PRICES.find((p) => p.planKey === "addon-connect");
  ok("  priced at ₹999 a month, ₹9,990 a year, for the workspace", price?.month === 999 && price.year === 9990 && price.perSeat === false, price);

  const db = directClient();
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true } });
  if (!admin) throw new Error("No super admin in the local database.");
  actor = { id: admin.id, role: "ADMIN", name: admin.name, email: admin.email ?? actor.email };
  const run = Date.now().toString(36);
  let connId = "";
  const workbooks: string[] = [];
  const companies: string[] = [];

  try {
    section("Who counts");
    const conn = await db.connection.create({ data: { name: `Zz Plan ${run}` }, select: { id: true } });
    connId = conn.id;
    const before = await db.guest.count({ where: act.countsWhere() });
    const day = 86_400_000;
    const mk = (name: string, data: object) => db.guest.create({ data: { connectionId: conn.id, name, email: `zz.${name}.${run}@zz-plan-${run}.example`, inviteExpiresAt: new Date(Date.now() + day), ...data }, select: { id: true } });
    const active = await mk("active", { status: "ACTIVE" });
    await mk("invited", { status: "INVITED" });
    await mk("ranout", { status: "INVITED", inviteExpiresAt: new Date(Date.now() - day) });
    await mk("stopped", { status: "SUSPENDED" });
    await mk("ended", { status: "ACTIVE", accessUntil: new Date(Date.now() - day) });
    await mk("signedthenran", { status: "ACTIVE", inviteExpiresAt: new Date(Date.now() - day) });
    const after = await db.guest.count({ where: act.countsWhere() });
    ok("signed in, or invited and still able to, count; stopped, ended and run-out ones don't", after - before === 3, after - before);

    section("Activity");
    const lists = await import("../src/lib/connect/guest-lists");
    const working = await import("../src/lib/connect/working");
    const city = `Zzpcity${run}`;
    const c = await db.company.create({ data: { name: `Zz Plan ${run} Co`, normalizedName: `zz plan ${run} co`, createdById: admin.id }, select: { id: true } });
    companies.push(c.id);
    await db.companyLocation.create({ data: { companyId: c.id, label: "Head office", city, isPrimary: true } });
    const wb = await db.workbook.create({ data: { name: `Zz Plan list ${run}`, filters: { city: [city] }, ownerUserId: admin.id }, select: { id: true } });
    workbooks.push(wb.id);
    const prop = await db.workbookProperty.create({ data: { workbookId: wb.id, name: "Next", kind: "TEXT", guestVisible: true, guestEditable: true }, select: { id: true } });
    const share = await db.listShare.create({ data: { workbookId: wb.id, guestId: active.id }, select: { id: true } });
    await lists.setGuestValue(active.id, { shareId: share.id, propertyId: prop.id, companyId: c.id, value: "Call Tuesday" });
    await lists.setGuestValue(active.id, { shareId: share.id, propertyId: prop.id, companyId: c.id, value: "Called" });
    await working.guestAddComment(active.id, { shareId: share.id, companyId: c.id, body: "Done." });
    await working.guestSuggestCompany(active.id, { shareId: share.id, name: `Zz Plan ${run} New`, note: "Fits." });
    await lists.setGuestValue(active.id, { shareId: share.id, propertyId: prop.id, companyId: "nope", value: "x" });
    const kinds = await db.guestActivity.groupBy({ by: ["kind"], where: { guestId: active.id }, _count: { _all: true } });
    const n = (k: string) => kinds.find((x) => x.kind === k)?._count._all ?? 0;
    ok("each change, comment and suggestion is recorded — a refused change isn't", n("EDIT") === 2 && n("COMMENT") === 1 && n("SUGGEST") === 1, kinds);
    const report = await (await import("../src/actions/connect")).guestActivityReport(30);
    const row = report?.guests.find((g) => g.id === active.id);
    ok("the report counts them by guest", row?.edits === 2 && row.comments === 1 && row.suggested === 1 && row.lists.includes(`Zz Plan list ${run}`), row);
    const listRow = report?.lists.find((l) => l.id === wb.id);
    ok("  and by list", listRow?.edits === 2 && listRow.guests === 1, listRow);
  } finally {
    if (connId) await db.connection.deleteMany({ where: { id: connId } });
    await db.workbook.deleteMany({ where: { id: { in: workbooks } } });
    await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
  }

  console.log(failures === 0 ? `\nAll ${passes} Connect plan checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
