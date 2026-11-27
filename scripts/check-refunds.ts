/**
 * check:refunds — the 30-day policy (owner, 7 Nov 2026: src/lib/billing/refunds.ts).
 *
 * On a scratch control plane, dropped at the end; `fetch` is a fake Razorpay and mail is caught:
 *
 *   · what the policy says: the first yearly payment in 30 days, and nothing else;
 *   · Razorpay: the money goes back on the right payment, found through a subscription's invoice; a part then the rest; a
 *     credit note for what went back, once, the webhook after it changing nothing; never more than was paid;
 *   · a refund in full takes back extra people; a part refund leaves them; a plan ends only if asked;
 *   · bank transfer: recorded, credited, the plan left alone unless asked; ended, the workspace is lapsed;
 *   · Stripe is refused and sent to its dashboard; Razorpay saying no leaves nothing changed and it can be tried again;
 *   · a bank-transfer customer can stop renewing, and paying again undoes it;
 *   · the policy page is on the site, in the footer, and says the terms agreed.
 *
 *   npm run check:refunds
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
const razorpay = { refunds: [] as { payment: string; amount: number }[], cancelled: [] as { id: string; body: unknown }[], refuseRefund: false };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const refund = /^https:\/\/api\.razorpay\.com\/v1\/payments\/([^/]+)\/refund$/.exec(url);
  if (refund && init?.method === "POST") {
    if (razorpay.refuseRefund) return json({ error: { code: "BAD_REQUEST_ERROR", description: "The refund amount is too high" } }, 400);
    const body = JSON.parse(String(init.body)) as { amount: number };
    razorpay.refunds.push({ payment: decodeURIComponent(refund[1]!), amount: body.amount });
    return json({ id: `rfnd_zz${razorpay.refunds.length}`, amount: body.amount, status: "processed" });
  }
  const invoice = /^https:\/\/api\.razorpay\.com\/v1\/invoices\/([^/]+)$/.exec(url);
  if (invoice) return json({ id: decodeURIComponent(invoice[1]!), payment_id: "pay_fromInvoice" });
  const cancel = /^https:\/\/api\.razorpay\.com\/v1\/subscriptions\/([^/]+)\/cancel$/.exec(url);
  if (cancel) {
    razorpay.cancelled.push({ id: decodeURIComponent(cancel[1]!), body: JSON.parse(String(init?.body)) });
    return json({ id: decodeURIComponent(cancel[1]!), status: "cancelled" });
  }
  outside.push(url);
  throw new Error(`check:refunds makes no outside calls — ${url}`);
}) as typeof fetch;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname)) throw new Error("not a local database");
  section("A scratch control plane");
  const controlName = `${new URL(url).pathname.slice(1)}_refunds_control`;
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
    const checkout = require("../src/lib/billing/checkout") as typeof import("../src/lib/billing/checkout");
    const lifecycle = require("../src/lib/billing/lifecycle") as typeof import("../src/lib/billing/lifecycle");
    const sync = require("../src/lib/billing/sync") as typeof import("../src/lib/billing/sync");
    const ent = require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const settings = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
    const refunds = require("../src/lib/billing/refunds") as typeof import("../src/lib/billing/refunds");
    cleanup = async () => closeControlDb();
    const control = controlDb();
    const mail: { to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m as (typeof mail)[number]));
    await settings.setSecret("razorpay.keyId", "rzp_test_zz", "script:check");
    await settings.setSecret("razorpay.keySecret", "zz-secret", "script:check");
    await taxInvoice.saveSeller({ name: "Deskzo Technologies Private Limited", address: "12 Residency Road\nBengaluru 560025", state: "29", gstin: "29ABCDE1234F1Z5", pan: "ABCDE1234F", sac: "9983", prefix: "DZ" }, "script:check");

    section("What the policy says");
    const now = new Date();
    const policy = (days: number, first = true) => refunds.refundPolicyFor({ paidAt: new Date(now.getTime() - days * DAY), isFirstYearly: first, now });
    ok("the first yearly payment, 29 days on: within", policy(29) === "within");
    ok("  30 days on: within", policy(30) === "within");
    ok("  45 days on: outside", policy(45) === "outside");
    ok("  not the first: outside", policy(5, false) === "outside");
    ok("  never paid: outside", refunds.refundPolicyFor({ paidAt: null, isFirstYearly: true, now }) === "outside");

    const base = { countries: [] as string[], seats: null, copilotTokens: null, modules: [] as string[] };
    await plans.savePlan({ ...base, kind: "EDITION", key: "zz-one", name: "One", modules: ["tasks"], isDefault: true }, "script:check");
    await prices.addPlanPrice({ planKey: "zz-one", currency: "INR", interval: "YEAR", amount: 1499000, perSeat: true }, "script:check");
    const one = await control.plan.findUniqueOrThrow({ where: { key: "zz-one" }, include: { prices: true } });
    const makeTenant = async (slug: string) => {
      const id = randomUUID();
      await control.tenant.create({ data: { id, slug, name: `Zz ${slug}`, status: "ACTIVE", keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()), country: "IN", currency: "INR", ownerEmail: `owner@${slug}.example`, billingEmail: `accounts@${slug}.example` } as never });
      return id;
    };
    const until = new Date(now.getTime() + 300 * DAY);
    const subscribe = async (tenantId: string, gateway: "RAZORPAY" | "OFFLINE" | "STRIPE") => {
      const sub = await control.subscription.create({
        data: { tenantId, gateway, status: "ACTIVE", currentPeriodEnd: until, currency: "INR", interval: "YEAR", ...(gateway === "OFFLINE" ? {} : { externalId: `sub_zz${tenantId.slice(0, 8)}` }), items: { create: { planId: one.id, priceId: one.prices[0]!.id, quantity: 10 } } },
        select: { id: true },
      });
      await ent.refreshEntitlements(tenantId);
      return sub.id;
    };
    const TOTAL = 17688200;
    const invoiceFor = async (tenantId: string, subscriptionId: string, gateway: "RAZORPAY" | "OFFLINE" | "STRIPE", externalId: string, daysAgo = 5) => {
      const made = await control.invoice.create({
        data: { tenantId, gateway, externalId, status: "PAID", currency: "INR", subtotal: 14990000, tax: 2698200, total: TOTAL, amountPaid: TOTAL, issuedAt: new Date(now.getTime() - daysAgo * DAY), paidAt: new Date(now.getTime() - daysAgo * DAY), subscriptionId, planLines: [{ planKey: "zz-one", amount: 14990000 }] },
        select: { id: true },
      });
      await taxInvoice.issueTaxInvoice(made.id);
      return made.id;
    };
    const notes = (id: string) => control.platformCreditNote.findMany({ where: { invoiceId: id } });
    const ask = (invoiceId: string, amount: number, extra: { endPlan?: boolean; reason?: string } = {}) => refunds.refundInvoice({ invoiceId, amount, reason: extra.reason ?? "Asked within 30 days", endPlan: extra.endPlan ?? false, staffId: "staff:zz" });

    section("Razorpay");
    const R = await makeTenant("zzrf-razorpay");
    const rSub = await subscribe(R, "RAZORPAY");
    const inv = await invoiceFor(R, rSub, "RAZORPAY", "inv_zzsub");
    const facts = await refunds.refundFacts(R, [{ id: inv, gateway: "RAZORPAY", status: "PAID", amountPaid: TOTAL, amountRefunded: 0, paidAt: new Date(now.getTime() - 5 * DAY) }]);
    ok("its first yearly payment shows as within the policy", facts.get(inv)?.policy === "within" && facts.get(inv)?.refundable === TOTAL, facts.get(inv));
    const second = await invoiceFor(R, rSub, "RAZORPAY", "pay_zzsecond", 1);
    const factsTwo = await refunds.refundFacts(R, [{ id: second, gateway: "RAZORPAY", status: "PAID", amountPaid: TOTAL, amountRefunded: 0, paidAt: new Date(now.getTime() - DAY) }]);
    ok("  a later one doesn't", factsTwo.get(second)?.policy === "outside");
    ok("no reason: refused", /Say why/.test(await thrown(() => ask(inv, 100, { reason: "" }))));
    ok("more than was paid: refused, nothing sent", /more than is left/.test(await thrown(() => ask(inv, TOTAL + 1))) && razorpay.refunds.length === 0);
    razorpay.refuseRefund = true;
    const said = await thrown(() => ask(inv, 100000));
    razorpay.refuseRefund = false;
    const untouched = await control.invoice.findUniqueOrThrow({ where: { id: inv } });
    ok("Razorpay saying no: its words shown, nothing changed", /too high/.test(said) && untouched.amountRefunded === 0 && (await notes(inv)).length === 0, said);
    await ask(inv, 5000000);
    ok("a part refund: on the payment its invoice names", razorpay.refunds[0]?.payment === "pay_fromInvoice" && razorpay.refunds[0].amount === 5000000, razorpay.refunds[0]);
    let credited = await notes(inv);
    ok("  a credit note for what went back", credited.length === 1 && credited[0]!.amount === 5000000 && (await control.invoice.findUniqueOrThrow({ where: { id: inv } })).amountRefunded === 5000000);
    ok("  mailed", mail.some((m) => /Credit note/.test(m.subject)));
    ok("  the plan left alone", (await control.subscription.findUniqueOrThrow({ where: { id: rSub } })).status === "ACTIVE" && razorpay.cancelled.length === 0);
    await sync.applyRazorpayRefund({ id: "pay_fromInvoice", invoice_id: "inv_zzsub", amount_refunded: 5000000 } as never);
    ok("  the webhook after it changes nothing", (await notes(inv)).length === 1);
    await ask(inv, TOTAL - 5000000, { endPlan: true });
    credited = await notes(inv);
    const ended = await control.subscription.findUniqueOrThrow({ where: { id: rSub } });
    ok("the rest: credited too", credited.length === 2 && credited.reduce((n, c) => n + c.amount, 0) === TOTAL);
    ok("  the plan ended when asked, at Razorpay as well, at once", ended.status === "CANCELLED" && razorpay.cancelled[0]?.id === ended.externalId && (razorpay.cancelled[0]?.body as { cancel_at_cycle_end?: number }).cancel_at_cycle_end === 0, razorpay.cancelled[0]);
    ok("  so it counts for no people", (await ent.computeEntitlements(R)).seats !== 10);
    ok("again: refused", /in full already/.test(await thrown(() => ask(inv, 1))));
    ok("a pay_ invoice goes straight to its payment", !!(await ask(second, 100)) && razorpay.refunds.at(-1)?.payment === "pay_zzsecond");

    section("Extra people");
    const X = await makeTenant("zzrf-extra");
    const xSub = await subscribe(X, "RAZORPAY");
    const xInv = await invoiceFor(X, xSub, "RAZORPAY", "pay_zzextra");
    await control.extraSeatPurchase.create({ data: { tenantId: X, subscriptionId: xSub, planKey: "zz-one", quantity: 2, startsAt: now, endsAt: until, subtotal: 1, total: 1, gateway: "RAZORPAY", status: "PAID", invoiceId: xInv, requestedBy: "z" } });
    await ent.refreshEntitlements(X);
    await ask(xInv, 100);
    ok("a part refund leaves them", (await ent.computeEntitlements(X)).seats === 12);
    await ask(xInv, TOTAL - 100);
    ok("in full takes them back", (await ent.computeEntitlements(X)).seats === 10);

    section("Bank transfer");
    const O = await makeTenant("zzrf-transfer");
    const receivedOn = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const paid = await offline.recordOfflinePayment({ tenantId: O, items: [{ planKey: "zz-one", quantity: 10 }], interval: "YEAR", periods: 1, amount: TOTAL, method: "NEFT", reference: "UTRZZ", receivedOn }, "staff:zz");
    await ask(paid.invoiceId, 1000000);
    const oInv = await control.invoice.findUniqueOrThrow({ where: { id: paid.invoiceId } });
    const oSub = await control.subscription.findUniqueOrThrow({ where: { id: paid.subscriptionId } });
    ok("recorded and credited, the plan and paid-until date alone", oInv.amountRefunded === 1000000 && (await notes(paid.invoiceId)).length === 1 && oSub.status === "ACTIVE" && oSub.currentPeriodEnd!.getTime() === paid.periodEnd.getTime());
    ok("  no call to any gateway", razorpay.refunds.every((r) => !r.payment.includes("offline")));
    await ask(paid.invoiceId, TOTAL - 1000000, { endPlan: true });
    const oEnded = await lifecycle.billingStanding(O);
    ok("ended when asked: lapsed, so it's held", oEnded.kind === "lapsed", oEnded.kind);

    section("Stripe");
    const S = await makeTenant("zzrf-stripe");
    const sSub = await subscribe(S, "STRIPE");
    const sInv = await invoiceFor(S, sSub, "STRIPE", "in_zz");
    ok("sent to its dashboard", /Stripe's dashboard/.test(await thrown(() => ask(sInv, 100))));

    section("A bank-transfer customer stopping");
    const C = await makeTenant("zzrf-stop");
    const cPaid = await offline.recordOfflinePayment({ tenantId: C, items: [{ planKey: "zz-one", quantity: 10 }], interval: "YEAR", periods: 1, amount: TOTAL, method: "NEFT", reference: "UTRZZ2", receivedOn }, "staff:zz");
    ok("paid: reminders to renew", (await lifecycle.billingStanding(C)).kind === "paid");
    await checkout.cancelAtPeriodEnd(C, cPaid.subscriptionId);
    ok("stopped: ending, still working", (await lifecycle.billingStanding(C)).kind === "ending" && (await control.subscription.findUniqueOrThrow({ where: { id: cPaid.subscriptionId } })).status === "ACTIVE");
    ok("  and nobody else's can be stopped", /not one to cancel/.test(await thrown(() => checkout.cancelAtPeriodEnd(O, cPaid.subscriptionId))));
    await offline.recordOfflinePayment({ tenantId: C, items: [{ planKey: "zz-one", quantity: 10 }], interval: "YEAR", periods: 1, amount: TOTAL, method: "NEFT", reference: "UTRZZ3", receivedOn }, "staff:zz");
    ok("paying again undoes it", (await lifecycle.billingStanding(C)).kind === "paid");

    section("The page, and the reminder");
    const { DEFAULT_SITE_PAGES, DEFAULT_SITE_SETTINGS } = require("../src/components/site/defaults") as typeof import("../src/components/site/defaults");
    const page = DEFAULT_SITE_PAGES.find((p) => p.slug === "refunds");
    const text = JSON.stringify(page ?? "");
    ok("the policy is a page", !!page && text.includes("within 30 days of paying") && text.includes("no refund") && text.includes("Settings › Data"));
    ok("  in the footer", JSON.stringify(DEFAULT_SITE_SETTINGS).includes('"/refunds"'));
    ok("  and linked from the terms", JSON.stringify(DEFAULT_SITE_PAGES.find((p) => p.slug === "terms")).includes('"/refunds"'));
    const { PLATFORM_MAIL_TEMPLATES } = (() => {
      try {
        return require("../src/lib/console-shared/mail-templates/billing") as { PLATFORM_MAIL_TEMPLATES?: unknown };
      } catch {
        return { PLATFORM_MAIL_TEMPLATES: undefined };
      }
    })();
    void PLATFORM_MAIL_TEMPLATES;
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    ok("the hold reminder says to download first", readFileSync("src/lib/console-shared/mail-templates/billing.ts", "utf8").includes("Download what you want to keep from Settings › Data"));
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
  console.log(failures === 0 ? `\nAll ${passes} refund checks passed.\n` : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
