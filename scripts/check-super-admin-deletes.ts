/**
 * check:super-admin-deletes — deleting a ticket, a call, an order, an item or a company (customer or vendor) is the workspace's super
 * admin's alone (owner, 27 Oct 2026; src/actions/ticket.ts deleteTicket, src/actions/company.ts removeCompanyProduct,
 * src/actions/company-delete.ts).
 *
 * On a scratch workspace database of its own (<db>_super_admin_deletes_check, built from the migrations and dropped
 * at the end, pass or fail):
 *
 *   · an admin whose role holds "tickets.delete" is refused; the super admin deletes the ticket, and it is audited;
 *   · an admin is refused an order; an invoiced one is refused even the super admin; the super admin deletes it;
 *   · an item in use is refused, saying where; an admin is refused an item; an unused one deletes;
 *   · vendors also by "Delete vendors" (owner, 28 Oct 2026 — admins hold it), several ticked at once: a sales user is
 *     refused; a vendor with a bill is refused, naming what it has; one with nothing deletes, its contact with it;
 *   · a customer with a ticket is refused; one with nothing deletes; an admin is refused a company too.
 *
 * The session is a stand-in; nothing is written to any other database.
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
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: "ADMIN", name: "Zz", email: `${actorId}@zzdeletes.invalid` } : null);
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
  const scratchName = `${new URL(url).pathname.slice(1)}_super_admin_deletes_check`;
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
  console.log(failures === 0 ? "\nAll super-admin delete checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

async function scenario() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const tickets = require("../src/actions/ticket") as typeof import("../src/actions/ticket");
  const companies = require("../src/actions/company-delete") as typeof import("../src/actions/company-delete");
  const orders = require("../src/actions/company") as typeof import("../src/actions/company");
  const items = require("../src/actions/item") as typeof import("../src/actions/item");
  const calls = require("../src/actions/call") as typeof import("../src/actions/call");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const sa = await db.user.create({ data: { name: "Zz Super", email: "super@zzdeletes.invalid", role: "ADMIN", isSuperAdmin: true, passwordHash: "x".repeat(60) } });
  const adminUser = await db.user.create({ data: { name: "Zz Admin", email: "admin@zzdeletes.invalid", role: "ADMIN", passwordHash: "x".repeat(60) } });
  await db.userPermission.create({ data: { userId: adminUser.id, permission: "tickets.delete", allowed: true, reason: "check:super-admin-deletes" } });
  const customer = await db.company.create({ data: { name: "Zz Customer Co", normalizedName: "zz customer co", relationshipType: "CLIENT", createdById: sa.id } });

  section("Tickets");
  const ticket = await db.ticket.create({ data: { companyId: customer.id, title: "Zz printer jam", createdByUserId: sa.id } });
  actorId = adminUser.id;
  const byAdmin = await tickets.deleteTicket(ticket.id);
  ok("an admin whose role may delete tickets is refused", !byAdmin.ok && /super admin/.test(byAdmin.error) && !!(await db.ticket.findUnique({ where: { id: ticket.id } })), byAdmin);
  actorId = sa.id;
  const bySa = await tickets.deleteTicket(ticket.id);
  ok("the super admin deletes it", bySa.ok && !(await db.ticket.findUnique({ where: { id: ticket.id } })), bySa);
  ok("  and it is in the audit log", !!(await db.auditLog.findFirst({ where: { entityType: "Ticket", entityId: ticket.id, action: "DELETE" } })));

  section("Orders");
  const location = await db.companyLocation.create({ data: { companyId: customer.id, label: "Head Office", isPrimary: true } });
  const item = await db.item.create({ data: { name: "Zz Licence", sku: "ZZ-1", type: "SUBSCRIPTION", sellingPrice: 100, createdById: sa.id } });
  const order = await db.companyProduct.create({ data: { companyId: customer.id, locationId: location.id, itemId: item.id, addedByUserId: sa.id, orderStatus: "PENDING_APPROVAL" } });
  actorId = adminUser.id;
  const orderByAdmin = await orders.removeCompanyProduct(order.id);
  ok("an admin is refused an order", !orderByAdmin.ok && /super admin/.test(orderByAdmin.error) && !!(await db.companyProduct.findUnique({ where: { id: order.id } })), orderByAdmin);
  actorId = sa.id;
  const billed = await db.companyProduct.create({ data: { companyId: customer.id, locationId: location.id, itemId: item.id, addedByUserId: sa.id, orderStatus: "FULFILLED" } });
  const invoice = await db.tradeDocument.create({ data: { docType: "INVOICE", direction: "SALES", docNumber: "ZZ-INV-1", companyId: customer.id, createdById: sa.id } });
  await db.tradeDocumentLine.create({ data: { documentId: invoice.id, itemId: item.id, companyProductId: billed.id, name: "Zz", quantity: 1, unitPrice: 100 } });
  const invoicedOrder = await orders.removeCompanyProduct(billed.id);
  ok("an invoiced order is refused, even to the super admin", !invoicedOrder.ok && /invoice/.test(invoicedOrder.error) && !!(await db.companyProduct.findUnique({ where: { id: billed.id } })), invoicedOrder);

  section("Items");
  const itemInUse = await items.deleteItem(item.id);
  ok("an item on orders and an invoice is refused, and told why", !itemInUse.ok && /2 orders/.test(itemInUse.error) && /1 document lines/.test(itemInUse.error), itemInUse);
  const spare = await db.item.create({ data: { name: "Zz Spare", sku: "ZZ-2", type: "SUBSCRIPTION", sellingPrice: 100, createdById: sa.id } });
  actorId = adminUser.id;
  const itemByAdmin = await items.deleteItem(spare.id);
  ok("an admin is refused an item", !itemByAdmin.ok && /super admin/.test(itemByAdmin.error) && !!(await db.item.findUnique({ where: { id: spare.id } })), itemByAdmin);
  actorId = sa.id;
  const itemGone = await items.deleteItem(spare.id);
  ok("the super admin deletes an unused item", itemGone.ok && !(await db.item.findUnique({ where: { id: spare.id } })), itemGone);
  ok("  and it is in the audit log", !!(await db.auditLog.findFirst({ where: { entityType: "Item", entityId: spare.id, action: "DELETE" } })));
  await db.tradeDocument.delete({ where: { id: invoice.id } });
  await db.companyProduct.delete({ where: { id: billed.id } });

  section("Orders, again");
  const orderBySa = await orders.removeCompanyProduct(order.id);
  ok("the super admin deletes it", orderBySa.ok && !(await db.companyProduct.findUnique({ where: { id: order.id } })), orderBySa);

  section("Calls");
  const callback = await db.task.create({ data: { title: "Zz call back", createdByUserId: sa.id, assignedToUserId: sa.id } });
  const call = await db.callLog.create({ data: { companyId: customer.id, userId: adminUser.id, phoneNumber: "9000000000", outcome: "CALLBACK_REQUESTED", startedAt: new Date(), followUpAt: new Date(), followUpTaskId: callback.id } });
  actorId = adminUser.id;
  const callByAdmin = await calls.deleteCall(call.id);
  ok("an admin is refused a call, even their own", !callByAdmin.ok && /super admin/.test(callByAdmin.error) && !!(await db.callLog.findUnique({ where: { id: call.id } })), callByAdmin);
  actorId = sa.id;
  const callBySa = await calls.deleteCall(call.id);
  ok("the super admin deletes it, its open callback task with it", callBySa.ok && !(await db.callLog.findUnique({ where: { id: call.id } })) && !(await db.task.findUnique({ where: { id: callback.id } })), callBySa);
  ok("  and it is in the audit log", !!(await db.auditLog.findFirst({ where: { entityType: "CallLog", entityId: call.id, action: "DELETE" } })));

  section("Vendors");
  const busy = await db.company.create({ data: { name: "Zz Busy Vendor", normalizedName: "zz busy vendor", relationshipType: "VENDOR", createdById: sa.id } });
  await db.tradeDocument.create({ data: { docType: "BILL", direction: "PURCHASE", docNumber: "ZZ-BILL-1", companyId: busy.id, createdById: sa.id } });
  const quiet = await db.company.create({ data: { name: "Zz Quiet Vendor", normalizedName: "zz quiet vendor", relationshipType: "VENDOR", createdById: sa.id } });
  const contact = await db.contact.create({ data: { companyId: quiet.id, name: "Zz Person" } });

  // Owner, 28 Oct 2026: a vendor's delete is also "Delete vendors" — admins hold it — and several at once from the list.
  const salesUser = await db.user.create({ data: { name: "Zz Sales", email: "sales@zzdeletes.invalid", role: "SALES", passwordHash: "x".repeat(60) } });
  actorId = salesUser.id;
  const salesVendor = await companies.deleteCompany(quiet.id);
  const salesBulk = await companies.bulkDeleteVendors([quiet.id]);
  ok("a sales user, without \"Delete vendors\", is refused a vendor — one or ticked", !salesVendor.ok && !salesBulk.ok && !!(await db.company.findUnique({ where: { id: quiet.id } })), { salesVendor, salesBulk });
  actorId = sa.id;
  const refused = await companies.deleteCompany(busy.id);
  ok("a vendor with a bill is refused, and told why", !refused.ok && /1 documents/.test(refused.error) && !!(await db.company.findUnique({ where: { id: busy.id } })), refused);
  actorId = adminUser.id;
  const bulk = await companies.bulkDeleteVendors([busy.id, quiet.id, customer.id]);
  ok(
    "an admin deletes the ticked vendors: the one with nothing goes, its contact with it; the one with a bill and a ticked customer stay, each with why",
    bulk.ok && bulk.data.deleted === 1 && !(await db.company.findUnique({ where: { id: quiet.id } })) && !(await db.contact.findUnique({ where: { id: contact.id } })) && bulk.data.kept.some((k) => k.name === "Zz Busy Vendor" && /documents/.test(k.why)) && bulk.data.kept.some((k) => k.name === "Zz Customer Co" && /not a vendor/.test(k.why)) && !!(await db.company.findUnique({ where: { id: busy.id } })),
    bulk,
  );
  ok("  and it is in the audit log", !!(await db.auditLog.findFirst({ where: { entityType: "Company", entityId: quiet.id, action: "DELETE" } })));
  actorId = sa.id;

  section("Customers");
  const withTicket = await db.company.create({ data: { name: "Zz Ticket Customer", normalizedName: "zz ticket customer", relationshipType: "CLIENT", createdById: sa.id } });
  await db.ticket.create({ data: { companyId: withTicket.id, title: "Zz still open", createdByUserId: sa.id } });
  const busyCustomer = await companies.deleteCompany(withTicket.id);
  ok("a customer with a ticket is refused, and told why", !busyCustomer.ok && /1 tickets/.test(busyCustomer.error) && !!(await db.company.findUnique({ where: { id: withTicket.id } })), busyCustomer);
  actorId = adminUser.id;
  const adminCustomer = await companies.deleteCompany(customer.id);
  ok("an admin is refused a customer", !adminCustomer.ok && /super admin/.test(adminCustomer.error), adminCustomer);
  actorId = sa.id;
  const customerGone = await companies.deleteCompany(customer.id);
  ok("the super admin deletes a customer with nothing, its address with it", customerGone.ok && !(await db.company.findUnique({ where: { id: customer.id } })) && !(await db.companyLocation.findUnique({ where: { id: location.id } })), customerGone);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
