/**
 * check:migration-sections — the switch to Deskzo a section at a time (owner, 28 Oct 2026; src/lib/migration/sections.ts,
 * steps.ts `retryWaitingPart`, undo-section.ts, src/lib/zoho/pull.ts `handBooks` and `only`).
 *
 * On a scratch workspace database of its own (<db>_migration_sections_check, built from the migrations and dropped at the
 * end, pass or fail):
 *
 *   · out of order: receipts imported before their invoices wait for them — kept, not failed — and come across by
 *     themselves once the invoices are in, applied to them;
 *   · an invoice whose customer isn't here waits for the customers, and goes on once the customer is;
 *   · a stopped import carries on from where it stopped;
 *   · undoing one section: invoices take their receipts and credit notes with them, said first; refused while something
 *     made in Deskzo is set against them; the files stay to import again; receipts alone leave the invoices be;
 *   · pulling one module from Zoho: only its calls, handed to its section as soon as it is fetched — before the pull is
 *     over — and Zoho's daily limit waited for, for that module too;
 *   · part of a module handed over (owner, 25 Nov 2026 — the earlier years' quotes went): it only ever adds to what is
 *     kept, stopped or not; the earlier years' quotes come from Zoho's list, by themselves too, and their PDFs when asked;
 *   · an earlier document's PDF fetched from Zoho as it is opened (25 Nov 2026): who may, who makes no call, kept once,
 *     counted against the day's calls, and each thing that stops it said.
 *
 * The session is a stand-in; Zoho is a stand-in; nothing is written to any other database.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import Module from "node:module";
import Papa from "papaparse";
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
const file = (rows: Record<string, string>[], name: string) => ({
  filename: name,
  base64: Buffer.from(Papa.unparse({ fields: [...new Set(rows.flatMap((r) => Object.keys(r)))], data: rows })).toString("base64"),
});

let actorId = "";
const roles = new Map<string, string>();
let storageIsFull = false;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request.endsWith("lib/storage/allowance")) {
    const real = originalLoad.call(this, request, parent, isMain) as typeof import("../src/lib/storage/allowance");
    const assertRoomFor = async (bytes: number) => {
      if (storageIsFull) throw new real.StorageFull(10, 10);
      await real.assertRoomFor(bytes);
    };
    return { ...real, assertRoomFor };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} }),
      usePathname: () => "/settings/data/switch",
      useSearchParams: () => new URLSearchParams(),
      notFound: () => {
        throw new Error("NOT_FOUND");
      },
      redirect: (to: string) => {
        throw new Error(`REDIRECT ${to}`);
      },
    };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "PROFILE", name: "Zz Sections", email: `${actorId}@zzsections.invalid` } : null);
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
  const scratchName = `${new URL(url).pathname.slice(1)}_migration_sections_check`;
  const scratchUrl = withDatabase(url, scratchName);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from its migrations", true);
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
  console.log(failures === 0 ? "\nAll migration section checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

async function scenario() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const actions = require("../src/actions/migration") as typeof import("../src/actions/migration");
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
  const SwitchPage = (require("../src/app/(dashboard)/settings/data/switch/page") as { default: () => Promise<unknown> }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  await journal.ensureChartOfAccounts();
  const boss = await db.user.create({ data: { name: "Zz Boss", email: "boss@zzsections.invalid", role: "ADMIN", passwordHash: "x".repeat(60), isSuperAdmin: true } });
  roles.set(boss.id, "ADMIN");
  const clerk = await db.user.create({ data: { name: "Zz Clerk", email: "clerk@zzsections.invalid", role: "PROFILE", passwordHash: "x".repeat(60) } });
  roles.set(clerk.id, "PROFILE");
  for (const permission of ["ledger.post", "data.importFinance"]) await db.userPermission.create({ data: { userId: clerk.id, permission, allowed: true, reason: "check:migration-sections" } });
  const company = async (name: string) => {
    const c = await db.company.create({ data: { name, normalizedName: name.toLowerCase(), relationshipType: "CLIENT", createdById: boss.id, ownerUserId: boss.id } });
    await db.companyLocation.create({ data: { companyId: c.id, label: "Head office", isPrimary: true, state: "Maharashtra", gstNumber: "27AAACZ1234F1Z5", gstTreatment: "REGISTERED_REGULAR", city: "Pune", address: "1 Road", pincode: "411001", country: "India" } });
    return c;
  };
  const acme = await company("Zz Acme Traders");
  const hdfc = await db.ledgerAccount.create({ data: { code: "ZZ-HDFC", name: "Zz HDFC Current", type: "ASSET" } });
  await db.bankAccount.create({ data: { name: "Zz HDFC", ledgerAccountId: hdfc.id } });

  actorId = clerk.id;
  const started = await actions.startMigrationAction({ source: "zoho-books", yearStart: "2026-04-01", switchDate: "2026-07-01" });
  ok("a switch to bring April to June across", started.ok, started);

  // 45 invoices for Acme, and one for a customer Deskzo hasn't got yet — as Zoho exports them, a row a line.
  const invoice = (n: number, customer = "Zz Acme Traders") => ({
    "Invoice Number": `ZZS-INV-${String(n).padStart(3, "0")}`,
    "Invoice Date": `2026-05-${String(1 + (n % 28)).padStart(2, "0")}`,
    "Customer Name": customer,
    "Invoice Status": "Sent",
    "Item Name": "Widget",
    Quantity: "1",
    "Item Price": "1000",
    "Item Tax %": "18",
    Total: "1180",
  });
  const invoiceRows = [...Array.from({ length: 45 }, (_, i) => invoice(i + 1)), invoice(46, "Zz Newco Ltd")];
  const receiptRows = [
    { "Payment Number": "ZZS-PAY-001", Date: "2026-06-01", "Customer Name": "Zz Acme Traders", Amount: "1180", "Payment Mode": "Bank Transfer", "Deposit To": "Zz HDFC", "Invoice Number": "ZZS-INV-001", "Amount Applied to Invoice": "1180" },
    { "Payment Number": "ZZS-PAY-002", Date: "2026-06-02", "Customer Name": "Zz Acme Traders", Amount: "1180", "Payment Mode": "Bank Transfer", "Deposit To": "Zz HDFC", "Invoice Number": "ZZS-INV-002", "Amount Applied to Invoice": "1180" },
  ];
  const creditRows = [{ "Credit Note Number": "ZZS-CN-001", "Credit Note Date": "2026-06-05", "Customer Name": "Zz Acme Traders", "Invoice Number": "ZZS-INV-003", "Item Name": "Return", Quantity: "1", "Item Price": "100", "Item Tax %": "18", Total: "118" }];

  const upload = async (step: string, rows: Record<string, string>[]) => {
    const up = await actions.uploadMigrationFile(step, file(rows, `${step}.csv`));
    if (!up.ok) throw new Error(`${step}: ${up.error}`);
    return up.data.fileId;
  };
  const importAll = async (fileId: string) => {
    for (;;) {
      const r = await actions.importMigrationPart(fileId);
      if (!r.ok) throw new Error(r.error);
      if (r.data.done >= r.data.units) return r.data;
    }
  };
  const retryAll = async (fileId: string, waitFor: string[] | null) => {
    let after = -1;
    let created = 0;
    for (;;) {
      const r = await actions.retryMigrationWaiting(fileId, waitFor, after);
      if (!r.ok) throw new Error(r.error);
      created += r.data.created;
      if (r.data.left === 0) return { created, failed: r.data.failed };
      after = r.data.after;
    }
  };
  const migrated = (docType: "INVOICE" | "CREDIT_NOTE") => db.tradeDocument.count({ where: { docType, origin: "MIGRATED" } });

  section("Out of order: receipts before their invoices");
  const receiptsFile = await upload("receipts", receiptRows);
  const early = await importAll(receiptsFile);
  ok("both receipts wait for the invoices — kept with where they are, not failed", early.created === 0 && early.failed.length === 2 && early.failed.every((f) => f.waitFor === "invoices" && typeof f.unit === "number"), early.failed);
  ok("  and nothing was posted for them", (await db.payment.count()) === 0);
  const waitingPage = await renderHtml(SwitchPage());
  ok(
    "the page: Customer receipts waiting for Invoices, with Retry waiting and what to do next; Invoices not started",
    waitingPage.includes("Waiting for Invoices: 2") && waitingPage.includes("Retry waiting") && waitingPage.includes("wait for Invoices") && waitingPage.includes("Not started") && waitingPage.includes("Customers, vendors and items"),
    waitingPage.length,
  );

  section("A stopped import carries on");
  const invoicesFile = await upload("invoices", invoiceRows);
  const firstPart = await actions.importMigrationPart(invoicesFile);
  ok("the first part brings 40 of the 46, and stops", firstPart.ok && firstPart.data.done === 40 && firstPart.data.units === 46 && (await migrated("INVOICE")) === 40, firstPart.ok ? firstPart.data.done : firstPart);
  const rest = await importAll(invoicesFile);
  ok("  carried on, it brings the rest from where it stopped", rest.done === 46 && (await migrated("INVOICE")) === 45);
  ok("  the invoice for a customer not here waits for the customers", rest.failed.length === 1 && rest.failed[0]!.waitFor === "customers" && rest.failed[0]!.key === "ZZS-INV-046", rest.failed);

  section("Waiting rows go on by themselves");
  const freed = await retryAll(receiptsFile, ["invoices"]);
  ok("the invoices in, the waiting receipts come across", freed.created === 2 && freed.failed.length === 0, freed);
  const inv1 = await db.tradeDocument.findFirst({ where: { docNumber: "ZZS-INV-001", origin: "MIGRATED" }, select: { id: true } });
  ok("  applied to the invoice they paid", !!inv1 && (await db.paymentAllocation.count({ where: { documentId: inv1.id } })) === 1);
  await company("Zz Newco Ltd");
  const newco = await retryAll(invoicesFile, null);
  ok("the customer added, Retry waiting brings its invoice", newco.created === 1 && newco.failed.length === 0 && (await migrated("INVOICE")) === 46, newco);
  const notesFile = await upload("credit-notes", creditRows);
  const notes = await importAll(notesFile);
  ok("a credit note against an invoice comes across", notes.created === 1 && notes.failed.length === 0, notes);
  const counts = async () => ((await db.migration.findFirst({ where: { status: "OPEN" }, select: { counts: true } }))?.counts ?? {}) as Record<string, number>;
  const importedPage = await renderHtml(SwitchPage());
  ok("the page: Invoices imported, 46, with Undo this section", importedPage.includes("Imported 46") && importedPage.includes("Undo this section") && !importedPage.includes("Waiting for Invoices"), importedPage.length);
  ok("  the counts: 46 invoices, 2 receipts, 1 credit note", (await counts()).invoices === 46 && (await counts()).receipts === 2 && (await counts())["credit-notes"] === 1, await counts());

  section("Undoing one section");
  const plan = await actions.sectionUndoPreview("invoices");
  ok("undoing invoices says first what goes with them: the credit note and both receipts", plan.ok && plan.data.own === 46 && plan.data.refusal === null && plan.data.dependents.some((d) => d.step === "credit-notes" && d.count === 1) && plan.data.dependents.some((d) => d.step === "receipts" && d.count === 2), plan);
  // An order converted in Deskzo from a migrated invoice: undo can't take the invoice from under it.
  const inv10 = await db.tradeDocument.findFirst({ where: { docNumber: "ZZS-INV-010", origin: "MIGRATED" }, select: { id: true } });
  const madeHere = await db.tradeDocument.create({ data: { docType: "CREDIT_NOTE", direction: "SALES", docNumber: "ZZS-HERE-1", companyId: acme.id, createdById: boss.id, sourceDocumentId: inv10!.id } });
  const blocked = await actions.undoMigrationSection("invoices");
  ok("refused while a document made in Deskzo comes from one of them, saying so — nothing taken", !blocked.ok && /converted/.test(blocked.error) && (await migrated("INVOICE")) === 46, blocked);
  await db.tradeDocument.delete({ where: { id: madeHere.id } });
  const undone = await actions.undoMigrationSection("invoices");
  ok("undone: the invoices, the credit note and the receipts all gone", undone.ok && (await migrated("INVOICE")) === 0 && (await migrated("CREDIT_NOTE")) === 0 && (await db.payment.count()) === 0, undone);
  const files = await db.migrationFile.findMany({ select: { step: true, done: true } });
  ok("  their files stay, as if not yet imported", ["invoices", "receipts", "credit-notes"].every((s) => files.find((f) => f.step === s)?.done === 0), files);
  ok("  the counts back to none", !(await counts()).invoices && !(await counts()).receipts && !(await counts())["credit-notes"], await counts());
  ok("  and the open switch carries on", (await db.migration.count({ where: { status: "OPEN" } })) === 1);
  await importAll(invoicesFile);
  await importAll(receiptsFile);
  ok("imported again: back as they were", (await migrated("INVOICE")) === 46 && (await db.payment.count()) === 2);
  const receiptsOnly = await actions.undoMigrationSection("receipts");
  ok("undoing receipts alone leaves the invoices be", receiptsOnly.ok && (await db.payment.count()) === 0 && (await migrated("INVOICE")) === 46, receiptsOnly);
  actorId = boss.id;
  await throughZoho(boss.id);
}

/** One module pulled by itself, against a stand-in Zoho. */
async function throughZoho(bossId: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const zohoActions = require("../src/actions/zoho") as typeof import("../src/actions/zoho");
  const client = require("../src/lib/zoho/client") as typeof import("../src/lib/zoho/client");
  const state = require("../src/lib/migration/state") as typeof import("../src/lib/migration/state");
  const pullLib = require("../src/lib/zoho/pull") as typeof import("../src/lib/zoho/pull");
  /* eslint-enable @typescript-eslint/no-require-imports */
  section("Pulling one module from Zoho");
  const calls: string[] = [];
  const page = (key: string, rows: unknown[], more = false) => ({ code: 0, [key]: rows, page_context: { has_more_page: more } });
  const line = (o: Record<string, unknown>) => ({ item_id: "", name: "", description: "", quantity: 1, rate: 0, discount_amount: 0, tax_percentage: 18, item_total: 0, hsn_or_sac: "", unit: "", ...o });
  const answers: Record<string, unknown> = {
    "/organizations": { code: 0, organizations: [{ organization_id: "60001", name: "Zz Sections Books", plan_name: "Standard" }] },
    "/invoices?page=1": page("invoices", [{ invoice_id: "API-INV-1", invoice_number: "ZZP-INV-1", date: "2026-05-10", status: "sent", customer_id: "API-C1", customer_name: "Zz Acme Traders", total: 2360, balance: 2360 }]),
    "/invoices/API-INV-1": { code: 0, invoice: { invoice_id: "API-INV-1", invoice_number: "ZZP-INV-1", date: "2026-05-10", due_date: "2026-05-25", status: "sent", customer_id: "API-C1", customer_name: "Zz Acme Traders", place_of_supply: "MH", gst_no: "27AAACZ1234F1Z5", is_inclusive_tax: false, currency_code: "INR", exchange_rate: 1, discount_type: "item_level", sub_total: 2000, total: 2360, balance: 2360, adjustment: 0, shipping_charge: 0, line_items: [line({ name: "Zz Widget", quantity: 2, rate: 1000, item_total: 2000 })] } },
    "/customerpayments?page=1": page("customerpayments", [{ payment_id: "API-PAY-1", payment_number: "ZZP-PAY-1", date: "2026-05-20", amount: 2360, customer_name: "Zz Acme Traders" }]),
    "/customerpayments/API-PAY-1": { code: 0, payment: { payment_id: "API-PAY-1", payment_mode: "Bank Transfer", amount: 2360, date: "2026-05-20", customer_name: "Zz Acme Traders", account_name: "Zz HDFC", invoices: [{ invoice_id: "API-INV-1", invoice_number: "ZZP-INV-1", amount_applied: 2360 }] } },
  };
  /** Lists Zoho asks Deskzo to slow down over, by path and page: the pull stops short of them, wherever its clock is. */
  const slowed = new Set<string>();
  /** PDFs answered otherwise than with one, by path. */
  const pdfAnswers = new Map<string, () => Response | Promise<Response>>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname.startsWith("accounts.zoho.")) return new Response(JSON.stringify({ access_token: "zz-access", refresh_token: "zz-refresh", expires_in: 3600 }), { status: 200 });
    if (!url.hostname.startsWith("www.zohoapis.")) return realFetch(input as RequestInfo, init);
    const path = url.pathname.replace(/^\/books\/v3/, "");
    const pdf = url.searchParams.get("accept") === "pdf";
    calls.push(`${path}${pdf ? " pdf" : ""}`);
    if (pdf && pdfAnswers.has(path)) return pdfAnswers.get(path)!();
    if (pdf) return new Response(new Uint8Array(Buffer.from("%PDF-1.4 zz")), { status: 200, headers: { "content-type": "application/pdf" } });
    const q = ["contact_type", "page"].filter((k) => url.searchParams.has(k)).map((k) => `${k}=${url.searchParams.get(k)}`).join("&");
    if (slowed.has(`${path}?${q}`)) return new Response(JSON.stringify({ code: 44, message: "Too many at once" }), { status: 429, headers: { "content-type": "application/json" } });
    const known = answers[q ? `${path}?${q}` : path];
    const empty = { code: 0, page_context: { has_more_page: false }, [pullLib.MODULES.find((mod) => mod.path === path)?.listKey ?? "items"]: [] };
    return new Response(JSON.stringify(known ?? empty), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await zohoActions.saveZohoApp({ dataCentre: "in", clientId: "1000.ZZSECTIONS", clientSecret: "zz-secret-value-1234" });
    await client.finishSignIn("zz-code", "https://zz.invalid/api/zoho/callback", bossId);
    const orgs = await client.listOrganisations();
    await zohoActions.chooseZohoOrganisation(orgs[0]!.id);
    const m = (await state.openMigration())!;
    // Only the pull's own calls from here: signing in asked Zoho for its organisations.
    calls.length = 0;

    // Today's calls used: a pull of one module waits for tomorrow, as the whole pull does.
    const waiting = await zohoActions.startZohoPull({}, { only: ["invoices"] });
    ok("a pull of only the invoices starts", waiting.ok && waiting.data.progress.only?.join() === "invoices", waiting.ok ? waiting.data.progress : waiting);
    const pullId = waiting.ok ? waiting.data.id : "";
    const today = new Date().toISOString().slice(0, 10);
    await db.$executeRaw`update "zoho_pulls" set "progress" = jsonb_set("progress", '{calls}', ${JSON.stringify({ [today]: client.dailyAllowance("Standard") })}::jsonb) where "id" = ${pullId}`;
    const waited = await zohoActions.stepZohoPull(pullId);
    ok("  with today's allowance used, it waits for tomorrow at the invoices and says so — calling Zoho for nothing", waited.ok && waited.data.status === "WAITING" && waited.data.module === "Invoices" && /carries on by itself after midnight/.test(waited.data.progress.note ?? "") && calls.length === 0, waited.ok ? waited.data : waited);
    await db.$executeRaw`update "zoho_pulls" set "progress" = jsonb_set("progress", '{calls}', '{}'::jsonb) where "id" = ${pullId}`;
    let view = waited.ok ? waited.data : null;
    for (let i = 0; i < 40; i++) {
      const r = await zohoActions.stepZohoPull(pullId);
      if (!r.ok) break;
      view = r.data;
      if (["DONE", "FAILED"].includes(view.status)) break;
    }
    ok("  the next day it carries on to the end", view?.status === "DONE", view);
    ok("  only the invoices' calls — no other module's", calls.length > 0 && calls.every((c) => c.startsWith("/invoices")), calls);
    const handed = await db.migrationFile.findFirst({ where: { migrationId: m.id, step: "invoices" }, select: { rows: true } });
    const handedRows = (handed?.rows as Record<string, string>[] | undefined) ?? [];
    ok(
      "  the pulled invoice is in the Invoices section — a full pull replacing the file uploaded (what came across from it stays in Deskzo)",
      handedRows.some((r) => Object.values(r).includes("ZZP-INV-1")) && !handedRows.some((r) => Object.values(r).includes("ZZS-INV-001")) && (await db.tradeDocument.count({ where: { docType: "INVOICE", origin: "MIGRATED" } })) === 46,
    );

    // A section with its file: topped up — only what Zoho changed since a day, added to the file (owner, 29 Oct 2026).
    answers["/invoices?page=1"] = page("invoices", [
      { invoice_id: "API-INV-1", invoice_number: "ZZP-INV-1", date: "2026-05-10", status: "sent", customer_id: "API-C1", customer_name: "Zz Acme Traders", total: 2360, balance: 2360, last_modified_time: "2026-05-12T10:00:00+0530" },
      { invoice_id: "API-INV-2", invoice_number: "ZZP-INV-2", date: "2026-06-12", status: "sent", customer_id: "API-C1", customer_name: "Zz Acme Traders", total: 1180, balance: 1180, last_modified_time: "2026-10-28T11:00:00+0530" },
    ]);
    answers["/invoices/API-INV-2"] = { code: 0, invoice: { invoice_id: "API-INV-2", invoice_number: "ZZP-INV-2", date: "2026-06-12", due_date: "2026-06-27", status: "sent", customer_id: "API-C1", customer_name: "Zz Acme Traders", place_of_supply: "MH", is_inclusive_tax: false, currency_code: "INR", exchange_rate: 1, sub_total: 1000, total: 1180, balance: 1180, line_items: [line({ name: "Zz Widget", quantity: 1, rate: 1000, item_total: 1000 })] } };
    calls.length = 0;
    const topup = await zohoActions.startZohoPull({}, { only: ["invoices"], mode: "topup", since: "2026-10-20" });
    ok("a section's top-up starts: only its module, from the day given", topup.ok && topup.data.progress.mode === "topup" && topup.data.progress.since === "2026-10-20" && topup.data.progress.only?.join() === "invoices", topup.ok ? topup.data.progress : topup);
    for (let i = 0; i < 40 && topup.ok; i++) {
      const r = await zohoActions.stepZohoPull(topup.data.id);
      if (!r.ok || ["DONE", "FAILED", "WAITING"].includes(r.data.status)) break;
    }
    ok("  only the invoice changed since is read in full — not the one already here", calls.includes("/invoices/API-INV-2") && !calls.includes("/invoices/API-INV-1") && calls.every((c) => c.startsWith("/invoices")), calls);
    const topped = ((await db.migrationFile.findFirst({ where: { migrationId: m.id, step: "invoices" }, select: { rows: true } }))?.rows as Record<string, string>[] | undefined) ?? [];
    ok("  added to the section's file, what was there kept", topped.some((r) => Object.values(r).includes("ZZP-INV-2")) && topped.some((r) => Object.values(r).includes("ZZP-INV-1")));

    // Two modules: the first is in its section while the second is still being fetched.
    calls.length = 0;
    const two = await zohoActions.startZohoPull({}, { only: ["invoices", "customerpayments"] });
    const twoId = two.ok ? two.data.id : "";
    const paymentsAt = pullLib.MODULES.findIndex((mod) => mod.key === "customerpayments");
    await db.migrationFile.deleteMany({ where: { migrationId: m.id, step: "receipts" } });
    let partway = await pullLib.pullStep(m, twoId, bossId, 1);
    for (let i = 0; i < 60 && partway.status === "FETCHING" && partway.progress.module < paymentsAt; i++) partway = await pullLib.pullStep(m, twoId, bossId, 1);
    const receiptsYet = await db.migrationFile.count({ where: { migrationId: m.id, step: "receipts" } });
    ok("partway — at the customer payments — the invoices are in their section already, the receipts not yet", partway.status === "FETCHING" && partway.progress.module === paymentsAt && receiptsYet === 0 && partway.progress.booksHanded?.some((b) => b.module === "invoices" && b.steps.some((s) => s.step === "invoices")) === true, partway.progress);
    // Hand over what's fetched so far (owner, 5 Nov 2026): the module still going, without waiting for it to finish.
    for (let i = 0; i < 30 && partway.progress.module === paymentsAt && !partway.progress.counts.customerpayments; i++) partway = await pullLib.pullStep(m, twoId, bossId, 1);
    const stillGoing = partway.status === "FETCHING" && partway.progress.module === paymentsAt && !!partway.progress.counts.customerpayments;
    ok("a payment fetched, its module not finished", stillGoing, { module: partway.progress.module, counts: partway.progress.counts, status: partway.status });
    if (stillGoing) {
      const refused = await pullLib.handOverFetched({ ...m, status: "COMPLETED" } as never, twoId, bossId);
      const why = refused.progress.booksHanded?.find((b) => b.module === "customerpayments");
      ok("  refused: the page is told why", !!why?.refused.length, why);
      ok("  and what was fetched stays in the pull", (await db.zohoPullPage.count({ where: { pullId: twoId, file: "Customer_Payment.csv" } })) > 0 && !refused.progress.handedFiles?.includes("Customer_Payment.csv"));
      const handed = await pullLib.handOverFetched(m, twoId, bossId);
      const steps = handed.progress.booksHanded?.find((b) => b.module === "customerpayments");
      ok("  handed over: the receipts are in their section with the module still going", (await db.migrationFile.count({ where: { migrationId: m.id, step: "receipts" } })) === 1 && steps?.steps[0]?.step === "receipts" && !steps.refused.length && handed.status === "FETCHING", steps);
      ok("  the pull's copy is gone, and it isn't left holding the pull", (await db.zohoPullPage.count({ where: { pullId: twoId, file: "Customer_Payment.csv" } })) === 0 && !handed.progress.lease);
      const unitsThen = (await db.migrationFile.findFirst({ where: { migrationId: m.id, step: "receipts" }, select: { units: true } }))?.units;
      const twice = await pullLib.handOverFetched(m, twoId, bossId);
      ok("  pressed again with nothing new: nothing changes, and what it brought is still said", (await db.migrationFile.findFirst({ where: { migrationId: m.id, step: "receipts" }, select: { units: true } }))?.units === unitsThen && twice.progress.booksHanded?.find((b) => b.module === "customerpayments")?.steps[0]?.step === "receipts");
    }
    let last: Awaited<ReturnType<typeof pullLib.pullStep>> | null = null;
    for (let i = 0; i < 40; i++) {
      const r = await zohoActions.stepZohoPull(twoId);
      if (!r.ok) break;
      last = r.data;
      if (["DONE", "FAILED", "WAITING"].includes(r.data.status)) break;
    }
    ok("  then the receipts land in theirs", (await db.migrationFile.count({ where: { migrationId: m.id, step: "receipts" } })) === 1);
    ok("  and the pull's own copy is gone", (await db.zohoPullPage.count({ where: { pullId: twoId } })) === 0);
    ok("  and finishing the module after a hand-over keeps what it brought", last?.progress.booksHanded?.find((b) => b.module === "customerpayments")?.steps[0]?.step === "receipts", last?.progress.booksHanded);

    // Part of a whole pull handed over, then stopped (owner, 25 Nov 2026 — WT/25-26/QT/4648 and every earlier year's quote
    // gone from the archive): a part says nothing of what it hasn't reached, so it only ever adds.
    section("Part of the quotes handed over");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the stubs, as the others are
    const archiveLib = require("../src/lib/migration/archive") as typeof import("../src/lib/migration/archive");
    const backupQuote = (id: string, number: string) => ({ "Quote ID": id, "Quote Number": number, "Quote Date": "2025-12-06", "Quote Status": "approved", "Customer ID": "API-C1", "Customer Name": "Zz Acme Traders", "Item Name": "Zz old line", Quantity: "1", "Item Price": "100", "Item Tax %": "18", "Item Total": "100", Total: "118" });
    const fromBackup = archiveLib.archiveDocuments("quotes", [backupQuote("EST-OLD", "ZZQ-OLD-1"), backupQuote("EST-GONE", "ZZQ-GONE-1")]).documents;
    const keepOld = async () => {
      await archiveLib.storeArchive(m, "QUOTE", fromBackup);
      const doc = await db.archivedDocument.findFirstOrThrow({ where: { migrationId: m.id, number: "ZZQ-OLD-1" }, select: { id: true } });
      await db.archivedDocumentFile.deleteMany({ where: { documentId: doc.id } });
      await db.archivedDocumentFile.create({ data: { documentId: doc.id, data: new Uint8Array(Buffer.from("%PDF-1.4 kept")), size: 13 } });
    };
    const archivedQuote = (number: string) => db.archivedDocument.findFirst({ where: { migrationId: m.id, kind: "QUOTE", number }, select: { lines: true, status: true, companyId: true, file: { select: { size: true } } } });
    const listed = (id: string, number: string, date: string, status: string) => ({ estimate_id: id, estimate_number: number, date, status, customer_id: "API-C1", customer_name: "Zz Acme Traders", total: 118 });
    answers["/estimates?page=1"] = page("estimates", [listed("EST-NEW", "ZZQ-NEW-1", "2026-06-05", "sent"), listed("EST-DONE", "ZZQ-DONE-1", "2026-06-06", "invoiced")], true);
    answers["/estimates?page=2"] = page("estimates", [listed("EST-OLD", "ZZQ-OLD-1", "2025-12-06", "approved")]);
    const readInFull = (id: string, number: string, date: string, status: string) => ({ code: 0, estimate: { ...listed(id, number, date, status), expiry_date: "2026-07-05", place_of_supply: "MH", line_items: [line({ name: "Zz Quote line", rate: 100, item_total: 100 })] } });
    answers["/estimates/EST-NEW"] = readInFull("EST-NEW", "ZZQ-NEW-1", "2026-06-05", "sent");
    answers["/estimates/EST-OLD"] = readInFull("EST-OLD", "ZZQ-OLD-1", "2025-12-06", "approved");
    const toTheEnd = async (id: string) => {
      for (let i = 0; i < 60; i++) {
        const r = await zohoActions.stepZohoPull(id);
        if (!r.ok || ["DONE", "FAILED", "WAITING"].includes(r.data.status)) return r;
      }
      return null;
    };
    /** Stepped to its list's second page, which Zoho asks it to wait for: part of it fetched, the list not read to the end. */
    const partOf = async (id: string, path: string) => {
      slowed.add(`${path}?page=2`);
      let v = await pullLib.pullStep(m, id, bossId, 500);
      for (let i = 0; i < 60 && v.status === "FETCHING" && !/slow down/.test(v.progress.note ?? ""); i++) v = await pullLib.pullStep(m, id, bossId, 500);
      slowed.delete(`${path}?page=2`);
      return v;
    };
    const quoteRowsKept = async () => ((await db.migrationFile.findFirst({ where: { migrationId: m.id, step: "quotes" }, select: { rows: true } }))?.rows as Record<string, string>[] | undefined) ?? [];

    await keepOld();
    const partPull = await zohoActions.startZohoPull({}, { only: ["estimates"] });
    const partId = partPull.ok ? partPull.data.id : "";
    const part = await partOf(partId, "/estimates");
    ok("a whole pull of the quotes, this year's fetched and the earlier years' page not reached", part.status === "FETCHING" && part.progress.page === 2 && part.progress.counts.estimates === 2, part.progress);
    await pullLib.handOverFetched(m, partId, bossId);
    await zohoActions.stopZohoPull();
    const oldNow = await archivedQuote("ZZQ-OLD-1");
    ok("  handed over and stopped: the earlier year's quote is still in the archive, its PDF with it", !!oldNow && oldNow.file?.size === 13, oldNow);
    ok("  as is one Zoho may no longer have — a part can't say", !!(await archivedQuote("ZZQ-GONE-1")));
    ok("  and what came went where it goes: the finished one archived, the open one to its section", !!(await archivedQuote("ZZQ-DONE-1")) && (await quoteRowsKept()).some((r) => r.Number === "ZZQ-NEW-1"));

    calls.length = 0;
    const wholePull = await zohoActions.startZohoPull({}, { only: ["estimates"] });
    const wholeEnd = wholePull.ok ? await toTheEnd(wholePull.data.id) : null;
    ok("the whole of them, to the end", wholeEnd?.ok === true && wholeEnd.data.status === "DONE", wholeEnd);
    ok("  this year's open quote read in full, the earlier year's only listed", calls.includes("/estimates/EST-NEW") && !calls.includes("/estimates/EST-OLD"), calls);
    const oldListed = await archivedQuote("ZZQ-OLD-1");
    ok("  the earlier one kept, with the lines and the PDF it had", (oldListed?.lines as unknown[] | undefined)?.length === 1 && oldListed?.file?.size === 13 && oldListed.status === "approved", oldListed);
    ok("  and one Zoho doesn't list any more is gone, the list having been read to its end", (await archivedQuote("ZZQ-GONE-1")) === null);

    await keepOld();
    const thenEnd = await zohoActions.startZohoPull({}, { only: ["estimates"] });
    const thenId = thenEnd.ok ? thenEnd.data.id : "";
    await partOf(thenId, "/estimates");
    await pullLib.handOverFetched(m, thenId, bossId);
    await toTheEnd(thenId);
    ok("part handed over, then read to the end: the part and the rest are both there", !!(await archivedQuote("ZZQ-OLD-1")) && !!(await archivedQuote("ZZQ-DONE-1")) && (await quoteRowsKept()).some((r) => r.Number === "ZZQ-NEW-1"));
    // Challans go to the archive and to no section, so nothing but the pull itself remembers a part of them went.
    const challan = (n: number) => ({ deliverychallan_id: `CH-${n}`, deliverychallan_number: `ZZ-CH-${n}`, date: `2025-09-0${n}`, status: "delivered", customer_id: "API-C1", customer_name: "Zz Acme Traders", total: 10 });
    answers["/deliverychallans?page=1"] = page("deliverychallans", [challan(1)], true);
    answers["/deliverychallans?page=2"] = page("deliverychallans", [challan(2)]);
    const challans = await zohoActions.startZohoPull({}, { only: ["deliverychallans"] });
    const challansId = challans.ok ? challans.data.id : "";
    const someChallans = await partOf(challansId, "/deliverychallans");
    await pullLib.handOverFetched(m, challansId, bossId);
    await toTheEnd(challansId);
    ok("delivery challans the same: the part handed over stays when the rest comes", someChallans.status === "FETCHING" && someChallans.progress.counts.deliverychallans === 1 && (await db.archivedDocument.count({ where: { migrationId: m.id, kind: "DELIVERY_CHALLAN", number: { in: ["ZZ-CH-1", "ZZ-CH-2"] } } })) === 2, someChallans.progress);

    section("The earlier years' quotes by themselves");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the stubs, as the others are
    const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
    const SwitchPage = (require("../src/app/(dashboard)/settings/data/switch/page") as { default: () => Promise<unknown> }).default;
    const offered = (await renderHtml(SwitchPage())).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    ok("the Earlier years section offers them, saying what comes", /Pull the earlier years' quotes from Zoho/.test(offered) && /every quote dated before 1 Apr 2026/.test(offered), offered.slice(offered.indexOf("Earlier years"), offered.indexOf("Earlier years") + 400));
    await db.archivedDocument.deleteMany({ where: { migrationId: m.id, kind: "QUOTE", number: { in: ["ZZQ-OLD-1", "ZZQ-GONE-1"] } } });
    const stepBefore = await quoteRowsKept();
    calls.length = 0;
    const notThese = await zohoActions.startZohoPull({}, { only: ["invoices"], earlier: true });
    ok("only the quotes: another kind's earlier years are refused", !notThese.ok && calls.length === 0, notThese.ok ? notThese.data.progress : notThese.error);
    if (notThese.ok) await zohoActions.stopZohoPull();
    const earlier = await zohoActions.startZohoPull({}, { only: ["estimates"], earlier: true });
    ok("started, and logged as that", earlier.ok && earlier.data.progress.earlier === true && (await db.auditLog.count({ where: { entityType: "ZohoPull", entityLabel: "Started pulling the earlier years' quotes from Zoho Books" } })) === 1, earlier.ok ? earlier.data.progress : earlier);
    ok("  the Open quotes section isn't told to expect them", earlier.ok && pullLib.sectionsStillToCome(earlier.data).length === 0, earlier.ok ? pullLib.sectionsStillToCome(earlier.data) : "");
    const earlierEnd = earlier.ok ? await toTheEnd(earlier.data.id) : null;
    ok("  to the end", earlierEnd?.ok === true && earlierEnd.data.status === "DONE" && earlierEnd.data.progress.counts.estimates === 1, earlierEnd);
    ok("  two list calls and nothing else: no quote read in full, no PDF", calls.length === 2 && calls.every((c) => c === "/estimates"), calls);
    const broughtBack = await archivedQuote("ZZQ-OLD-1");
    ok("  the earlier quote is back, on its company", broughtBack?.status === "approved" && !!broughtBack.companyId, broughtBack);
    ok("  this year's, in the archive and in the section, left as they were", !!(await archivedQuote("ZZQ-DONE-1")) && JSON.stringify(await quoteRowsKept()) === JSON.stringify(stepBefore));
    calls.length = 0;
    const alone = await zohoActions.startZohoPull({}, { mode: "topup", since: "2026-11-01", only: ["estimates"] });
    if (alone.ok) await toTheEnd(alone.data.id);
    ok("  a pull doesn't fetch its PDF by itself — there are tens of thousands, and a pull fetching them keeps the night's from starting", !calls.includes("/estimates/EST-OLD pdf"), calls);
    const pdfs = await zohoActions.startZohoPull({}, { mode: "pdfs" });
    if (pdfs.ok) await toTheEnd(pdfs.data.id);
    ok("  \"Fetch the archive's PDFs only\" does", calls.filter((c) => c === "/estimates/EST-OLD pdf").length === 1 && (await archivedQuote("ZZQ-OLD-1"))?.file !== null, calls);

    section("An earlier document's PDF, fetched as it is opened");
    /* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stubs, as the others are */
    const route = require("../src/app/api/archive/[id]/pdf/route") as typeof import("../src/app/api/archive/[id]/pdf/route");
    const pdfs1 = require("../src/lib/zoho/archive-pdf") as typeof import("../src/lib/zoho/archive-pdf");
    const { ArchivedHistory } = require("../src/components/companies/archived-history") as typeof import("../src/components/companies/archived-history");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const acmeId = (await archivedQuote("ZZQ-OLD-1"))!.companyId!;
    const seller = await db.user.create({ data: { name: "Zz Seller", email: "seller@zzsections.invalid", role: "SALES", passwordHash: "x".repeat(60) } });
    roles.set(seller.id, "SALES");
    const nobody = await db.user.create({ data: { name: "Zz Nobody", email: "nobody@zzsections.invalid", role: "PROFILE", passwordHash: "x".repeat(60) } });
    roles.set(nobody.id, "PROFILE");
    const earlierDoc = async (number: string, kind = "QUOTE", oldId: string | null = number) =>
      (await db.archivedDocument.create({ data: { migrationId: m.id, kind, key: `${kind}:zz:${number}`, number, date: new Date("2025-02-01"), year: "2024-25", partyName: "Zz Acme Traders", companyId: acmeId, total: 118, oldId }, select: { id: true } })).id;
    const open = async (id: string, as = bossId) => {
      actorId = as;
      const res = await route.GET(new Request("http://zz.invalid/api/archive/pdf"), { params: Promise.resolve({ id }) });
      actorId = bossId;
      return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
    };
    const kept = (documentId: string) => db.archivedDocumentFile.findUnique({ where: { documentId }, select: { size: true } });
    const day = await pullLib.callDay();
    const isOpen = (r: { status: number; type: string; body: string }) => r.status === 200 && r.type === "application/pdf" && r.body.startsWith("%PDF-");

    const first = await earlierDoc("ZZO-1");
    const empty = await earlierDoc("ZZO-EMPTY");
    await pullLib.keepArchivedPdf(empty, null);
    const keptDoc = await earlierDoc("ZZO-KEPT");
    await pullLib.keepArchivedPdf(keptDoc, Buffer.from("%PDF-1.4 kept"));
    const payment = await earlierDoc("ZZO-PAY", "CUSTOMER_PAYMENT");
    const noId = await earlierDoc("ZZO-NOID", "INVOICE", null);
    const badId = await earlierDoc("ZZO-BADID", "INVOICE", "../contacts/1");
    const links = async () => {
      const html = await renderHtml(ArchivedHistory({ companyId: acmeId }));
      return (id: string) => html.includes(`/api/archive/${id}/pdf`);
    };
    calls.length = 0;
    const linked = await links();
    ok("with the workspace connected, a quote whose PDF isn't kept yet links, as one kept does", linked(first) && linked(keptDoc));
    ok("  not one Zoho had no PDF of, a payment, one without Zoho's id, or an id that isn't one", ![empty, payment, noId, badId].some(linked));
    ok("  and showing the tab asks Zoho for nothing", calls.length === 0, calls);

    const outOfReach = await open(first, nobody.id);
    const notTheirs = await open(first, seller.id);
    const signedOut = await open(first, "");
    const missing = await open("zz-not-there");
    ok("somebody without documents, a seller whose customer it isn't, nobody signed in: 404 — as for one that isn't there", [outOfReach, notTheirs, signedOut, missing].every((r) => r.status === 404 && r.body === missing.body), [outOfReach, notTheirs, signedOut, missing]);
    await db.systemModule.upsert({ where: { key: "sales_documents" }, create: { key: "sales_documents", enabled: false }, update: { enabled: false } });
    const switchedOff = await open(first);
    await db.systemModule.update({ where: { key: "sales_documents" }, data: { enabled: true } });
    ok("  sales documents switched off: the same", switchedOff.status === 404 && switchedOff.body === missing.body, switchedOff);
    const others = [await open(empty), await open(payment), await open(noId), await open(badId)];
    ok("  one Zoho had no PDF of, a payment, no id, an id that isn't one: the same", others.every((r) => r.status === 404 && r.body === missing.body), others);
    ok("  none of them a call to Zoho, or one counted", calls.length === 0 && (await pdfs1.openedCalls(day)) === 0, calls);

    const opened = await open(first);
    ok("opened by somebody who may: its one PDF fetched, served and kept", isOpen(opened) && calls.join() === "/estimates/ZZO-1 pdf" && ((await kept(first))?.size ?? 0) > 0, { opened, calls });
    ok("  counted against the day, on the pull's page too", (await pdfs1.openedCalls(day)) === 1 && (await pullLib.latestPull(m.id))!.callsToday === ((await pullLib.latestPull(m.id))!.progress.calls[day] ?? 0) + 1);
    const again = await open(first);
    ok("  opened again: served as kept, no second call", isOpen(again) && calls.length === 1, calls);
    await db.company.update({ where: { id: acmeId }, data: { ownerUserId: seller.id } });
    const theirs = await earlierDoc("ZZO-THEIRS");
    const bySeller = await open(theirs, seller.id);
    ok("  by the seller, once the customer is theirs", isOpen(bySeller) && calls.length === 2, bySeller);
    await db.company.update({ where: { id: acmeId }, data: { ownerUserId: null } });

    calls.length = 0;
    const both = await earlierDoc("ZZO-BOTH");
    pdfAnswers.set("/estimates/ZZO-BOTH", async () => {
      await new Promise((r) => setTimeout(r, 300));
      return new Response(new Uint8Array(Buffer.from("%PDF-1.4 both")), { status: 200 });
    });
    const together = await Promise.all([open(both), open(both), open(both)]);
    ok("three people at once: one call, all three served", together.every(isOpen) && calls.length === 1, { together, calls });
    const clash = await earlierDoc("ZZO-CLASH");
    pdfAnswers.set("/estimates/ZZO-CLASH", async () => {
      // A pull, or another server, keeps its own while Zoho is answering.
      await pullLib.keepArchivedPdf(clash, Buffer.from("%PDF-1.4 the other one's"));
      return new Response(new Uint8Array(Buffer.from("%PDF-1.4 mine")), { status: 200 });
    });
    const clashed = await open(clash);
    ok("  kept by a pull in the meantime: still served, one file", isOpen(clashed) && (await db.archivedDocumentFile.count({ where: { documentId: clash } })) === 1 && (await kept(clash))?.size === 24, { clashed, kept: await kept(clash) });
    await pullLib.keepArchivedPdf(clash, null);
    ok("  and an empty one never takes a kept one's place", (await kept(clash))?.size === 24);
    const taken = await earlierDoc("ZZO-TAKEN");
    pdfAnswers.set("/estimates/ZZO-TAKEN", async () => {
      await db.archivedDocument.delete({ where: { id: taken } });
      return new Response(new Uint8Array(Buffer.from("%PDF-1.4 gone")), { status: 200 });
    });
    const takenOut = await open(taken);
    ok("  taken out of the archive in the meantime: not found, not an error", takenOut.status === 404, takenOut);

    const said = await earlierDoc("ZZO-SAID");
    const notKept = async () => (await kept(said)) === null && (await links())(said);
    pdfAnswers.set("/estimates/ZZO-SAID", () => new Response("{}", { status: 404 }));
    const refused = await open(said);
    ok("Zoho refusing it: said, nothing kept, so it can be tried again", refused.status === 424 && /Zoho refused this PDF/.test(refused.body) && refused.type.startsWith("text/plain") && (await notKept()), refused);
    pdfAnswers.set("/estimates/ZZO-SAID", () => new Response(JSON.stringify({ code: 57, message: "not authorised" }), { status: 200 }));
    const notAPdf = await open(said);
    ok("  as for an answer that isn't a PDF", notAPdf.status === 424 && (await notKept()), notAPdf);
    pdfAnswers.set("/estimates/ZZO-SAID", () => {
      throw new TypeError("fetch failed");
    });
    const unreached = await open(said);
    ok("  and Zoho not reached", unreached.status === 424 && /couldn't reach Zoho/.test(unreached.body) && (await notKept()), unreached);
    pdfAnswers.set("/estimates/ZZO-SAID", () => new Response(JSON.stringify({ code: 44, message: "Too many at once" }), { status: 429 }));
    const slow = await open(said);
    ok("Zoho asking to slow down: in a minute", slow.status === 429 && /in a minute/.test(slow.body) && (await notKept()), slow);
    pdfAnswers.set("/estimates/ZZO-SAID", () => new Response(JSON.stringify({ code: 45, message: "Daily limit" }), { status: 429 }));
    const zohoUsed = await open(said);
    ok("Zoho saying the day's calls are used: after midnight", zohoUsed.status === 429 && /Today's Zoho calls are used/.test(zohoUsed.body) && (await notKept()), zohoUsed);
    pdfAnswers.delete("/estimates/ZZO-SAID");

    calls.length = 0;
    storageIsFull = true;
    const full = await open(said);
    storageIsFull = false;
    ok("storage full: said, without spending a call", full.status === 413 && /storage is full/.test(full.body) && calls.length === 0 && (await notKept()), { full, calls });

    // The day's calls, whoever spent them: a pull's and the ones opened together.
    const allowance = client.dailyAllowance("Standard");
    const lastPull = (await db.zohoPull.findFirstOrThrow({ where: { migrationId: m.id }, orderBy: { startedAt: "desc" }, select: { id: true } })).id;
    const setCalls = (n: number) => db.$executeRaw`update "zoho_pulls" set "progress" = jsonb_set("progress", '{calls}', ${JSON.stringify({ [day]: n })}::jsonb) where "id" = ${lastPull}`;
    const before = await db.zohoPull.findMany({ where: { migrationId: m.id }, select: { id: true, progress: true } });
    const spentByPulls = before.filter((p) => p.id !== lastPull).reduce((n, p) => n + ((p.progress as { calls?: Record<string, number> }).calls?.[day] ?? 0), 0);
    const spentOpening = await pdfs1.openedCalls(day);
    await setCalls(allowance - spentByPulls - spentOpening);
    const used = await open(said);
    ok("the day's allowance used, pulls and opening together: said, without a call", used.status === 429 && /Today's Zoho calls are used/.test(used.body) && calls.length === 0 && (await pdfs1.openedCalls(day)) === spentOpening, { used, calls });
    await setCalls(allowance - spentByPulls - spentOpening - 1);
    const lastCall = await open(said);
    ok("  with one left, it is fetched", isOpen(lastCall) && calls.length === 1, lastCall);
    const oneMore = await open(await earlierDoc("ZZO-MORE"));
    ok("  and the next one isn't", oneMore.status === 429 && calls.length === 1, oneMore);
    // A pull counts what was opened: its own calls and those together are the day's.
    const roomPull = await zohoActions.startZohoPull({}, { only: ["estimates"], earlier: true });
    const roomId = roomPull.ok ? roomPull.data.id : "";
    const nowOpened = await pdfs1.openedCalls(day);
    await db.$executeRaw`update "zoho_pulls" set "progress" = jsonb_set("progress", '{calls}', ${JSON.stringify({ [day]: allowance - nowOpened })}::jsonb) where "id" = ${roomId}`;
    calls.length = 0;
    const roomStep = await zohoActions.stepZohoPull(roomId);
    ok("  a pull counts them too: it waits for tomorrow", roomStep.ok && roomStep.data.status === "WAITING" && calls.length === 0, roomStep.ok ? { status: roomStep.data.status, calls } : roomStep);
    await zohoActions.stopZohoPull();
    for (const p of [...before.map((b) => b.id), roomId]) await db.$executeRaw`update "zoho_pulls" set "progress" = jsonb_set("progress", '{calls}', '{}'::jsonb) where "id" = ${p}`;
    await db.migrationRecord.create({ data: { migrationId: m.id, kind: pdfs1.OPENED_CALL, recordId: "zz-yesterday", key: "2020-01-01:zz-yesterday" } });
    await open(await earlierDoc("ZZO-TODAY"));
    ok("  yesterday's are done with", (await db.migrationRecord.count({ where: { kind: pdfs1.OPENED_CALL, key: { startsWith: "2020-" } } })) === 0);

    calls.length = 0;
    await db.zohoConnection.update({ where: { id: "default" }, data: { refreshToken: null } });
    const apart = await earlierDoc("ZZO-APART");
    const unlinked = await links();
    const disconnected = await open(apart);
    ok("disconnected from Zoho: no link — the kept ones still — and its address says why, calling nothing", !unlinked(apart) && unlinked(first) && disconnected.status === 409 && /isn't connected to Zoho/.test(disconnected.body) && calls.length === 0, disconnected);
    const apartRefused = await open(apart, nobody.id);
    ok("  though not to somebody who may not see it", apartRefused.status === 404 && apartRefused.body === missing.body, apartRefused);
    ok("  and one kept before opens as it did", isOpen(await open(first)));
  } finally {
    globalThis.fetch = realFetch;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
