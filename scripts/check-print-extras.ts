/**
 * check:print-extras — what a printed document carries besides itself (owner, 29 Oct 2026; src/lib/documents/print-extras.ts):
 * Rule 48's copies — triplicate for goods, duplicate for services, each labelled and on its own page — and a UPI
 * scan-to-pay code for what a customer still owes. On a scratch workspace database, dropped at the end.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { notFound: () => { throw new Error("NOT_FOUND"); }, redirect: () => {}, useRouter: () => ({ push() {}, refresh() {}, replace() {} }), usePathname: () => "/documents/x/print", useSearchParams: () => new URLSearchParams() };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: "ADMIN", name: "Zz", email: `${actorId}@zzprint.invalid` } : null);
    return {
      requireUser: async () => {
        const u = await user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: user,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is needed.");
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("Only against a local database server.");
  const scratchName = `${new URL(url).pathname.slice(1)}_print_extras_check`;
  const scratchUrl = withDatabase(url, scratchName);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from its migrations", true);
    // Off by value, never deleted, so a client re-reading .env can't put them back.
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = " ";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    await scenario();
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${scratchName}`;
    ok("the scratch workspace is dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }
  console.log(failures === 0 ? "\nAll print extras checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

async function scenario() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const extras = require("../src/lib/documents/print-extras") as typeof import("../src/lib/documents/print-extras");
  const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
  const PrintPage = (require("../src/app/(print)/documents/[id]/print/page") as { default: (p: unknown) => Promise<unknown> }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("The rules");
  const goods = extras.ruleCopies("INVOICE", [{ hsnCode: "8471" }, { hsnCode: "997331" }]);
  const services = extras.ruleCopies("INVOICE", [{ hsnCode: "997331" }, { hsnCode: "998314" }]);
  ok("an invoice of goods is in triplicate: recipient, transporter, supplier", goods?.join("|") === "Original for recipient|Duplicate for transporter|Triplicate for supplier", goods);
  ok("  one of services alone in duplicate: recipient, supplier", services?.join("|") === "Original for recipient|Duplicate for supplier", services);
  ok("  a quote or a purchase order in none", extras.ruleCopies("PROPOSAL", [{ hsnCode: "8471" }]) === null && extras.ruleCopies("PURCHASE_ORDER", [{ hsnCode: "8471" }]) === null);
  ok("  the original alone unless all are asked for", extras.copiesToPrint(goods, undefined).length === 1 && extras.copiesToPrint(goods, "all").length === 3 && extras.copiesToPrint(null, "all")[0] === null);
  const doc = { docType: "INVOICE" as const, status: "ISSUED" as const, currency: "INR", total: 1180, docNumber: "INV/26-27/0007" };
  const link = extras.upiPayLink(doc, "wroffy@hdfcbank", "Zz Wroffy & Co");
  ok("the UPI link: our ID with its @ as it is, our name, the amount, rupees, the number", link === "upi://pay?pa=wroffy@hdfcbank&pn=Zz%20Wroffy%20%26%20Co&am=1180.00&cu=INR&tn=INV%2F26-27%2F0007", link);
  ok("  part-paid: no amount, for the payer to type", !extras.upiPayLink({ ...doc, status: "PARTIALLY_PAID" }, "wroffy@hdfcbank", "Zz")!.includes("am="));
  ok(
    "  none when paid, cancelled, in dollars, a bill, or with no UPI ID that is one",
    [extras.upiPayLink({ ...doc, status: "PAID" }, "a@b", "Zz"), extras.upiPayLink({ ...doc, status: "CANCELLED" }, "wroffy@hdfc", "Zz"), extras.upiPayLink({ ...doc, currency: "USD" }, "wroffy@hdfc", "Zz"), extras.upiPayLink({ ...doc, docType: "BILL" }, "wroffy@hdfc", "Zz"), extras.upiPayLink(doc, "not an id", "Zz"), extras.upiPayLink(doc, null, "Zz")].every((x) => x === null),
  );

  const untaxed = { docType: "INVOICE" as const, gstTreatment: "UNREGISTERED", cgstAmount: 0, sgstAmount: 0, igstAmount: 0, lines: [{ taxRatePercent: 0 }] };
  ok("an invoice with no tax on any line is a bill of supply, with Rule 49's declaration", extras.printedTitle(untaxed, "Tax invoice").title === "Bill of supply" && !!extras.printedTitle(untaxed, "Tax invoice").declaration);
  ok(
    "  a taxed line, an export, an SEZ supply or a credit note keeps its own name",
    [
      extras.printedTitle({ ...untaxed, cgstAmount: 9, sgstAmount: 9, lines: [{ taxRatePercent: 0 }, { taxRatePercent: 18 }] }, "Tax invoice"),
      extras.printedTitle({ ...untaxed, gstTreatment: "OVERSEAS" }, "Tax invoice"),
      extras.printedTitle({ ...untaxed, gstTreatment: "SEZ" }, "Tax invoice"),
      extras.printedTitle({ ...untaxed, docType: "CREDIT_NOTE" }, "Credit note"),
    ].every((t) => t.declaration === null && t.title !== "Bill of supply"),
  );

  section("On the printed invoice");
  const boss = await db.user.create({ data: { name: "Zz Boss", email: "boss@zzprint.invalid", role: "ADMIN", isSuperAdmin: true, passwordHash: "x".repeat(60) } });
  actorId = boss.id;
  await db.organisationBankAccount.create({ data: { label: "Zz HDFC", bankName: "HDFC Bank", accountNumber: "50200012345678", ifsc: "HDFC0000123", upiId: "wroffy@hdfcbank", isPrimary: true } });
  const company = await db.company.create({ data: { name: "Zz Juniper Pharma", normalizedName: "zz juniper pharma", relationshipType: "CLIENT", createdById: boss.id, ownerUserId: boss.id } });
  const invoice = await db.tradeDocument.create({
    data: {
      docType: "INVOICE", direction: "SALES", status: "ISSUED", docNumber: "ZZP/INV/1", companyId: company.id, createdById: boss.id, issueDate: new Date("2026-10-01T00:00:00Z"),
      subtotal: 1000, taxableValue: 1000, igstAmount: 180, total: 1180,
      lines: { create: [{ name: "Zz Laptop stand", quantity: 1, unitPrice: 1000, hsnCode: "8473", taxRatePercent: 18, taxableValue: 1000, igstAmount: 180, lineTotal: 1180 }] },
    },
    select: { id: true },
  });
  const render = (copies?: string) => renderHtml(PrintPage({ params: Promise.resolve({ id: invoice.id }), searchParams: Promise.resolve({ embed: "1", ...(copies ? { copies } : {}) }) }));
  const one = await render();
  ok("printed once: marked the original for the recipient, with the UPI code to pay it", one.includes("Original for recipient") && !one.includes("Duplicate for transporter") && one.includes("Scan to pay by UPI") && one.includes("UPI QR code to pay this document"), one.length);
  const all = await render("all");
  const pages = (all.match(/break-after:page/g) ?? []).length;
  ok("all copies: original, duplicate for the transporter, triplicate for the supplier — each on its own page", ["Original for recipient", "Duplicate for transporter", "Triplicate for supplier"].every((l) => all.includes(l)) && pages === 2, { pages });
  await db.tradeDocument.update({ where: { id: invoice.id }, data: { status: "PAID" } });
  ok("  a paid invoice carries no code to pay it", !(await render()).includes("Scan to pay by UPI"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
