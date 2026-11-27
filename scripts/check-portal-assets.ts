/**
 * A customer's machines in their portal (owner, 15 Nov 2026 — src/lib/portal/assets.ts): shown only where Settings ›
 * Customer portal › "Hardware and warranties" is on; theirs and ours at their site, never another company's, never a
 * retired one, never a cost or licence key; and from a machine a problem (a ticket on it), a change or more cover —
 * each refused for a machine that isn't theirs.
 *
 *   npx tsx scripts/check-portal-assets.ts
 *
 * Builds two companies of its own under a reserved prefix, and puts the portal settings back exactly as found.
 */
import Module from "node:module";
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";

const internals = Module as unknown as { _load(r: string, parent: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};
import { portalAssets, raisePortalAssetRequest } from "../src/actions/portal-public";
import { moduleAvailableForTenant } from "../src/lib/modules-access";

const PREFIX = "ZZPortalAsset";
let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
}

const BASE = {
  enabled: true,
  access: "SELECTED" as const,
  showSubscriptions: true,
  showInvoices: false,
  showPayments: false,
  showTickets: true,
  showAssets: true,
  showContacts: false,
  allowRenewalRequest: true,
  allowSeatRequest: true,
  allowQuestion: true,
  linkValidityDays: null,
};

async function main() {
  if (!(await moduleAvailableForTenant("it_assets"))) {
    console.log("IT Assets isn't in this workspace's plan — nothing to check.");
    return;
  }
  const stamp = Date.now();
  const settingsBefore = await db.portalSettings.findUnique({ where: { id: "global" } });
  const user = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!user) throw new Error("Seed the app first — this needs a user.");
  const company = (name: string) =>
    db.company.create({
      data: { name: `${PREFIX} ${name} ${stamp}`, normalizedName: `${PREFIX.toLowerCase()} ${name.toLowerCase()} ${stamp}`, relationshipType: "CLIENT", portalEnabled: true, createdById: user.id },
      select: { id: true },
    });
  const mine = await company("Mine");
  const other = await company("Other");
  const tag = (n: string) => `${PREFIX}-${stamp}-${n}`;
  const made: string[] = [];
  try {
    const asset = async (n: string, data: Record<string, unknown>) => {
      const a = await db.asset.create({ data: { assetTag: tag(n), name: `Laptop ${n}`, status: "INSTALLED", createdById: user.id, ...data } as never, select: { id: true } });
      made.push(a.id);
      return a.id;
    };
    const theirs = await asset("theirs", { ownership: "CLIENT_OWNED", ownerCompanyId: mine.id, warrantyEndsOn: new Date(Date.now() + 20 * 86_400_000), purchaseCost: 99999, licenceKey: "SECRET-KEY", notes: "internal note" });
    const oursThere = await asset("ours", { ownership: "DEPLOYED", siteCompanyId: mine.id, amcEndsOn: new Date("2027-06-30") });
    const retired = await asset("retired", { ownership: "CLIENT_OWNED", ownerCompanyId: mine.id, status: "RETIRED" });
    const otherOne = await asset("other", { ownership: "CLIENT_OWNED", ownerCompanyId: other.id });

    const token = randomBytes(24).toString("base64url");
    await db.portalLogin.create({ data: { token, companyId: mine.id, personName: "Priya Sharma", createdById: user.id } });
    const setSettings = (over: Partial<typeof BASE>) => {
      const data = { ...BASE, ...over };
      return db.portalSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
    };

    await setSettings({ showAssets: false });
    ok("with Hardware and warranties off, no machines", (await portalAssets(token)).length === 0);
    ok("  and no request about one", !(await raisePortalAssetRequest(token, { assetId: theirs, kind: "change", message: "moved" })).ok);

    await setSettings({});
    const list = await portalAssets(token);
    const ids = list.map((a) => a.id);
    ok("theirs and ours at their site are shown", ids.includes(theirs) && ids.includes(oursThere), ids.length);
    ok("  a retired one isn't", !ids.includes(retired));
    ok("  nor another company's", !ids.includes(otherOne));
    ok("  ours is said to be ours, theirs isn't", list.find((a) => a.id === oursThere)?.ours === true && list.find((a) => a.id === theirs)?.ours === false);
    const sent = JSON.stringify(list);
    ok("no cost, licence key or internal note leaves the server", !sent.includes("99999") && !sent.includes("SECRET-KEY") && !sent.includes("internal note"));

    const problem = await raisePortalAssetRequest(token, { assetId: theirs, kind: "problem", message: "Won't turn on" });
    const helpdesk = await moduleAvailableForTenant("helpdesk");
    if (helpdesk) {
      ok("a problem opens a ticket on the machine", problem.ok && !!problem.data.ticket, problem);
      const ticket = await db.ticket.findFirst({ where: { companyId: mine.id, assetId: theirs }, select: { title: true, description: true } });
      ok("  titled with the machine, the words and who asked in it", !!ticket?.title.includes(tag("theirs")) && !!ticket?.description?.includes("Won't turn on") && !!ticket?.description?.includes("Priya Sharma"), ticket);
    } else {
      ok("without Tickets, a problem is a request", problem.ok && problem.data.ticket === null);
    }
    const change = await raisePortalAssetRequest(token, { assetId: oursThere, kind: "change", message: "Moved to Gurugram" });
    ok("a change is a request about the machine", change.ok && (await db.portalRequest.count({ where: { companyId: mine.id, kind: "ASSET_CHANGE", assetId: oursThere } })) === 1, change);
    const cover = await raisePortalAssetRequest(token, { assetId: theirs, kind: "cover" });
    ok("more cover needs no words", cover.ok && (await db.portalRequest.count({ where: { companyId: mine.id, kind: "ASSET_COVER", assetId: theirs } })) === 1, cover);
    ok("a problem or a change needs words", !(await raisePortalAssetRequest(token, { assetId: theirs, kind: "change", message: " " })).ok);
    ok("another company's machine is refused", !(await raisePortalAssetRequest(token, { assetId: otherOne, kind: "cover" })).ok);
    ok("  so is a retired one", !(await raisePortalAssetRequest(token, { assetId: retired, kind: "cover" })).ok);
    ok("  and a made-up kind", !(await raisePortalAssetRequest(token, { assetId: theirs, kind: "delete" as never })).ok);
    ok("a bad link sees nothing", (await portalAssets("not-a-real-token-at-all-really")).length === 0);

    // Security review, 15 Nov 2026 (ADV-03): requests fired at once can't get past the link's day.
    const burst = await Promise.all(Array.from({ length: 30 }, () => raisePortalAssetRequest(token, { assetId: oursThere, kind: "cover" })));
    const rows = await db.portalRequest.count({ where: { loginId: (await db.portalLogin.findFirstOrThrow({ where: { companyId: mine.id }, select: { id: true } })).id } });
    ok("30 at once: never more than 20 requests in a day for the link", rows <= 20 && burst.some((b) => !b.ok), { rows, refused: burst.filter((b) => !b.ok).length });
  } finally {
    await db.portalRequest.deleteMany({ where: { companyId: { in: [mine.id, other.id] } } });
    await db.ticket.deleteMany({ where: { companyId: { in: [mine.id, other.id] } } });
    await db.portalLogin.deleteMany({ where: { companyId: { in: [mine.id, other.id] } } });
    await db.asset.deleteMany({ where: { id: { in: made } } });
    await db.company.deleteMany({ where: { id: { in: [mine.id, other.id] } } });
    if (settingsBefore) {
      const { id: _id, updatedAt: _updatedAt, ...restore } = settingsBefore;
      await db.portalSettings.upsert({ where: { id: "global" }, create: { id: "global", ...restore }, update: restore });
    } else {
      await db.portalSettings.deleteMany({ where: { id: "global" } });
    }
  }
  console.log(failures === 0 ? "\nAll portal asset checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
