/**
 * check:audit-fixes-a2 — the security audit of 11 Nov 2026 (docs/reports/security-audit-2026-11-11.md), the ledger,
 * expense, stock, lead, incentive and commission fixes, each shown to hold the way it was broken: by calling the
 * server's own code, as a hand-made request would.
 *
 *   SEC-14  a hand reversal reverses only hand-written (MANUAL/OPENING) entries
 *   SEC-40  manual journals: no negative sides, no borrowed source; the chart can't loop
 *   SEC-56  a database error reaches the screen as a plain sentence
 *   SEC-15  an unapproved claim doesn't post; a claim posts once, however often it is asked to
 *   SEC-13  a stock adjustment isn't approved by whoever sent it in or changed it, nor once sent back
 *   SEC-36  a won lead's value is locked; a move between won stages keeps the won date
 *   SEC-37  an incentive decision that isn't one of the four is refused, not paid
 *   SEC-17  payee bank details are finance's (payments.manage)
 *
 * A fixture of its own in the local database, named ZZA2, removed in a finally. Assertions are about the fixture only.
 *
 *   npx tsx scripts/check-audit-fixes-a2.ts
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";

const TAG = "ZZA2";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "" : (r.error ?? ""));

async function cleanup() {
  const accounts = (await db.ledgerAccount.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } })).map((a) => a.id);
  const users = (await db.user.findMany({ where: { email: { endsWith: "@zza2.invalid" } }, select: { id: true } })).map((u) => u.id);
  const expenses = (await db.expense.findMany({ where: { description: { startsWith: TAG } }, select: { id: true } })).map((e) => e.id);
  const entries = (
    await db.journalEntry.findMany({
      where: { OR: [{ lines: { some: { accountId: { in: accounts } } } }, { expenseId: { in: expenses } }, { entryNumber: { startsWith: TAG } }] },
      select: { id: true },
    })
  ).map((e) => e.id);
  await db.auditLog.deleteMany({ where: { entityId: { in: entries } } });
  await db.journalEntry.updateMany({ where: { id: { in: entries } }, data: { reversesId: null } });
  await db.journalLine.deleteMany({ where: { entryId: { in: entries } } });
  await db.journalEntry.deleteMany({ where: { id: { in: entries } } });
  await db.expense.deleteMany({ where: { id: { in: expenses } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: accounts } } });
  await db.ledgerAccount.updateMany({ where: { id: { in: accounts } }, data: { parentId: null } });
  await db.ledgerAccount.deleteMany({ where: { id: { in: accounts } } });

  const docs = (await db.stockDocument.findMany({ where: { number: { startsWith: TAG } }, select: { id: true } })).map((d) => d.id);
  await db.auditLog.deleteMany({ where: { entityId: { in: docs } } });
  await db.stockDocument.deleteMany({ where: { id: { in: docs } } });
  await db.warehouse.deleteMany({ where: { code: { startsWith: TAG } } });

  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const leads = (await db.lead.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((l) => l.id);
  for (const id of leads) await db.automationEvent.deleteMany({ where: { recordId: { startsWith: id } } });
  await db.activity.deleteMany({ where: { leadId: { in: leads } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: leads } } });
  await db.lead.deleteMany({ where: { id: { in: leads } } });
  const partyAccounts = (await db.commissionPartyAccount.findMany({ where: { commissionPartyId: { in: companies } }, select: { id: true } })).map((a) => a.id);
  await db.auditLog.deleteMany({ where: { entityId: { in: partyAccounts } } });
  await db.commissionPartyAccount.deleteMany({ where: { id: { in: partyAccounts } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.auditLog.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
}

async function main() {
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;

  const ledger = await import("../src/actions/ledger");
  const expenseActions = await import("../src/actions/expense");
  const inventory = await import("../src/actions/inventory");
  const { postApprovedStockDocument } = await import("../src/lib/inventory/stock-documents");
  const { accountsSettings } = await import("../src/lib/accounts/settings");
  const leadActions = await import("../src/actions/lead");
  const { writeStageMove } = await import("../src/lib/leads/stage-move");
  const { leadStages } = await import("../src/lib/pipeline/server");
  const incentive = await import("../src/actions/incentive");
  const commission = await import("../src/actions/commission-party");
  const { moduleAvailableForTenant } = await import("../src/lib/modules-access");

  await cleanup();
  try {
    const rep = await db.user.create({ data: { name: "ZZ A2 Rep", email: "rep@zza2.invalid", passwordHash: "!", role: "SALES" }, select: { id: true } });
    const clerk = await db.user.create({ data: { name: "ZZ A2 Clerk", email: "clerk@zza2.invalid", passwordHash: "!", role: "SALES" }, select: { id: true } });

    // ── Ledger ──
    const cash = await db.ledgerAccount.create({ data: { code: `${TAG}-1`, name: `${TAG} Cash`, type: "ASSET" }, select: { id: true } });
    const rent = await db.ledgerAccount.create({ data: { code: `${TAG}-2`, name: `${TAG} Rent`, type: "EXPENSE" }, select: { id: true } });
    const today = new Date().toISOString().slice(0, 10);

    section("SEC-40: manual journals");
    const negative = await ledger.createManualJournal({
      date: today,
      narration: `${TAG} negative`,
      lines: [
        { accountId: cash.id, debit: "-500", credit: "" },
        { accountId: rent.id, debit: "-500", credit: "" },
        { accountId: rent.id, debit: "", credit: "-1000" },
      ],
    });
    ok("a negative debit or credit is refused", /zero or more/.test(errorOf(negative)), negative);
    ok("  and nothing was written", (await db.journalLine.count({ where: { accountId: { in: [cash.id, rent.id] } } })) === 0);
    const borrowed = await ledger.createManualJournal({
      date: today,
      narration: `${TAG} borrowed source`,
      source: "INVOICE" as "MANUAL",
      lines: [
        { accountId: rent.id, debit: "100", credit: "" },
        { accountId: cash.id, debit: "", credit: "100" },
      ],
    });
    const borrowedRow = borrowed.ok ? await db.journalEntry.findUnique({ where: { id: borrowed.data.id }, select: { source: true } }) : null;
    ok("a hand-written entry naming INVOICE as its source is booked as MANUAL", borrowed.ok && borrowedRow?.source === "MANUAL", { borrowed, borrowedRow });
    const opening = await ledger.createManualJournal({
      date: today,
      narration: `${TAG} opening`,
      source: "OPENING",
      lines: [
        { accountId: cash.id, debit: "50", credit: "" },
        { accountId: rent.id, debit: "", credit: "50" },
      ],
    });
    const openingRow = opening.ok ? await db.journalEntry.findUnique({ where: { id: opening.data.id }, select: { source: true } }) : null;
    ok("  OPENING, which the dialog offers, stays OPENING", openingRow?.source === "OPENING", opening);

    const parent = await db.ledgerAccount.create({ data: { code: `${TAG}-G1`, name: `${TAG} Group`, type: "ASSET", isGroup: true }, select: { id: true } });
    const child = await db.ledgerAccount.create({ data: { code: `${TAG}-G2`, name: `${TAG} Sub-group`, type: "ASSET", isGroup: true, parentId: parent.id }, select: { id: true } });
    const grandchild = await db.ledgerAccount.create({ data: { code: `${TAG}-G3`, name: `${TAG} Sub-sub`, type: "ASSET", isGroup: true, parentId: child.id }, select: { id: true } });
    const self = await ledger.saveAccount({ id: parent.id, code: `${TAG}-G1`, name: `${TAG} Group`, type: "ASSET", isGroup: true, parentId: parent.id });
    ok("an account can't be its own parent", /under itself/.test(errorOf(self)), self);
    const loop = await ledger.saveAccount({ id: parent.id, code: `${TAG}-G1`, name: `${TAG} Group`, type: "ASSET", isGroup: true, parentId: grandchild.id });
    ok("  nor sit under one of its own sub-accounts, two levels down", /its own sub-accounts/.test(errorOf(loop)), loop);
    ok("  and the tree is as it was", (await db.ledgerAccount.findUnique({ where: { id: parent.id }, select: { parentId: true } }))?.parentId === null);
    const fine = await ledger.saveAccount({ id: grandchild.id, code: `${TAG}-G3`, name: `${TAG} Sub-sub`, type: "ASSET", isGroup: true, parentId: parent.id });
    ok("  moving a sub-account up under a grandparent is fine", fine.ok, fine);

    section("SEC-14: reversing by hand");
    const system = await db.journalEntry.create({
      data: {
        entryNumber: `${TAG}/SYS/1`,
        date: new Date(`${today}T00:00:00Z`),
        narration: `${TAG} posted by an invoice`,
        source: "INVOICE",
        createdById: admin.id,
        lines: { create: [{ accountId: cash.id, debit: 10, credit: 0, sortOrder: 0 }, { accountId: rent.id, debit: 0, credit: 10, sortOrder: 1 }] },
      },
      select: { id: true },
    });
    const refused = await ledger.reverseJournalEntry({ entryId: system.id });
    ok("an invoice's own posting can't be reversed by hand", /posted automatically/.test(errorOf(refused)), refused);
    ok("  and no reversal was written", (await db.journalEntry.count({ where: { reversesId: system.id } })) === 0);
    const allowed = borrowed.ok ? await ledger.reverseJournalEntry({ entryId: borrowed.data.id, reason: TAG }) : { ok: false as const, error: "no manual entry" };
    ok("  a hand-written one still can", allowed.ok, allowed);

    section("SEC-56: what a failed ledger action says");
    const internal = await ledger.reverseJournalEntry({ entryId: 12345 as unknown as string });
    ok("a database error comes back as a plain sentence, not Prisma's", errorOf(internal) === "Could not reverse that entry.", errorOf(internal).slice(0, 120));
    const missing = await ledger.reverseJournalEntry({ entryId: "zza2-not-there" });
    ok("  our own refusal still reads as written", errorOf(missing) === "That entry no longer exists.", missing);

    section("SEC-15: posting expense claims");
    const books = await moduleAvailableForTenant("accounting");
    const claim = (status: "SUBMITTED" | "APPROVED" | "DRAFT") =>
      db.expense.create({ data: { userId: admin.id, amount: 420, spentOn: new Date(`${today}T00:00:00Z`), description: `${TAG} taxi`, status, reimbursable: true }, select: { id: true } });
    const submitted = await claim("SUBMITTED");
    const draft = await claim("DRAFT");
    const early = await expenseActions.postExpensesToLedger([submitted.id, draft.id]);
    ok("a submitted or draft claim isn't posted from the unposted list", (await db.journalEntry.count({ where: { expenseId: { in: [submitted.id, draft.id] } } })) === 0, early);
    if (books) ok("  and both are counted as failed", early.ok && early.data.failed === 2 && early.data.posted === 0, early);
    const approved = await claim("APPROVED");
    const [one, two] = await Promise.all([expenseActions.postExpensesToLedger([approved.id]), expenseActions.postExpensesToLedger([approved.id])]);
    const posted = await db.journalEntry.findMany({ where: { expenseId: approved.id }, select: { postingKey: true, source: true } });
    if (books) {
      ok("an approved claim posted twice at once books one entry", posted.length === 1 && posted[0]?.source === "EXPENSE", { one, two, posted });
      ok("  carrying its posting key", posted[0]?.postingKey === `expense:${approved.id}`, posted);
    } else {
      console.log("  (accounting is off in this workspace — the posting itself isn't exercised)");
    }

    // ── Stock ──
    section("SEC-13: four eyes on a stock adjustment");
    const warehouse = await db.warehouse.create({ data: { code: `${TAG}-WH`, name: `${TAG} Store` }, select: { id: true } });
    const stockDoc = (number: string, data: { status: "DRAFT" | "PENDING_APPROVAL"; createdById: string; submittedById?: string | null }) =>
      db.stockDocument.create({ data: { type: "ADJUSTMENT", number: `${TAG}/${number}`, date: new Date(`${today}T00:00:00Z`), warehouseId: warehouse.id, reason: TAG, ...data }, select: { id: true } });
    const sentIn = await stockDoc("1", { status: "PENDING_APPROVAL", createdById: rep.id, submittedById: admin.id });
    const r1 = await inventory.approveStockDocument(sentIn.id);
    ok("whoever sent it for approval can't approve it", /sent this for approval/.test(errorOf(r1)), r1);
    const edited = await stockDoc("2", { status: "PENDING_APPROVAL", createdById: rep.id, submittedById: clerk.id });
    await db.auditLog.create({ data: { userId: admin.id, action: "UPDATE", entityType: "StockDocument", entityId: edited.id, entityLabel: `Stock adjustment ${TAG}/2 drafted` } });
    const r2 = await inventory.approveStockDocument(edited.id);
    ok("  nor whoever changed a colleague's draft", /You changed this voucher/.test(errorOf(r2)), r2);
    const sentBack = await stockDoc("3", { status: "DRAFT", createdById: rep.id });
    const r3 = await inventory.approveStockDocument(sentBack.id);
    ok("  a draft (sent back) isn't approved", !r3.ok && (await db.stockDocument.findUnique({ where: { id: sentBack.id }, select: { status: true, approvedById: true } }))?.approvedById === null, r3);
    const settings = await accountsSettings();
    let thrown = "";
    try {
      await db.$transaction((tx) => postApprovedStockDocument(tx, sentBack.id, admin.id, settings));
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    ok("  and the posting step itself refuses a draft, inside its transaction", /sent back to draft/.test(thrown), thrown);
    ok("  it stays a draft with nothing posted", (await db.stockDocument.findUnique({ where: { id: sentBack.id }, select: { status: true } }))?.status === "DRAFT");

    // ── Leads ──
    section("SEC-36: a won lead");
    const customer = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, createdById: admin.id }, select: { id: true } });
    const pipeline = await leadStages();
    const wonStage = pipeline.stages.find((s) => s.status === "WON" && !s.archived);
    const wonAt = new Date("2026-04-15T10:00:00Z");
    const lead = await db.lead.create({
      data: { companyId: customer.id, title: `${TAG} deal`, status: "WON", estimatedValue: 100000, ownerUserId: admin.id, ...(pipeline.stored && wonStage ? { stageId: wonStage.id, stageChangedAt: wonAt } : {}) },
    });
    const raised = await leadActions.updateLeadDetails({ leadId: lead.id, title: lead.title, estimatedValue: 900000 });
    ok("a won lead's value can't be changed", /value is locked/.test(errorOf(raised)), raised);
    ok("  it holds what it was won at", Number((await db.lead.findUnique({ where: { id: lead.id }, select: { estimatedValue: true } }))?.estimatedValue) === 100000);
    const retitled = await leadActions.updateLeadDetails({ leadId: lead.id, title: `${TAG} deal renamed`, estimatedValue: 100000 });
    ok("  its other details still can", retitled.ok, retitled);
    if (pipeline.stored && wonStage) {
      const from = { ...wonStage };
      await db.$transaction((tx) =>
        writeStageMove(tx, { lead, from, target: wonStage, status: "WON", lostReason: null, pipeline, moves: true, won: false, sales: false }, admin.id),
      );
      const after = await db.lead.findUnique({ where: { id: lead.id }, select: { stageChangedAt: true } });
      ok("a move from a won stage to a won stage keeps the won date", after?.stageChangedAt?.getTime() === wonAt.getTime(), after);
    } else {
      console.log("  (no stored stages in this workspace — the won-date check is skipped)");
    }

    // ── Incentives ──
    section("SEC-37: an incentive decision");
    const bogus = await incentive.decideEarning({ id: "zza2-not-there", decision: "BOGUS" as "PAY" });
    ok("a decision that isn't approve, hold, cancel or pay is refused before anything is read", /Choose approve, hold, cancel or pay/.test(errorOf(bogus)), bogus);
    const proto = await incentive.decideEarning({ id: "zza2-not-there", decision: "__proto__" as "PAY" });
    ok("  nor a name the object happens to have", /Choose approve/.test(errorOf(proto)), proto);
    const real = await incentive.decideEarning({ id: "zza2-not-there", decision: "APPROVE" });
    ok("  a real one goes on to look the earning up", /no longer exists/.test(errorOf(real)), real);

    // ── Commission ──
    section("SEC-17: commission payee bank details");
    const party = await db.company.create({ data: { name: `${TAG} Referrer`, normalizedName: `${TAG.toLowerCase()} referrer`, relationshipType: "COMMISSION_PARTY", createdById: admin.id, ownerUserId: rep.id }, select: { id: true } });
    const account = { label: "Primary", accountHolderName: "ZZ Referrer", bankAccountNumber: "000111222333", bankIfsc: "HDFC0000001", bankName: "HDFC", isDefault: true };
    actorId = rep.id;
    let repAdd: { ok: boolean; error?: string } | string;
    try {
      repAdd = await commission.createCommissionPartyAccount(party.id, account);
    } catch (err) {
      repAdd = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    ok("a rep without “Manage finance records” can't add a payee account", (typeof repAdd === "string" ? repAdd : errorOf(repAdd)) !== "" && (await db.commissionPartyAccount.count({ where: { commissionPartyId: party.id } })) === 0, repAdd);
    actorId = admin.id;
    const adminAdd = await commission.createCommissionPartyAccount(party.id, account);
    ok("  finance can", adminAdd.ok, adminAdd);
    if (adminAdd.ok) {
      actorId = rep.id;
      let repChange: { ok: boolean; error?: string } | string;
      try {
        repChange = await commission.updateCommissionPartyAccount(adminAdd.data.id, { ...account, bankAccountNumber: "999888777666" });
      } catch (err) {
        repChange = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      const held = await db.commissionPartyAccount.findUnique({ where: { id: adminAdd.data.id }, select: { bankAccountNumber: true } });
      ok("  a rep can't repoint it to another bank account", held?.bankAccountNumber === "000111222333", { repChange, held });
      actorId = admin.id;
    }
  } finally {
    actorId = admin.id;
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} A2 audit-fix checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
