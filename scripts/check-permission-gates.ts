/**
 * The gates the owner asked for on 8 Oct 2026, after viewing the app as a calling agent:
 *
 *   · whose activity somebody sees — their own and their team's calls, notes and meetings, or
 *     everybody's with "See everyone's calls, notes & meetings";
 *   · the pro-rata tool reads a customer's subscriptions, so it takes "View orders";
 *   · a proposal, from anywhere, takes "Create proposals" — and so does the blank
 *     document form and every New button that opens it;
 *   · booking a meeting takes "Schedule meetings".
 *
 * Four probe people on one probe account: the rep who manages it, a junior who reports to the rep,
 * a peer outside the rep's team, and a manager. Each is given the permissions the checks rely on by
 * name, so a role an admin has configured in this database can't change the answers. Nothing here
 * issues a document or books a meeting for real — only refusals are exercised on those. Everything is
 * named ZZPROBE_GATES and removed in a finally.
 *
 *   npm run check:permission-gates
 */
import "dotenv/config";
import { replacedBy } from "../src/lib/documents/permission-keys";
const ISSUE = replacedBy("documents.issue");
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

let actorId = "";
class NotFound extends Error {}
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzprobe Gates", email: `actor${MAIL}` });
    return {
      requireUser: async () => user(),
      currentUser: async () => user(),
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new NotFound("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/companies",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_GATES";
const MAIL = "@zzprobe-gates.invalid";
/**
 * A module's own action refused because the module isn't open to the person — its section, its view permission or
 * the company's switch (`requireModuleAccess`, owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-6).
 */
async function notOpen(call: Promise<unknown>, module: string): Promise<boolean> {
  try {
    await call;
    return false;
  } catch (err) {
    return err instanceof Error && err.message === `${module} isn't open to you.`;
  }
}

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  const leads = await db.lead.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...companyIds, ...leads.map((l) => l.id)] } }, { userId: { in: userIds } }] } });
  await db.notification.deleteMany({ where: { userId: { in: userIds } } });
  await db.calendarEvent.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { userId: { in: userIds } }] } });
  await db.activity.deleteMany({ where: { leadId: { in: leads.map((l) => l.id) } } });
  await db.callLog.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.companyProduct.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.lead.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.contact.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.workbook.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.updateMany({ where: { id: { in: userIds } }, data: { managerId: null } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

/** Sets one person's own answer for a key — a person's grant beats their role's. */
async function grant(userId: string, permission: string, allowed: boolean) {
  await db.userPermission.upsert({
    where: { user_permission: { userId, permission } },
    create: { userId, permission, allowed, reason: TAG },
    update: { allowed },
  });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const companyActions = require("../src/actions/company") as typeof import("../src/actions/company");
  const leadActions = require("../src/actions/lead") as typeof import("../src/actions/lead");
  const callActions = require("../src/actions/call") as typeof import("../src/actions/call");
  const addonActions = require("../src/actions/addon") as typeof import("../src/actions/addon");
  const { createProposalFromAddonQuote } = require("../src/actions/addon-proposal") as typeof import("../src/actions/addon-proposal");
  const { createProposalFromRenewal } = require("../src/actions/renewal-proposal") as typeof import("../src/actions/renewal-proposal");
  const calendarActions = require("../src/actions/calendar") as typeof import("../src/actions/calendar");
  const { switchedOn } = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  const { meetingsForRecord } = require("../src/lib/calendar/listing") as typeof import("../src/lib/calendar/listing");
  const { CompanyDetail } = require("../src/components/companies/company-detail") as typeof import("../src/components/companies/company-detail");
  const { default: NewDocumentPage } = require("../src/app/(dashboard)/documents/new/page") as typeof import("../src/app/(dashboard)/documents/new/page");
  const { activityReport } = require("../src/actions/calling-activity") as typeof import("../src/actions/calling-activity");
  const { getResellerPriceForItem } = require("../src/actions/reseller") as typeof import("../src/actions/reseller");

  await cleanup();
  try {
    section("The fixture");
    const person = (key: string, role: "SALES" | "MANAGEMENT", managerId: string | null = null) =>
      db.user.create({ data: { name: `Zzprobe ${key}`, email: `${key.toLowerCase()}${MAIL}`, role, passwordHash: "x".repeat(60), managerId } });
    const rep = await person("Rep", "SALES");
    const junior = await person("Junior", "SALES", rep.id);
    const peer = await person("Peer", "SALES");
    const boss = await person("Boss", "MANAGEMENT");
    // What every check below stands on, whatever this database's roles say.
    for (const u of [rep, junior, peer, boss]) {
      for (const key of ["leads.view", "calls.view", "orders.view", "documents.view", "meetings.schedule", ...ISSUE]) await grant(u.id, key, true);
      await grant(u.id, "activities.viewAll", u.id === boss.id);
      if (u.id !== rep.id) await grant(u.id, "companies.viewAll", true);
    }

    const company = await db.company.create({
      data: { name: `${TAG} Account`, normalizedName: `${TAG} account`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
    });
    const location = await db.companyLocation.create({ data: { companyId: company.id, label: "Head Office", isPrimary: true } });
    const lead = await db.lead.create({ data: { companyId: company.id, title: `${TAG} Deal`, ownerUserId: rep.id, estimatedValue: 5000 } });
    for (const u of [rep, junior, peer]) {
      await db.activity.create({ data: { leadId: lead.id, userId: u.id, type: "NOTE", notes: `${u.name} note` } });
      await db.callLog.create({ data: { companyId: company.id, phoneNumber: "+919800000009", outcome: "CONNECTED", startedAt: new Date(), userId: u.id, notes: `${u.name} call` } });
    }
    const soon = new Date(Date.now() + 3 * 86_400_000);
    for (const u of [rep, peer]) {
      await db.calendarEvent.create({
        data: { userId: u.id, provider: "MICROSOFT", externalId: `${TAG}-${u.id}`, title: `${u.name} meeting`, startsAt: soon, endsAt: new Date(soon.getTime() + 3_600_000), isOrganizer: true, fromDeskzo: true, companyId: company.id },
      });
    }
    const item = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-1`, type: "SUBSCRIPTION", sellingPrice: 1000, createdById: rep.id } });
    const subscription = await db.companyProduct.create({
      data: {
        companyId: company.id,
        locationId: location.id,
        itemId: item.id,
        addedByUserId: rep.id,
        quantity: 5,
        unitPrice: 12000,
        fullTermUnitPrice: 12000,
        startDate: new Date(Date.now() - 30 * 86_400_000),
        endDate: new Date(Date.now() + 300 * 86_400_000),
      },
    });
    ok("a rep, their junior, a peer and a manager, on one account with a note, a call and a meeting each", true);

    const notesSeen = async () => ((await leadActions.getLead(lead.id))?.activities ?? []).map((a) => a.notes).sort();
    const companyNotesSeen = async () => ((await companyActions.getCompany(company.id))?.leads ?? []).flatMap((l) => l.activities.map((a) => a.notes)).sort();
    const callsSeen = async (userId?: string) => (await callActions.listCalls({ page: 1, pageSize: 50, search: "+919800000009", userId })).rows.map((r) => r.notes).sort();

    section("Whose activity: your own and your team's");
    actorId = rep.id;
    const repSees = ["Zzprobe Junior note", "Zzprobe Rep note"];
    ok("the rep reads their own and their junior's notes on the lead, not the peer's", JSON.stringify(await notesSeen()) === JSON.stringify(repSees), (await notesSeen()).join(", "));
    ok("  and the same on the customer's Activity", JSON.stringify(await companyNotesSeen()) === JSON.stringify(repSees), (await companyNotesSeen()).join(", "));
    ok("  their own and their junior's calls", JSON.stringify(await callsSeen()) === JSON.stringify(["Zzprobe Junior call", "Zzprobe Rep call"]), (await callsSeen()).join(", "));
    ok("  and picking the peer in the caller filter shows nothing, rather than the peer's calls", (await callsSeen(peer.id)).length === 0);
    ok("  the customer's Calls tab agrees", (await callActions.listCompanyCalls(company.id)).length === 2);
    ok("  so does the day's tally", (await callActions.callSummary()).total >= 2 && !(await callActions.listCallers()).some((c) => c.id === peer.id));
    ok("  the customer's Meetings: their own, not the peer's", (await meetingsForRecord(rep.id, { kind: "company", id: company.id })).map((m) => m.title).join() === "Zzprobe Rep meeting");

    actorId = junior.id;
    ok("the junior reads only their own — a manager's notes aren't the team's", JSON.stringify(await notesSeen()) === JSON.stringify(["Zzprobe Junior note"]), (await notesSeen()).join(", "));
    actorId = peer.id;
    ok("the peer reads only their own", JSON.stringify(await notesSeen()) === JSON.stringify(["Zzprobe Peer note"]) && JSON.stringify(await callsSeen()) === JSON.stringify(["Zzprobe Peer call"]));

    actorId = boss.id;
    ok("with \"See everyone's calls, notes & meetings\", all three", (await notesSeen()).length === 3 && (await companyNotesSeen()).length === 3 && (await callsSeen()).length === 3);
    ok("  and both meetings", (await meetingsForRecord(boss.id, { kind: "company", id: company.id })).length === 2);

    section("The pro-rata tool takes \"View orders\"");
    actorId = rep.id;
    ok("with it, the customer's subscription is listed and quoted", (await addonActions.addableSubscriptions(company.id)).length === 1 && (await addonActions.quoteAddon({ parentId: subscription.id, quantity: 1, startDate: new Date().toISOString().slice(0, 10) })) !== null);
    await grant(rep.id, "orders.view", false);
    ok("without it, nothing: no subscriptions, no quote, no subscription", (await addonActions.addableSubscriptions(company.id)).length === 0 && (await addonActions.quoteAddon({ parentId: subscription.id, quantity: 1, startDate: new Date().toISOString().slice(0, 10) })) === null && (await notOpen(addonActions.subscriptionWithAddons(subscription.id), "Renewals")));
    const blindProposal = await createProposalFromAddonQuote({ parentId: subscription.id, quantity: 1, startDate: new Date().toISOString().slice(0, 10) });
    ok("  and no proposal from it — answered as if it weren't there", !blindProposal.ok && /no longer exists/.test(blindProposal.ok ? "" : blindProposal.error));
    await grant(rep.id, "orders.view", true);

    section("A proposal takes \"Create proposals\"");
    await grant(rep.id, "docs.createProposal", false);
    const fromQuote = await createProposalFromAddonQuote({ parentId: subscription.id, quantity: 1, startDate: new Date().toISOString().slice(0, 10) });
    const fromRenewal = await createProposalFromRenewal({ companyProductId: subscription.id });
    ok("the pro-rata panel's Create proposal is refused", !fromQuote.ok && /create a proposal/.test(fromQuote.ok ? "" : fromQuote.error), fromQuote.ok ? "made one" : fromQuote.error);
    ok("  and so is a renewal's", !fromRenewal.ok && /create a proposal/.test(fromRenewal.ok ? "" : fromRenewal.error));
    ok("  and nothing was made", (await db.tradeDocument.count({ where: { companyId: company.id } })) === 0);
    const blankForm = await NewDocumentPage({ searchParams: Promise.resolve({ type: "PROPOSAL", companyId: company.id }) }).then(
      () => "rendered",
      (err: unknown) => (err instanceof NotFound ? "notFound" : String(err)),
    );
    ok("  the blank document form is the 404 page", blankForm === "notFound", blankForm);
    const withoutIssue = await renderHtml(CompanyDetail({ id: company.id, tab: "documents" }));
    ok("  the customer's Documents tab offers no New button", !withoutIssue.includes("/documents/new?type="));
    await grant(rep.id, "docs.createProposal", true);
    const withIssue = await renderHtml(CompanyDetail({ id: company.id, tab: "documents" }));
    ok("  which comes back with the permission", withIssue.includes("/documents/new?type="));

    section("Booking a meeting takes \"Schedule meetings\"");
    ok("the customer page offers Schedule meeting with it", !(await switchedOn("calendar")) || withIssue.includes("Schedule meeting"));
    await grant(rep.id, "meetings.schedule", false);
    const noButton = await renderHtml(CompanyDetail({ id: company.id, tab: "documents" }));
    ok("  and not without it", !noButton.includes("Schedule meeting"));
    if (await switchedOn("calendar")) {
      const refused = await calendarActions.scheduleMeetingAction({ record: { kind: "company", id: company.id }, title: "x", startsAt: "2099-01-01T10:00", durationMinutes: 30, online: true });
      const form = await calendarActions.meetingFormFor({ record: { kind: "company", id: company.id } });
      ok("  booking one is refused, and so is its dialog", !refused.ok && /permission to schedule/.test(refused.ok ? "" : refused.error) && !form.ok, refused.ok ? "booked" : refused.error);
    } else {
      ok("  (Calendar is switched off in this workspace, so the actions answer that first — not checked)", true);
    }
    await grant(rep.id, "meetings.schedule", true);

    // Phase 2 permission fixes (owner, 3 Nov 2026 — audit L-2): two reads only a page or a form called, with no check of
    // their own, answer only what that page or form would show.
    section("A calling campaign's report is for whoever may open the list");
    const campaign = await db.workbook.create({ data: { name: `${TAG} Campaign`, filters: {}, ownerUserId: rep.id, shared: false, mode: "COLD_CALLING", startedAt: new Date() } });
    for (const u of [rep, peer]) await grant(u.id, "workspace.manageAny", false);
    await grant(boss.id, "workspace.manageAny", true);
    actorId = rep.id;
    ok("its owner reads it", (await activityReport(campaign.id))?.workbook.id === campaign.id);
    actorId = peer.id;
    ok("  somebody it isn't shared with gets nothing, as if it weren't there", (await activityReport(campaign.id)) === null);
    actorId = boss.id;
    ok("  with \"Manage any workspace list\", read again", (await activityReport(campaign.id))?.workbook.id === campaign.id);

    section("A reseller's price is for whoever may see the reseller");
    // The peer's own reseller: outside the rep's team, and the rep doesn't see every account.
    const reseller = await db.company.create({
      data: { name: `${TAG} Reseller`, normalizedName: `${TAG} reseller`.toLowerCase(), createdById: peer.id, ownerUserId: peer.id, relationshipType: "RESELLER", resellerProfile: { create: { discountPercent: 10 } } },
    });
    actorId = peer.id;
    const priced = await getResellerPriceForItem(reseller.id, item.id);
    ok("whoever sees the reseller gets its price for an item", priced?.catalogPrice === 1000 && priced?.discountPercent === 10, JSON.stringify(priced));
    actorId = rep.id;
    ok("  somebody who doesn't gets nothing, as for a reseller that isn't there", (await getResellerPriceForItem(reseller.id, item.id)) === null);
  } finally {
    await cleanup();
    const left = await db.user.count({ where: { email: { endsWith: MAIL } } });
    ok("nothing of the fixture is left behind", left === 0 && (await db.company.count({ where: { name: { startsWith: TAG } } })) === 0);
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll permission-gate checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
