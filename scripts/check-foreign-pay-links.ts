/**
 * check:foreign-pay-links — multi-currency phase 4 (owner, 30 Oct 2026): pay-now links for invoices in another
 * currency (src/lib/collect).
 *
 *   1. The gateways' calls, against a fake Razorpay and Cashfree: a dollar link in cents with `currency`, a yen link
 *      in whole yen (CURRENCIES' decimals), Cashfree's `link_currency` with the amount in the currency itself.
 *   2. International payments off (the default): no link for a dollar invoice, and why — on the invoice page and in
 *      the portal, where the Pay button would be.
 *   3. Switched on: a link in dollars for the invoice's open dollar balance; a yen invoice's in whole yen.
 *   4. Paid: the notice has us ask, and the payment is recorded in dollars at the day's rate, allocated to the
 *      invoice, in the default (rupee) account — and the existing settlement posts the realised exchange gain.
 *   5. A gateway reporting a different currency from the one asked: held for a person, not recorded; no new link
 *      asks the customer again until the balance moves.
 *   6. A rupee invoice as before: paise, rate 1, no exchange entry.
 *   7. A reminder for a dollar invoice carries its link.
 *
 * Only ever against fakes — neither gateway's real API has seen a foreign-currency link from Deskzo.
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:foreign-pay-links
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
class PdfError extends Error {}
const pdf = { renderPdf: async () => Buffer.from("%PDF-1.4 zz"), PdfError, PDF_MAX_BYTES: 3 * 1024 * 1024 };
const renderTarget = { renderTarget: async (p: string) => ({ url: `http://localhost:3000${p}`, hostRules: null }) };
const renderGrant = { mintRenderGrant: async () => "zz-grant" };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
  ["@/lib/documents/pdf", pdf],
  ["@/lib/tenancy/render-target", renderTarget],
  ["@/lib/documents/render-grant", renderGrant],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/documents/pdf"), pdf],
  [load.resolve("../src/lib/tenancy/render-target"), renderTarget],
  [load.resolve("../src/lib/documents/render-grant"), renderGrant],
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

// ── A fake Razorpay and Cashfree, which keep and report each link's currency ─────────────────────

type FakeLink = { id: string; provider: "RAZORPAY" | "CASHFREE"; amount: number; currency: string; paid: number; status: string; paymentId: string };
const fake = {
  links: new Map<string, FakeLink>(),
  calls: [] as { method: string; url: string; body: Record<string, unknown> | null }[],
  /** What the fake says a link's currency is, where it should lie. */
  reportCurrency: new Map<string, string>(),
};
let linkSeq = 0;
const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
async function gatewayFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (!/razorpay\.com|cashfree\.com/.test(url)) return realFetch(input, init);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  fake.calls.push({ method: init?.method ?? "GET", url, body });
  if (url.includes("razorpay.com")) {
    if (/\/payment_links\?count=1$/.test(url)) return json(200, { payment_links: [] });
    if (url.endsWith("/payment_links") && init?.method === "POST") {
      const id = `plink_fx${++linkSeq}`;
      fake.links.set(id, { id, provider: "RAZORPAY", amount: Number(body!.amount), currency: String(body!.currency), paid: 0, status: "created", paymentId: `pay_fx${linkSeq}` });
      return json(200, { id, short_url: `https://rzp.io/i/fx${linkSeq}`, status: "created", amount: body!.amount, amount_paid: 0, currency: body!.currency });
    }
    const cancel = /\/payment_links\/([^/]+)\/cancel$/.exec(url);
    if (cancel) {
      const l = fake.links.get(decodeURIComponent(cancel[1]!));
      if (!l || l.status === "paid") return json(400, { error: { description: "Payment link cannot be cancelled" } });
      l.status = "cancelled";
      return json(200, { id: l.id, status: "cancelled" });
    }
    const get = /\/payment_links\/([^/?]+)$/.exec(url);
    if (get) {
      const l = fake.links.get(decodeURIComponent(get[1]!));
      if (!l) return json(404, { error: { description: "not found" } });
      return json(200, {
        id: l.id,
        short_url: `https://rzp.io/i/${l.id}`,
        status: l.status,
        amount: l.amount,
        amount_paid: l.paid,
        currency: fake.reportCurrency.get(l.id) ?? l.currency,
        payments: l.paid ? [{ payment_id: l.paymentId, amount: l.paid, method: "card", status: "captured", created_at: Math.floor(Date.now() / 1000) }] : null,
      });
    }
  }
  const base = url.replace(/^https:\/\/(sandbox|api)\.cashfree\.com\/pg/, "");
  if (base === "/links" && init?.method === "POST") {
    const id = String(body!.link_id);
    fake.links.set(id, { id, provider: "CASHFREE", amount: Number(body!.link_amount), currency: String(body!.link_currency), paid: 0, status: "ACTIVE", paymentId: `cf_order_${++linkSeq}` });
    return json(200, { link_id: id, link_url: `https://payments-test.cashfree.com/links/${id}`, link_status: "ACTIVE", link_amount: body!.link_amount, link_currency: body!.link_currency, link_amount_paid: 0 });
  }
  return json(404, { message: `the fake has no ${url}` });
}
globalThis.fetch = gatewayFetch as typeof fetch;
const payAtGateway = (providerLinkId: string) => {
  const l = fake.links.get(providerLinkId)!;
  l.paid = l.amount;
  l.status = l.provider === "RAZORPAY" ? "paid" : "PAID";
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_fxpaylinks`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const collect = require("../src/actions/payment-collection") as typeof import("../src/actions/payment-collection");
    const links = require("../src/lib/collect/links") as typeof import("../src/lib/collect/links");
    const reminders = require("../src/lib/collect/reminders") as typeof import("../src/lib/collect/reminders");
    const api = require("../src/lib/collect/gateway-api") as typeof import("../src/lib/collect/gateway-api");
    const portal = require("../src/actions/portal-public") as typeof import("../src/actions/portal-public");
    const webhook = require("../src/app/api/collect/[provider]/route") as typeof import("../src/app/api/collect/[provider]/route");
    const rates = require("../src/lib/finance/rates") as typeof import("../src/lib/finance/rates");
    const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
    const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const caught: { to: string; subject: string; text?: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void caught.push({ to: m.to, subject: m.subject, text: m.text }));
    // The rate lookup never reaches the network: a day with no rate kept has none.
    rates.rateLookup.lookup = async () => ({ ok: false as const, reason: "the check never looks a rate up" });

    const DAY = 86_400_000;
    const DEADLINE = new Date(Date.now() + 30 * DAY);

    section("1. The gateways' calls");
    const rzpKeys = { provider: "RAZORPAY" as const, mode: "TEST" as const, keyId: "rzp_test_fx", secret: "fxsecret" };
    const usd = await api.gatewayApi("RAZORPAY").create(rzpKeys, { reference: "FX-1", amount: 1234.56, currency: "USD", purpose: "x", customer: { name: "Zz", email: null, phone: null }, expiresAt: DEADLINE, notifyUrl: null, notes: {} });
    const usdCall = fake.calls.at(-1)!;
    ok("Razorpay: dollars in cents, with the currency", usdCall.body?.amount === 123456 && usdCall.body?.currency === "USD", usdCall.body);
    ok("  read back in dollars, its currency named", usd.amount === 1234.56 && usd.currency === "USD", usd);
    await api.gatewayApi("RAZORPAY").create(rzpKeys, { reference: "FX-2", amount: 15000, currency: "JPY", purpose: "x", customer: { name: "Zz", email: null, phone: null }, expiresAt: DEADLINE, notifyUrl: null, notes: {} });
    ok("  yen in whole yen — no decimals", fake.calls.at(-1)!.body?.amount === 15000 && fake.calls.at(-1)!.body?.currency === "JPY", fake.calls.at(-1)!.body);
    const cfKeys = { provider: "CASHFREE" as const, mode: "TEST" as const, keyId: "cf_app_fx", secret: "cfsecret" };
    const cf = await api.gatewayApi("CASHFREE").create(cfKeys, { reference: "FX-3", amount: 15000.4, currency: "JPY", purpose: "x", customer: { name: "Zz", email: null, phone: "9810000000" }, expiresAt: DEADLINE, notifyUrl: null, notes: {} });
    const cfCall = fake.calls.at(-1)!;
    ok("Cashfree: link_currency, the amount in yen rounded to whole yen", cfCall.body?.link_currency === "JPY" && cfCall.body?.link_amount === 15000 && cf.currency === "JPY", cfCall.body);
    await api.gatewayApi("CASHFREE").create(cfKeys, { reference: "FX-4", amount: 99.999, currency: "USD", purpose: "x", customer: { name: "Zz", email: null, phone: "9810000000" }, expiresAt: DEADLINE, notifyUrl: null, notes: {} });
    ok("  dollars rounded to cents", fake.calls.at(-1)!.body?.link_amount === 100 && fake.calls.at(-1)!.body?.link_currency === "USD", fake.calls.at(-1)!.body);

    // ── People, a customer, invoices ──
    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-fxlinks.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Fx Boss", { role: "ADMIN", isSuperAdmin: true });
    const rep = await person("Zz Fx Rep");
    actor = { id: boss.id, name: boss.name, email: boss.email!, role: boss.role };
    await journal.ensureChartOfAccounts(db);
    const acme = await db.company.create({ data: { name: "Zz Globex Inc", normalizedName: "zz globex inc", relationshipType: "CLIENT", createdById: boss.id, ownerUserId: rep.id }, select: { id: true } });
    await db.contact.create({ data: { companyId: acme.id, name: "Hank Zz", email: "ap@zz-globex.com", phone: "9810000003", receivesDocuments: true, isPrimary: true } });
    const clock = await workspaceClock();
    const today = clock.calendarDate(new Date());
    const todayKey = today.toISOString().slice(0, 10);
    const dayFrom = (n: number) => new Date(today.getTime() + n * DAY);
    let seq = 0;
    const invoice = async (currency: string, rate: number, total: number, due = dayFrom(10)) => {
      seq += 1;
      const row = await db.tradeDocument.create({
        data: { docNumber: `ZZFX-INV-${seq}`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: acme.id, createdById: boss.id, salespersonId: rep.id, issueDate: dayFrom(-20), dueDate: due, currency, exchangeRate: rate, subtotal: total, taxableValue: total, total },
        select: { id: true, docNumber: true },
      });
      await db.$transaction((t) => journal.postDocumentToLedger(t, row.id, boss.id), { timeout: 60_000 });
      return row;
    };
    const linkCreates = () => fake.calls.filter((c) => c.method === "POST" && c.url.endsWith("/payment_links")).length;

    section("2. International payments off");
    const connected = await collect.connectGateway({ provider: "RAZORPAY", mode: "TEST", keyId: "rzp_test_fx", secret: "fxsecret", bankAccountId: "", isDefault: true });
    ok("(Razorpay connected)", connected.ok, connected.ok ? "" : connected.error);
    const view = await collect.paymentCollectionView();
    ok("off by default", view.ok && view.data.gateways[0]?.internationalOn === false);
    const usdInv = await invoice("USD", 83, 1000);
    const before = linkCreates();
    const off = await links.payLinkFor(usdInv.id, boss.id);
    ok("no link for a dollar invoice, and why", !off.ok && off.error.includes("international payments") && off.error.includes("USD") && linkCreates() === before, off.ok ? off.link : off.error);
    const offState = await collect.invoicePayLinkState(usdInv.id);
    ok("  the invoice page says why where the button would be", offState.ok && offState.data.gateway === null && !!offState.data.unavailable?.includes("Settings › Payment collection"), offState.ok ? offState.data : offState.error);
    await db.portalSettings.upsert({ where: { id: "global" }, create: { id: "global", enabled: true }, update: { enabled: true } });
    await db.company.update({ where: { id: acme.id }, data: { portalEnabled: true } });
    const loginToken = `zzfxportal${"x".repeat(40)}`;
    await db.portalLogin.create({ data: { companyId: acme.id, token: loginToken, personName: "Hank Zz", personEmail: "ap@zz-globex.com" } });
    {
      const row = (await portal.portalInvoices(loginToken)).find((i) => i.id === usdInv.id);
      ok("  the portal: no Pay button, and a line saying so, in dollars", row?.payable === false && !!row.payNote?.includes("USD") && row.currency === "USD" && row.balance === 1000, row);
    }

    section("3. Switched on");
    const on = await collect.connectGateway({ provider: "RAZORPAY", mode: "TEST", keyId: "", secret: "", bankAccountId: "", isDefault: true, internationalOn: true });
    const viewOn = await collect.paymentCollectionView();
    ok("switched on in the settings", on.ok && viewOn.ok && viewOn.data.gateways[0]?.internationalOn === true, on.ok ? "" : on.error);
    const usdLink = await links.payLinkFor(usdInv.id, boss.id);
    const usdCreate = fake.calls.at(-1)!;
    ok("a dollar link for the open dollar balance — $1,000 as 100000 cents", usdLink.ok && usdLink.link.currency === "USD" && usdLink.link.amount === 1000 && usdCreate.body?.amount === 100000 && usdCreate.body?.currency === "USD", usdLink.ok ? usdCreate.body : usdLink.error);
    const usdRow = await db.paymentLink.findFirst({ where: { documentId: usdInv.id, status: "ACTIVE" } });
    ok("  kept in dollars", usdRow?.currency === "USD" && Number(usdRow.amount) === 1000);
    const again = await links.payLinkFor(usdInv.id, null);
    ok("  asked again, the same link", again.ok && usdLink.ok && again.link.url === usdLink.link.url);
    const onState = await collect.invoicePayLinkState(usdInv.id);
    ok("  the invoice page shows it", onState.ok && onState.data.gateway === "Razorpay" && onState.data.unavailable === null && onState.data.link?.currency === "USD");
    {
      const row = (await portal.portalInvoices(loginToken)).find((i) => i.id === usdInv.id);
      ok("  the portal: a Pay button, no note", row?.payable === true && row.payNote === null, row);
      const pay = await portal.portalPayLink(loginToken, usdInv.id);
      ok("  Pay opens the dollar link", pay.ok && usdLink.ok && pay.url === usdLink.link.url, pay);
    }
    const jpyInv = await invoice("JPY", 0.56, 15000);
    const jpyLink = await links.payLinkFor(jpyInv.id, boss.id);
    ok("a yen invoice: ¥15,000 as 15000 — no decimals", jpyLink.ok && jpyLink.link.currency === "JPY" && jpyLink.link.amount === 15000 && fake.calls.at(-1)!.body?.amount === 15000 && fake.calls.at(-1)!.body?.currency === "JPY", fake.calls.at(-1)!.body);

    section("4. Paid in dollars");
    await rates.storeRate({ currency: "USD", day: todayKey, rate: 84.1, source: "typed", setById: boss.id });
    payAtGateway(usdRow!.providerLinkId);
    const notice = (body: unknown) =>
      webhook.POST(new Request("http://localhost/api/collect/razorpay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ provider: "razorpay" }) });
    await notice({ event: "payment_link.paid", payload: { payment_link: { entity: { id: usdRow!.providerLinkId } } } });
    const paidLink = await db.paymentLink.findUnique({ where: { id: usdRow!.id } });
    const payment = paidLink?.paymentId ? await db.payment.findUnique({ where: { id: paidLink.paymentId }, include: { allocations: true } }) : null;
    ok("the notice has us ask: recorded once, as a payment", paidLink?.status === "PAID" && !!payment, paidLink?.status);
    ok("  in dollars, $1,000, at the day's rate of 84.10", payment?.currency === "USD" && Number(payment.amount) === 1000 && Number(payment.exchangeRate) === 84.1, { currency: payment?.currency, amount: payment?.amount, rate: payment?.exchangeRate });
    ok("  allocated to the invoice in full, by card", payment?.allocations.length === 1 && payment.allocations[0]!.documentId === usdInv.id && Number(payment.allocations[0]!.amount) === 1000 && payment.method === "CARD");
    ok("  in the default account — the gateway settles rupees", payment?.bankAccountId === null);
    ok("  the invoice paid", (await db.tradeDocument.findUnique({ where: { id: usdInv.id }, select: { status: true } }))?.status === "PAID");
    const entries = payment
      ? await db.journalEntry.findMany({ where: { paymentId: payment.id }, select: { source: true, lines: { select: { debit: true, credit: true, account: { select: { systemKey: true } } } } } })
      : [];
    const lineOf = (source: string, key: string) => entries.find((e) => e.source === source)?.lines.find((l) => l.account.systemKey === key);
    ok("  posted: Dr Bank ₹84,100 / Cr AR ₹84,100", Number(lineOf("PAYMENT", "BANK")?.debit) === 84100 && Number(lineOf("PAYMENT", "AR")?.credit) === 84100, entries.map((e) => e.source));
    ok("  and the realised gain: Dr AR ₹1,100 / Cr exchange gain ₹1,100", Number(lineOf("FX", "AR")?.debit) === 1100 && Number(lineOf("FX", "FX_GAIN_LOSS")?.credit) === 1100);
    const arLeft = await db.journalLine.aggregate({ where: { account: { systemKey: "AR" }, companyId: acme.id, entry: { OR: [{ documentId: usdInv.id }, { paymentId: payment?.id ?? "-" }] } }, _sum: { debit: true, credit: true } });
    ok("  AR for the invoice is nil", Math.round((Number(arLeft._sum.debit ?? 0) - Number(arLeft._sum.credit ?? 0)) * 100) === 0, arLeft._sum);
    ok("  the salesperson told, in dollars", (await db.notification.count({ where: { userId: rep.id, type: "PAYMENT_RECEIVED_ONLINE", title: { contains: "$" } } })) === 1);
    await links.confirmLink(usdRow!.id);
    ok("  asked again: still one payment", (await db.payment.count({ where: { companyId: acme.id, currency: "USD" } })) === 1);

    section("5. Paid in a currency other than the one asked");
    const oddInv = await invoice("USD", 83, 500);
    const oddLink = await links.payLinkFor(oddInv.id, boss.id);
    const oddRow = await db.paymentLink.findFirst({ where: { documentId: oddInv.id, status: "ACTIVE" } });
    payAtGateway(oddRow!.providerLinkId);
    fake.reportCurrency.set(oddRow!.providerLinkId, "INR");
    const paymentsBefore = await db.payment.count();
    const outcome = await links.confirmLink(oddRow!.id);
    const held = await db.paymentLink.findUnique({ where: { id: oddRow!.id }, select: { status: true, paymentId: true, heldReason: true } });
    ok("held, not recorded: no payment, the link paid at the gateway with why", oddLink.ok && outcome === "paid" && held?.status === "PAID" && held.paymentId === null && !!held.heldReason?.includes("INR") && (await db.payment.count()) === paymentsBefore, held);
    ok("  the invoice still open", (await db.tradeDocument.findUnique({ where: { id: oddInv.id }, select: { status: true } }))?.status !== "PAID");
    ok("  the salesperson told to check it", (await db.notification.count({ where: { userId: rep.id, title: { contains: "needs checking" } } })) === 1);
    const blocked = await links.payLinkFor(oddInv.id, boss.id);
    ok("  no new link asks the customer again", !blocked.ok && blocked.error.includes("record it by hand"), blocked.ok ? blocked.link : blocked.error);
    const heldState = await collect.invoicePayLinkState(oddInv.id);
    ok("  the invoice page says so", heldState.ok && !!heldState.data.held?.includes("INR"));
    await links.sweepPayLinks(new Date(Date.now() + 3600_000));
    ok("  the sweep leaves it alone", (await db.payment.count()) === paymentsBefore);

    section("6. A rupee invoice as before");
    const inrInv = await invoice("INR", 1, 11800);
    const inrLink = await links.payLinkFor(inrInv.id, boss.id);
    ok("a rupee link in paise, currency INR", inrLink.ok && inrLink.link.currency === "INR" && fake.calls.at(-1)!.body?.amount === 1180000 && fake.calls.at(-1)!.body?.currency === "INR", fake.calls.at(-1)!.body);
    const inrRow = await db.paymentLink.findFirst({ where: { documentId: inrInv.id, status: "ACTIVE" } });
    payAtGateway(inrRow!.providerLinkId);
    await links.confirmLink(inrRow!.id);
    const inrPay = await db.payment.findFirst({ where: { allocations: { some: { documentId: inrInv.id } } } });
    ok("  paid: ₹11,800 at rate 1", inrPay?.currency === "INR" && Number(inrPay.amount) === 11800 && Number(inrPay.exchangeRate) === 1);
    ok("  no exchange entry", inrPay ? (await db.journalEntry.count({ where: { paymentId: inrPay.id, source: "FX" } })) === 0 : false);

    section("7. A reminder for a dollar invoice");
    const remInv = await invoice("USD", 83, 250, dayFrom(0));
    const saved = await collect.saveReminderSettings({ on: true, senderUserId: boss.id, steps: null, statementOn: false, whatsappTemplate: "" });
    ok("(reminders on)", saved.ok, saved.ok ? "" : saved.error);
    const ten = clock.at(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 10, 0);
    caught.length = 0;
    await reminders.runPaymentReminders(ten);
    const mail = caught.find((m) => m.subject.includes(remInv.docNumber ?? "-"));
    const remLink = await db.paymentLink.findFirst({ where: { documentId: remInv.id, status: "ACTIVE" } });
    ok("due today: the reminder carries the dollar link", !!mail?.text?.includes("pay it online") && !!remLink && remLink.currency === "USD" && !!mail.text.includes(remLink.url) && mail.text.includes("$250.00"), mail?.text?.slice(0, 300));
  } finally {
    actor = null;
    globalThis.fetch = realFetch;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} foreign pay-link checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
