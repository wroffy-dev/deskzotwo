/**
 * check:statement-print — a customer's statement of accounts to print, download and email (owner, 31 Oct 2026 —
 * src/lib/statements, src/actions/statement-send.ts).
 *
 *   1. The account summary for a period: brought forward, invoiced, received, the balance due — and the lines.
 *   2. Outstanding only: what is still open on each invoice.
 *   3. Who may: payments.view and the account; anybody else gets nothing.
 *   4. The server's pass: once, for this statement, and the print path the proxy lets through.
 *   5. The PDF: its own print page, for the period and view asked, opened with a pass.
 *   6. Send email: to the customer's contacts, the PDF attached, logged per person and in the activity.
 *
 * In a scratch workspace built from the migrations, dropped after; mail and the PDF browser are stand-ins.
 *
 *   npm run check:statement-print
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
const sent: { to: { email: string }[]; subject: string; attachment?: { filename: string; content: Buffer } }[] = [];
const mailRoute = {
  documentSender: async () => ({ choice: "OWN", company: null }),
  sendDocumentMail: async (_choice: string, mail: (typeof sent)[number]) => {
    sent.push(mail);
    return { ok: true, from: "me@zz-stmt.in", via: "OWN", label: "their mailbox" };
  },
};
const mailbox = { mailboxState: async () => ({ state: "connected", mailbox: "me@zz-stmt.in", provider: "GOOGLE", providers: ["GOOGLE"] }) };
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
  ["@/lib/documents/mail-route", mailRoute],
  ["@/lib/mail/mailbox", mailbox],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/documents/mail-route"), mailRoute],
  [load.resolve("../src/lib/mail/mailbox"), mailbox],
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

const day = (d: string) => new Date(`${d}T00:00:00Z`);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_stmtprint`;
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
    const data = require("../src/lib/statements/print-data") as typeof import("../src/lib/statements/print-data");
    const render = require("../src/lib/statements/render") as typeof import("../src/lib/statements/render");
    const paths = require("../src/lib/statements/paths") as typeof import("../src/lib/statements/paths");
    const pdf = require("../src/lib/documents/pdf") as typeof import("../src/lib/documents/pdf");
    const send = require("../src/actions/statement-send") as typeof import("../src/actions/statement-send");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-stmt.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    const rep = await person("Zz Rep");
    const as = (u: { id: string; name: string; email: string | null; role: string }) => (actor = { id: u.id, name: u.name, email: u.email!, role: u.role });
    const acme = await db.company.create({
      data: { name: "Zz Acme Pvt Ltd", normalizedName: "zz acme pvt ltd", relationshipType: "CLIENT", stage: "CUSTOMER", createdById: boss.id, ownerUserId: boss.id, locations: { create: { label: "HO", isPrimary: true, isBilling: true, address: "82, Sukhdev Vihar", city: "New Delhi", pincode: "110025", state: "Delhi", country: "India", gstNumber: "07ZZACM1234K1Z5" } } },
      select: { id: true },
    });
    const ravi = await db.contact.create({ data: { companyId: acme.id, name: "Ravi Accounts", email: "ravi@zz-acme.in", receivesDocuments: true, createdByUserId: boss.id }, select: { id: true } });
    let n = 0;
    const invoice = (total: number, issued: string) =>
      db.tradeDocument.create({ data: { docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: acme.id, docNumber: `ZZST-${++n}`, taxableValue: total, total, createdById: boss.id, issueDate: day(issued), dueDate: day(issued) } as never, select: { id: true } });
    const inv1 = await invoice(10000, "2026-09-20");
    await invoice(5000, "2026-10-05");
    const paid = await db.payment.create({ data: { companyId: acme.id, amount: 6000, paidOn: day("2026-10-10"), method: "BANK_TRANSFER", recordedByUserId: boss.id } as never, select: { id: true } });
    await db.paymentAllocation.create({ data: { paymentId: paid.id, documentId: inv1.id, amount: 6000, allocatedByUserId: boss.id } });

    section("1. The account summary for a period");
    const oct = await data.statementForPrint(boss.id, "AR", acme.id, { from: "2026-10-01", to: "2026-10-31" });
    ok("brought forward ₹10,000, invoiced ₹5,000, received ₹6,000, ₹9,000 due", !!oct && JSON.stringify(oct.summary) === JSON.stringify({ opening: 10000, raised: 5000, settled: 6000, closing: 9000 }), oct?.summary);
    ok("  the opening line first, then the invoice and the payment, the balance running to ₹9,000", oct?.lines.map((l) => `${l.kind}:${l.balance}`).join() === "OPENING:10000,INVOICE:15000,PAYMENT:9000", oct?.lines.map((l) => `${l.kind}:${l.balance}`));
    ok("  the customer's billing address and GSTIN", oct?.party.gstin === "07ZZACM1234K1Z5" && oct.party.lines.includes("82, Sukhdev Vihar"));
    const all = await data.statementForPrint(boss.id, "AR", acme.id, {});
    ok("no period: everything, nothing brought forward", all?.summary.opening === 0 && all.summary.raised === 15000 && all.summary.closing === 9000, all?.summary);

    section("2. Outstanding only");
    const open = await data.statementForPrint(boss.id, "AR", acme.id, { show: "outstanding" });
    ok("each invoice with what is still open on it", open?.show === "outstanding" && open.open.map((d) => `${d.docNumber}:${d.balance}`).sort().join() === "ZZST-1:4000,ZZST-2:5000", open?.open);

    section("3. Who may");
    ok("a rep without payments.view gets nothing", (await data.statementForPrint(rep.id, "AR", acme.id, {})) === null);
    ok("  nor a made-up company", (await data.statementForPrint(boss.id, "AR", "nope", {})) === null);

    section("4. The server's pass");
    const token = await render.mintStatementGrant("AR", acme.id, boss.id);
    ok("spent once, it names who it was minted for", (await render.spendStatementGrant(token, "AR", acme.id)) === boss.id);
    ok("  twice, nobody", (await render.spendStatementGrant(token, "AR", acme.id)) === null);
    const other = await render.mintStatementGrant("AR", acme.id, boss.id);
    ok("  for another statement, nobody", (await render.spendStatementGrant(other, "AP", acme.id)) === null);
    ok("the proxy lets through only a statement's print path", paths.statementPrintSubject(`/statements/AR/${acme.id}/print`) === `statement:AR:${acme.id}` && paths.statementPrintSubject(`/statements/XX/${acme.id}/print`) === null && paths.statementPrintSubject(`/statements/AR/${acme.id}`) === null);

    section("5. The PDF");
    let printed = "";
    pdf.setTestPdfRenderer(async (u) => {
      printed = u;
      return Buffer.from("%PDF-1.4 zz");
    });
    const file = await render.statementPdf(boss.id, "AR", acme.id, { from: "2026-10-01", to: "2026-10-31", show: "outstanding" });
    const printedUrl = new URL(printed);
    ok("its own print page, for the period and view asked, with a pass", file.toString().startsWith("%PDF") && printedUrl.pathname === `/statements/AR/${acme.id}/print` && printedUrl.searchParams.get("from") === "2026-10-01" && printedUrl.searchParams.get("show") === "outstanding" && !!printedUrl.searchParams.get("render"), printed);
    ok("  named for the customer and the period", render.statementFilename("Zz Acme Pvt Ltd", { from: "2026-10-01", to: "2026-10-31" }) === "Statement-Zz-Acme-Pvt-Ltd-2026-10-01-to-2026-10-31.pdf");

    section("6. Send email");
    as(rep);
    ok("a rep who may not see it can't send it", !(await send.sendStatement({ side: "AR", companyId: acme.id, view: {}, contactIds: [ravi.id], subject: "x", body: "y" })).ok);
    as(boss);
    const setup = await send.statementEmailSetup("AR", acme.id, { from: "2026-10-01", to: "2026-10-31" });
    ok("the dialog offers the customer's contacts and a subject naming the period", setup.ok && setup.data.recipients.some((r) => r.id === ravi.id && r.canReceive) && setup.data.subject.includes("1 Oct 2026"), setup.ok ? setup.data.subject : setup);
    const done = await send.sendStatement({ side: "AR", companyId: acme.id, view: { from: "2026-10-01", to: "2026-10-31" }, contactIds: [ravi.id], subject: "Your statement", body: "Attached." });
    ok("sent to Ravi with the PDF attached", done.ok && sent.length === 1 && sent[0]!.to[0]!.email === "ravi@zz-acme.in" && sent[0]!.attachment?.filename.endsWith(".pdf") === true, done);
    ok("  logged in the mail log and the activity", (await db.marketingMessage.count({ where: { companyId: acme.id, status: "SENT", toEmail: "ravi@zz-acme.in" } })) === 1 && (await db.auditLog.count({ where: { entityId: acme.id, entityLabel: { contains: "statement of accounts" } } })) === 1);
    ok("  somebody not a contact of theirs is refused", !(await send.sendStatement({ side: "AR", companyId: acme.id, view: {}, contactIds: [rep.id], subject: "x", body: "y" })).ok);
    // Field masking (owner, 5 Nov 2026 — Phase 3 masking fixes): an admin whose contacts policy masks names and addresses
    // sees the dialog's recipients masked; the statement, by the contact ids ticked, still goes to the real address.
    const accountant = await person("Zz Accountant", { role: "ADMIN" });
    await db.userFieldPolicy.createMany({
      data: [
        { field: "name", format: "first" },
        { field: "email", format: "email" },
      ].map((p) => ({ userId: accountant.id, entity: "contacts", view: true, maskInList: true, maskInDetail: true, unmask: true, reason: "zz stmt", ...p })),
    });
    as(accountant);
    const maskedSetup = await send.statementEmailSetup("AR", acme.id, { from: "2026-10-01", to: "2026-10-31" });
    const shownRavi = maskedSetup.ok ? maskedSetup.data.recipients.find((r) => r.id === ravi.id) : undefined;
    ok("masked for an admin: the dialog shows Ravi's name and address masked, still able to receive it", !!shownRavi && shownRavi.email !== "ravi@zz-acme.in" && /\*/.test(shownRavi.email ?? "") && shownRavi.name !== "Ravi Accounts" && shownRavi.canReceive, maskedSetup.ok ? shownRavi : maskedSetup);
    ok("  the dialog's recipients carry no raw address or name", maskedSetup.ok && !/ravi@zz-acme\.in|ravi accounts/i.test(JSON.stringify(maskedSetup.data.recipients)));
    const maskedSend = await send.sendStatement({ side: "AR", companyId: acme.id, view: { from: "2026-10-01", to: "2026-10-31" }, contactIds: [ravi.id], subject: "Your statement", body: "Attached." });
    ok("  and the statement, by contact id, goes to the real address", maskedSend.ok && sent.at(-1)?.to[0]?.email === "ravi@zz-acme.in", maskedSend);
    as(boss);
    pdf.setTestPdfRenderer(null);
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `
All ${passes} statement print checks passed.
` : `
${failures} check(s) FAILED (${passes} passed).
`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
