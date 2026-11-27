/**
 * check:order-scope — the three ways an order is raised, held to the same lines (owner, 2 Oct 2026):
 * punched (`createOrder`), seats added to a running subscription (`createAddon`), and a renewal
 * (`createRenewalOrder`).
 *
 *   · each only for an account the person could open — seats and renewals used to take any id, so a
 *     salesperson could add seats to, or renew, a customer outside their book; an account out of scope
 *     answers exactly as a missing one does;
 *   · each refused for a reseller whose onboarding isn't signed off (src/lib/orders/reseller-gate.ts);
 *   · seats and renewals audited as orders, as every other order is;
 *   · and the company page offers "Add seats" only to whom `createAddon` will let add them.
 *
 * And the actions on an order once it is there (owner, 2 Nov 2026 — "Phase 1 security fixes", audit M-6): each asks
 * the Orders record level for what it does, not only the account. Somebody who sees every account but only their own
 * orders can't cancel, process, re-price, hand off, approve a loss on, re-register, reveal, edit, re-customer or
 * settle anybody else's order, nor download its file or pick it to apply a payment to — and the payments picker never
 * carries an order's cost.
 *
 * Nor put money on one (owner, 3 Nov 2026 — "Phase 2 permission fixes", audit M-6 follow-up): recording a payment onto an
 * order and allocating one to it ask the order's Orders level for view — the level the picker lists by — and an order out
 * of reach answers as a made-up id does.
 *
 * Builds a scratch workspace database beside the real one (as check:custom-fields does), drives the real
 * actions as a workspace pointed at it (`runAsTenant`), and drops it at the end, pass or fail.
 *
 *   npm run check:order-scope
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { indiaClock } from "../src/lib/time/zone";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZSCOPE";
const MISSING = "That subscription no longer exists.";

// ── Who the actions think is calling ────────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
  UnauthorizedError,
};
const navigation = {
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/companies",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const email = { sendEmailNotification: async () => {} };
const viewMode = { getViewMode: async () => "list" as const, setViewMode: async () => {} };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["@/lib/email", email],
  ["@/actions/view-mode", viewMode],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/email"), email],
  [load.resolve("../src/actions/view-mode"), viewMode],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

/** A calendar day `days` after `key`, as a `@db.Date`-style value (midnight UTC of that day). */
const dayFrom = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00.000Z`) + days * 86_400_000);

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_orderscope`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);

  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    /* eslint-enable @typescript-eslint/no-require-imports */
    await run(scratchUrl);
  } finally {
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its companies and orders are as they were", realAfter.counts === realBefore.counts, realAfter.counts);
  ok("  and nothing of this suite's is in it", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} order-scope checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient) {
  const [companies, orders, tagged] = await Promise.all([
    client.company.count(),
    client.companyProduct.count(),
    client.company.count({ where: { name: { startsWith: TAG } } }),
  ]);
  return { counts: JSON.stringify({ companies, orders }), tagged };
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const addons = require("../src/actions/addon") as typeof import("../src/actions/addon");
  const renewals = require("../src/actions/renewal-order") as typeof import("../src/actions/renewal-order");
  const orders = require("../src/actions/order") as typeof import("../src/actions/order");
  const { CompanyDetail } = require("../src/components/companies/company-detail") as typeof import("../src/components/companies/company-detail");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const payments = require("../src/actions/payment") as typeof import("../src/actions/payment");
  const fileRoute = require("../src/app/api/custom-fields/files/[id]/route") as typeof import("../src/app/api/custom-fields/files/[id]/route");
  const { fileValue } = require("../src/lib/custom-fields/rules") as typeof import("../src/lib/custom-fields/rules");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = {
    id: randomUUID(),
    slug: "zzscope",
    name: "zzscope",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzscope.localhost",
    hosts: ["zzscope.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    entitlements: { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };

  await runAsTenant(tenant, async () => {
    // ── Fixture ────────────────────────────────────────────────────────────────────────────────
    section("Fixture");
    const user = (key: string, grants: Record<string, boolean>, extra: { isSuperAdmin?: boolean; role?: string } = {}) =>
      db.user.create({
        data: {
          name: `${TAG} ${key}`,
          email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`,
          passwordHash: "!",
          role: extra.role ?? "PROFILE",
          isSuperAdmin: extra.isSuperAdmin ?? false,
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
        select: { id: true, name: true, email: true, role: true },
      });
    const sells = { "orders.view": true, "orders.process": true, "products.edit": true, "companies.viewAll": false };
    const owner = await user("Owner", {}, { isSuperAdmin: true, role: "ADMIN" });
    // Alpha's and the reseller's account manager.
    const salesA = await user("Asha", sells);
    // Sells too, but neither of those accounts is in their book.
    const salesB = await user("Bilal", sells);
    // Sees every account and its orders, but raises none.
    const viewer = await user("Viewer", { "orders.view": true, "orders.process": false, "products.edit": false, "companies.viewAll": true });
    const as = (u: { id: string; name: string; email: string; role: string }) => {
      actor = u;
    };

    const item = await db.item.create({
      data: { name: `${TAG} Cloud seats`, sku: `${TAG}-SEAT`, type: "SUBSCRIPTION", billingCycle: "ANNUAL", unit: "seat", sellingPrice: 1000, createdById: owner.id },
      select: { id: true, name: true },
    });
    const account = async (name: string, relationshipType: "CLIENT" | "RESELLER") => {
      const company = await db.company.create({
        data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: owner.id, ownerUserId: salesA.id, relationshipType, stage: "CUSTOMER" },
        select: { id: true },
      });
      const location = await db.companyLocation.create({ data: { companyId: company.id, label: "Head Office", isPrimary: true }, select: { id: true } });
      return { id: company.id, locationId: location.id };
    };
    // Today in the suite's workspace, which keeps India's clock.
    const today = indiaClock.today();
    // Ten seats, a month into a year's term.
    const subscription = (to: { id: string; locationId: string }) =>
      db.companyProduct.create({
        data: {
          companyId: to.id,
          locationId: to.locationId,
          itemId: item.id,
          quantity: 10,
          unitPrice: 1000,
          fullTermUnitPrice: 1000,
          startDate: dayFrom(today, -30),
          endDate: dayFrom(today, 335),
          orderStatus: "FULFILLED",
          addedByUserId: salesA.id,
        },
        select: { id: true },
      });
    const alpha = await account("Alpha", "CLIENT");
    const alphaSub = await subscription(alpha);
    const reseller = await account("Reseller", "RESELLER");
    await db.resellerProfile.create({ data: { companyId: reseller.id, status: "SUSPENDED" } });
    const resellerSub = await subscription(reseller);
    ok("an account and a reseller in Asha's book, each with ten seats a month into the year; Bilal sells too", !!alphaSub.id && !!resellerSub.id);

    const seats = (parentId: string) => addons.createAddon({ parentId, quantity: 2, startDate: today });
    const childrenOf = (parentId: string) => db.companyProduct.count({ where: { parentId } });
    const renewalsOf = (id: string) => db.companyProduct.count({ where: { renewedFromId: id } });
    const auditedAs = async (entityId: string) => (await db.auditLog.findFirst({ where: { entityId, action: "CREATE" }, select: { entityType: true } }))?.entityType;

    // ── Seats ──────────────────────────────────────────────────────────────────────────────────
    section("Seats added to a running subscription");
    as(salesB);
    ok("the quote already answered an account outside Bilal's book as missing", (await addons.quoteAddon({ parentId: alphaSub.id, quantity: 2, startDate: today })) === null);
    const outOfBook = await seats(alphaSub.id);
    ok("Bilal can't add seats to Alpha's subscription", !outOfBook.ok && outOfBook.error === MISSING && (await childrenOf(alphaSub.id)) === 0, errorOf(outOfBook));
    const noSuch = await seats(randomUUID());
    ok("  the same answer as an id that doesn't exist", !noSuch.ok && noSuch.error === MISSING, errorOf(noSuch));
    ok("  nor read it with its add-ons", (await addons.subscriptionWithAddons(alphaSub.id)) === null);
    as(salesA);
    const added = await seats(alphaSub.id);
    const addedId = added.ok ? added.data.id : "";
    ok("Asha adds two seats to it", added.ok && (await childrenOf(alphaSub.id)) === 1, errorOf(added));
    ok("  audited as an order, as every other order is", (await auditedAs(addedId)) === "Order", await auditedAs(addedId));
    const withAddons = await addons.subscriptionWithAddons(alphaSub.id);
    ok("  and reads it back with them", withAddons?.addons.length === 1, JSON.stringify(withAddons?.group ?? null));

    // ── Renewals ───────────────────────────────────────────────────────────────────────────────
    section("Renewals");
    as(salesB);
    ok("Bilal gets no renewal draft for Alpha's subscription", (await renewals.renewalDraft(alphaSub.id)) === null);
    const renewOutOfBook = await renewals.createRenewalOrder({ companyProductId: alphaSub.id });
    ok("  and can't renew it", !renewOutOfBook.ok && renewOutOfBook.error === MISSING && (await renewalsOf(alphaSub.id)) === 0, errorOf(renewOutOfBook));
    as(salesA);
    ok("Asha gets the draft", (await renewals.renewalDraft(alphaSub.id)) !== null);
    const renewed = await renewals.createRenewalOrder({ companyProductId: alphaSub.id });
    const renewedId = renewed.ok ? renewed.data.id : "";
    ok("  renews it — twelve seats, the two added included", renewed.ok && (await db.companyProduct.findUnique({ where: { id: renewedId }, select: { quantity: true } }))?.quantity === 12, errorOf(renewed));
    ok("  audited as an order", (await auditedAs(renewedId)) === "Order", await auditedAs(renewedId));

    // ── The reseller gate ──────────────────────────────────────────────────────────────────────
    section("A reseller whose onboarding isn't signed off");
    const suspended = (r: { ok: boolean; error?: string }) => !r.ok && (r.error ?? "").includes("reseller onboarding is suspended");
    const punchForReseller = await orders.createOrder({
      companyId: reseller.id,
      locationId: reseller.locationId,
      itemId: item.id,
      quantity: 1,
      unitPrice: 1000,
      businessType: "NEW",
      watcherUserIds: [],
      expenses: [],
    });
    ok("no order is punched for them", suspended(punchForReseller), errorOf(punchForReseller));
    const resellerSeats = await seats(resellerSub.id);
    ok("  no seats are added", suspended(resellerSeats) && (await childrenOf(resellerSub.id)) === 0, errorOf(resellerSeats));
    const resellerRenewal = await renewals.createRenewalOrder({ companyProductId: resellerSub.id });
    ok("  and nothing is renewed", suspended(resellerRenewal) && (await renewalsOf(resellerSub.id)) === 0, errorOf(resellerRenewal));
    await db.resellerProfile.update({ where: { companyId: reseller.id }, data: { status: "ACTIVE" } });
    const activeSeats = await seats(resellerSub.id);
    ok("once they're active, seats can be added", activeSeats.ok, errorOf(activeSeats));

    // ── The company page ───────────────────────────────────────────────────────────────────────
    section("The company page offers Add seats only to whom it will work for");
    const page = async (u: typeof salesA) => {
      as(u);
      return renderToStaticMarkup((await CompanyDetail({ id: alpha.id, tab: "products" })) as ReactElement);
    };
    const ashaPage = await page(salesA);
    ok("Asha, who may add seats, is offered them", ashaPage.includes(item.name) && ashaPage.includes("Add seats"));
    const viewerPage = await page(viewer);
    ok("  somebody who sees the subscription but raises no orders is not", viewerPage.includes(item.name) && !viewerPage.includes("Add seats"));

    // ── The Orders level, not only the account (audit M-6) ─────────────────────────────────────
    section("An Orders level narrower than Companies — the order's own actions (audit M-6)");
    // Sees every account, and holds every order right there is — so nothing but the Orders level can refuse them.
    const narrow = await user("Narrow", {
      "orders.view": true,
      "orders.process": true,
      "orders.approve": true,
      "orders.approveLoss": true,
      "fields.revealSecrets": true,
      "payments.view": true,
      "payments.record": true,
      "companies.viewAll": true,
    });
    const ordersLevel = async (levels: { view: "OWN" | "ALL"; edit: "OWN" | "ALL" } | null) => {
      await db.userAccessLevel.deleteMany({ where: { userId: narrow.id, record: "orders" } });
      if (!levels) return;
      await db.userAccessLevel.createMany({
        data: (["view", "edit", "delete", "assign"] as const).map((action) => ({ userId: narrow.id, record: "orders", action, level: action === "view" ? levels.view : levels.edit, reason: TAG })),
      });
    };
    // Asha's order on Alpha, in every state an action could move: awaiting approval, held, a higher price waiting —
    // and its cost, deal and quoted prices set. A cancelled one beside it, its vendor PO still to settle.
    const m6Order = await db.companyProduct.create({
      data: {
        companyId: alpha.id,
        locationId: alpha.locationId,
        itemId: item.id,
        quantity: 1,
        unitPrice: 1000,
        purchasePrice: 700,
        dealPrice: 650,
        quotedPurchasePrice: 720,
        pendingPurchasePrice: 750,
        priceIncreaseReason: "zz the distributor's price went up",
        priceReviewRequestedAt: new Date(),
        orderStatus: "PENDING_APPROVAL",
        purchaseRelease: "HELD",
        addedByUserId: salesA.id,
      },
      select: { id: true },
    });
    const m6Cancelled = await db.companyProduct.create({
      data: {
        companyId: alpha.id,
        locationId: alpha.locationId,
        itemId: item.id,
        quantity: 1,
        unitPrice: 1000,
        orderStatus: "CANCELLED",
        cancelledAt: new Date(),
        vendorPoCancel: "PENDING",
        addedByUserId: salesA.id,
      },
      select: { id: true },
    });
    const m6Resale = await db.companyProduct.create({
      data: { companyId: reseller.id, locationId: reseller.locationId, itemId: item.id, quantity: 1, unitPrice: 1000, orderStatus: "PENDING_APPROVAL", addedByUserId: salesA.id },
      select: { id: true },
    });
    const endCustomer = await db.company.create({
      data: { name: `${TAG} End customer`, normalizedName: `${TAG} end customer`.toLowerCase(), createdById: owner.id, ownerUserId: salesA.id, relationshipType: "CLIENT", stage: "CUSTOMER", managedByResellerId: reseller.id },
      select: { id: true },
    });
    // A file on Asha's order, as the "More details" card keeps a certificate.
    await db.customFieldDefinition.create({ data: { entity: "ORDER", key: "zz_certificate", label: "Certificate", type: "FILE", createdById: owner.id } });
    const pdf = Buffer.from("%PDF-1.4\n% zz order-scope\n");
    const file = await db.customFieldFile.create({
      data: { entity: "ORDER", fieldKey: "zz_certificate", name: "certificate.pdf", contentType: "application/pdf", size: pdf.length, data: new Uint8Array(pdf), uploadedById: salesA.id },
      select: { id: true },
    });
    await db.companyProduct.update({ where: { id: m6Order.id }, data: { customFields: { zz_certificate: fileValue(file.id, "certificate.pdf") } } });
    const download = async () =>
      (await fileRoute.GET(new Request(`http://zzscope.localhost/api/custom-fields/files/${file.id}?order=${m6Order.id}`), { params: Promise.resolve({ id: file.id }) })).status;
    const orderState = async (id: string) =>
      JSON.stringify(
        await db.companyProduct.findUnique({
          where: { id },
          select: {
            orderStatus: true,
            purchaseRelease: true,
            releaseOn: true,
            purchasePrice: true,
            quotedPurchasePrice: true,
            pendingPurchasePrice: true,
            dealPrice: true,
            dealRegStatus: true,
            vendorPoCancel: true,
            lossApprovedCost: true,
            endCustomerId: true,
            customFields: true,
            cancelledAt: true,
          },
        }),
      );
    const NOT_FOUND = "Order not found.";
    const missingOrder = (r: { ok: boolean; error?: string }) => !r.ok && r.error === NOT_FOUND;
    const dealInput = { orderId: m6Order.id, dealRegStatus: "APPLIED", dealRegNumber: "ZZ-1", dealPrice: 640 };

    await ordersLevel({ view: "OWN", edit: "OWN" });
    as(narrow);
    const before = await orderState(m6Order.id);
    const resaleBefore = await orderState(m6Resale.id);
    const cancelledBefore = await orderState(m6Cancelled.id);
    const refusals: [string, () => Promise<{ ok: boolean; error?: string }>][] = [
      ["cancel Asha's order", () => orders.cancelOrder(m6Order.id, "zz the customer changed their mind")],
      ["process it", () => orders.processOrder({ orderId: m6Order.id, vendorId: "zz-no-vendor", purchasePrice: 700 })],
      ["set its distributor price", () => orders.setOrderQuote({ orderId: m6Order.id, quotedPurchasePrice: 690, quoteVendorName: `${TAG} Distributor` })],
      ["accept purchase's higher price on it", () => orders.acceptPriceIncrease(m6Order.id)],
      ["send that price back", () => orders.sendBackPriceIncrease(m6Order.id, "zz try another distributor")],
      ["send it to purchase", () => orders.releaseOrder(m6Order.id)],
      ["schedule it for purchase", () => orders.scheduleRelease(m6Order.id, dayFrom(today, 7).toISOString().slice(0, 10))],
      ["hold it", () => orders.holdOrder(m6Order.id)],
      ["approve selling it below cost", () => orders.approveOrderLoss({ orderId: m6Order.id, note: "zz worth taking" })],
      ["change its deal registration", () => orders.setOrderDeal(dealInput)],
      ["reveal its secrets", () => orders.revealOrderSecret(m6Order.id, "zz_licence")],
      ["change its own fields", () => orders.updateOrderCustomFields(m6Order.id, {})],
      ["settle the vendor PO of Asha's cancelled order", () => orders.settleVendorPo(m6Cancelled.id, "NOT_NEEDED")],
      ["set the end customer on Asha's reseller order", () => orders.setOrderEndCustomer(m6Resale.id, endCustomer.id)],
    ];
    for (const [what, act] of refusals) {
      const r = await act();
      ok(`seeing every account but only their own orders, Narrow can't ${what} — answered as a made-up id`, missingOrder(r), errorOf(r));
    }
    ok(
      "  and the orders are exactly as they were",
      (await orderState(m6Order.id)) === before && (await orderState(m6Resale.id)) === resaleBefore && (await orderState(m6Cancelled.id)) === cancelledBefore,
    );
    ok("  no end customers are offered for the reseller order", (await orders.endCustomerChoices(m6Resale.id, "")).theirs.length === 0);
    ok("  its certificate doesn't download — the same 404 as a made-up file", (await download()) === 404);
    const hidden = await payments.listCompanyOrdersForPayment(alpha.id);
    ok("  and it isn't offered to apply a payment to", !hidden.some((o) => o.id === m6Order.id), `${hidden.length} order(s) offered`);

    // Nor can money be put on it by id (audit M-6 follow-up). A throw is an answer too — the unfixed code gets as far as
    // posting the payment — so it is caught and shown rather than ending the suite.
    const attempt = async (act: () => Promise<{ ok: boolean; error?: string }>) => act().catch((err: unknown) => ({ ok: false, error: `threw: ${err instanceof Error ? err.message : String(err)}` }));
    const moneyOn = async () => JSON.stringify({
      payments: await db.payment.count({ where: { companyId: alpha.id } }),
      allocations: await db.paymentAllocation.count({ where: { companyProductId: m6Order.id } }),
    });
    const moneyBefore = await moneyOn();
    const receipt = (allocateToOrderId: string) => attempt(() => payments.recordPayment({ companyId: alpha.id, amount: 100, paidOn: today, method: "UPI", allocateToOrderId }));
    const recordedOn = await receipt(m6Order.id);
    const recordedOnMadeUp = await receipt(randomUUID());
    ok(
      "  Narrow can't record a payment onto Asha's order — answered as a made-up order id",
      !recordedOn.ok && !recordedOnMadeUp.ok && recordedOn.error === recordedOnMadeUp.error,
      `${errorOf(recordedOn)} | made-up: ${errorOf(recordedOnMadeUp)}`,
    );
    ok("    and no payment was recorded", (await moneyOn()) === moneyBefore, await moneyOn());
    // A receipt on account Narrow recorded, which is theirs to allocate — written straight, as the ledger is not the point here.
    const onAccount = await db.payment.create({ data: { companyId: alpha.id, amount: 500, paidOn: new Date(), method: "UPI", recordedByUserId: narrow.id }, select: { id: true } });
    const allocateTo = (companyProductId: string) => attempt(() => payments.allocatePayment({ paymentId: onAccount.id, companyProductId, amount: 10 }));
    const allocated = await allocateTo(m6Order.id);
    const allocatedMadeUp = await allocateTo(randomUUID());
    ok(
      "  nor allocate their own receipt to it — answered as a made-up order id",
      !allocated.ok && !allocatedMadeUp.ok && allocated.error === allocatedMadeUp.error,
      `${errorOf(allocated)} | made-up: ${errorOf(allocatedMadeUp)}`,
    );
    ok("    and nothing was allocated", (await db.paymentAllocation.count({ where: { OR: [{ paymentId: onAccount.id }, { companyProductId: m6Order.id }] } })) === 0);

    section("Every order to see, only their own to change (audit M-6)");
    await ordersLevel({ view: "ALL", edit: "OWN" });
    const reveal = await orders.revealOrderSecret(m6Order.id, "zz_licence");
    ok("revealing a secret is reading the order, so it gets past the order's scope", !reveal.ok && reveal.error === "There's no secret kept there.", errorOf(reveal));
    ok("  the certificate downloads", (await download()) === 200);
    const dealRefused = await orders.setOrderDeal(dealInput);
    ok("  changing it is still refused", missingOrder(dealRefused) && (await orderState(m6Order.id)) === before, errorOf(dealRefused));
    const offered = await payments.listCompanyOrdersForPayment(alpha.id);
    const row = offered.find((o) => o.id === m6Order.id);
    ok("  it is offered to apply a payment to, with what's owed", !!row && row.balance > 0 && row.balance === row.total, row ? row.balance : "not offered");
    const COST_KEYS = ["purchasePrice", "dealPrice", "quotedPurchasePrice", "pendingPurchasePrice", "lossApprovedCost", "lossRequestedCost", "quoteVendorId"];
    ok(
      "  but carrying nothing of its cost — no purchase, deal, quoted or pending price",
      !!row && !COST_KEYS.some((k) => k in row) && !("costPrice" in row.item),
      row ? Object.keys(row).join(",") : "not offered",
    );
    // Seeing it is enough to put money on it, as the picker that offers it says (audit M-6 follow-up) — on an order of
    // its own beside it, so the order above stays as the checks around it expect.
    const payable = await db.companyProduct.create({
      data: { companyId: alpha.id, locationId: alpha.locationId, itemId: item.id, quantity: 1, unitPrice: 1000, orderStatus: "FULFILLED", addedByUserId: salesA.id },
      select: { id: true },
    });
    const seenAllocated = await allocateTo(payable.id);
    ok(
      "  seeing every order, Narrow allocates their receipt to one of Asha's — view is what money on an order asks",
      seenAllocated.ok && (await db.paymentAllocation.count({ where: { paymentId: onAccount.id, companyProductId: payable.id } })) === 1,
      errorOf(seenAllocated),
    );

    section("No Orders level set: it follows the account again (audit M-6)");
    await ordersLevel(null);
    const dealSet = await orders.setOrderDeal(dealInput);
    const dealNow = await db.companyProduct.findUnique({ where: { id: m6Order.id }, select: { dealPrice: true } });
    ok("Narrow, who sees every account, changes the deal registration", dealSet.ok && Number(dealNow?.dealPrice) === 640, errorOf(dealSet));
    ok("  is offered the reseller's end customers", (await orders.endCustomerChoices(m6Resale.id, "")).theirs.some((c) => c.id === endCustomer.id));
    const endSet = await orders.setOrderEndCustomer(m6Resale.id, endCustomer.id);
    const endNow = await db.companyProduct.findUnique({ where: { id: m6Resale.id }, select: { endCustomerId: true } });
    ok("  sets the end customer", endSet.ok && endNow?.endCustomerId === endCustomer.id, errorOf(endSet));
    ok("  and downloads the certificate", (await download()) === 200);
    as(salesA);
    const released = await orders.releaseOrder(m6Order.id);
    const releaseNow = await db.companyProduct.findUnique({ where: { id: m6Order.id }, select: { purchaseRelease: true } });
    ok("Asha, who punched it, still sends it to purchase", released.ok && releaseNow?.purchaseRelease === "RELEASED", errorOf(released));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
