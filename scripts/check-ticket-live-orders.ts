/**
 * check:ticket-live-orders — a ticket is about something the customer has live (owner, 2 Nov 2026: "no customer can
 * ask for support for a product he didn't purchase").
 *
 * The rule (liveForSupport, src/lib/ticket-open.ts) on made-up orders; then on this database's own: the New ticket
 * picker offers only delivered products and unexpired subscriptions, and a ticket on anything else is refused before
 * it is written. Nothing is written.
 *
 * And a support team that sees every customer but changes none, with Items & Inventory hidden (owner, 25 Nov 2026): the
 * order field is there all the same, a ticket it may not add says why, and with Support tickets at All it may. The role
 * and its people are made here and removed.
 *
 *   npm run check:ticket-live-orders
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; role: string; name: string; email: string } | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { liveForSupport, newTicketRefusal } = require("../src/lib/ticket-open") as typeof import("../src/lib/ticket-open");
  const { listCompanyOrderOptions } = require("../src/actions/ticket") as typeof import("../src/actions/ticket");

  console.log("\n— The rule —\n");
  // Noon in India on 2 Nov 2026, so the calendar days below are the same in any zone the suite runs in.
  const now = new Date("2026-11-02T12:00:00+05:30");
  const sub = (endDate: string | null, more: Partial<{ orderStatus: string; parentId: string | null }> = {}) => ({ orderStatus: "FULFILLED", parentId: null, endDate: endDate ? new Date(`${endDate}T00:00:00Z`) : null, item: { type: "SUBSCRIPTION" }, ...more });
  ok("a delivered subscription running a year is live", liveForSupport(sub("2027-11-01"), now));
  ok("one ending today is still live", liveForSupport(sub("2026-11-02"), now));
  ok("one that ended yesterday isn't", !liveForSupport(sub("2026-11-01"), now));
  ok("one with no expiry set is live once delivered", liveForSupport(sub(null), now));
  ok("one not yet delivered isn't", !liveForSupport(sub("2027-11-01", { orderStatus: "PROCESSING" }), now) && !liveForSupport(sub("2027-11-01", { orderStatus: "APPROVED" }), now));
  ok("a cancelled one isn't", !liveForSupport(sub("2027-11-01", { orderStatus: "CANCELLED" }), now));
  ok("seats added mid-term come with their subscription, not on their own", !liveForSupport(sub("2027-11-01", { parentId: "x" }), now));
  ok("a delivered product without a term is live", liveForSupport({ orderStatus: "FULFILLED", parentId: null, endDate: null, item: { type: "GOODS" } }, now));

  console.log("\n— On this database —\n");
  actor = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true, role: true, name: true, email: true } });
  const today = new Date();
  const expired = await db.companyProduct.findFirst({ where: { orderStatus: "FULFILLED", parentId: null, item: { type: "SUBSCRIPTION" }, endDate: { lt: new Date(today.getTime() - 3 * 86_400_000) } }, select: { id: true, companyId: true } });
  const live = await db.companyProduct.findFirst({ where: { orderStatus: "FULFILLED", parentId: null, item: { type: "SUBSCRIPTION" }, endDate: { gt: new Date(today.getTime() + 3 * 86_400_000) } }, select: { id: true, companyId: true } });
  const pending = await db.companyProduct.findFirst({ where: { orderStatus: "PENDING_APPROVAL" }, select: { id: true, companyId: true } });
  const base = { title: "Zzprobe", description: "", ticketType: "PRODUCT_SUPPORT", priority: "MEDIUM", contactId: "", assignedToUserId: "" } as never as Record<string, string>;

  if (live) {
    const offered = await listCompanyOrderOptions(live.companyId);
    ok("the picker offers a live subscription, with its end date", offered.some((o) => o.id === live.id && o.until !== null));
    const refused = await newTicketRefusal(actor.id, { ...base, companyId: live.companyId, companyProductId: live.id } as never);
    ok("a ticket on it isn't refused for the order", !refused || !/live|belong/.test(refused), refused ?? "");
  } else console.log("  ..   no live subscription here");
  if (expired) {
    const offered = await listCompanyOrderOptions(expired.companyId);
    ok("the picker leaves out an expired subscription", !offered.some((o) => o.id === expired.id));
    const refused = await newTicketRefusal(actor.id, { ...base, companyId: expired.companyId, companyProductId: expired.id } as never);
    ok("a ticket on it is refused", !!refused && /live/.test(refused), refused ?? "");
  } else console.log("  ..   no expired subscription here");
  if (pending) {
    const offered = await listCompanyOrderOptions(pending.companyId);
    ok("the picker leaves out an order waiting for approval", !offered.some((o) => o.id === pending.id));
    const refused = await newTicketRefusal(actor.id, { ...base, companyId: pending.companyId, companyProductId: pending.id } as never);
    ok("a ticket on it is refused", !!refused && /live/.test(refused), refused ?? "");
  } else console.log("  ..   no order waiting for approval here");

  console.log("\n— A support team that sees every customer and changes none —\n");
  const ROLE = "ZZPROBE_TICKETS";
  const clean = async () => {
    await db.user.deleteMany({ where: { role: ROLE } });
    await db.role.deleteMany({ where: { key: ROLE } });
  };
  await clean();
  try {
    await db.role.create({ data: { key: ROLE, name: "Zzprobe tickets" } });
    for (const [permission, allowed] of [["tickets.view", true], ["tickets.create", true], ["companies.viewAll", true], ["orders.view", false], ["section.items", false], ["section.orders", false]] as const) {
      await db.rolePermission.create({ data: { role: ROLE, permission, allowed } });
    }
    await db.roleAccessLevel.create({ data: { role: ROLE, record: "companies", action: "edit", level: "NONE" } });
    await db.roleAccessLevel.create({ data: { role: ROLE, record: "orders", action: "view", level: "ALL" } });
    const person = (n: number) => db.user.create({ data: { name: `Zzprobe ticket ${n}`, email: `tickets-${n}@zzprobe-tickets.invalid`, role: ROLE, passwordHash: "x".repeat(60) }, select: { id: true, role: true, name: true, email: true } });
    const access = require("../src/lib/authz/access") as typeof import("../src/lib/authz/access");
    const { default: NewTicketPage } = await import("../src/app/(dashboard)/tickets/new/page");
    const company = await db.company.findFirstOrThrow({ where: { relationshipType: "CLIENT", managedByResellerId: null }, select: { id: true } });
    const ticket = { ...base, companyId: company.id, companyProductId: "" };

    const before = await person(1);
    actor = before;
    const seen = await db.ticket.count({ where: await access.ticketAccess(before.id, "view") });
    ok("they see every ticket", seen === (await db.ticket.count()), seen);
    const why = await newTicketRefusal(before.id, ticket as never);
    ok("a ticket they may not add says why, on a company they can see", !!why && /can't add tickets/.test(why) && /Data Scope/.test(why), why ?? "");
    const gone = await newTicketRefusal(before.id, { ...ticket, companyId: "zz-none" } as never);
    ok("  one that isn't there is still not found", gone === "Company not found.", gone ?? "");

    for (const action of ["view", "edit", "assign"]) await db.roleAccessLevel.create({ data: { role: ROLE, record: "tickets", action, level: "ALL" } });
    const after = await person(2);
    actor = after;
    ok("with Support tickets at All, they may", (await newTicketRefusal(after.id, ticket as never)) === null);
    ok("  and change every ticket", (await db.ticket.count({ where: await access.ticketAccess(after.id, "edit") })) === (await db.ticket.count()));
    const page = JSON.stringify(await NewTicketPage({ searchParams: Promise.resolve({}) }), (k, v) => (k === "_owner" || k === "_store" ? undefined : v));
    ok("  the form has the order field, with Items & Inventory hidden from them", page.includes('"itemsEnabled":true'));
    if (live) ok("  and offers that customer's live order", (await listCompanyOrderOptions(live.companyId)).some((o) => o.id === live.id));
  } finally {
    await clean();
  }

  await db.$disconnect();
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
