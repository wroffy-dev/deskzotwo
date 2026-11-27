/**
 * check:receipt-reader — Arjun filling an expense claim in from its receipt (owner, 20 Nov 2026 —
 * src/lib/bill-reader/receipt.ts).
 *
 *   · The receipt as read: figures as a model may write them; the checks (not a receipt, no amount stop it; another
 *     currency, no date, a date ahead or long ago, tax over the total, GST without a GSTIN, a GSTIN that doesn't check
 *     out, the same claim made before are said); what it fills in — only what was read.
 *   · On a workspace: offered to somebody who may use Deskzo AI; only a claim's receipt (its kinds, 512KB, a PDF of a
 *     page or two); read as Arjun with the receipt sent to the model; the same amount on the same day already claimed
 *     said; nothing saved; the form drawn.
 *
 * Nothing leaves: Deskzo AI is a stand-in.
 *
 *   npm run check:receipt-reader
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
const sent: { feature: string; files: { mediaType: string }[] }[] = [];
let answer: Record<string, unknown> = {};
const gateway = {
  AiRefusal,
  aiService: async () => ({ model: "Zz Model", residency: "Zzland", noTraining: true }),
  aiUnavailable: async () => null,
  aiTurn: async (turn: { feature: string; history: { files?: { mediaType: string }[] }[] }) => {
    sent.push({ feature: turn.feature, files: turn.history[0]?.files ?? [] });
    return { text: "", toolCalls: [{ id: randomUUID(), name: "propose_receipt", input: answer }], native: null, usage: { input: 1, output: 1 }, stop: "tools", model: "zz", family: "BEDROCK", modelKey: "zz", charge: { credits: 1 } };
  },
};
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }), usePathname: () => "/expenses/new", useSearchParams: () => new URLSearchParams() };
  if (request === "@/lib/session" || request.endsWith("/lib/session")) return session;
  if (request === "@/lib/ai/gateway" || request.endsWith("/lib/ai/gateway")) return gateway;
  if (request === "@/lib/modules-access" || request.endsWith("/lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => session.requireUser(), requireModuleAccess: async () => session.requireUser() };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
function makePdf(pages: number): string {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${pages} >>`, ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>")];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1").toString("base64");
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const r = require("../src/lib/bill-reader/receipt") as typeof import("../src/lib/bill-reader/receipt");
  const gst = require("../src/lib/gst-engine") as typeof import("../src/lib/gst-engine");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("1. The receipt as read");
  const first14 = "29AABCU9603R1Z";
  const gstin = first14 + gst.gstinCheckCharacter(first14);
  const read = r.proposedReceiptSchema.parse({ merchant: "Hotel Zz Residency", merchantGstin: gstin.toLowerCase(), invoiceNumber: "HZR/221", date: "2026-11-12", total: "₹5,900.00", tax: "900", what: "Room, one night", category: "ACCOMMODATION", paidBy: "card" });
  ok("figures as a model writes them", read.total === 5900 && read.tax === 900 && read.merchantGstin === gstin && read.category === "ACCOMMODATION");
  const ctx = { today: "2026-11-20", baseCurrency: "INR", sameClaim: null as string | null };
  ok("a clean receipt: nothing to say", r.checkReceipt(read, ctx).length === 0, r.checkReceipt(read, ctx));
  const fill = r.receiptFill(read, "INR");
  ok("what it fills in: amount, tax, day, category, what it was for with the bill number, paid by card", fill.amount === "5900.00" && fill.taxAmount === "900.00" && fill.spentOn === "2026-11-12" && fill.category === "ACCOMMODATION" && fill.description === "Room, one night — Hotel Zz Residency (bill HZR/221)" && fill.paymentMode === "PERSONAL_CARD", fill);
  const say = (x: Partial<import("../src/lib/bill-reader/receipt").ReadReceipt>, c: Partial<typeof ctx> = {}) => r.checkReceipt({ ...read, ...x }, { ...ctx, ...c }).map((y) => `${y.level}: ${y.text}`);
  ok("not a receipt: stopped, nothing else", say({ notAReceipt: "a menu card" }).join() === "stop: This doesn't look like a receipt — it reads as a menu card.");
  ok("no amount read: stopped", say({ total: undefined }).some((x) => x.startsWith("stop: No amount")));
  ok("another currency, no date, a date ahead, a date long ago: said", say({ currency: "USD" }).some((x) => x.includes("It's in USD")) && say({ date: undefined }).some((x) => x.includes("No date")) && say({ date: "2026-12-01" }).some((x) => x.includes("after today")) && say({ date: "2026-06-01" }).some((x) => x.includes("more than three months")));
  ok("tax over the total said, and left out of the claim", say({ tax: 6000 }).some((x) => x.includes("more than the total")) && r.receiptFill({ ...read, tax: 6000 }, "INR").taxAmount === null);
  ok("GST without a GSTIN, and a GSTIN that doesn't check out: said", say({ merchantGstin: undefined }).some((x) => x.includes("no GSTIN for the seller")) && say({ merchantGstin: "29AABCU9603R1ZZ" }).some((x) => x.includes("doesn't check out")));
  ok("in another currency: the amount isn't filled in", r.receiptFill({ ...read, currency: "USD" }, "INR").amount === null);
  const uae = r.checkReceipt({ ...read, merchantGstin: "100234567890003" }, { ...ctx, baseCurrency: "AED", tax: { india: false, name: "VAT" } }).map((x) => x.text);
  ok("in the UAE: a TRN isn't held to a GSTIN's check character; VAT without one said as VAT", !uae.some((x) => x.includes("doesn't check out")) && r.checkReceipt({ ...read, merchantGstin: undefined }, { ...ctx, tax: { india: false, name: "VAT" } }).some((x) => x.text === "It shows VAT but no tax number for the seller — no input VAT can be claimed on it."));
  ok("  and the model asked about VAT and a TRN, not GST", r.readReceiptSystem({ india: false, name: "VAT" }).includes("VAT on it") && r.readReceiptSystem({ india: false, name: "VAT" }).includes("(TRN)") && !r.readReceiptSystem({ india: false, name: "VAT" }).includes("CGST"));
  ok("paid by UPI or cash; nothing said, nothing filled", r.receiptFill({ ...read, paidBy: "upi" }, "INR").paymentMode === "UPI" && r.receiptFill({ ...read, paidBy: undefined }, "INR").paymentMode === null);

  section("2. On a workspace");
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const actions = require("../src/actions/receipt-reader") as typeof import("../src/actions/receipt-reader");
  const copilotSettings = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  if (!admin) throw new Error("no super admin");
  actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
  const t0 = new Date();
  const tag = randomUUID().slice(0, 6);
  let expenseId: string | null = null;
  try {
    copilotSettings.setTestSettings({ enabled: false, draftingEnabled: true, dailyCreditLimit: null });
    ok("not offered while Deskzo AI is off", (await actions.mayReadReceipts()) === false && !(await actions.readExpenseReceipt({ name: "r.png", dataUrl: `data:image/png;base64,${PNG}` })).ok);
    copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: null });
    ok("offered to somebody who may use Deskzo AI", (await actions.mayReadReceipts()) === true);

    const txt = await actions.readExpenseReceipt({ name: "r.txt", dataUrl: "data:text/plain;base64,aGVsbG8=" });
    const big = await actions.readExpenseReceipt({ name: "big.png", dataUrl: `data:image/png;base64,${Buffer.alloc(600 * 1024, 1).toString("base64")}` });
    const pdf4 = await actions.readExpenseReceipt({ name: "four.pdf", dataUrl: `data:application/pdf;base64,${makePdf(4)}` });
    ok("only a claim's receipt: its kinds, 512KB at most, a PDF of three pages at most", !txt.ok && !big.ok && /512KB/.test(big.ok ? "" : big.error) && !pdf4.ok && /4 pages/.test(pdf4.ok ? "" : pdf4.error), [txt, big, pdf4].map((x) => (x.ok ? "ok" : x.error)));

    answer = { merchant: `Zz Cabs ${tag}`, date: t0.toISOString().slice(0, 10), total: 412, what: "Cab, airport to office", category: "TRAVEL", paidBy: "upi" };
    sent.length = 0;
    const got = await actions.readExpenseReceipt({ name: "cab.png", dataUrl: `data:image/png;base64,${PNG}` });
    ok("read as Arjun, the photo sent to the model; the claim filled in", got.ok && sent[0]?.feature === "receipts.read" && sent[0].files[0]?.mediaType === "image/png" && got.data.fill.amount === "412.00" && got.data.fill.category === "TRAVEL" && got.data.fill.paymentMode === "UPI", got.ok ? got.data.fill : got.error);
    const work = await db.aiTeammateWork.findFirst({ where: { userId: admin.id, teammate: "arjun", kind: "receipts.read", startedAt: { gte: t0 } }, select: { status: true, label: true, summary: true } });
    ok("  seen working, named for the seller", work?.status === "DONE" && work.label === `Zz Cabs ${tag}` && /₹412/.test(work.summary ?? ""), work);
    const pdf1 = await actions.readExpenseReceipt({ name: "one.pdf", dataUrl: `data:application/pdf;base64,${makePdf(1)}` });
    ok("  a one-page PDF too, sent as a PDF", pdf1.ok && sent[sent.length - 1]?.files[0]?.mediaType === "application/pdf");

    // The same receipt claimed before.
    const day = new Date(`${t0.toISOString().slice(0, 10)}T00:00:00Z`);
    expenseId = (await db.expense.create({ data: { category: "TRAVEL", amount: 412, spentOn: day, description: `Zz cab ${tag}`, userId: admin.id, status: "SUBMITTED" } as never, select: { id: true, expenseSeq: true } })).id;
    const twice = await actions.readExpenseReceipt({ name: "cab-again.png", dataUrl: `data:image/png;base64,${PNG}` });
    ok("the same amount on the same day already claimed: said, naming the claim", twice.ok && twice.data.checks.some((c) => /already \(EXP-/.test(c.text)), twice.ok ? twice.data.checks : twice.error);
    const editing = await actions.readExpenseReceipt({ name: "cab.png", dataUrl: `data:image/png;base64,${PNG}`, expenseId });
    ok("  but not the claim being edited itself", editing.ok && !editing.data.checks.some((c) => /already/.test(c.text)));
    ok("nothing saved by reading — no new claim", (await db.expense.count({ where: { userId: admin.id, createdAt: { gte: t0 } } })) === 1);

    answer = { notAReceipt: "a visiting card" };
    const card = await actions.readExpenseReceipt({ name: "card.png", dataUrl: `data:image/png;base64,${PNG}` });
    ok("not a receipt: said, and nothing filled in", card.ok && card.data.checks[0]?.level === "stop" && /visiting card/.test(card.data.checks[0].text));

    section("3. The form");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
    const { createElement } = require("react") as typeof import("react");
    const { ExpenseForm } = require("../src/components/expenses/expense-form") as typeof import("../src/components/expenses/expense-form");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const html = await renderHtml(
      createElement(ExpenseForm, {
        companies: [],
        visit: null,
        mayReadReceipts: true,
        defaults: { category: "OTHER", amount: "", taxAmount: "", spentOn: "2026-11-20", description: "", paymentMode: "CASH", reimbursable: true, visitId: "", companyId: "", leadId: "", receiptName: "" },
      }),
    );
    ok("the expense form: the receipt, and that a photo is shrunk to fit", html.includes("Attach") && html.includes("a photo is shrunk to fit"), html.slice(0, 200));
  } finally {
    copilotSettings.setTestSettings(null);
    if (expenseId) await db.expense.deleteMany({ where: { id: expenseId } }).catch(() => undefined);
    await db.aiTeammateWork.deleteMany({ where: { teammate: "arjun", kind: "receipts.read", startedAt: { gte: t0 } } }).catch(() => undefined);
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? `All ${passes} receipt reader checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
