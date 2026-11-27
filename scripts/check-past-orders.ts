/**
 * check:past-orders — "Add past order" (owner, 23 Nov 2026 — TEMPORARY; src/actions/past-order.ts).
 *
 *   · Only with "Add past orders" (orders.recordPast), on a customer this person can see.
 *   · Saved as done: FULFILLED, booked from its start, no approval or purchase step; the tenant / domain in the old-CRM
 *     import's own field; marked as a past order, and in the audit log.
 *   · Checked: an expiry before the start, an address that isn't the customer's, a vendor that isn't one.
 *   · Renewal reminders: one ending within 15 days of being entered sends the customer none; later, as any other.
 *   · The button opens the old CRM's form.
 *
 * Its own records only (ZZPAST …), removed at the end.
 *
 *   npm run check:past-orders
 */
import "dotenv/config";
import Module from "node:module";
import { randomUUID } from "node:crypto";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

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
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ refresh() {}, push() {} }), notFound: () => { throw new Error("notFound"); } };
  if (request === "@/lib/session" || request.endsWith("/lib/session")) return { ...(originalLoad.call(this, request, parent, isMain) as Record<string, unknown>), ...session };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const actions = require("../src/actions/past-order") as typeof import("../src/actions/past-order");
  const reminders = require("../src/lib/renewal-customer-reminders") as typeof import("../src/lib/renewal-customer-reminders");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  if (!admin) throw new Error("no super admin");
  const item = await db.item.findFirst({ where: { active: true }, select: { id: true, name: true } });
  if (!item) throw new Error("no product");
  const tag = randomUUID().slice(0, 6);
  const MAIL = `@zzpast${tag}.invalid`;
  const hadField = !!(await db.customFieldDefinition.findUnique({ where: { entity_key: { entity: "ORDER", key: "tenant_domain" } } }));
  const companyIds: string[] = [];
  let sellerId: string | null = null;
  try {
    const customer = await db.company.create({ data: { name: `ZZPAST ${tag} Customer`, normalizedName: `zzpast ${tag} customer`, createdById: admin.id, ownerUserId: admin.id }, select: { id: true } });
    const other = await db.company.create({ data: { name: `ZZPAST ${tag} Other`, normalizedName: `zzpast ${tag} other`, createdById: admin.id }, select: { id: true } });
    const vendor = await db.company.create({ data: { name: `ZZPAST ${tag} Distributor`, normalizedName: `zzpast ${tag} distributor`, createdById: admin.id, relationshipType: "DISTRIBUTOR" }, select: { id: true } });
    companyIds.push(customer.id, other.id, vendor.id);
    const site = await db.companyLocation.create({ data: { companyId: customer.id, label: "Head Office", isPrimary: true }, select: { id: true } });
    const elsewhere = await db.companyLocation.create({ data: { companyId: other.id, label: "HO", isPrimary: true }, select: { id: true } });
    const seller = await db.user.create({ data: { name: `ZZPAST ${tag} Seller`, email: `seller${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) }, select: { id: true, name: true, email: true, role: true } });
    sellerId = seller.id;
    const start = ymd(new Date(Date.now() - 340 * DAY));
    const base = { companyId: customer.id, itemId: item.id, quantity: 25, poNumber: `PO-${tag}`, businessType: "NEW" as const, tenantDomain: `zz${tag}.onmicrosoft.com`, vendorId: vendor.id, locationId: site.id, paymentTerms: "NET_30" as const, notes: "From the old CRM", startDate: start, endDate: ymd(new Date(Date.now() + 25 * DAY)) };

    section("Who may");
    actor = { ...seller, role: String(seller.role) };
    const refused = await actions.recordPastOrder(base);
    ok("without “Add past orders”: refused, saying which permission", !refused.ok && /Add past orders/.test(refused.ok ? "" : refused.error), refused);
    actor = { ...admin, role: String(admin.role) };
    ok("an admin holds it", await actions.mayRecordPastOrders());

    section("Saved as done");
    const made = await actions.recordPastOrder(base);
    const order = made.ok ? await db.companyProduct.findUnique({ where: { id: made.data.id }, include: { pastOrderEntry: true }, omit: { customFields: false } }) : null;
    ok("a fulfilled order, released, with nothing for accounts or purchase to do", made.ok && order?.orderStatus === "FULFILLED" && order.purchaseRelease === "RELEASED" && order.accountsApprovedAt === null, made);
    ok("  booked and fulfilled from its start date, with its expiry, quantity, PO, vendor and terms", ymd(order!.bookedAt!) === start && ymd(order!.fulfilledAt!) === start && ymd(order!.endDate!) === base.endDate && order!.quantity === 25 && order!.poNumber === `PO-${tag}` && order!.vendorId === vendor.id && order!.paymentTerms === "NET_30");
    ok("  the tenant / domain in the old-CRM import's own field", (order!.customFields as Record<string, string>).tenant_domain === base.tenantDomain && !!(await db.customFieldDefinition.findUnique({ where: { entity_key: { entity: "ORDER", key: "tenant_domain" } } })));
    ok("  marked as a past order, by whom", order?.pastOrderEntry?.recordedById === admin.id);
    ok("  and in the audit log", (await db.auditLog.count({ where: { entityId: made.ok ? made.data.id : "", entityLabel: { contains: "past order added" } } })) === 1);
    const noPrice = await actions.recordPastOrder({ ...base, poNumber: "", tenantDomain: "", vendorId: "", paymentTerms: undefined, endDate: "", unitPrice: undefined });
    ok("the optional fields left out: still saved", noPrice.ok, noPrice);

    section("Checked");
    ok("an expiry before the start: refused", !(await actions.recordPastOrder({ ...base, endDate: ymd(new Date(Date.now() - 400 * DAY)) })).ok);
    ok("an address that isn't the customer's: refused", !(await actions.recordPastOrder({ ...base, locationId: elsewhere.id })).ok);
    ok("a vendor that isn't one: refused", !(await actions.recordPastOrder({ ...base, vendorId: other.id })).ok);
    ok("no product: refused", !(await actions.recordPastOrder({ ...base, itemId: "" })).ok);

    section("Renewal reminders");
    const soon = await actions.recordPastOrder({ ...base, endDate: ymd(new Date(Date.now() + 10 * DAY)) });
    const later = await actions.recordPastOrder({ ...base, endDate: ymd(new Date(Date.now() + 40 * DAY)) });
    const ordinary = await db.companyProduct.create({ data: { companyId: customer.id, locationId: site.id, itemId: item.id, addedByUserId: admin.id, orderStatus: "FULFILLED", endDate: new Date(Date.now() + 10 * DAY) }, select: { id: true, endDate: true } });
    const subs = await db.companyProduct.findMany({ where: { id: { in: [soon.ok ? soon.data.id : "", later.ok ? later.data.id : "", ordinary.id] } }, select: { id: true, endDate: true } });
    const quiet = await reminders.quietPastOrders(subs.map((s) => ({ id: s.id, endDate: s.endDate! })));
    ok("a past order ending within 15 days of being entered: no automatic customer reminder", soon.ok && quiet.has(soon.data.id));
    ok("  one ending later: reminded as any other", later.ok && !quiet.has(later.data.id));
    ok("  an ordinary order: untouched by the rule", !quiet.has(ordinary.id));

    section("The button");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createElement } = require("react") as typeof import("react");
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const { PastOrderButton } = require("../src/components/companies/past-order-dialog") as typeof import("../src/components/companies/past-order-dialog");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const html = renderToStaticMarkup(createElement(PastOrderButton, { companyId: customer.id, items: [{ id: item.id, name: item.name }], locations: [{ id: site.id, label: "Head Office", isPrimary: true }], vendors: [{ id: vendor.id, name: "Distributor" }] }));
    ok("“Add past order” on the customer's orders", html.includes("Add past order"));
  } finally {
    const orders = (await db.companyProduct.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } })).map((o) => o.id);
    await db.auditLog.deleteMany({ where: { entityId: { in: orders } } });
    await db.companyProduct.deleteMany({ where: { id: { in: orders } } });
    await db.companyLocation.deleteMany({ where: { companyId: { in: companyIds } } });
    await db.company.deleteMany({ where: { id: { in: companyIds } } });
    if (sellerId) await db.user.deleteMany({ where: { id: sellerId } });
    if (!hadField) await db.customFieldDefinition.deleteMany({ where: { entity: "ORDER", key: "tenant_domain" } });
  }
  console.log(failures ? `\n${failures} failed` : "\nAll past-order checks passed.");
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
