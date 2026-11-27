/**
 * check:bill-reader — Arjun reading a vendor's bill into a draft bill (owner, 20 Nov 2026 — src/lib/bill-reader).
 *
 *   · The AI connection sends a file with a message: a PDF as a document and a photo as an image to Claude, a file and an
 *     image URL to OpenAI, inline data to Gemini.
 *   · The bill as read: figures as a model may write them, a line with only its taxable value, the GSTIN's own check
 *     character; the checks (not a bill, already entered, another currency stop it; arithmetic, GST, the split, the
 *     total, the GSTIN billed to and unknown HSN codes are said); the draft as the bill form's own schema takes it.
 *   · On a workspace, with its own vendor (Zz …): only PDFs and photos, not too big, not too many pages; read as Arjun
 *     with the file sent to the model; the vendor found by GSTIN; the draft bill made through the bill form's door —
 *     DRAFT, the vendor's number, the lines, the vendor's file linked; the same bill again refused; something that isn't a
 *     bill can't be drafted; the file served to whoever uploaded it, and not to somebody who may not see the bill; the screens.
 *
 * Nothing leaves: Deskzo AI is a stand-in.
 *
 *   npm run check:bill-reader
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
const sent: { feature: string; files: { name: string; mediaType: string; data: string }[] }[] = [];
let answer: Record<string, unknown> = {};
const gateway = {
  AiRefusal,
  aiService: async () => ({ model: "Zz Model", residency: "Zzland", noTraining: true }),
  aiUnavailable: async () => null,
  aiTurn: async (turn: { feature: string; history: { role: string; files?: { name: string; mediaType: string; data: string }[] }[] }) => {
    sent.push({ feature: turn.feature, files: turn.history[0]?.files ?? [] });
    return { text: "", toolCalls: [{ id: randomUUID(), name: "propose_bill", input: answer }], native: null, usage: { input: 1, output: 1 }, stop: "tools", model: "zz", family: "BEDROCK", modelKey: "zz", charge: { credits: 1 } };
  },
};
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/purchase/bills/read",
      useSearchParams: () => new URLSearchParams(),
      notFound: () => {
        throw new Error("NOT_FOUND (notFound() was called)");
      },
      redirect: (to: string) => {
        throw new Error(`REDIRECT to ${to}`);
      },
    };
  }
  if (request === "@/lib/session" || request.endsWith("/lib/session")) return session;
  if (request === "@/lib/ai/gateway" || request.endsWith("/lib/ai/gateway")) return gateway;
  if (request === "@/lib/modules-access" || request.endsWith("/lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => session.requireUser(), requireModuleAccess: async () => session.requireUser() };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

/** A PDF of `pages` blank pages — enough for a page count. */
function makePdf(pages: number): Buffer {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const r = require("../src/lib/bill-reader/rules") as typeof import("../src/lib/bill-reader/rules");
  const gst = require("../src/lib/gst-engine") as typeof import("../src/lib/gst-engine");
  const anthropic = require("../src/lib/copilot/providers/anthropic") as typeof import("../src/lib/copilot/providers/anthropic");
  const openai = require("../src/lib/copilot/providers/openai") as typeof import("../src/lib/copilot/providers/openai");
  const gemini = require("../src/lib/copilot/providers/gemini") as typeof import("../src/lib/copilot/providers/gemini");
  const { tradeDocumentSchema } = require("../src/lib/validation/trade-document") as typeof import("../src/lib/validation/trade-document");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("1. A file with a message, to each provider");
  const turn = { role: "user" as const, text: "Read this bill.", files: [{ name: "bill.pdf", mediaType: "application/pdf" as const, data: "QUJD" }, { name: "p.png", mediaType: "image/png" as const, data: "REVG" }] };
  const a = anthropic.messagesFor([turn])[0]!.content as { type: string; source?: { media_type?: string } }[];
  ok("Claude: the PDF as a document, the photo as an image, then the words", a[0]?.type === "document" && a[0].source?.media_type === "application/pdf" && a[1]?.type === "image" && a[1].source?.media_type === "image/png" && a[2]?.type === "text");
  const o = openai.messagesFor("sys", [turn])[1]!.content as { type: string; file?: { file_data: string }; image_url?: { url: string } }[];
  ok("OpenAI: a file and an image URL, as data", o[0]?.type === "file" && o[0].file?.file_data === "data:application/pdf;base64,QUJD" && o[1]?.image_url?.url === "data:image/png;base64,REVG" && o[2]?.type === "text");
  const g = gemini.contentsFor([turn])[0]!.parts as { inlineData?: { mimeType: string } ; text?: string }[];
  ok("Gemini: inline data, then the words", g[0]?.inlineData?.mimeType === "application/pdf" && g[1]?.inlineData?.mimeType === "image/png" && g[2]?.text === "Read this bill.");
  ok("  and a message with no file is as it was", anthropic.messagesFor([{ role: "user", text: "Hi" }])[0]!.content === "Hi");

  section("2. The bill as read, and its checks");
  const first14 = "27AABCZ1234F1Z";
  const vendorGstin = first14 + gst.gstinCheckCharacter(first14);
  ok("a GSTIN checks out by its own check character; one character off doesn't", r.gstinChecksOut(vendorGstin) && !r.gstinChecksOut(vendorGstin.slice(0, 14) + (vendorGstin[14] === "A" ? "B" : "A")));
  const settled = r.settleBill(
    r.proposedBillSchema.parse({ vendorName: "Zz Traders", vendorGstin: ` ${vendorGstin.toLowerCase()} `, billNumber: "INV-1", billDate: "2026-11-10", lines: [{ description: "Toner", quantity: "2", rate: "₹1,500.00", taxable: 3000, gstRate: 18 }, { description: "Service", taxable: "1,000", gstRate: 18 }], cgst: 360, sgst: 360, total: "4,720", currency: "inr" }),
  );
  ok("figures as a model writes them; a line with only its taxable value is one of it", settled.vendorGstin === vendorGstin && settled.lines[0]!.rate === 1500 && settled.lines[1]!.quantity === 1 && settled.lines[1]!.rate === 1000 && settled.total === 4720 && settled.currency === "INR", settled);
  const ctx = { ourGstins: ["27AAACD0000D1Z5"], ourStateCode: "27", baseCurrency: "INR", duplicate: null, unknownHsn: [] as number[], today: "2026-11-20" };
  ok("a bill that adds up, CGST and SGST within the state: nothing to say", r.checkBill(settled, ctx).length === 0, r.checkBill(settled, ctx));
  const say = (b: Partial<import("../src/lib/bill-reader/rules").ReadBill>, c: Partial<typeof ctx> = {}) => r.checkBill({ ...settled, ...b }, { ...ctx, ...c }).map((x) => `${x.level}: ${x.text}`);
  ok("not a bill: stopped, and nothing else said", say({ notABill: "a quotation" }).join() === "stop: This doesn't look like a bill — it reads as a quotation.");
  ok("already entered: stopped", say({}, { duplicate: "This vendor's bill INV-1 is already entered — the same bill can't be booked twice." })[0]!.startsWith("stop: This vendor's bill"));
  ok("another currency: stopped", say({ currency: "USD" }).some((x) => x.startsWith("stop: It's in USD")));
  ok("IGST within one state: said", say({ cgst: 0, sgst: 0, igst: 720 }).some((x) => x.includes("both in Maharashtra, but the bill charges IGST")));
  ok("CGST and SGST across states: said", say({}, { ourStateCode: "29" }).some((x) => x.includes("in Maharashtra and your branch in Karnataka")));
  ok("a line that doesn't multiply out: said", say({ lines: [{ ...settled.lines[0]!, taxable: 3100 }, settled.lines[1]!] }).some((x) => x.includes("Line 1: 2 × ₹1,500.00 is ₹3,000.00, but the bill says ₹3,100.00")));
  ok("GST not what the rates make: said; a total that doesn't add up: said", say({ cgst: 400, sgst: 400 }).some((x) => x.includes("The GST charged is ₹800.00; the lines' rates make it ₹720.00")) && say({ total: 5000 }).some((x) => x.includes("the bill's total is ₹5,000.00")));
  ok("billed to a GSTIN that isn't yours, an HSN the directory doesn't have, a GSTIN that doesn't check out: said", say({ billedToGstin: "29AAACX0000X1Z1" }).some((x) => x.includes("isn't one of yours")) && say({}, { unknownHsn: [0] }).some((x) => x.includes("Line 1: HSN/SAC")) && say({ vendorGstin: "27AABCZ1234F1ZZ" }).some((x) => x.includes("doesn't check out")));
  const draft = r.draftInput({ ...settled, roundOff: -0.4, lines: [{ ...settled.lines[0]!, hsn: "844332" }, { ...settled.lines[1]!, hsn: "9999" }] }, { vendorId: "v1", locationId: "l1", poId: null, billNumber: "INV-1", billDate: "2026-11-10", dueDate: null, itemIds: ["i1", null] }, { unknownHsn: [1], fileName: "bill.pdf" });
  const parsedDraft = tradeDocumentSchema.safeParse(draft);
  ok("the draft as the bill form's own schema takes it: registered vendor, lines, round off, the unknown HSN left off", parsedDraft.success && draft.gstTreatment === "REGISTERED_REGULAR" && draft.buyerGstin === vendorGstin && draft.lines[0]!.itemId === "i1" && draft.lines[0]!.hsnCode === "844332" && draft.lines[1]!.hsnCode === "" && draft.adjustment === -0.4 && draft.adjustmentLabel === "Round off", parsedDraft.success ? draft : parsedDraft.error.issues[0]);
  ok("a line's words matched to a name", r.nameOverlap("HP 88A Toner Cartridge", "Toner cartridge HP 88A black") >= 0.75 && r.nameOverlap("Toner", "Laptop") === 0);

  section("3. On a workspace");
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const actions = require("../src/actions/bill-reader") as typeof import("../src/actions/bill-reader");
  const route = require("../src/app/api/bill-readings/[id]/route") as typeof import("../src/app/api/bill-readings/[id]/route");
  const copilotSettings = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
  const { branchIdentity, defaultBranchIdFor } = require("../src/lib/branches/identity") as typeof import("../src/lib/branches/identity");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { findTradeDocumentFor } = require("../src/lib/documents/load") as typeof import("../src/lib/documents/load");
  const { documentWriteKey } = require("../src/lib/documents/write-permission") as typeof import("../src/lib/documents/write-permission");
  /* eslint-enable @typescript-eslint/no-require-imports */
  copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: null });
  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  if (!admin) throw new Error("no super admin");
  actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
  const ourState = (await branchIdentity(await defaultBranchIdFor(admin.id))).stateCode ?? "27";
  const ourGstin = (await db.gstRegistration.findFirst({ where: { active: true }, select: { gstin: true } }))?.gstin ?? null;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const vFirst14 = `${ourState}AABCZ${String(Math.floor(Math.random() * 9000) + 1000)}F1Z`;
  const vGstin = vFirst14 + gst.gstinCheckCharacter(vFirst14);
  const NAME = `Zz Bill Vendor ${tag} Pvt Ltd`;
  const vendor = await db.company.create({ data: { name: NAME, normalizedName: NAME.toLowerCase(), createdById: admin.id, relationshipType: "VENDOR" }, select: { id: true } });
  await db.companyLocation.create({ data: { companyId: vendor.id, label: "Head office", gstNumber: vGstin, state: gst.GST_STATE_CODES[ourState] ?? null, isPrimary: true } });
  const t0 = new Date();
  const billNo = `ZZB-${tag}-1`;
  const goodBill = {
    vendorName: NAME,
    vendorGstin: vGstin,
    ...(ourGstin ? { billedToGstin: ourGstin } : {}),
    billNumber: billNo,
    endCustomer: `Zz End Customer ${tag} Ltd`,
    billDate: new Date().toISOString().slice(0, 10),
    lines: [{ description: `Zz printer toner ${tag}`, hsn: "844399", quantity: 2, unit: "NOS", rate: 1500, taxable: 3000, gstRate: 18 }],
    cgst: 270,
    sgst: 270,
    total: 3540,
  };
  const form = (name: string, type: string, bytes: Buffer) => {
    const f = new FormData();
    f.set("file", new File([new Uint8Array(bytes)], name, { type }));
    return f;
  };
  let otherUser: { id: string; name: string; email: string; role: string } | null = null;
  try {
    // Files that can't be read.
    const txt = await actions.readBillFile(form("bill.txt", "text/plain", Buffer.from("hello")));
    const big = await actions.readBillFile(form("big.png", "image/png", Buffer.alloc(6 * 1024 * 1024, 1)));
    const many = await actions.readBillFile(form("bundle.pdf", "application/pdf", makePdf(6)));
    ok("only PDFs and photos; not over 5 MB; not more than 5 pages", !txt.ok && /reads PDF, JPG, PNG, WebP/.test(txt.ok ? "" : txt.error) && !big.ok && /5 MB at most/.test(big.ok ? "" : big.error) && !many.ok && /has 6 pages/.test(many.ok ? "" : many.error), [txt, big, many].map((x) => (x.ok ? "ok" : x.error)));

    // A one-page PDF and a photo, read.
    answer = goodBill;
    sent.length = 0;
    const pdf = await actions.readBillFile(form("zz-bill.pdf", "application/pdf", makePdf(1)));
    ok("a one-page PDF read as Arjun, the file sent to the model as a PDF", pdf.ok && pdf.data.status === "READ" && sent[0]?.feature === "bills.read" && sent[0].files[0]?.mediaType === "application/pdf", pdf.ok ? pdf.data.status : pdf.error);
    answer = goodBill;
    const read = await actions.readBillFile(form("zz-bill.png", "image/png", PNG));
    const view = read.ok ? read.data : null;
    ok("a photo read; the vendor found by the GSTIN on their address", !!view && view.vendor?.id === vendor.id && view.bill?.lines.length === 1, view?.vendor);

    // Not found by GSTIN (owner, 23 Nov 2026 — Savex's Maharashtra GSTIN): the same PAN in another state first, then the
    // names that share the bill's telling word — never six vendors that only share "Technologies".
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const billServer = require("../src/lib/bill-reader/server") as typeof import("../src/lib/bill-reader/server");
    const brand = `Savex${tag.toLowerCase()}`;
    const lookalikes = await Promise.all(
      [`Aaa ${tag} Technologies Pvt Ltd`, `${brand} Technologies Pvt Ltd`].map((n) => db.company.create({ data: { name: n, normalizedName: n.toLowerCase(), createdById: admin.id, relationshipType: "VENDOR" }, select: { id: true } })),
    );
    try {
      const byName = await billServer.matchVendor({ ...goodBill, vendorName: `${brand} Technologies Private Limited`, vendorGstin: undefined } as never);
      ok("a vendor not found by GSTIN: the one sharing the bill's brand offered first, not those only sharing Technologies", byName.vendor === null && byName.candidates[0]?.id === lookalikes[1]!.id && !byName.candidates.some((c) => c.id === lookalikes[0]!.id), byName.candidates);
      const otherState = ourState === "29" ? "27" : "29";
      const other14 = otherState + vFirst14.slice(2);
      const byPan = await billServer.matchVendor({ ...goodBill, vendorName: "Somebody Else Ltd", vendorGstin: other14 + gst.gstinCheckCharacter(other14) } as never);
      ok("  the same PAN registered in another state: that vendor offered first, with the GSTIN they have", byPan.vendor === null && byPan.candidates[0]?.id === vendor.id && byPan.candidates[0]?.gstin === vGstin, byPan.candidates);
    } finally {
      await db.company.deleteMany({ where: { id: { in: lookalikes.map((l) => l.id) } } });
    }
    ok("  a bill that adds up within the state: nothing to stop it", !!view && !view.checks.some((c) => c.level === "stop"), view?.checks);
    const stored = await db.billReading.findUnique({ where: { id: view!.id }, select: { fileDataUrl: true, bytes: true } });
    ok("  the vendor's file kept — in the storage box, or as data where there's none", !!stored && /^(dzblob:|data:image\/png;base64,)/.test(stored.fileDataUrl) && stored.bytes === PNG.length);
    const work = await db.aiTeammateWork.findFirst({ where: { userId: admin.id, teammate: "arjun", kind: "bills.read", startedAt: { gte: t0 } }, select: { status: true, label: true } });
    ok("  seen working, as Arjun, named for the vendor and bill", work?.status === "DONE" && work.label.includes(billNo), work);

    // The draft.
    const made = await actions.makeDraftBill({ id: view!.id, vendorId: vendor.id, billNumber: billNo, billDate: goodBill.billDate });
    const doc = made.ok ? await db.tradeDocument.findUnique({ where: { id: made.data.documentId }, select: { docType: true, status: true, docNumber: true, companyId: true, origin: true, lines: { select: { name: true, quantity: true, unitPrice: true, taxRatePercent: true, hsnCode: true } } } }) : null;
    ok("the draft bill: DRAFT, the vendor's number, the line as read — through the bill form's door", !!doc && doc.docType === "BILL" && doc.status === "DRAFT" && doc.docNumber === billNo && doc.companyId === vendor.id && doc.lines.length === 1 && Number(doc.lines[0]!.unitPrice) === 1500 && Number(doc.lines[0]!.taxRatePercent) === 18, made.ok ? doc : made.error);
    const notes = made.ok ? (await db.tradeDocument.findUnique({ where: { id: made.data.documentId }, select: { notes: true } }))?.notes : null;
    ok("  the end customer the bill names, in the draft's notes", !!notes && notes.includes(`End customer: Zz End Customer ${tag} Ltd`), notes);
    const linked = await db.billReading.findUnique({ where: { id: view!.id }, select: { status: true, documentId: true } });
    ok("  the reading linked to the bill", linked?.status === "USED" && linked.documentId === (made.ok ? made.data.documentId : null));

    // The same bill again.
    answer = goodBill;
    const again = await actions.readBillFile(form("zz-bill-again.png", "image/png", PNG));
    ok("the same bill read again: stopped as already entered", again.ok && again.data.checks.some((c) => c.level === "stop" && c.text.includes("already entered")));
    const twice = await actions.makeDraftBill({ id: again.ok ? again.data.id : "", vendorId: vendor.id, billNumber: billNo, billDate: goodBill.billDate });
    ok("  and no second draft made", !twice.ok && /already entered/.test(twice.ok ? "" : twice.error), twice);

    // Not a bill.
    answer = { notABill: "a delivery challan" };
    const challan = await actions.readBillFile(form("challan.png", "image/png", PNG));
    const noDraft = await actions.makeDraftBill({ id: challan.ok ? challan.data.id : "", vendorId: vendor.id, billNumber: "X-1", billDate: goodBill.billDate });
    ok("something that isn't a bill: said so, and no draft", challan.ok && challan.data.checks[0]?.text.includes("a delivery challan") === true && !noDraft.ok, noDraft);

    // The vendor's file, served.
    const served = await route.GET(new Request("http://x.test"), { params: Promise.resolve({ id: view!.id }) });
    ok("the vendor's file served to whoever uploaded it, as itself", served.status === 200 && served.headers.get("content-type") === "image/png" && served.headers.get("x-content-type-options") === "nosniff");
    // Somebody else: served the file exactly when they may open the bill made from it.
    const members = await db.user.findMany({ where: { active: true, kind: "MEMBER", isSuperAdmin: false, id: { not: admin.id } }, select: { id: true, name: true, email: true, role: true }, take: 40 });
    for (const m of members) if (made.ok && !(await findTradeDocumentFor(m.id, made.data.documentId))) { otherUser = m; break; }
    if (otherUser) {
      actor = otherUser;
      const refused = await route.GET(new Request("http://x.test"), { params: Promise.resolve({ id: view!.id }) });
      ok("  not to somebody who may not open the bill made from it — a 404", refused.status === 404, refused.status);
      const may = await can(otherUser.id, documentWriteKey("BILL", "create"));
      const notAllowed = await actions.readBillFile(form("x.png", "image/png", PNG));
      ok("  and reading a bill takes the right to create one", may || (!notAllowed.ok && /right to create bills/.test(notAllowed.error)), notAllowed.ok ? "read" : notAllowed.error);
      actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
    } else console.log("        (everybody here may open that bill — the refusal isn't shown)");

    section("4. The screens");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
    const { createElement } = require("react") as typeof import("react");
    const { BillReader } = require("../src/components/documents/bill-reader") as typeof import("../src/components/documents/bill-reader");
    const ReadPage = (require("../src/app/(dashboard)/purchase/bills/read/page") as { default: (p: unknown) => Promise<unknown> }).default;
    const { readingView } = require("../src/lib/bill-reader/server") as typeof import("../src/lib/bill-reader/server");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const blank = await renderHtml(createElement(BillReader, { initial: null }));
    ok("Read a bill: somewhere to drop the vendor's file", blank.includes("Drop the vendor&#x27;s bill here") || blank.includes("Drop the vendor's bill here"), blank.slice(0, 200));
    const again2 = await readingView(again.ok ? again.data.id : "", admin.id);
    const filled = await renderHtml(createElement(BillReader, { initial: again2 }));
    ok("  a reading: the file beside what was read, the check, the vendor, the line, and the button", filled.includes(`/api/bill-readings/${again2!.id}`) && filled.includes("already entered") && filled.includes(NAME) && filled.includes(`Zz printer toner ${tag}`) && filled.includes("Make the draft bill"), filled.slice(0, 300));
    const page = await renderHtml(ReadPage({ searchParams: Promise.resolve({}) }));
    ok("  the page itself, for somebody who may create bills", page.includes("Read a bill") && page.includes("nothing reaches your books"), page.slice(0, 200));
  } finally {
    copilotSettings.setTestSettings(null);
    actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
    await db.billReading.deleteMany({ where: { createdById: { in: [admin.id, ...(otherUser ? [otherUser.id] : [])] }, createdAt: { gte: t0 } } }).catch(() => undefined);
    await db.aiTeammateWork.deleteMany({ where: { teammate: "arjun", kind: "bills.read", startedAt: { gte: t0 } } }).catch(() => undefined);
    const docs = await db.tradeDocument.findMany({ where: { companyId: vendor.id }, select: { id: true } });
    await db.tradeDocumentLine.deleteMany({ where: { documentId: { in: docs.map((d) => d.id) } } }).catch(() => undefined);
    await db.auditLog.deleteMany({ where: { entityId: { in: docs.map((d) => d.id) } } }).catch(() => undefined);
    await db.tradeDocument.deleteMany({ where: { companyId: vendor.id } }).catch((e) => console.error("cleanup: documents", e instanceof Error ? e.message : e));
    await db.companyLocation.deleteMany({ where: { companyId: vendor.id } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: vendor.id } }).catch((e) => console.error("cleanup: vendor", e instanceof Error ? e.message : e));
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? `All ${passes} bill reader checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
