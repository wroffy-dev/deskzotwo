/**
 * check:document-permissions — create, edit, issue, delete, cancel and approve, one permission per kind of document
 * (owner, 9 Nov 2026: "a salesperson creates a proposal only, his senior issues the proforma, only a person with
 * create invoice creates an invoice"). src/lib/documents/permission-keys.ts.
 *
 * The registry's keys and defaults; the migration copied every stored grant and denial of the four keys they replace;
 * each document action asks its own (a proposal-only salesperson can't create a proforma or an invoice, or convert to
 * one; can't issue, edit or delete a proforma; cancel and a status are separate); Approve lets its holder approve,
 * never their own; and the role screen draws them as a grid. People of its own on @zzprobe-dp.invalid, a customer
 * and three documents, removed in a finally.
 *
 *   npm run check:document-permissions
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { DOCUMENT_PERMISSIONS, replacedBy } from "../src/lib/documents/permission-keys";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzprobe", email: `actor${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const MAIL = "@zzprobe-dp.invalid";
const TAG = "ZZPROBE_DP";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const said = (r: { ok: boolean; error?: string }) => (r.ok ? "" : (r.error ?? ""));

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { PERMISSIONS, getPermissionDefinition, heldByDefaultKey } = require("../src/lib/permissions") as typeof import("../src/lib/permissions");
  const { documentWriteRefusal } = require("../src/lib/documents/write-permission") as typeof import("../src/lib/documents/write-permission");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { mayApprove, defaultApprovalPolicy } = require("../src/lib/documents/approval") as typeof import("../src/lib/documents/approval");
  const { actionRowsOf, docGridOf } = require("../src/lib/staff/access-modules") as typeof import("../src/lib/staff/access-modules");
  const documents = require("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  /* eslint-enable @typescript-eslint/no-require-imports */

  console.log("\n— The keys —\n");
  const keys = DOCUMENT_PERMISSIONS.map((d) => d.key);
  ok("eight kinds of document, six actions each", keys.length === 48 && new Set(keys).size === 48);
  ok("every one in the registry, noun.verb, under Documents", keys.every((k) => /^[a-z]+\.[a-zA-Z]+$/.test(k) && getPermissionDefinition(k)?.group === "Documents"));
  ok("the four keys they replace are gone", ["documents.issue", "documents.void", "documents.notes", "purchase.raiseOrders"].every((k) => !getPermissionDefinition(k)));
  ok("a salesperson creates and issues invoices by default, as before", heldByDefaultKey("docs.createInvoice", "SALES") && heldByDefaultKey("docs.issueInvoice", "SALES"));
  ok("  but doesn't cancel one, raise a note or a PO", !heldByDefaultKey("docs.cancelInvoice", "SALES") && !heldByDefaultKey("docs.createCreditNote", "SALES") && !heldByDefaultKey("docs.createPurchaseOrder", "SALES"));
  ok("purchase raises and cancels POs by default", heldByDefaultKey("docs.createPurchaseOrder", "PURCHASE") && heldByDefaultKey("docs.cancelPurchaseOrder", "PURCHASE"));
  ok("nobody approves by default but admins, and never their own", keys.filter((k) => k.startsWith("docs.approve")).every((k) => getPermissionDefinition(k)!.defaultRoles.length === 0 && getPermissionDefinition(k)!.selfExcluded === true));
  ok("certificates kept keys of their own", !!getPermissionDefinition("certificates.issue") && !!getPermissionDefinition("certificates.withdraw"));
  ok("no other key is called docs.*", PERMISSIONS.filter((p) => p.key.startsWith("docs.")).length === 48);

  console.log("\n— The migration —\n");
  const OLD = ["documents.issue", "documents.void", "documents.notes", "purchase.raiseOrders"] as const;
  const [oldRoles, newRoles, oldPeople, newPeople] = await Promise.all([
    db.rolePermission.findMany({ where: { permission: { in: [...OLD] } }, select: { role: true, permission: true, allowed: true } }),
    db.rolePermission.findMany({ where: { permission: { startsWith: "docs." } }, select: { role: true, permission: true, allowed: true } }),
    db.userPermission.findMany({ where: { permission: { in: [...OLD] } }, select: { userId: true, permission: true, allowed: true } }),
    db.userPermission.findMany({ where: { permission: { startsWith: "docs." } }, select: { userId: true, permission: true, allowed: true } }),
  ]);
  const roleMiss = oldRoles.filter((r) => !replacedBy(r.permission as (typeof OLD)[number]).every((k) => newRoles.some((n) => n.role === r.role && n.permission === k && n.allowed === r.allowed)));
  ok("every stored role grant and denial was copied onto the keys that replaced it", roleMiss.length === 0, roleMiss.map((r) => `${r.role}:${r.permission}`).join(", ") || `${oldRoles.length} rows`);
  const personMiss = oldPeople.filter((r) => !replacedBy(r.permission as (typeof OLD)[number]).every((k) => newPeople.some((n) => n.userId === r.userId && n.permission === k && n.allowed === r.allowed)));
  ok("  and every person's", personMiss.length === 0, `${oldPeople.length} rows`);

  await cleanup();
  try {
    const person = async (local: string, allowed: string[]) => {
      const u = await db.user.create({ data: { name: `Zzprobe ${local}`, email: `${local}${MAIL}`, role: "SALES", passwordHash: "!" }, select: { id: true } });
      // Every document key settled on the person, whatever this database's Sales role says.
      await db.userPermission.createMany({
        data: [
          { userId: u.id, permission: "documents.view", allowed: true, reason: TAG },
          ...keys.map((permission) => ({ userId: u.id, permission, allowed: allowed.includes(permission), reason: TAG })),
        ],
      });
      return u;
    };
    const seller = await person("seller", ["docs.createProposal", "docs.editProposal", "docs.issueProposal"]);
    const senior = await person("senior", ["docs.createProposal", "docs.editProposal", "docs.issueProposal", "docs.createProforma", "docs.editProforma", "docs.issueProforma", "docs.approveProforma"]);
    const company = await db.company.create({
      data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: seller.id, ownerUserId: seller.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
      select: { id: true },
    });
    const doc = (n: string, docType: "PROPOSAL" | "PROFORMA", status: "DRAFT" | "ISSUED") =>
      db.tradeDocument.create({ data: { docNumber: `${TAG}-${n}`, docType, direction: "SALES", status, companyId: company.id, createdById: seller.id, salespersonId: seller.id, total: 1000, issueDate: new Date() }, select: { id: true } });
    const quote = await doc("Q1", "PROPOSAL", "ISSUED");
    const proforma = await doc("P1", "PROFORMA", "DRAFT");

    console.log("\n— A salesperson who makes proposals only —\n");
    ok("holds Create, Edit and Issue proposals, nothing on proformas or invoices", (await can(seller.id, "docs.issueProposal")) && !(await can(seller.id, "docs.createProforma")) && !(await can(seller.id, "docs.createInvoice")));
    actorId = seller.id;
    const invoice = await documents.createTradeDocument({ docType: "INVOICE" });
    ok("creating a tax invoice is refused", said(invoice) === documentWriteRefusal("INVOICE", "create"), said(invoice));
    const pi = await documents.createTradeDocument({ docType: "PROFORMA" });
    ok("  and a proforma", said(pi) === documentWriteRefusal("PROFORMA", "create"), said(pi));
    const quoteMade = await documents.createTradeDocument({ docType: "PROPOSAL" });
    ok("  while a proposal gets past the permission (the empty form stops it)", !quoteMade.ok && said(quoteMade) !== documentWriteRefusal("PROPOSAL", "create"), said(quoteMade));
    const converted = await documents.convertTradeDocument({ id: quote.id, target: "PROFORMA" });
    ok("converting the quote to a proforma is refused", said(converted) === documentWriteRefusal("PROFORMA", "create"), said(converted));
    const issued = await documents.issueTradeDocument({ id: proforma.id, generateEInvoice: false });
    ok("issuing the senior's proforma is refused", said(issued) === documentWriteRefusal("PROFORMA", "issue"), said(issued));
    const edited = await documents.updateTradeDocument({ id: proforma.id, docType: "PROFORMA" });
    ok("  and editing it", said(edited) === documentWriteRefusal("PROFORMA", "edit"), said(edited));
    const cancelled = await documents.setTradeDocumentStatus(quote.id, "CANCELLED", "Changed their mind");
    ok("cancelling an issued proposal is its own permission", said(cancelled) === documentWriteRefusal("PROPOSAL", "cancel"), said(cancelled));
    const accepted = await documents.setTradeDocumentStatus(quote.id, "ACCEPTED");
    ok("  while marking it accepted is Issue's, which they hold", accepted.ok || said(accepted) !== documentWriteRefusal("PROPOSAL", "issue"), said(accepted) || "accepted");

    console.log("\n— Their senior, who issues proformas —\n");
    actorId = senior.id;
    const deleted = await documents.deleteTradeDocument(proforma.id);
    ok("deleting a draft proforma is its own permission too", said(deleted) === documentWriteRefusal("PROFORMA", "delete"), said(deleted));
    ok("issuing one gets past the permission", await can(senior.id, "docs.issueProforma"));

    console.log("\n— Approve —\n");
    const policy = { ...defaultApprovalPolicy("PROFORMA"), enabled: true };
    const subject = { submittedById: seller.id, createdById: seller.id, submitterManagerIds: [] };
    const asSenior = mayApprove({ policy, actor: { id: senior.id, role: "SALES", isSuperAdmin: false, holdsApprove: await can(senior.id, "docs.approveProforma") }, subject });
    ok("holding Approve proformas approves a proforma no rule names them for", asSenior.may && asSenior.reason === "permission", asSenior);
    const own = mayApprove({ policy, actor: { id: senior.id, role: "SALES", isSuperAdmin: false, holdsApprove: true }, subject: { ...subject, submittedById: senior.id } });
    ok("  never their own", !own.may && own.reason === "own-document");
    const without = mayApprove({ policy, actor: { id: seller.id, role: "SALES", isSuperAdmin: false, holdsApprove: await can(seller.id, "docs.approveProforma") }, subject: { ...subject, submittedById: senior.id, createdById: senior.id } });
    ok("  and without it, not an approver", !without.may && without.reason === "not-an-approver");

    console.log("\n— The role screen —\n");
    ok("Sales shows six kinds in its grid, Purchases two", docGridOf("sales").length === 6 && docGridOf("purchases").length === 2 && docGridOf("crm").length === 0);
    const rowKeys = (o?: { withoutDocs?: boolean }) => actionRowsOf("sales", [], o).flatMap((r) => (r.kind === "key" ? [r.key] : []));
    ok("drawn as the grid, they aren't rows as well", !rowKeys({ withoutDocs: true }).some((k) => k.startsWith("docs.")));
    ok("  while the person screen still lists them as rows", rowKeys().filter((k) => k.startsWith("docs.")).length === 36);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
