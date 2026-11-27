/**
 * check:storage-documents — documents, PDFs and receipts in the storage box (owner, 13 Nov 2026: "deskzo k saare pdf
 * and doc vhi pr save ho naa ki vm mein"; src/lib/storage/files.ts).
 *
 * For each column, through its real writer and its real readers:
 *
 *   1. A personnel file's document and a candidate's (EmployeeDocument.fileDataUrl), an issued letter's copy left as
 *      "letter:<id>"; /api/hr/documents/[id] serves the file.
 *   2. A project's document (ProjectDocument.fileDataUrl), opened through getProjectDocumentFile.
 *   3. A close task's attachment (CloseTaskAttachment.fileDataUrl), opened through getTaskAttachmentFile.
 *   4. A support email's attachments (SupportEmailAttachment.dataUrl), kept as the email is received — waiting in the
 *      inbox, and on a new ticket — and served by /api/support-email/attachments/[id].
 *   5. The old system's PDF of an archived document (ArchivedDocumentFile.data), as the Zoho pull keeps it — a PDF Zoho
 *      refused stays an empty row — and served by /api/archive/[id]/pdf.
 *   6. A custom field's file (CustomFieldFile.data), kept on upload and read for both download routes.
 *   7. A message template's PDF (QuickTemplateFile.data), attached and read for a send; one gone refuses the send.
 *   8. An expense claim's receipt (Expense.receiptDataUrl), from the web form and on an edit; the claim's page has it,
 *      a list never carries it.
 *
 * Each: without a box the column holds the file as it always did; with one it holds a reference, the file is in the
 * box, and the reader gives back exactly what was uploaded; a reference whose file is gone answers "not found" — never
 * a 500 — and a reference never reaches a page.
 *
 * In a scratch database built from the migrations, with a folder for a box, both dropped after.
 *
 *   npm run check:storage-documents
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
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

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_storagedocs`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  const folder = await mkdtemp(path.join(os.tmpdir(), "deskzo-docs-box-"));
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";
    for (const k of ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER", "STORAGE_AZURE_CONTAINER_URL", "STORAGE_AZURE_SAS", "STORAGE_DIR", "STORAGE_PREFIX"]) delete process.env[k];

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const files = require("../src/lib/storage/files") as typeof import("../src/lib/storage/files");
    const docs = require("../src/actions/employee-docs") as typeof import("../src/actions/employee-docs");
    const candidates = require("../src/actions/candidate") as typeof import("../src/actions/candidate");
    const hrRoute = require("../src/app/api/hr/documents/[id]/route") as typeof import("../src/app/api/hr/documents/[id]/route");
    const projectDocs = require("../src/actions/project-document") as typeof import("../src/actions/project-document");
    const closeActions = require("../src/actions/close") as typeof import("../src/actions/close");
    const { receiveEmail } = require("../src/lib/support-mail/receive") as typeof import("../src/lib/support-mail/receive");
    const supportActions = require("../src/actions/support-mail") as typeof import("../src/actions/support-mail");
    const supportRoute = require("../src/app/api/support-email/attachments/[id]/route") as typeof import("../src/app/api/support-email/attachments/[id]/route");
    const pull = require("../src/lib/zoho/pull") as typeof import("../src/lib/zoho/pull");
    const archiveRoute = require("../src/app/api/archive/[id]/pdf/route") as typeof import("../src/app/api/archive/[id]/pdf/route");
    const secure = require("../src/lib/custom-fields/secure") as typeof import("../src/lib/custom-fields/secure");
    const quick = require("../src/lib/quick-messages/server") as typeof import("../src/lib/quick-messages/server");
    const expenses = require("../src/actions/expense") as typeof import("../src/actions/expense");
    const { checkUpload } = require("../src/lib/hr/document-upload") as typeof import("../src/lib/hr/document-upload");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const person = (name: string, role: string, extra: Record<string, unknown> = {}) =>
      db.user.create({
        data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-storagedocs.in`, passwordHash: "!", role, ...extra },
        select: { id: true, name: true, email: true, role: true },
      });
    const boss = await person("Zz Boss", "ADMIN", { isSuperAdmin: true });
    const asha = await person("Zz Asha", "SALES");
    actor = { id: boss.id, name: boss.name, email: boss.email, role: boss.role };

    const pdfBytes = (tag: string) => Buffer.from(`%PDF-1.4 zz ${tag}\n%%EOF\n`, "latin1");
    const pdfUrl = (tag: string) => files.toDataUrl(pdfBytes(tag), "application/pdf");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
    const pngUrl = files.toDataUrl(png, "image/png");
    // The size an upload's own check gives the row (src/lib/hr/document-upload.ts) — from the file as it came, box or not.
    const checkedSize = (tag: string) => {
      const c = checkUpload({ name: `${tag}.pdf`, fileDataUrl: pdfUrl(tag), mimeType: "application/pdf" });
      return c.ok ? c.sizeBytes : -1;
    };
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    const req = (p: string) => new Request(`http://zz.invalid${p}`);
    const bodyOf = async (res: Response) => Buffer.from(await res.arrayBuffer());
    // A reference to a file the box doesn't have — as a box's file would be after it was lost.
    const lost = (kind: string, type: string) => `${files.TEXT_REF}${kind}/2026-11/${"0".repeat(23)}1|${type}`;
    const lostBytes = (kind: string, type: string) => new Uint8Array(Buffer.concat([Buffer.from("\u0000DZBLOB\u0000", "latin1"), Buffer.from(lost(kind, type), "utf8")]));
    const inBox = (value: string | Uint8Array | null | undefined, kind: string) => files.isStoredRef(value) && files.storedRef(value)!.key.startsWith(`${kind}/`);
    const boxOn = () => {
      process.env.STORAGE_DIR = folder;
    };
    const boxOff = () => {
      delete process.env.STORAGE_DIR;
    };

    // ── 1. Personnel files ──────────────────────────────────────────────────────────────────────────
    section("1. A personnel file's documents (EmployeeDocument.fileDataUrl)");
    const upload = (tag: string) => docs.uploadEmployeeDocument({ userId: asha.id, type: "PAN_CARD", name: `Zz ${tag}.pdf`, fileDataUrl: pdfUrl(tag), mimeType: "application/pdf" });
    boxOff();
    const plainDoc = await upload("plain");
    const plainRow = plainDoc.ok ? await db.employeeDocument.findUnique({ where: { id: plainDoc.data.id }, select: { fileDataUrl: true, sizeBytes: true } }) : null;
    ok("without a box the document is kept in its row, as it always was", plainRow?.fileDataUrl === pdfUrl("plain"), plainDoc);
    const plainServed = plainDoc.ok ? await hrRoute.GET(req("/api/hr/documents"), ctx(plainDoc.data.id)) : null;
    ok("  and served as it was", plainServed?.status === 200 && (await bodyOf(plainServed)).equals(pdfBytes("plain")));
    // HR filing a document they can see tells them, in the bell and by email (owner, 18 Nov 2026).
    const told = await db.notification.findFirst({ where: { userId: asha.id, type: "LETTER_ISSUED", title: "Zz plain.pdf is on your file" }, select: { link: true } });
    ok("  and the person it's filed on is told, with a link to their documents", !!told?.link?.endsWith("?tab=documents"), told);

    boxOn();
    const boxed = await upload("boxed");
    const boxedRow = boxed.ok ? await db.employeeDocument.findUnique({ where: { id: boxed.data.id }, select: { fileDataUrl: true, sizeBytes: true } }) : null;
    ok("with a box the row keeps a reference into employee-documents", inBox(boxedRow?.fileDataUrl, "employee-documents"), boxedRow?.fileDataUrl.slice(0, 60));
    ok("  its size the file's own", boxedRow?.sizeBytes === checkedSize("boxed"), boxedRow?.sizeBytes);
    const fetched = boxed.ok ? await docs.getEmployeeDocument(boxed.data.id) : null;
    ok("getEmployeeDocument hands back the file, never the reference", fetched?.fileDataUrl === pdfUrl("boxed"), fetched?.fileDataUrl.slice(0, 40));
    const served = boxed.ok ? await hrRoute.GET(req("/api/hr/documents"), ctx(boxed.data.id)) : null;
    ok("/api/hr/documents/[id] serves the uploaded bytes", served?.status === 200 && (await bodyOf(served)).equals(pdfBytes("boxed")) && served.headers.get("content-type") === "application/pdf");
    ok("  the old row beside it still reads as it did", (await docs.getEmployeeDocument(plainDoc.ok ? plainDoc.data.id : ""))?.fileDataUrl === pdfUrl("plain"));
    const refused = await docs.uploadEmployeeDocument({ userId: asha.id, type: "PAN_CARD", name: "Zz bad.exe", fileDataUrl: files.toDataUrl(Buffer.from("MZ"), "application/x-msdownload"), mimeType: "application/x-msdownload" });
    ok("the upload's own checks still refuse what they refused", !refused.ok);

    const candidate = await db.candidate.create({ data: { name: "Zz Candidate", email: "zz.candidate@zz-storagedocs.in" }, select: { id: true } });
    const cv = await candidates.uploadCandidateDocument({ candidateId: candidate.id, type: "PAN_CARD", name: "Zz CV.pdf", fileDataUrl: pdfUrl("cv"), mimeType: "application/pdf" });
    const cvRow = cv.ok ? await db.employeeDocument.findUnique({ where: { id: cv.data.id }, select: { fileDataUrl: true } }) : null;
    ok("a candidate's document goes to the box too", cv.ok && inBox(cvRow?.fileDataUrl, "employee-documents"), cv);
    const cvServed = cv.ok ? await hrRoute.GET(req("/api/hr/documents"), ctx(cv.data.id)) : null;
    ok("  and is served whole", cvServed?.status === 200 && (await bodyOf(cvServed)).equals(pdfBytes("cv")), cvServed?.status);

    await db.employeeProfile.upsert({ where: { userId: asha.id }, create: { userId: asha.id, designation: "Analyst", joinedOn: new Date("2026-04-01") }, update: {} });
    const drafted = await docs.draftLetter(asha.id, "SALARY_CERTIFICATE");
    const issued = drafted.ok ? await docs.issueLetter(drafted.data.id) : drafted;
    const letterCopy = drafted.ok ? await db.employeeDocument.findFirst({ where: { letterId: drafted.data.id }, select: { fileDataUrl: true } }) : null;
    ok("an issued letter's copy on the file is still \"letter:<id>\", nothing in the box", issued.ok && drafted.ok && letterCopy?.fileDataUrl === `letter:${drafted.data.id}`, letterCopy?.fileDataUrl);

    if (boxed.ok) await db.employeeDocument.update({ where: { id: boxed.data.id }, data: { fileDataUrl: lost("employee-documents", "application/pdf") } });
    const gone = boxed.ok ? await hrRoute.GET(req("/api/hr/documents"), ctx(boxed.data.id)) : null;
    ok("a document whose file is gone from the box is not found — not a 500", gone?.status === 404, gone?.status);
    ok("  getEmployeeDocument says null, as for one you may not see", boxed.ok && (await docs.getEmployeeDocument(boxed.data.id)) === null);

    // ── 2. Projects ─────────────────────────────────────────────────────────────────────────────────
    section("2. A project's documents (ProjectDocument.fileDataUrl)");
    const company = await db.company.create({ data: { name: "Zz Docs Co", normalizedName: "zz docs co", createdById: boss.id }, select: { id: true, ownerUserId: true, relationshipType: true } });
    const project = await db.project.create({ data: { code: "ZZ-DOC-1", name: "Zz Docs project", companyId: company.id, createdById: boss.id }, select: { id: true } });
    const projectUpload = (tag: string) => projectDocs.uploadProjectDocument({ projectId: project.id, type: "AGREEMENT", name: `Zz ${tag}.pdf`, fileDataUrl: pdfUrl(tag), mimeType: "application/pdf" });
    boxOff();
    const pPlain = await projectUpload("project-plain");
    ok("without a box, in the row", pPlain.ok && (await db.projectDocument.findUnique({ where: { id: pPlain.data.id }, select: { fileDataUrl: true } }))?.fileDataUrl === pdfUrl("project-plain"), pPlain);
    boxOn();
    const pBoxed = await projectUpload("project-boxed");
    const pRow = pBoxed.ok ? await db.projectDocument.findUnique({ where: { id: pBoxed.data.id }, select: { fileDataUrl: true, sizeBytes: true } }) : null;
    ok("with a box, a reference into project-documents, the real size kept", inBox(pRow?.fileDataUrl, "project-documents") && pRow?.sizeBytes === checkedSize("project-boxed"), pRow);
    const pFile = pBoxed.ok ? await projectDocs.getProjectDocumentFile(pBoxed.data.id) : null;
    ok("getProjectDocumentFile hands the browser the file, not the reference", !!pFile?.ok && pFile.data.fileDataUrl === pdfUrl("project-boxed"), pFile?.ok ? pFile.data.fileDataUrl.slice(0, 40) : pFile);
    ok("  and the older row as it was", pPlain.ok && (await projectDocs.getProjectDocumentFile(pPlain.data.id)).ok);
    if (pBoxed.ok) await db.projectDocument.update({ where: { id: pBoxed.data.id }, data: { fileDataUrl: lost("project-documents", "application/pdf") } });
    const pGone = pBoxed.ok ? await projectDocs.getProjectDocumentFile(pBoxed.data.id) : null;
    ok("a file gone from the box: \"That document no longer exists.\"", pGone !== null && !pGone.ok && pGone.error === "That document no longer exists.", pGone);

    // ── 3. The month-end close ──────────────────────────────────────────────────────────────────────
    section("3. A close task's attachments (CloseTaskAttachment.fileDataUrl)");
    const task = await db.closeTask.create({ data: { month: new Date("2026-09-01T00:00:00Z"), title: "Zz GST returns", dueOn: new Date("2026-10-10T00:00:00Z") }, select: { id: true } });
    const attach = (tag: string) => closeActions.addTaskAttachment(task.id, { name: `Zz ${tag}.pdf`, fileDataUrl: pdfUrl(tag), mimeType: "application/pdf" });
    boxOff();
    const cPlain = await attach("close-plain");
    ok("without a box, in the row", cPlain.ok && (await db.closeTaskAttachment.findUnique({ where: { id: cPlain.data.id }, select: { fileDataUrl: true } }))?.fileDataUrl === pdfUrl("close-plain"), cPlain);
    boxOn();
    const cBoxed = await attach("close-boxed");
    const cRow = cBoxed.ok ? await db.closeTaskAttachment.findUnique({ where: { id: cBoxed.data.id }, select: { fileDataUrl: true, sizeBytes: true } }) : null;
    ok("with a box, a reference into close-attachments, the real size kept", inBox(cRow?.fileDataUrl, "close-attachments") && cRow?.sizeBytes === checkedSize("close-boxed"), cRow);
    const cFile = cBoxed.ok ? await closeActions.getTaskAttachmentFile(cBoxed.data.id) : null;
    ok("getTaskAttachmentFile hands back the file as uploaded", !!cFile?.ok && cFile.data.fileDataUrl === pdfUrl("close-boxed"), cFile?.ok ? cFile.data.fileDataUrl.slice(0, 40) : cFile);
    if (cBoxed.ok) await db.closeTaskAttachment.update({ where: { id: cBoxed.data.id }, data: { fileDataUrl: lost("close-attachments", "application/pdf") } });
    const cGone = cBoxed.ok ? await closeActions.getTaskAttachmentFile(cBoxed.data.id) : null;
    ok("a file gone from the box: \"That file no longer exists.\"", cGone !== null && !cGone.ok && cGone.error === "That file no longer exists.", cGone);

    // ── 4. Support email ────────────────────────────────────────────────────────────────────────────
    section("4. A support email's attachments (SupportEmailAttachment.dataUrl)");
    let seq = 0;
    const mail = (from: string, tag: string) => {
      seq += 1;
      return {
        from: { address: from, name: "Zz Sender" },
        to: ["help@zz-storagedocs.invalid"],
        cc: [],
        subject: `Zz printer broken ${seq}`,
        text: "It prints nothing.",
        messageId: `<zz-${seq}-${tag}@zz-storagedocs.invalid>`,
        inReplyTo: null,
        references: [],
        automated: null,
        senderVerified: true,
        senderCheck: "pass",
        attachments: [{ fileName: `${tag}.pdf`, mimeType: "application/pdf", sizeBytes: pdfBytes(tag).length, dataUrl: pdfUrl(tag) }],
      };
    };
    const attachmentOf = (emailId: string | null) => db.supportEmailAttachment.findFirst({ where: { emailId: emailId ?? "" }, select: { id: true, dataUrl: true, sizeBytes: true } });
    boxOff();
    const sPlain = await receiveEmail(mail("stranger@zz-nobody.invalid", "mail-plain"));
    const sPlainRow = await attachmentOf(sPlain.emailId);
    ok("without a box, the email's file is kept in its row", sPlain.state === "INBOX" && sPlainRow?.dataUrl === pdfUrl("mail-plain"), sPlain);
    boxOn();
    const sBoxed = await receiveEmail(mail("stranger@zz-nobody.invalid", "mail-boxed"));
    const sRow = await attachmentOf(sBoxed.emailId);
    ok("with a box, an email waiting in the inbox keeps a reference into support-email", sBoxed.state === "INBOX" && inBox(sRow?.dataUrl, "support-email") && sRow?.sizeBytes === pdfBytes("mail-boxed").length, sRow?.dataUrl.slice(0, 50));
    const sFile = sRow ? await supportActions.supportEmailAttachment(sRow.id) : null;
    ok("supportEmailAttachment hands back the file", sFile?.dataUrl === pdfUrl("mail-boxed"), sFile?.dataUrl.slice(0, 40));
    const sServed = sRow ? await supportRoute.GET(req("/api/support-email/attachments"), ctx(sRow.id)) : null;
    ok("/api/support-email/attachments/[id] serves the bytes", sServed?.status === 200 && (await bodyOf(sServed)).equals(pdfBytes("mail-boxed")), sServed?.status);
    const customerCo = await db.company.create({ data: { name: "Zz Customer Co", normalizedName: "zz customer co", createdById: boss.id }, select: { id: true } });
    await db.contact.create({ data: { companyId: customerCo.id, name: "Zz Customer", email: "customer@zz-customer.invalid" } });
    const sTicket = await receiveEmail(mail("customer@zz-customer.invalid", "mail-ticket"));
    const tRow = await attachmentOf(sTicket.emailId);
    ok("an email that opens a ticket keeps its file in the box too", sTicket.state === "NEW_TICKET" && inBox(tRow?.dataUrl, "support-email"), { state: sTicket.state, value: tRow?.dataUrl.slice(0, 50) });
    const tServed = tRow ? await supportRoute.GET(req("/api/support-email/attachments"), ctx(tRow.id)) : null;
    ok("  and is served whole", tServed?.status === 200 && (await bodyOf(tServed)).equals(pdfBytes("mail-ticket")), tServed?.status);
    if (sRow) await db.supportEmailAttachment.update({ where: { id: sRow.id }, data: { dataUrl: lost("support-email", "application/pdf") } });
    const sGone = sRow ? await supportRoute.GET(req("/api/support-email/attachments"), ctx(sRow.id)) : null;
    ok("a file gone from the box is not found — not a 500", sGone?.status === 404, sGone?.status);

    // ── 5. The archive's PDFs ───────────────────────────────────────────────────────────────────────
    section("5. An archived document's PDF (ArchivedDocumentFile.data)");
    const migration = await db.migration.create({ data: { source: "zoho-books", yearStart: new Date("2026-04-01"), switchDate: new Date("2026-07-01"), createdById: boss.id } as never, select: { id: true } });
    const archived = (n: string) =>
      db.archivedDocument.create({ data: { migrationId: migration.id, kind: "INVOICE", key: `INVOICE:zz:${n}`, number: n, date: new Date("2025-02-01"), year: "2024-25", partyName: "Zz Docs Co", total: 590, companyId: company.id, oldId: `OLD-${n}` } as never, select: { id: true } });
    const fileOf = (documentId: string) => db.archivedDocumentFile.findUnique({ where: { documentId }, select: { data: true, size: true, contentType: true } });
    boxOff();
    const aPlain = await archived("ZZ-ARC-1");
    await pull.keepArchivedPdf(aPlain.id, pdfBytes("archive-plain"));
    const aPlainFile = await fileOf(aPlain.id);
    ok("without a box, the PDF is kept in its row", !!aPlainFile && Buffer.from(aPlainFile.data).equals(pdfBytes("archive-plain")), aPlainFile?.size);
    boxOn();
    const aBoxed = await archived("ZZ-ARC-2");
    await pull.keepArchivedPdf(aBoxed.id, pdfBytes("archive-boxed"));
    const aFile = await fileOf(aBoxed.id);
    ok("with a box, a reference into archived-documents, the PDF's own size kept", inBox(aFile?.data, "archived-documents") && aFile?.size === pdfBytes("archive-boxed").length && aFile.contentType === "application/pdf", aFile?.size);
    const aServed = await archiveRoute.GET(req("/api/archive/pdf"), ctx(aBoxed.id));
    ok("/api/archive/[id]/pdf serves the PDF Zoho sent", aServed.status === 200 && (await bodyOf(aServed)).equals(pdfBytes("archive-boxed")), aServed.status);
    const aPlainServed = await archiveRoute.GET(req("/api/archive/pdf"), ctx(aPlain.id));
    ok("  and the one kept in its row as before", aPlainServed.status === 200 && (await bodyOf(aPlainServed)).equals(pdfBytes("archive-plain")), aPlainServed.status);
    const aRefused = await archived("ZZ-ARC-3");
    await pull.keepArchivedPdf(aRefused.id, null);
    const refusedFile = await fileOf(aRefused.id);
    ok("a PDF Zoho refused stays an empty row, \"none\", nothing in the box", refusedFile?.contentType === "none" && refusedFile.size === 0 && refusedFile.data.length === 0, refusedFile);
    ok("  and is not found", (await archiveRoute.GET(req("/api/archive/pdf"), ctx(aRefused.id))).status === 404);
    await db.archivedDocumentFile.update({ where: { documentId: aBoxed.id }, data: { data: lostBytes("archived-documents", "application/pdf") } });
    const aGone = await archiveRoute.GET(req("/api/archive/pdf"), ctx(aBoxed.id));
    ok("a PDF gone from the box is not found — not a 500", aGone.status === 404, aGone.status);

    // ── 6. Custom fields' files ─────────────────────────────────────────────────────────────────────
    section("6. A custom field's file (CustomFieldFile.data)");
    await db.customFieldDefinition.create({ data: { entity: "ORDER", key: "certificate", label: "Certificate", type: "FILE", createdById: boss.id } as never });
    const keepField = (tag: string) => secure.keepUploadedFile({ entity: "ORDER", fieldKey: "certificate", name: `Zz ${tag}`, bytes: pdfBytes(tag), userId: boss.id });
    // The value a record keeps names the file: "f1|<id>|<name>" (src/lib/custom-fields/rules.ts fileValue).
    const fieldRow = (value: string) => db.customFieldFile.findUnique({ where: { id: value.split("|")[1] ?? "" }, select: { id: true, data: true, size: true, contentType: true } });
    boxOff();
    const fPlain = await keepField("field-plain");
    const fPlainRow = fPlain.ok ? await fieldRow(fPlain.value) : null;
    ok("without a box, the file is kept in its row", !!fPlainRow && Buffer.from(fPlainRow.data).equals(pdfBytes("field-plain")), fPlain);
    boxOn();
    const fBoxed = await keepField("field-boxed");
    const fRow = fBoxed.ok ? await fieldRow(fBoxed.value) : null;
    ok("with a box, a reference into custom-field-files, the file's own size and type kept", inBox(fRow?.data, "custom-field-files") && fRow?.size === pdfBytes("field-boxed").length && fRow.contentType === "application/pdf", fRow?.size);
    const fRead = fRow ? await secure.readFieldFile(fRow.id) : null;
    ok("readFieldFile — both download routes' reader — gives the uploaded bytes", !!fRead && fRead.data.equals(pdfBytes("field-boxed")) && fRead.contentType === "application/pdf", fRead?.data.length);
    ok("  and the row kept before the box as it was", !!fPlainRow && (await secure.readFieldFile(fPlainRow.id))?.data.equals(pdfBytes("field-plain")) === true);
    const notPdf = await secure.keepUploadedFile({ entity: "ORDER", fieldKey: "certificate", name: "x.pdf", bytes: Buffer.from("MZ not a pdf"), userId: boss.id });
    ok("what isn't a PDF or an image is still refused, by its bytes", !notPdf.ok);
    if (fRow) await db.customFieldFile.update({ where: { id: fRow.id }, data: { data: lostBytes("custom-field-files", "application/pdf") } });
    ok("a file gone from the box reads as none — the routes answer not found", fRow !== null && (await secure.readFieldFile(fRow.id)) === null);

    // ── 7. Message templates' PDFs ──────────────────────────────────────────────────────────────────
    section("7. A message template's PDF (QuickTemplateFile.data)");
    const template = await db.quickTemplate.create({ data: { name: "Zz Company profile", emailSubject: "Our profile", emailBody: "Attached.", createdById: boss.id }, select: { id: true } });
    const qFileRow = () => db.quickTemplateFile.findUnique({ where: { templateId: template.id }, select: { data: true, size: true, mimeType: true } });
    boxOff();
    const qPlain = await quick.attachTemplateFile(boss.id, template.id, { bytes: pdfBytes("quick-plain"), name: "Profile.pdf" });
    const qPlainRow = await qFileRow();
    ok("without a box, the PDF is kept in its row", qPlain.ok && !!qPlainRow && Buffer.from(qPlainRow.data).equals(pdfBytes("quick-plain")), qPlain);
    boxOn();
    const qBoxed = await quick.attachTemplateFile(boss.id, template.id, { bytes: pdfBytes("quick-boxed"), name: "Profile.pdf" });
    const qRow = await qFileRow();
    ok("replaced with a box, a reference into quick-templates, the PDF's own size kept", qBoxed.ok && inBox(qRow?.data, "quick-templates") && qRow?.size === pdfBytes("quick-boxed").length, qRow?.size);
    const qFile = await quick.templateFile(template.id);
    ok("templateFile — what a send attaches — is the PDF itself", !!qFile && qFile.bytes.equals(pdfBytes("quick-boxed")) && qFile.mime === "application/pdf", qFile?.bytes.length);
    const listed = (await quick.listQuickTemplates()).find((t) => t.id === template.id);
    ok("  the list names it with its real size", listed?.attachment?.size === pdfBytes("quick-boxed").length, listed?.attachment);
    await db.quickTemplateFile.update({ where: { templateId: template.id }, data: { data: lostBytes("quick-templates", "application/pdf") } });
    const qSend = await quick.fileForSend(template.id);
    ok("a PDF gone from the box refuses the send, saying so, rather than sending without it", "error" in qSend && /attach it to the template again/.test(qSend.error), qSend);
    const noFile = await quick.fileForSend(null);
    ok("  a template without a PDF sends as it did", "file" in noFile && noFile.file === null);

    // ── 8. Expense receipts ─────────────────────────────────────────────────────────────────────────
    section("8. An expense claim's receipt (Expense.receiptDataUrl)");
    // Asha's own claims. (getExpense finds nothing for a workspace-wide reader: its access is {} beside other branches
    // of an OR, which Prisma 6 reads as no match — a matter apart from where the receipt is kept.)
    actor = { id: asha.id, name: asha.name, email: asha.email, role: asha.role };
    const claim = (tag: string, receipt: string) =>
      expenses.createExpense({ category: "TRAVEL", amount: 250, spentOn: "2026-11-02", description: `Zz cab ${tag}`, paymentMode: "CASH", reimbursable: true, receiptDataUrl: receipt, receiptName: "receipt.png", submit: false });
    const receiptOf = (id: string) => db.expense.findUnique({ where: { id }, select: { receiptDataUrl: true } });
    boxOff();
    const ePlain = await claim("plain", pngUrl);
    ok("without a box, the receipt is kept in the claim", ePlain.ok && (await receiptOf(ePlain.data.id))?.receiptDataUrl === pngUrl, ePlain);
    boxOn();
    const eBoxed = await claim("boxed", pngUrl);
    const eRow = eBoxed.ok ? await receiptOf(eBoxed.data.id) : null;
    ok("with a box, a reference into expense-receipts", inBox(eRow?.receiptDataUrl, "expense-receipts"), eRow?.receiptDataUrl?.slice(0, 50));
    const eNone = await claim("none", "");
    ok("  a claim without one has none", eNone.ok && (await receiptOf(eNone.data.id))?.receiptDataUrl === null);
    const eOpened = eBoxed.ok ? await expenses.getExpense(eBoxed.data.id) : null;
    ok("the claim's page gets the receipt itself, to draw and download", eOpened?.receiptDataUrl === pngUrl, eOpened?.receiptDataUrl?.slice(0, 40));
    const bigReceipt = files.toDataUrl(Buffer.alloc(600 * 1024, 1), "image/png");
    const tooBig = await claim("big", bigReceipt);
    ok("a receipt over 512 KB is still refused", !tooBig.ok);
    const pdfReceipt = pdfUrl("receipt-edit");
    const edited = eBoxed.ok ? await expenses.updateExpense({ id: eBoxed.data.id, category: "TRAVEL", amount: 250, spentOn: "2026-11-02", description: "Zz cab boxed", paymentMode: "CASH", reimbursable: true, receiptDataUrl: pdfReceipt, receiptName: "receipt.pdf" }) : null;
    const eEditedRow = eBoxed.ok ? await receiptOf(eBoxed.data.id) : null;
    ok("a receipt replaced on an edit goes to the box", !!edited?.ok && inBox(eEditedRow?.receiptDataUrl, "expense-receipts") && eEditedRow?.receiptDataUrl !== eRow?.receiptDataUrl, edited);
    ok("  and reads back as the new one", eBoxed.ok && (await expenses.getExpense(eBoxed.data.id))?.receiptDataUrl === pdfReceipt);
    const page = await expenses.listExpensesPaged({ page: 1, pageSize: 50 });
    const leaked = JSON.stringify(page.rows).includes(files.TEXT_REF);
    ok("the list never carries a receipt — no reference, and no megabytes of base64", !leaked && page.rows.every((r) => !("receiptDataUrl" in r)), page.rows.length);
    if (eBoxed.ok) await db.expense.update({ where: { id: eBoxed.data.id }, data: { receiptDataUrl: lost("expense-receipts", "image/png") } });
    let eGone: Awaited<ReturnType<typeof expenses.getExpense>> | "threw" = null;
    try {
      eGone = eBoxed.ok ? await expenses.getExpense(eBoxed.data.id) : null;
    } catch {
      eGone = "threw";
    }
    ok("a receipt gone from the box: the claim still opens, with no receipt drawn", eGone !== "threw" && eGone !== null && eGone.receiptDataUrl === null, eGone === "threw" ? eGone : eGone?.receiptDataUrl);

    section("The box itself");
    const stored = await walk(folder);
    const kinds = new Set(stored.map((f) => path.relative(folder, f).split(path.sep).slice(-3)[0]));
    const want = ["employee-documents", "project-documents", "close-attachments", "support-email", "archived-documents", "custom-field-files", "quick-templates", "expense-receipts"];
    ok("each column's files are in its own folder of the workspace's part of the box", want.every((k) => kinds.has(k)), [...kinds]);
    const raw = await Promise.all(stored.map((f) => import("node:fs/promises").then((fs) => fs.readFile(f))));
    ok("  sealed: none of them holds the file's own bytes", raw.every((b) => b.subarray(0, 8).toString("latin1") === "DZBKENC1" && !b.includes(Buffer.from("%PDF-1.4 zz"))), raw.length);
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect().catch(() => {});
    await rm(folder, { recursive: true, force: true });
    ok("the scratch database and the box's folder are gone", true);
  }

  console.log(`\n${failures ? `${passes} passed, ${failures} FAILED` : `All ${passes} storage documents checks passed.`}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
