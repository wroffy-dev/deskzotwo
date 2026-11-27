/**
 * check:migration-not-counted — Zoho's rejected and waiting-for-approval documents stay in Zoho (owner, 17 Nov 2026 —
 * "why different in numbers of zoho and deskzo?"; src/lib/migration/documents.ts `leftBehind`,
 * src/lib/migration/not-counted.ts).
 *
 *   1. The import leaves behind what Zoho never posts: void, draft, rejected, pending approval, approved — written the
 *      API's way ("pending_approval") or the backup's ("Pending Approval") — and brings sent, paid, overdue, open.
 *   2. The repair: from Zoho's own statuses, this year's documents brought across that Zoho doesn't count are listed —
 *      not those Zoho counts, not another migration's — and one with a kept credit note set against it is held.
 *   3. Taken back on a press: gone with their migration records; an invoice a taken-back credit note had settled owes
 *      again; the held one stays; looking again finds only it.
 *
 * Zoho is stubbed (no calls leave the machine). Own fixture tagged ZZNC, removed in a finally.
 *
 *   npm run check:migration-not-counted
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { leftBehind } from "../src/lib/migration/documents";

type Row = Record<string, unknown>;
let zohoInvoices: Row[] = [];
let zohoNotes: Row[] = [];
let calls = 0;

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/zoho/client" || request.endsWith("lib/zoho/client")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      zohoGet: async (path: string, query: Record<string, string | number>) => {
        calls += 1;
        const list = path === "/invoices" ? zohoInvoices : zohoNotes;
        const page = Number(query.page);
        const slice = list.slice((page - 1) * 2, page * 2); // two to a page here, to walk the pages
        return { code: 0, [path === "/invoices" ? "invoices" : "creditnotes"]: slice, page_context: { has_more_page: page * 2 < list.length } };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const TAG = "ZZNC";

async function cleanup() {
  const docs = await db.tradeDocument.findMany({ where: { docNumber: { startsWith: TAG } }, select: { id: true } });
  const ids = docs.map((d) => d.id);
  await db.creditNoteApplication.deleteMany({ where: { OR: [{ creditNoteId: { in: ids } }, { invoiceId: { in: ids } }] } });
  await db.tradeDocument.deleteMany({ where: { id: { in: ids } } });
  await db.migration.deleteMany({ where: { source: { startsWith: TAG } } });
  await db.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

async function main() {
  section("1. What the import leaves behind");
  const behind = (s: string) => leftBehind(s) !== null;
  ok("void, draft: left behind as before", behind("void") && behind("Void") && behind("draft") && behind("Cancelled"));
  ok("rejected: left behind", behind("rejected") && behind("Rejected") && /rejected/.test(leftBehind("rejected") ?? ""));
  ok("waiting for approval, either way Zoho writes it: left behind", behind("pending_approval") && behind("Pending Approval") && behind("approved") && behind("Approved"));
  ok("what Zoho posts comes across", !behind("sent") && !behind("paid") && !behind("overdue") && !behind("partially_paid") && !behind("open") && !behind("closed") && !behind("") && !behind("Unapproved Expense".slice(0, 0)));

  await cleanup();
  const someone = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true } });
  const company = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, relationshipType: "CLIENT", createdById: someone.id }, select: { id: true } });
  const lib = await import("../src/lib/migration/not-counted");
  const state = await import("../src/lib/migration/state");

  try {
    const migration = await db.migration.create({ data: { source: `${TAG}-check`, yearStart: new Date("2026-04-01T00:00:00Z"), switchDate: new Date("2026-12-01T00:00:00Z"), createdById: someone.id }, select: { id: true } });
    const other = await db.migration.create({ data: { source: `${TAG}-other`, status: "UNDONE", yearStart: new Date("2025-04-01T00:00:00Z"), switchDate: new Date("2025-12-01T00:00:00Z"), createdById: someone.id }, select: { id: true } });
    const doc = async (n: string, docType: "INVOICE" | "CREDIT_NOTE", status: "ISSUED" | "PAID", total: number, migrationId = migration.id) => {
      const d = await db.tradeDocument.create({ data: { docNumber: `${TAG}-${n}`, docType, direction: "SALES", status, companyId: company.id, createdById: someone.id, total, issueDate: new Date("2026-07-16T00:00:00Z") }, select: { id: true } });
      await db.migrationRecord.create({ data: { migrationId, kind: "document", recordId: d.id, key: `${docType}:${TAG}-${n}` } });
      return d.id;
    };
    const rejected = await doc("244", "INVOICE", "ISSUED", 109150);
    const approved = await doc("2465", "INVOICE", "ISSUED", 115640);
    const counted = await doc("1000", "INVOICE", "PAID", 5963.72);
    const held = await doc("2456", "INVOICE", "ISSUED", 61065);
    const rejectedNote = await doc("CN-492", "CREDIT_NOTE", "ISSUED", 5963.72);
    const keptNote = await doc("CN-500", "CREDIT_NOTE", "ISSUED", 1000);
    const elsewhere = await doc("9999", "INVOICE", "ISSUED", 100, other.id);
    // The rejected note settled an invoice Zoho counts; a note Zoho counts is set against the pending one.
    await db.creditNoteApplication.create({ data: { creditNoteId: rejectedNote, invoiceId: counted, amount: 5963.72, appliedByUserId: someone.id } });
    await db.creditNoteApplication.create({ data: { creditNoteId: keptNote, invoiceId: held, amount: 1000, appliedByUserId: someone.id } });
    await db.migrationRecord.create({ data: { migrationId: migration.id, kind: "journal", recordId: `${TAG}-no-such-entry`, key: `INVOICE:${TAG}-244:entry` } });

    zohoInvoices = [
      { invoice_number: `${TAG}-244`, status: "rejected" },
      { invoice_number: `${TAG}-2465`, status: "approved" },
      { invoice_number: `${TAG}-1000`, status: "paid" },
      { invoice_number: `${TAG}-2456`, status: "pending_approval" },
      { invoice_number: `${TAG}-9999`, status: "void" },
      { invoice_number: `${TAG}-NOT-HERE`, status: "rejected" },
    ];
    zohoNotes = [
      { creditnote_number: `${TAG}-CN-492`, status: "rejected" },
      { creditnote_number: `${TAG}-CN-500`, status: "closed" },
    ];

    section("2. The repair: what Zoho doesn't count");
    const m = (await state.openMigration()) ?? null;
    const row: Parameters<typeof lib.notCounted>[0] = m && m.id === migration.id ? m : { id: migration.id, source: `${TAG}-check`, yearStart: "2026-04-01", switchDate: "2026-12-01", status: "OPEN", createdById: someone.id, createdAt: new Date(), finishedAt: null, undoneAt: null, counts: {} };
    calls = 0;
    const list = await lib.notCounted(row);
    const numbers = list.rows.map((r) => r.number).sort();
    ok("found from Zoho's statuses: the rejected invoice and note, the approved and pending invoices", numbers.join() === [`${TAG}-244`, `${TAG}-2456`, `${TAG}-2465`, `${TAG}-CN-492`].sort().join(), list.rows);
    ok("  not one Zoho counts, nor another migration's, nor one Deskzo never had", !numbers.includes(`${TAG}-1000`) && !numbers.includes(`${TAG}-9999`) && !numbers.includes(`${TAG}-NOT-HERE`));
    ok("  Zoho's list read page by page", calls === 4, calls);
    const heldRow = list.rows.find((r) => r.number === `${TAG}-2456`);
    ok("  the one a kept credit note is set against is held", heldRow?.held === "A credit note is set against it" && list.held === 1 && list.toTakeBack === 3, heldRow);
    ok("  each says Zoho's status", list.rows.find((r) => r.number === `${TAG}-2465`)?.zohoStatus === "approved" && list.rows.find((r) => r.number === `${TAG}-244`)?.zohoStatus === "rejected");
    ok("  the net with tax: invoices less the note", list.total === Math.round((109150 + 115640 - 5963.72) * 100) / 100, list.total);
    ok("  looking changed nothing", (await db.tradeDocument.count({ where: { id: { in: [rejected, approved, rejectedNote] } } })) === 3);

    section("3. Taken back");
    await db.tradeDocument.update({ where: { id: counted }, data: { status: "PAID" } });
    const done = await lib.takeBackNotCounted(row);
    ok("three taken back", done.takenBack === 3, done);
    ok("  gone, with their migration records and the entry's", (await db.tradeDocument.count({ where: { id: { in: [rejected, approved, rejectedNote] } } })) === 0 && (await db.migrationRecord.count({ where: { migrationId: migration.id, key: { in: [`INVOICE:${TAG}-244`, `INVOICE:${TAG}-244:entry`, `INVOICE:${TAG}-2465`, `CREDIT_NOTE:${TAG}-CN-492`] } } })) === 0);
    const reopened = await db.tradeDocument.findUniqueOrThrow({ where: { id: counted }, select: { status: true } });
    ok("  the invoice the rejected note had settled owes again", reopened.status !== "PAID", reopened);
    ok("  the held one, the one Zoho counts and another migration's stay", (await db.tradeDocument.count({ where: { id: { in: [held, counted, keptNote, elsewhere] } } })) === 4);
    const again = await lib.notCounted(row);
    ok("looking again finds only the held one", again.rows.length === 1 && again.rows[0]!.number === `${TAG}-2456` && again.toTakeBack === 0, again.rows);
    ok("  and taking back again takes nothing", (await lib.takeBackNotCounted(row)).takenBack === 0);
  } finally {
    await cleanup();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  await db.$disconnect();
  if (failures) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
