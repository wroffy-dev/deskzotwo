/**
 * check:bank-match — Arjun reading the bank's money in that the books don't have yet (owner, 20 Nov 2026 —
 * src/lib/bank-match).
 *
 *   · Reading a narration: a name's telling words, run together or cut up by the bank; a UTR; an invoice number, never a
 *     UTR's digits taken for one.
 *   · What an amount fits: one invoice exactly, several adding up to it, one less TDS, part of the one named, else the
 *     account; two invoices of the amount, the older.
 *   · A proposal per line: already in the books (match it, never record it twice), an invoice named, a name, an amount
 *     only one invoice has, the AI's guess; two names alike, nothing.
 *   · On a workspace, with its own bank account, customer and invoices (Zz …): the proposals; Deskzo AI asked about the
 *     line the rules couldn't place, once; Record & match onto one invoice and onto several — the payment into this
 *     account, dated the statement's day, the line ticked, the invoices settled; a receipt already in the books refused
 *     a second recording; somebody without Banking sees nothing.
 *
 * Nothing leaves: Deskzo AI is a stand-in.
 *
 *   npm run check:bank-match
 */
import "dotenv/config";
import Module from "node:module";
import { randomUUID } from "node:crypto";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("no actor");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
class AiRefusal extends Error {}
const prompts: string[] = [];
let answer: Record<string, unknown> = { matches: [] };
const gateway = {
  AiRefusal,
  aiService: async () => ({ model: "Zz Model", residency: "Zzland", noTraining: true }),
  aiUnavailable: async () => null,
  aiTurn: async (turn: { history: { text?: string }[] }) => {
    prompts.push(turn.history[0]?.text ?? "");
    return { text: "", toolCalls: [{ id: randomUUID(), name: "propose_matches", input: answer }], native: null, usage: { input: 1, output: 1 }, stop: "tools", model: "zz", family: "BEDROCK", modelKey: "zz", charge: { credits: 1 } };
  },
};
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }), usePathname: () => "/accounting/banking", useSearchParams: () => new URLSearchParams() };
  if (request === "@/lib/session" || request.endsWith("/lib/session")) return session;
  if (request === "@/lib/ai/gateway" || request.endsWith("/lib/ai/gateway")) return gateway;
  if (request === "@/lib/modules-access" || request.endsWith("/lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => session.requireUser(), requireModuleAccess: async () => session.requireUser() };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const DAY = 86_400_000;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const r = require("../src/lib/bank-match/rules") as typeof import("../src/lib/bank-match/rules");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("1. Reading a narration");
  ok("a name's telling words — not Pvt, Ltd, Solutions", r.nameWords("Acme Solutions Pvt. Ltd.").join() === "acme" && r.nameWords("Brandbuzz Media LLP").join() === "brandbuzz,media");
  ok("found as words, or run together by the bank", r.nameScore("NEFT CR-HDFC0001234-ACME SOLUTIONS PVT LTD", "Acme Solutions Pvt Ltd") === 1 && r.nameScore("IMPS/ACMESOLNS/MUM", "Acme Solutions") === 1 && r.nameScore("NEFT-BRANDBUZZ-AXIS", "Brandbuzz Media LLP") === 0.5);
  ok("bank words and short words aren't a name", r.nameScore("NEFT CR TRF FROM", "Neft Traders") === 0 && r.nameScore("UPI CR 1234", "Co Op") === 0);
  ok("the UTR: the statement's, else a long run in the narration", r.referenceOf({ narration: "x", reference: "UTR123" }) === "UTR123" && r.referenceOf({ narration: "NEFT CR-HDFCN52026112012345-ACME", reference: null }) === "HDFCN52026112012345");
  const inv = (id: string, number: string, balance: number, extra: Partial<import("../src/lib/bank-match/rules").OpenInvoice> = {}) => ({ id, number, companyId: "acme", companyName: "Acme Solutions Pvt Ltd", balance, total: balance, taxable: Math.round((balance / 1.18) * 100) / 100, issueDate: new Date("2026-10-01"), ...extra });
  const named = r.invoicesNamed("NEFT ACME INV1644 PAYMENT 1700", [inv("a", "INV/1644", 1), inv("b", "1700", 1)]);
  ok("an invoice named by its number — never a bare number a UTR could hold", named.length === 1 && named[0]!.id === "a");

  section("2. What an amount fits");
  const pool = [inv("i1", "INV-1", 118000, { issueDate: new Date("2026-09-01") }), inv("i2", "INV-2", 59000, { issueDate: new Date("2026-09-15") }), inv("i3", "INV-3", 23600, { issueDate: new Date("2026-10-01") })];
  const one = r.fitAmount(59000, pool);
  ok("one invoice exactly", one.kind === "EXACT" && one.allocations[0]!.invoiceId === "i2");
  const several = r.fitAmount(82600, pool);
  ok("several adding up to it, when only one set does", several.kind === "SEVERAL" && several.allocations.map((a) => a.invoiceId).join() === "i2,i3", several);
  const tds = r.fitAmount(108000, [inv("t", "INV-9", 118000, { taxable: 100000 })]);
  ok("one less 10% TDS on the value before GST — said, the TDS left open", tds.kind === "TDS" && tds.allocations[0]!.amount === 108000 && /10% TDS/.test(tds.why), tds);
  ok("  outside India, TDS isn't looked for", r.fitAmount(108000, [inv("t", "INV-9", 118000, { taxable: 100000 })], [], { india: false }).kind === "ON_ACCOUNT");
  const part = r.fitAmount(50000, pool, [pool[0]!]);
  ok("part of the one the narration names", part.kind === "PART" && part.allocations[0]!.invoiceId === "i1" && part.allocations[0]!.amount === 50000);
  ok("nothing it fits: their account", r.fitAmount(1234, pool).kind === "ON_ACCOUNT");
  const twin = r.fitAmount(500, [inv("o", "INV-A", 500, { issueDate: new Date("2026-08-01") }), inv("n", "INV-B", 500, { issueDate: new Date("2026-09-01") })]);
  ok("two invoices of the amount: the older, said so", twin.allocations[0]!.invoiceId === "o" && /oldest of 2/.test(twin.why));

  section("3. A proposal per line");
  const line = (id: string, narration: string, amount: number, date = "2026-11-10") => ({ id, date: new Date(`${date}T00:00:00Z`), narration, reference: null, amount });
  const customers = [{ id: "acme", name: "Acme Solutions Pvt Ltd" }, { id: "beta", name: "Beta Infra LLP" }, { id: "gam1", name: "Gamma Foods" }, { id: "gam2", name: "Gamma Foods Retail" }];
  const invoices = [...pool, { ...inv("b1", "BI/77", 40000), companyId: "beta", companyName: "Beta Infra LLP" }];
  const ps = r.proposeMoneyIn(
    [line("l1", "NEFT CR-ACME SOLUTIONS PVT LTD", 59000), line("l2", "IMPS REF BI/77 PAID", 40000), line("l3", "UPI/CR/8899/RAVI", 23600), line("l4", "NEFT GAMMA FOODS", 1000), line("l5", "CHQ DEP 445566", 77000), line("l6", "UPI/QUOKKA", 1500)],
    { invoices, customers, unmatched: [{ id: "bk", date: new Date("2026-11-01T00:00:00Z"), amount: 77000, narration: "Receipt from Delta" }], guesses: new Map([["l6", { companyId: "beta", documentIds: [], why: "QUOKKA is Beta's trading name" }]]) },
  );
  const p = (id: string) => ps.find((x) => x.statementLineId === id);
  ok("a name in it: that customer, the invoice it fits", p("l1")?.companyId === "acme" && p("l1")?.kind === "EXACT" && p("l1")?.how === "NAME");
  ok("an invoice named in it: its customer", p("l2")?.companyId === "beta" && p("l2")?.how === "INVOICE" && p("l2")?.allocations[0]?.invoiceId === "b1");
  ok("no name, but only one invoice open of the amount: proposed, to be checked", p("l3")?.how === "AMOUNT" && p("l3")?.confidence === "MEDIUM" && p("l3")?.allocations[0]?.invoiceId === "i3");
  ok("two customers named alike: nothing proposed", !p("l4"));
  ok("a receipt of the amount already in the books: match it, never record it twice", p("l5")?.kind === "IN_BOOKS" && p("l5")?.bookLineId === "bk");
  ok("the AI's guess, where the rules had nothing: its customer, said so", p("l6")?.companyId === "beta" && p("l6")?.how === "AI" && p("l6")?.kind === "ON_ACCOUNT");

  section("4. On a workspace");
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const actions = require("../src/actions/bank-match") as typeof import("../src/actions/bank-match");
  const bank = require("../src/actions/bank") as typeof import("../src/actions/bank");
  const receivable = require("../src/actions/receivable") as typeof import("../src/actions/receivable");
  const copilotSettings = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  /* eslint-enable @typescript-eslint/no-require-imports */
  copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: null });
  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  if (!admin) throw new Error("no super admin");
  actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
  const tag = randomUUID().slice(0, 5).toUpperCase();
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const day = (n: number) => new Date(today.getTime() + n * DAY);
  const NAME = `Zzquokka ${tag} Solutions Pvt Ltd`;
  const company = await db.company.create({ data: { name: NAME, normalizedName: NAME.toLowerCase(), createdById: admin.id, relationshipType: "CLIENT" }, select: { id: true } });
  const madeAccount = await bank.saveBankAccount({ name: `Zz Bank ${tag}`, bankName: "Zz Bank", accountNumber: `00${tag}`, ifsc: "ZZBK0000001" });
  if (!madeAccount.ok) throw new Error(`bank account: ${madeAccount.error}`);
  const accountId = madeAccount.data.id;
  let n = 0;
  const invoice = (total: number, issued: number) =>
    db.tradeDocument.create({
      data: { docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: company.id, docNumber: `ZQ${tag}-${++n}`, taxableValue: Math.round((total / 1.18) * 100) / 100, total, createdById: admin.id, issueDate: day(issued), dueDate: day(issued + 30) } as never,
      select: { id: true, docNumber: true },
    });
  const stmt = (narration: string, amount: number, on: number) =>
    db.bankStatementLine.create({ data: { bankAccountId: accountId, date: day(on), narration, amount, fingerprint: randomUUID() }, select: { id: true } });
  const paymentIds: string[] = [];
  try {
    const a = await invoice(47200, -40);
    const b = await invoice(17700, -35);
    const c = await invoice(5900, -30);
    const d = await invoice(31860, -25);
    const lExact = await stmt(`NEFT CR-HDFCN52026112012345-ZZQUOKKA ${tag} SOLUTIONS-PAYMENT`, 47200, -3);
    const lSeveral = await stmt(`IMPS-${b.docNumber}-${c.docNumber}-ZZQ`, 23600, -2);
    const lUnknown = await stmt(`UPI/CR/77889/QKSOL${tag}`, 1000, -1);

    const panel = await actions.moneyInPanel(accountId);
    const item = (id: string) => panel?.items.find((i) => i.line.id === id);
    ok("the proposals: the name and its invoice; two invoices the narration names, adding up", item(lExact.id)?.proposal.kind === "EXACT" && item(lExact.id)?.proposal.allocations[0]?.invoiceId === a.id && item(lSeveral.id)?.proposal.kind === "SEVERAL" && item(lSeveral.id)?.proposal.allocations.length === 2, panel?.items.map((i) => i.proposal));
    ok("  the line the rules couldn't place, left to ask about; recording and asking offered", !item(lUnknown.id) && (panel?.unasked ?? 0) >= 1 && panel?.mayAsk === true && panel.mayRecord === true);

    // Deskzo AI, for the line the rules couldn't place.
    prompts.length = 0;
    answer = { matches: [{ line: 1, customer: 1, invoices: [], why: `QKSOL${tag} is Zzquokka Solutions` }] };
    const asked = await actions.askArjunMoneyIn(accountId);
    const sent = prompts[0] ?? "";
    ok("Deskzo AI asked about it: the narration and the customers it might be, with their open invoices", asked.ok && asked.data.placed === 1 && sent.includes(`QKSOL${tag}`) && sent.includes(NAME) && sent.includes(d.docNumber), asked.ok ? asked.data : asked.error);
    const after = await actions.moneyInPanel(accountId);
    const ai = after?.items.find((i) => i.line.id === lUnknown.id);
    ok("  its reading proposed, said so — on account, since ₹1,000 fits nothing", ai?.proposal.how === "AI" && ai.proposal.companyId === company.id && ai.proposal.kind === "ON_ACCOUNT", ai?.proposal);
    const again = await actions.askArjunMoneyIn(accountId);
    ok("  and each line asked once", again.ok && again.data.asked === 0 && prompts.length === 1);

    // Record & match: onto one invoice.
    const p1 = item(lExact.id)!.proposal;
    const rec1 = await actions.recordFromBankLine({ statementLineId: lExact.id, companyId: p1.companyId!, allocations: p1.allocations });
    const pay1 = rec1.ok ? await db.payment.findUnique({ where: { id: rec1.data.paymentId }, select: { bankAccountId: true, paidOn: true, amount: true, reference: true, allocations: { select: { documentId: true, amount: true } } } }) : null;
    if (rec1.ok) paymentIds.push(rec1.data.paymentId);
    const line1 = await db.bankStatementLine.findUnique({ where: { id: lExact.id }, select: { matchedLineId: true } });
    const invA = await db.tradeDocument.findUnique({ where: { id: a.id }, select: { status: true } });
    ok("Record & match onto one invoice: into this account, dated the statement's day, with its UTR — the line ticked, the invoice paid", rec1.ok && rec1.data.matched && pay1?.bankAccountId === accountId && pay1.paidOn.toISOString().slice(0, 10) === day(-3).toISOString().slice(0, 10) && pay1.reference === "HDFCN52026112012345" && !!line1?.matchedLineId && invA?.status === "PAID", rec1.ok ? { pay1, invA } : rec1.error);

    // Onto several.
    const p2 = item(lSeveral.id)!.proposal;
    const rec2 = await actions.recordFromBankLine({ statementLineId: lSeveral.id, companyId: p2.companyId!, allocations: p2.allocations });
    if (rec2.ok) paymentIds.push(rec2.data.paymentId);
    const pay2 = rec2.ok ? await db.payment.findUnique({ where: { id: rec2.data.paymentId }, select: { bankAccountId: true, allocations: { select: { documentId: true } } } }) : null;
    const settled = await db.tradeDocument.findMany({ where: { id: { in: [b.id, c.id] } }, select: { status: true } });
    ok("onto several: one payment into this account, applied to each, the line ticked", rec2.ok && rec2.data.matched && pay2?.bankAccountId === accountId && pay2.allocations.length === 2 && settled.every((s) => s.status === "PAID"), rec2.ok ? { pay2, settled, notes: rec2.data.notes } : rec2.error);

    // A receipt already in the books.
    const manual = await receivable.recordInvoicePayment({ invoiceId: d.id, amount: 31860, paidOn: day(-20).toISOString().slice(0, 10), method: "BANK_TRANSFER", reference: "", notes: "", bankAccountId: accountId });
    if (manual.ok) paymentIds.push(manual.data.id);
    const lDup = await stmt(`NEFT CR-ZZQUOKKA ${tag}`, 31860, -9);
    const third = await actions.moneyInPanel(accountId);
    const dup = third?.items.find((i) => i.line.id === lDup.id);
    ok("a receipt of the amount already in the books, eleven days apart: offered to match, not record", manual.ok && dup?.proposal.kind === "IN_BOOKS" && !!dup.proposal.bookLineId, dup?.proposal ?? (manual.ok ? "no proposal" : manual.error));
    const twice = await actions.recordFromBankLine({ statementLineId: lDup.id, companyId: company.id, allocations: [] });
    ok("  and recording it again refused", !twice.ok && /already in the books/.test(twice.ok ? "" : twice.error));

    // Somebody without Banking.
    const members = await db.user.findMany({ where: { active: true, kind: "MEMBER", isSuperAdmin: false }, select: { id: true, name: true, email: true, role: true }, take: 40 });
    let outsider: (typeof members)[number] | null = null;
    for (const m of members) if (!(await can(m.id, "payments.manage"))) { outsider = m; break; }
    if (outsider) {
      actor = outsider;
      const seen = await actions.moneyInPanel(accountId);
      const rec = await actions.recordFromBankLine({ statementLineId: lUnknown.id, companyId: company.id, allocations: [] });
      ok("somebody without “Manage finance records” sees nothing and records nothing", seen === null && !rec.ok);
      actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
    }

    section("5. The screen");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
    const { createElement } = require("react") as typeof import("react");
    const { MoneyInProposals } = require("../src/components/accounting/money-in-proposals") as typeof import("../src/components/accounting/money-in-proposals");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const html = await renderHtml(createElement(MoneyInProposals, { bankAccountId: accountId, panel: third! }));
    ok("Banking: the money in, who it's from, what it pays, and the buttons", html.includes("in your books yet") && html.includes("Already in the books") && html.includes(">Match<") && html.includes("read by Deskzo AI"), html.slice(0, 300));
  } finally {
    copilotSettings.setTestSettings(null);
    actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
    const entries = await db.journalEntry.findMany({ where: { paymentId: { in: paymentIds } }, select: { id: true } }).catch(() => [] as { id: string }[]);
    await db.bankStatementLine.deleteMany({ where: { bankAccountId: accountId } }).catch((e) => console.error("cleanup: lines", e.message));
    await db.journalLine.deleteMany({ where: { entryId: { in: entries.map((e) => e.id) } } }).catch((e) => console.error("cleanup: journal lines", e.message));
    await db.journalEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } }).catch((e) => console.error("cleanup: journal", e.message));
    await db.paymentAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } }).catch(() => undefined);
    await db.payment.deleteMany({ where: { id: { in: paymentIds } } }).catch((e) => console.error("cleanup: payments", e.message));
    await db.auditLog.deleteMany({ where: { entityId: { in: paymentIds } } }).catch(() => undefined);
    await db.tradeDocument.deleteMany({ where: { companyId: company.id } }).catch((e) => console.error("cleanup: invoices", e.message));
    const acct = await db.bankAccount.findUnique({ where: { id: accountId }, select: { ledgerAccountId: true } });
    await db.bankAccount.deleteMany({ where: { id: accountId } }).catch((e) => console.error("cleanup: bank account", e.message));
    if (acct) await db.ledgerAccount.deleteMany({ where: { id: acct.ledgerAccountId } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: company.id } }).catch((e) => console.error("cleanup: company", e.message));
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? `All ${passes} bank match checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
