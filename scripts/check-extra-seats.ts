/**
 * check:extra-seats — more people part-way through a paid period (owner, 7 Nov 2026: src/lib/billing/extra-seats.ts).
 *
 * On a scratch control plane, dropped at the end; `fetch` is a fake Razorpay and mail is caught:
 *
 *   · the price: the days left at the customer's price, GST on top, a year and a month;
 *   · who's offered it: paying by Razorpay or transfer, per person, in India — not a trial, a limit staff set, a plan priced
 *     whole, abroad, or a period that has run out;
 *   · Razorpay: a page for the right amount, counted only when paid, once however often the webhook comes, with a tax
 *     invoice; the subscription untouched; a read from Razorpay can't undo them; a refund in full takes them back;
 *   · bank transfer: a proforma that doesn't replace the next period's, nor is replaced by it; counted when staff record the
 *     transfer, the paid-until date and plans untouched; a void takes them back and leaves the subscription alone;
 *   · the end: off the limit when the period ends, by the daily run.
 *
 *   npm run check:extra-seats
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);
const DAY = 86_400_000;
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const outside: string[] = [];
const razorpay: { links: Map<string, Record<string, unknown>>; created: Record<string, unknown>[] } = { links: new Map(), created: [] };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url === "https://api.razorpay.com/v1/payment_links" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    razorpay.created.push(body);
    const id = `plink_zz${razorpay.created.length}`;
    const link = { id, entity: "payment_link", status: "created", amount: body.amount, amount_paid: 0, currency: "INR", short_url: `https://rzp.io/i/${id}`, notes: body.notes };
    razorpay.links.set(id, link);
    return json(link);
  }
  const m = /^https:\/\/api\.razorpay\.com\/v1\/payment_links\/([^/?]+)$/.exec(url);
  if (m && razorpay.links.has(decodeURIComponent(m[1]!))) return json(razorpay.links.get(decodeURIComponent(m[1]!)));
  outside.push(url);
  throw new Error(`check:extra-seats makes no outside calls — ${url}`);
}) as typeof fetch;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  section("A scratch control plane");
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname)) throw new Error("not a local database");
  const controlName = `${realName}_extraseats_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    const prices = require("../src/lib/billing/prices") as typeof import("../src/lib/billing/prices");
    const offline = require("../src/lib/billing/offline") as typeof import("../src/lib/billing/offline");
    const taxInvoice = require("../src/lib/billing/tax-invoice") as typeof import("../src/lib/billing/tax-invoice");
    const proforma = require("../src/lib/billing/proforma") as typeof import("../src/lib/billing/proforma");
    const lifecycle = require("../src/lib/billing/lifecycle") as typeof import("../src/lib/billing/lifecycle");
    const sync = require("../src/lib/billing/sync") as typeof import("../src/lib/billing/sync");
    const webhooks = require("../src/lib/billing/webhooks") as typeof import("../src/lib/billing/webhooks");
    const ent = require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const settings = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
    const seats = require("../src/lib/billing/extra-seats") as typeof import("../src/lib/billing/extra-seats");
    const pricing = require("../src/lib/billing/extra-seat-price") as typeof import("../src/lib/billing/extra-seat-price");
    cleanup = async () => closeControlDb();
    const control = controlDb();
    const mail: { to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m as (typeof mail)[number]));

    section("The price");
    const year = pricing.extraSeatPrice({ unitPrice: 1499000, interval: "YEAR", daysLeft: 100, quantity: 5 });
    ok("100 days of a year's price, for each of 5, GST on top", year.perPerson === Math.round((1499000 * 100) / 365) && year.subtotal === year.perPerson * 5 && year.total === Math.round(year.subtotal * 1.18) && year.gst === year.total - year.subtotal, year);
    ok("  a whole year left is the year's price", pricing.extraSeatPrice({ unitPrice: 1499000, interval: "YEAR", daysLeft: 365, quantity: 1 }).perPerson === 1499000);
    ok("  a 31-day month costs one month, not a little more", pricing.extraSeatPrice({ unitPrice: 149900, interval: "MONTH", daysLeft: 31, quantity: 1 }).perPerson === 149900);
    ok("  nor 366 days a year", pricing.extraSeatPrice({ unitPrice: 1499000, interval: "YEAR", daysLeft: 366, quantity: 1 }).perPerson === 1499000);
    ok("  but 59 days is 59 days", pricing.extraSeatPrice({ unitPrice: 30000, interval: "MONTH", daysLeft: 59, quantity: 1 }).perPerson === 59000);
    ok("  fifteen days of a month is half", pricing.extraSeatPrice({ unitPrice: 100000, interval: "MONTH", daysLeft: 15, quantity: 1 }).perPerson === 50000);
    const today = new Date("2026-11-07T00:00:00+05:30");
    ok("days left count up to the first day not paid for", pricing.daysLeftIn(today, new Date("2026-11-17T00:00:00+05:30")) === 10 && pricing.daysLeftIn(today, today) === 0);

    section("Plans, and workspaces paying each way");
    const base = { countries: [] as string[], seats: null, copilotTokens: null, modules: [] as string[] };
    await plans.savePlan({ ...base, kind: "EDITION", key: "zz-one", name: "One", modules: ["tasks"], isDefault: true }, "script:check");
    await plans.savePlan({ ...base, kind: "EDITION", key: "zz-whole", name: "Whole", modules: ["tasks"], seats: 5 }, "script:check");
    await prices.addPlanPrice({ planKey: "zz-one", currency: "INR", interval: "YEAR", amount: 1499000, perSeat: true }, "script:check");
    await prices.addPlanPrice({ planKey: "zz-whole", currency: "INR", interval: "YEAR", amount: 900000, perSeat: false }, "script:check");
    const one = await control.plan.findUniqueOrThrow({ where: { key: "zz-one" }, include: { prices: true } });
    const whole = await control.plan.findUniqueOrThrow({ where: { key: "zz-whole" }, include: { prices: true } });
    const makeTenant = async (slug: string, country = "IN", extra: { seatOverride?: number } = {}) => {
      const id = randomUUID();
      await control.tenant.create({
        data: { id, slug, name: `Zz ${slug}`, status: "ACTIVE", keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()), country, currency: country === "IN" ? "INR" : "USD", ownerEmail: `owner@${slug}.example`, billingEmail: `accounts@${slug}.example`, ...extra } as never,
      });
      return id;
    };
    const until = new Date(new Date("2027-01-01T00:00:00+05:30").getTime() + 365 * DAY);
    const subscribe = async (tenantId: string, gateway: "RAZORPAY" | "OFFLINE" | "MANUAL", plan = one, quantity = 10, status: "ACTIVE" | "TRIALING" = "ACTIVE", end: Date = until) => {
      const sub = await control.subscription.create({
        data: { tenantId, gateway, status, currentPeriodEnd: end, currency: "INR", interval: "YEAR", ...(gateway === "RAZORPAY" ? { externalId: `sub_zz${tenantId.slice(0, 8)}` } : {}), items: { create: { planId: plan.id, priceId: gateway === "MANUAL" ? null : plan.prices[0]!.id, quantity } } },
        select: { id: true },
      });
      await ent.refreshEntitlements(tenantId);
      return sub.id;
    };
    const seatsOf = async (id: string) => (await ent.computeEntitlements(id)).seats;

    section("Who's offered it");
    const R = await makeTenant("zzxs-razorpay");
    const rSub = await subscribe(R, "RAZORPAY");
    let offer = await seats.extraSeatOffer(R);
    ok("Razorpay, until its keys are set: says so", !offer.open && /isn't open yet/.test(offer.reason ?? ""), offer.reason ?? "");
    await settings.setSecret("razorpay.keyId", "rzp_test_zz", "script:check");
    await settings.setSecret("razorpay.keySecret", "zz-secret", "script:check");
    offer = await seats.extraSeatOffer(R);
    ok("  with them: open, at its own price", offer.open && offer.gateway === "RAZORPAY" && offer.plans[0]?.unitPrice === 1499000 && offer.plans[0].daysLeft > 0, offer.plans[0] ?? "");
    const trial = await makeTenant("zzxs-trial");
    await subscribe(trial, "MANUAL", one, 10, "TRIALING");
    ok("a free trial: not", !(await seats.extraSeatOffer(trial)).open);
    const flat = await makeTenant("zzxs-flat");
    await subscribe(flat, "RAZORPAY", whole, 1);
    ok("a plan priced whole, not per person: not", !(await seats.extraSeatOffer(flat)).open);
    const staffSet = await makeTenant("zzxs-limit", "IN", { seatOverride: 40 });
    await subscribe(staffSet, "RAZORPAY");
    const setOffer = await seats.extraSeatOffer(staffSet);
    ok("a limit staff set: not, and says who to ask", !setOffer.open && /set by Deskzo/.test(setOffer.reason ?? ""));
    const abroad = await makeTenant("zzxs-us", "US");
    await subscribe(abroad, "RAZORPAY");
    ok("abroad: not", !(await seats.extraSeatOffer(abroad)).open);
    const over = await makeTenant("zzxs-over");
    await subscribe(over, "RAZORPAY", one, 10, "ACTIVE", new Date(Date.now() - DAY));
    ok("a period already over: not", !(await seats.extraSeatOffer(over)).open);
    const ask = (tenantId: string, quantity = 5) => seats.buyExtraSeats({ tenantId, planKey: "zz-one", quantity, requestedBy: { name: "Zz Accounts", email: "asker@zzxs.example" }, returnUrl: "https://zz.example/settings/billing?seats=done" });
    ok("a quantity out of range: refused", /from 1 to/.test(await thrown(() => ask(R, 0))) && /from 1 to/.test(await thrown(() => ask(R, 501))));
    ok("a plan it doesn't pay for: refused", /isn't one this workspace pays for/.test(await thrown(() => seats.buyExtraSeats({ tenantId: R, planKey: "zz-whole", quantity: 1, requestedBy: { name: "Z", email: "z@z.example" }, returnUrl: "https://zz.example/" }))));

    section("Razorpay");
    const started = await ask(R);
    const made = razorpay.created.at(-1)!;
    const row = await control.extraSeatPurchase.findFirstOrThrow({ where: { tenantId: R } });
    const expected = pricing.extraSeatPrice({ unitPrice: 1499000, interval: "YEAR", daysLeft: offer.plans[0]!.daysLeft, quantity: 5 });
    ok("a page to pay on, for the worked-out total", started.kind === "pay" && made.amount === expected.total && row.total === expected.total, { amount: made.amount });
    ok("  not counted yet", (await seatsOf(R)) === 10 && row.status === "WAITING");
    const linkId = row.externalId!;
    const fire = (paymentId = "pay_zz1") =>
      webhooks.dispatchRazorpayEvent({ entity: "event", event: "payment_link.paid", payload: { payment_link: { entity: { ...(razorpay.links.get(linkId) as object) } as never }, payment: { entity: { id: paymentId, amount: row.total, currency: "INR", status: "captured", created_at: Math.floor(Date.now() / 1000) } as never } } } as never);
    ok("told it's paid when Razorpay says otherwise: not believed", /not counting/.test(await thrown(() => fire())) && (await seatsOf(R)) === 10);
    razorpay.links.set(linkId, { ...razorpay.links.get(linkId)!, status: "paid", amount_paid: row.total });
    await fire();
    ok("paid: counted on top of the plan", (await seatsOf(R)) === 15, await seatsOf(R));
    const paid = await control.extraSeatPurchase.findUniqueOrThrow({ where: { id: row.id }, include: { invoice: true } });
    ok("  an invoice for it, GST inside", paid.status === "PAID" && paid.invoice?.total === row.total && paid.invoice.subtotal === expected.subtotal && paid.invoice.tax === expected.gst, paid.invoice?.total ?? "");
    await fire();
    ok("  the webhook again changes nothing", (await seatsOf(R)) === 15 && (await control.invoice.count({ where: { tenantId: R } })) === 1);
    const sub = await control.subscription.findUniqueOrThrow({ where: { id: rSub }, include: { items: true } });
    ok("  the subscription is as it was", sub.items[0]!.quantity === 10 && sub.currentPeriodEnd!.getTime() === until.getTime());
    ok("  and the running list says so", (await seats.runningExtraSeats(R))[0]?.quantity === 5);
    await control.invoice.update({ where: { id: paid.invoiceId! }, data: { amountRefunded: Math.floor(row.total / 2) } });
    await seats.revokeRefundedExtraSeats(paid.invoiceId!);
    ok("a part refund leaves them", (await seatsOf(R)) === 15);
    await control.invoice.update({ where: { id: paid.invoiceId! }, data: { amountRefunded: row.total } });
    await seats.revokeRefundedExtraSeats(paid.invoiceId!);
    ok("a refund in full takes them back", (await seatsOf(R)) === 10);
    await fire();
    ok("  and the webhook replayed doesn't bring them back", (await seatsOf(R)) === 10);
    await control.invoice.update({ where: { id: paid.invoiceId! }, data: { amountRefunded: 0, amountCredited: 0 } });
    await control.extraSeatPurchase.update({ where: { id: row.id }, data: { status: "PAID" } });
    await ent.refreshEntitlements(R);
    await sync.applyRazorpayRefund({ id: "pay_zz1", amount: row.total, amount_refunded: row.total, currency: "INR", status: "refunded" } as never);
    ok("  a real refund event does it too", (await seatsOf(R)) === 10, await seatsOf(R));

    section("Bank transfer");
    const seller = { name: "Deskzo Technologies Private Limited", address: "12 Residency Road\nBengaluru 560025", state: "29", gstin: "29ABCDE1234F1Z5", pan: "ABCDE1234F", sac: "9983", prefix: "DZ" };
    const O = await makeTenant("zzxs-transfer");
    const oSub = await subscribe(O, "OFFLINE");
    ok("until the bank account is set: says so", /isn't open yet/.test((await seats.extraSeatOffer(O)).reason ?? ""));
    await taxInvoice.saveSeller(seller, "script:check");
    await taxInvoice.saveBank({ accountName: "Deskzo Technologies Private Limited", bankName: "HDFC Bank", account: "50200012345678", ifsc: "HDFC0001234", upi: "" }, "script:check");
    const next = await proforma.requestProforma({ tenantId: O, items: [{ planKey: "zz-one", quantity: 10 }], interval: "YEAR", periods: 1, requestedBy: { name: "Zz", email: "z@zzxs.example" } });
    mail.length = 0;
    const pf = await ask(O, 3);
    ok("a proforma, mailed", pf.kind === "proforma" && mail.some((m) => m.to === "accounts@zzxs-transfer.example"), pf.kind);
    const pfRow = await control.extraSeatPurchase.findFirstOrThrow({ where: { tenantId: O, status: "WAITING" }, include: { proforma: true } });
    ok("  for the worked-out total", pfRow.proforma?.total === pfRow.total && (pfRow.proforma.details as { taxable: number }).taxable === pfRow.subtotal);
    ok("  says what it's for", ((pfRow.proforma!.details as { lines: { description: string }[] }).lines[0]?.description ?? "").includes("3 more people"));
    ok("  and leaves the next period's proforma open", (await control.platformProforma.findUniqueOrThrow({ where: { id: next.id } })).status === "OPEN");
    const again = await proforma.requestProforma({ tenantId: O, items: [{ planKey: "zz-one", quantity: 10 }], interval: "YEAR", periods: 1, requestedBy: { name: "Zz", email: "z@zzxs.example" } });
    ok("a newer next-period proforma doesn't replace it", (await control.platformProforma.findUniqueOrThrow({ where: { id: pfRow.proformaId! } })).status === "OPEN" && (await control.platformProforma.findUniqueOrThrow({ where: { id: next.id } })).status === "CANCELLED" && !!again.id);
    ok("  not counted until the transfer is recorded", (await seatsOf(O)) === 10);
    const staff = "staff:zz";
    const receivedOn = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const recorded = await offline.recordOfflinePayment({ tenantId: O, items: [{ planKey: "zz-one", quantity: 3 }], interval: "YEAR", periods: 1, amount: pfRow.total, method: "NEFT", reference: "UTRZZ1", receivedOn, proformaId: pfRow.proformaId }, staff);
    ok("recorded: counted on top", (await seatsOf(O)) === 13, await seatsOf(O));
    const oAfter = await control.subscription.findUniqueOrThrow({ where: { id: oSub }, include: { items: true } });
    ok("  its plan's people and paid-until date untouched", oAfter.items[0]!.quantity === 10 && oAfter.currentPeriodEnd!.getTime() === until.getTime());
    ok("  the proforma closed as paid, with a tax invoice", (await control.platformProforma.findUniqueOrThrow({ where: { id: pfRow.proformaId! } })).status === "PAID" && !!recorded.taxNumber, recorded.taxNumber ?? "");
    ok("  recorded twice: refused", /closed already/.test(await thrown(() => offline.recordOfflinePayment({ tenantId: O, items: [{ planKey: "zz-one", quantity: 3 }], interval: "YEAR", periods: 1, amount: pfRow.total, method: "NEFT", reference: "UTRZZ2", receivedOn, proformaId: pfRow.proformaId }, staff))));
    await offline.voidOfflinePayment(recorded.paymentId, "Recorded by mistake", staff);
    const oVoid = await control.subscription.findUniqueOrThrow({ where: { id: oSub } });
    ok("voided: they go, and the subscription stays as it was", (await seatsOf(O)) === 10 && oVoid.status === "ACTIVE" && oVoid.currentPeriodEnd!.getTime() === until.getTime(), oVoid.status);

    section("The end of the period");
    const E = await makeTenant("zzxs-end");
    const eSub = await subscribe(E, "RAZORPAY");
    await control.extraSeatPurchase.create({ data: { tenantId: E, subscriptionId: eSub, planKey: "zz-one", quantity: 2, startsAt: new Date(Date.now() - 10 * DAY), endsAt: new Date(Date.now() + 2 * DAY), subtotal: 1, total: 1, gateway: "RAZORPAY", status: "PAID", requestedBy: "z" } });
    await ent.refreshEntitlements(E);
    ok("running: counted", (await control.tenant.findUniqueOrThrow({ where: { id: E } })).entitlements !== null && (await seatsOf(E)) === 12);
    await lifecycle.runBillingLifecycle();
    ok("the daily run leaves them while the period runs", (await seatsOf(E)) === 12);
    await lifecycle.runBillingLifecycle(new Date(Date.now() + 3 * DAY));
    const written = (await control.tenant.findUniqueOrThrow({ where: { id: E } })).entitlements as { seats: number };
    ok("after it ends: off the limit, written on the workspace", written.seats === 10 && (await control.extraSeatPurchase.findFirstOrThrow({ where: { tenantId: E } })).status === "EXPIRED", written.seats);
  } finally {
    try {
      (require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer")).setTestPlatformMailer(null);
    } catch {
      // Never loaded.
    }
    if (cleanup) await cleanup().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    ok("not one request left the machine", outside.length === 0, outside.join(", "));
    await admin.$disconnect();
  }
  console.log(failures === 0 ? `\nAll ${passes} more-people checks passed.\n` : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
