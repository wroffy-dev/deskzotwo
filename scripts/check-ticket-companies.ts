/**
 * check:ticket-companies — New ticket's company search marks the companies with an active order (owner, 25 Nov 2026: "when
 * support person search company show any live subscription going on … easy to guess in case of duplicate", then "only show
 * the green live banner for active orders"; src/lib/ticket-companies.ts).
 *
 *   · Live is the order field's own rule, order by order, at the edges of a term.
 *   · Companies with something live come first, and are never lost past the cap behind namesakes with nothing.
 *   · A reseller's order counts for its end customer. That there is an order, and nothing of it, leaves the server.
 *   · Only orders the person may see; only companies the form offers.
 *   · One picked with nothing live points at the same name that has something — not at a longer word that begins alike.
 *   · The picker draws "Live" beside those, and nothing beside the rest.
 *
 * Its companies, item, orders, role and people are made here and removed.
 *
 *   npm run check:ticket-companies
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; role: string; name: string; email: string } | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ push() {}, back() {} }), notFound: () => { throw new Error("notFound"); } };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const ROLE = "ZZPROBE_TKTCO";
const SEER = "ZZPROBE_TKTCO_NOORD";
const DAY = 86_400_000;

async function main() {
  const lib = await import("../src/lib/ticket-companies");
  const { liveForSupport } = await import("../src/lib/ticket-open");
  const actions = await import("../src/actions/ticket");

  const run = Date.now().toString(36);
  const tag = `Zzq${run}`;
  const companyIds: string[] = [];
  const itemIds: string[] = [];
  const clean = async () => {
    await db.companyProduct.deleteMany({ where: { companyId: { in: companyIds }, parentId: { not: null } } });
    await db.companyProduct.deleteMany({ where: { companyId: { in: companyIds } } });
    await db.company.deleteMany({ where: { id: { in: companyIds } } });
    await db.item.deleteMany({ where: { id: { in: itemIds } } });
    await db.user.deleteMany({ where: { role: { in: [ROLE, SEER] } } });
    await db.role.deleteMany({ where: { key: { in: [ROLE, SEER] } } });
  };
  await clean();
  try {
    for (const [key, orders] of [[ROLE, "ALL"], [SEER, "NONE"]] as const) {
      await db.role.create({ data: { key, name: `Zzprobe ${orders}` } });
      for (const [permission, allowed] of [["tickets.view", true], ["tickets.create", true], ["companies.viewAll", true], ["orders.view", false]] as const) {
        await db.rolePermission.create({ data: { role: key, permission, allowed } });
      }
      await db.roleAccessLevel.create({ data: { role: key, record: "orders", action: "view", level: orders } });
    }
    const person = (n: string, role: string) => db.user.create({ data: { name: `Zzprobe ${n}`, email: `${n}-${run}@zzprobe-tktco.invalid`, role, passwordHash: "x".repeat(60) }, select: { id: true, role: true, name: true, email: true } });
    const support = await person("support", ROLE);
    const blind = await person("blind", SEER);

    const now = new Date();
    const inDays = (n: number) => new Date(now.getTime() + n * DAY);
    const item = async (name: string, type: "SUBSCRIPTION" | "GOOD") => {
      const i = await db.item.create({ data: { name: `${tag} ${name}`, sku: `${tag}-${name}`, type, sellingPrice: 10, createdById: support.id }, select: { id: true } });
      itemIds.push(i.id);
      return i.id;
    };
    const suite = await item("Suite", "SUBSCRIPTION");
    const box = await item("Box", "GOOD");
    const company = async (name: string, extra: object = {}) => {
      const c = await db.company.create({
        data: { name, normalizedName: name.toLowerCase(), relationshipType: "CLIENT", createdById: support.id, locations: { create: { label: "Head office" } }, ...extra },
        select: { id: true, locations: { select: { id: true } } },
      });
      companyIds.push(c.id);
      return { id: c.id, locationId: c.locations[0]!.id };
    };
    type Co = Awaited<ReturnType<typeof company>>;
    const order = (c: Co, itemId: string, extra: object = {}) =>
      db.companyProduct.create({ data: { companyId: c.id, locationId: c.locationId, itemId, quantity: 5, orderStatus: "FULFILLED", addedByUserId: support.id, ...extra }, select: { id: true } });

    section("1. Live is the order field's rule");
    const edge = await company(`${tag} Edge`);
    const cases: [string, object][] = [
      ["a year to run", { endDate: inDays(365) }],
      ["ending in an hour", { endDate: new Date(now.getTime() + 3_600_000) }],
      ["ended an hour ago", { endDate: new Date(now.getTime() - 3_600_000) }],
      ["ended 23 hours ago", { endDate: new Date(now.getTime() - 23 * 3_600_000) }],
      ["ended 25 hours ago", { endDate: new Date(now.getTime() - 25 * 3_600_000) }],
      ["no end", { endDate: null }],
      ["not delivered", { endDate: inDays(90), orderStatus: "PROCESSING" }],
      ["cancelled", { endDate: inDays(90), orderStatus: "CANCELLED" }],
    ];
    for (const [label, extra] of cases) {
      const o = await order(edge, suite, extra);
      const row = await db.companyProduct.findUniqueOrThrow({ where: { id: o.id }, select: { orderStatus: true, parentId: true, endDate: true, item: { select: { type: true } } } });
      const byQuery = (await db.companyProduct.count({ where: { AND: [{ id: o.id }, lib.liveOrderWhere(now)] } })) === 1;
      ok(`${label}: the query and the form's rule agree`, byQuery === liveForSupport(row, now), { byQuery });
    }

    section("2. Searching");
    const traders = await company(`${tag} Traders`);
    const tradersPvt = await company(`${tag} Traders Pvt Ltd`);
    const noida = await company(`${tag} Traders (Noida)`);
    const tradersmen = await company(`${tag} Tradersmen Union`);
    const gone = await company(`${tag} Traders Gone`, { stage: "DISQUALIFIED" });
    await order(traders, suite, { endDate: inDays(-100) });
    const main1 = await order(tradersPvt, suite, { endDate: inDays(200) });
    await order(tradersPvt, suite, { endDate: inDays(200), parentId: main1.id, quantity: 3, businessType: "ADDON" });
    await order(noida, suite, { endDate: inDays(14), quantity: 1 });
    await order(noida, box, { quantity: 2 });
    await order(tradersmen, suite, { endDate: inDays(90) });
    await order(gone, suite, { endDate: inDays(90) });

    actor = support;
    const found = await actions.searchTicketCompanies(`${tag} Traders`);
    const at = (id: string) => found.findIndex((c) => c.id === id);
    ok("those with something live come first", at(traders.id) === found.length - 1 && at(tradersPvt.id) >= 0 && at(tradersPvt.id) < at(traders.id) && at(noida.id) < at(traders.id), found.map((c) => c.name));
    ok("  a disqualified company isn't offered", at(gone.id) === -1);
    const mark = (id: string) => found.find((c) => c.id === id)?.live;
    ok("  an active order marks it; an ended one doesn't", mark(tradersPvt.id) === true && mark(noida.id) === true && mark(traders.id) === false, found.map((c) => [c.name, c.live]));
    ok("  nothing of the orders goes with it", found.every((c) => JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["customerCategory", "id", "live", "name", "relationshipType"])), Object.keys(found[0]!));
    ok("  one character finds nothing", (await actions.searchTicketCompanies("Z")).length === 0);

    for (let i = 0; i < 24; i++) await company(`${tag} Aaa Crowd ${String(i).padStart(2, "0")}`);
    const last = await company(`${tag} Aaa Crowd zz live`);
    await order(last, suite, { endDate: inDays(60) });
    const crowd = await actions.searchTicketCompanies(`${tag} Aaa Crowd`);
    ok("a live one past twenty namesakes is still first", crowd.length === lib.TICKET_COMPANY_LIMIT && crowd[0]!.id === last.id, crowd.slice(0, 2).map((c) => c.name));

    const reseller = await company(`${tag} Reseller`);
    const end = await company(`${tag} Endcust`);
    await order(reseller, suite, { endDate: inDays(80), endCustomerId: end.id });
    const endRow = (await actions.searchTicketCompanies(`${tag} Endcust`))[0]!;
    ok("an order a reseller bought counts for its end customer", endRow.id === end.id && endRow.live, endRow);

    actor = blind;
    const unseen = await actions.searchTicketCompanies(`${tag} Traders`);
    ok("somebody whose role sees no orders learns of none", unseen.length > 0 && unseen.every((c) => !c.live), unseen.map((c) => c.live));
    ok("  and is pointed at nobody", (await actions.ticketNamesakes(traders.id)).length === 0);

    section("3. The same name");
    actor = support;
    const same = await actions.ticketNamesakes(traders.id);
    const ids = same.map((c) => c.id);
    ok("nothing live: the same name with something live", ids.includes(tradersPvt.id) && ids.includes(noida.id), same.map((c) => c.name));
    ok("  not a longer word that begins alike", !ids.includes(tradersmen.id));
    ok("  a company that isn't there has none", (await actions.ticketNamesakes("zz-none")).length === 0);

    section("4. The page and the picker");
    const { default: NewTicketPage } = await import("../src/app/(dashboard)/tickets/new/page");
    const page = (await NewTicketPage({ searchParams: Promise.resolve({ companyId: noida.id }) })) as { props: { children: unknown } };
    const json = JSON.stringify(page, (k, v) => (k === "_owner" || k === "_store" ? undefined : v));
    const sentCompanies = json.slice(json.indexOf('"companies"'), json.indexOf('"initialCompanyId"'));
    const sentNoida = /\{[^{}]*\}/.exec(sentCompanies.slice(sentCompanies.indexOf(`{"id":"${noida.id}"`)))?.[0] ?? "";
    ok("the page marks each company, and sends nothing of its orders", sentNoida.includes('"live":true') && !sentCompanies.includes(`${tag} Suite`), sentNoida);
    const onTraders = JSON.stringify(await NewTicketPage({ searchParams: Promise.resolve({ companyId: traders.id }) }), (k, v) => (k === "_owner" || k === "_store" ? undefined : v));
    const named = onTraders.slice(onTraders.indexOf('"initialNamesakes"'));
    ok("  and, opened on one with nothing live, the same name that has something", named.includes(tradersPvt.id) && named.includes(noida.id), named.slice(0, 200));
    const { CompanyCombobox } = await import("../src/components/ui/company-combobox");
    const plain = renderToStaticMarkup(createElement(CompanyCombobox, { companies: [{ id: "x", name: "Plain" }], value: "", onSelect: () => {} }));
    ok("a picker given none of it is as it was", plain.includes("Type to search companies") && !plain.includes("Live"));
  } finally {
    await clean();
  }
}

main()
  .catch((err) => {
    failures += 1;
    console.error(err);
  })
  .finally(async () => {
    await db.$disconnect();
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
