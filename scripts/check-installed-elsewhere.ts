/**
 * check:installed-elsewhere — what customers use that they didn't buy from us (owner, 2 Nov 2026 —
 * src/lib/customers/elsewhere.ts, src/actions/elsewhere.ts).
 *
 *   1. Saved on a customer by whoever may change it, our own item recognised by name; refused on a customer out of
 *      reach, and for a missing product, a date that isn't one, a negative value.
 *   2. The list across customers: only those this person may see; by renewal window, category, seller, words and
 *      account manager.
 *   3. The reminder: a task for the account manager the chosen days before it renews, once for a renewal date, again
 *      when the date moves on; none too early or when switched off.
 *   4. "Make a lead": the title, facts, close date and our item filled in; nothing for an entry on another company.
 *   5. The Excel: the filtered list, only what this person may see. Removing an entry.
 *
 * Works on existing customers of the dev workspace; removes its entries, tasks and audit rows afterwards.
 *
 *   npm run check:installed-elsewhere
 */
import "dotenv/config";
import Module from "node:module";
import ExcelJS from "exceljs";
import { directClient } from "../src/lib/tenancy/direct-client";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => actor, requireModuleAccess: async () => actor, moduleAvailableForTenant: async () => true };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const DAY = 86_400_000;
const pick = { id: true, role: true, name: true, email: true } as const;

async function main() {
  const { saveElsewhere, deleteElsewhere, listElsewhere, companyElsewhere } = await import("../src/actions/elsewhere");
  const { runElsewhereReminders, leadPrefillFromElsewhere, reminderTitle } = await import("../src/lib/customers/elsewhere");
  const { canSeeCompany } = await import("../src/lib/authz/company-scope");
  const { GET } = await import("../src/app/api/customers/elsewhere-export/route");

  // A sales person with a customer of their own, and a customer they can't reach.
  const sellers = await db.user.findMany({ where: { role: "SALES", active: true, isSuperAdmin: false }, select: pick, take: 20 });
  let seller: Actor | null = null;
  type Account = { id: string; name: string; ownerUserId: string | null; relationshipType: "CLIENT" };
  let mine: Account | null = null;
  let theirs: Account | null = null;
  for (const s of sellers) {
    const own = await db.company.findFirst({ where: { ownerUserId: s.id, relationshipType: "CLIENT" }, select: { id: true, name: true, ownerUserId: true, relationshipType: true } });
    if (!own || !(await canSeeCompany(s.id, own))) continue;
    const others = await db.company.findMany({ where: { relationshipType: "CLIENT", ownerUserId: { not: s.id } }, select: { id: true, name: true, ownerUserId: true, relationshipType: true }, take: 40 });
    for (const o of others) if (!(await canSeeCompany(s.id, o))) theirs = o as Account;
    if (theirs) {
      seller = s;
      mine = own as Account;
      break;
    }
  }
  if (!seller || !mine || !theirs) throw new Error("No sales person with a customer of their own and one out of reach.");
  const item = await db.item.findFirst({ where: { active: true }, select: { id: true, name: true } });
  const admin = await db.user.findFirst({ where: { role: "ADMIN", active: true }, select: pick });
  const made: string[] = [];
  const startedAt = new Date();
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);

  try {
    section("1. Saving");
    actor = seller;
    const sophos = await saveElsewhere({ companyId: mine.id, productName: "ZZ Sophos XGS 136", category: "SECURITY", quantity: 1, boughtFrom: "ZZ xyz reseller", renewsOn: dayKey(new Date(today.getTime() + 30 * DAY)), yearlyValue: 180000, source: "SAW_INVOICE", notes: "Unhappy with support", remindDays: 90 });
    if (sophos.ok) made.push(sophos.data.id);
    ok("an entry saved on one's own customer", sophos.ok, sophos.ok ? "" : sophos.error);
    const ours = item ? await saveElsewhere({ companyId: mine.id, productName: item.name.toUpperCase(), quantity: 100, boughtFrom: "ZZ abc reseller", renewsOn: dayKey(new Date(today.getTime() + 200 * DAY)), remindDays: 90 }) : null;
    if (ours?.ok) made.push(ours.data.id);
    const oursRow = ours?.ok ? await db.installedElsewhere.findUnique({ where: { id: ours.data.id }, select: { itemId: true } }) : null;
    ok("  our own item recognised by its name, whatever the case", !item || oursRow?.itemId === item.id, oursRow);
    const blocked = await saveElsewhere({ companyId: theirs.id, productName: "ZZ Nope" });
    if (blocked.ok) made.push(blocked.data.id);
    ok("refused on a customer out of reach", !blocked.ok && blocked.error === "Customer not found.", blocked.ok ? "saved" : blocked.error);
    const noName = await saveElsewhere({ companyId: mine.id, productName: "  " });
    ok("refused without a product", !noName.ok);
    const badDay = await saveElsewhere({ companyId: mine.id, productName: "ZZ x", renewsOn: "2 March 2027" });
    ok("refused for a date that isn't one", !badDay.ok);
    const negative = await saveElsewhere({ companyId: mine.id, productName: "ZZ x", yearlyValue: -5 });
    ok("refused for a negative value", !negative.ok);
    const tab = await companyElsewhere(mine.id);
    ok("the customer's tab lists them, soonest renewal first, and may change them", !!tab && tab.canEdit && tab.rows[0]?.productName === "ZZ Sophos XGS 136", tab?.rows.map((r) => r.productName));
    ok("  another's customer's tab isn't shown", (await companyElsewhere(theirs.id)) === null);

    section("2. The list across customers");
    if (admin) {
      actor = admin;
      const elsewhereOnTheirs = await saveElsewhere({ companyId: theirs.id, productName: "ZZ Hidden firewall", boughtFrom: "ZZ xyz reseller", renewsOn: dayKey(new Date(today.getTime() + 10 * DAY)) });
      if (elsewhereOnTheirs.ok) made.push(elsewhereOnTheirs.data.id);
      actor = seller;
    }
    const all = (await listElsewhere({ q: "ZZ" })).rows.map((r) => r.productName);
    ok("only customers this person may see", all.includes("ZZ Sophos XGS 136") && !all.includes("ZZ Hidden firewall"), all);
    const next90 = (await listElsewhere({ q: "ZZ", renews: "90" })).rows.map((r) => r.productName);
    ok("  renewing in the next 90 days", next90.includes("ZZ Sophos XGS 136") && !next90.some((n) => n !== "ZZ Sophos XGS 136"), next90);
    ok("  by category", (await listElsewhere({ q: "ZZ", category: "SECURITY" })).rows.every((r) => r.category === "SECURITY"));
    const fromAbc = await listElsewhere({ from: "zz abc reseller" });
    ok("  by who sold it, whatever the case", !item || (fromAbc.rows.length === 1 && fromAbc.rows[0]!.boughtFrom === "ZZ abc reseller"), fromAbc.rows.map((r) => r.productName));
    const byMe = await listElsewhere({ q: "ZZ", owner: seller.id });
    const byThem = await listElsewhere({ q: "ZZ", owner: theirs.ownerUserId ?? "nobody" });
    ok("  by account manager", byMe.rows.length >= 1 && byMe.rows.every((r) => r.company.owner?.id === seller!.id), byMe.rows.map((r) => r.company.owner?.name));
    ok("  asking for another manager's customers doesn't open them", byThem.rows.length === 0, byThem.rows.map((r) => r.productName));
    ok("  the sellers offered to filter by", (await listElsewhere({})).sellers.includes("ZZ xyz reseller"));

    section("3. The reminder");
    const first = await runElsewhereReminders();
    const sophosId = sophos.ok ? sophos.data.id : "";
    const title = reminderTitle("ZZ Sophos XGS 136", mine.name);
    const tasks = () => db.task.findMany({ where: { title, companyId: mine!.id, createdAt: { gte: startedAt } }, select: { id: true, assignedToUserId: true, description: true } });
    let raised = await tasks();
    ok("a task for the account manager, 90 days ahead of a renewal 30 days off", raised.length === 1 && raised[0]!.assignedToUserId === seller.id && raised[0]!.description!.includes("ZZ xyz reseller"), { first, raised: raised.length });
    ok("  nothing for one 200 days off", !(await db.task.findFirst({ where: { companyId: mine.id, createdAt: { gte: startedAt }, title: { contains: item?.name ?? "—" } } })));
    await runElsewhereReminders();
    ok("  once for a renewal date", (await tasks()).length === 1);
    await saveElsewhere({ id: sophosId, companyId: mine.id, productName: "ZZ Sophos XGS 136", category: "SECURITY", quantity: 1, boughtFrom: "ZZ xyz reseller", renewsOn: dayKey(new Date(today.getTime() + 60 * DAY)), remindDays: 90 });
    await runElsewhereReminders();
    raised = await tasks();
    ok("  again when the renewal date moves on", raised.length === 2, raised.length);
    await saveElsewhere({ id: sophosId, companyId: mine.id, productName: "ZZ Sophos XGS 136", boughtFrom: "ZZ xyz reseller", renewsOn: dayKey(new Date(today.getTime() + 61 * DAY)), remindDays: null });
    await runElsewhereReminders();
    ok("  none when switched off", (await tasks()).length === 2);

    section("4. Make a lead");
    const prefill = await leadPrefillFromElsewhere(seller.id, mine.id, sophosId);
    ok("title, facts and close date filled in", !!prefill && prefill.title === "ZZ Sophos XGS 136 — win from ZZ xyz reseller" && prefill.description.includes("bought from ZZ xyz reseller") && prefill.expectedCloseDate === dayKey(new Date(today.getTime() + 61 * DAY)), prefill);
    if (ours?.ok && item) {
      const withItem = await leadPrefillFromElsewhere(seller.id, mine.id, ours.data.id);
      ok("  our own item as the requirement, 100 of them", withItem?.requirements[0]?.itemId === item.id && withItem.requirements[0]!.quantity === 100, withItem?.requirements);
    }
    ok("  nothing for an entry on another company", (await leadPrefillFromElsewhere(seller.id, theirs.id, sophosId)) === null);

    section("6. Categories the workspace keeps, and finding customers by what they use");
    const { elsewhereCategoryOptions } = await import("../src/lib/customers/elsewhere-categories");
    const { createElsewhereCategory, renameElsewhereCategory, deleteElsewhereCategory } = await import("../src/actions/elsewhere-category");
    const { elsewhereOfCompanies } = await import("../src/lib/tables/list-extras");
    const { buildWhere } = await import("../src/lib/workspace/filters");
    const { workspaceClock } = await import("../src/lib/time/workspace");
    const { elsewhereSource } = await import("../src/lib/reporting/extra-sources");
    const { resolveColumns } = await import("../src/lib/tables/registry");
    const categoriesHaveAsync = async (key: string) => (await elsewhereCategoryOptions()).some((c) => c.key === key);
    const seen = (await elsewhereCategoryOptions()).map((c) => c.key);
    ok("the nine it came with are on the list, read from the table", ["SECURITY", "PRODUCTIVITY", "OTHER"].every((k) => seen.includes(k)), seen.length);
    actor = seller;
    const madeUp = await saveElsewhere({ companyId: mine.id, productName: "ZZ Made-up category", category: "NOT_A_CATEGORY" });
    ok("an entry refuses a category that isn't on the list", !madeUp.ok, !madeUp.ok ? madeUp.error : "");
    const notAllowed = await createElsewhereCategory("ZZ Telephony");
    ok("a sales person can't add a category", !notAllowed.ok);
    if (admin) {
      actor = admin;
      const added = await createElsewhereCategory("ZZ Telephony");
      ok("whoever manages settings adds one", added.ok && added.data.key === "ZZ_TELEPHONY" && (await categoriesHaveAsync("ZZ_TELEPHONY")), added.ok ? added.data : added.error);
      const twice = await createElsewhereCategory("zz telephony");
      ok("  not twice, whatever its capitals", !twice.ok);
      if (added.ok) {
        actor = seller;
        const onIt = await saveElsewhere({ companyId: mine.id, productName: "ZZ Avaya phones", category: "ZZ_TELEPHONY", quantity: 40 });
        ok("  an entry can take it", onIt.ok);
        if (onIt.ok) made.push(onIt.data.id);
        actor = admin;
        const renamed = await renameElsewhereCategory(added.data.id, "ZZ Telephony & PBX");
        ok("  renamed, keeping its key", renamed.ok && (await elsewhereCategoryOptions()).some((c) => c.key === "ZZ_TELEPHONY" && c.name === "ZZ Telephony & PBX"));
        const deleted = await deleteElsewhereCategory(added.data.id);
        const after = onIt.ok ? await db.installedElsewhere.findUnique({ where: { id: onIt.data.id }, select: { category: true } }) : null;
        ok("  deleted, clearing it from the entries that had it", deleted.ok && deleted.data.cleared === 1 && after?.category === null, deleted.ok ? deleted.data : deleted.error);
      }
      actor = seller;
    }

    // Step 3 left it without a category or quantity; put them back for what follows.
    await saveElsewhere({ id: sophosId, companyId: mine.id, productName: "ZZ Sophos XGS 136", category: "SECURITY", quantity: 1, boughtFrom: "ZZ xyz reseller", renewsOn: dayKey(new Date(today.getTime() + 61 * DAY)), remindDays: null });
    const summary = (await elsewhereOfCompanies([mine.id])).get(mine.id);
    ok("the Customers list's column: product, quantity and seller", !!summary?.products.includes("ZZ Sophos XGS 136 ×1 from ZZ xyz reseller"), summary?.products);
    ok("  and the next renewal still to come", !!summary?.next && summary.next.on >= dayKey(today), summary?.next);
    ok("  both columns offered on Customers and Companies, off until chosen", ["customers", "companies"].every((t) => !resolveColumns(t, null).includes("elsewhere")) && resolveColumns("customers", ["company", "elsewhere", "elsewhereRenewal"]).includes("elsewhereRenewal"));

    const clock = await workspaceClock();
    const count = (f: Parameters<typeof buildWhere>[0]) => db.company.count({ where: { AND: [{ id: mine!.id }, buildWhere(f, clock)] } });
    ok("Workspace: by category", (await count({ elsewhereCategory: ["SECURITY"] })) === 1 && (await count({ elsewhereCategory: ["ZZ_NO_SUCH"] })) === 0);
    ok("  by product or seller, any of the words", (await count({ elsewhereText: ["nothing-like-it", "zz xyz"] })) === 1 && (await count({ elsewhereText: ["nothing-like-it"] })) === 0);
    ok("  by an outside renewal coming up", (await count({ elsewhereRenewalWithinDays: 90 })) === 1);

    const reportRows = await elsewhereSource.load({ userId: seller.id, from: new Date(today.getTime() - DAY), to: new Date(today.getTime() + 400 * DAY), dateColumn: "renewsOn" });
    ok("Reports: the source has this person's customers' entries", reportRows.some((r) => r.productName === "ZZ Sophos XGS 136" && r.categoryName === "Security"));
    ok("  and none of a customer out of reach", !reportRows.some((r) => r.productName === "ZZ Hidden firewall"));
    const narrowed = await elsewhereSource.load({ userId: seller.id, from: new Date(today.getTime() - DAY), to: new Date(today.getTime() + 400 * DAY), dateColumn: "renewsOn", companyFilters: { elsewhereText: ["nothing-like-it"] } });
    ok("  narrowed by the report's account filters", !narrowed.some((r) => r.productName.startsWith("ZZ ")));

    // Found from the header's search, and on the Customers list (owner, 6 Nov 2026).
    const { searchRecords } = await import("../src/actions/search");
    const found = await searchRecords("elsewhere", "ZZ Sophos");
    ok("Search: finds it, naming the customer and the seller, opening that tab", found.ok && found.hits.some((h) => h.title === "ZZ Sophos XGS 136" && !!h.subtitle?.includes(mine!.name) && !!h.subtitle?.includes("ZZ xyz reseller") && h.href.endsWith("?tab=elsewhere")), found.ok ? found.hits : found.error);
    const hidden = await searchRecords("elsewhere", "ZZ Hidden");
    ok("  and not a customer out of reach", hidden.ok && hidden.hits.length === 0, hidden.ok ? hidden.hits : hidden.error);
    const { listCustomersPaged } = await import("../src/actions/company");
    const had = await db.companyProduct.findFirst({ where: { companyId: mine.id }, select: { id: true } });
    const made1 = had ? null : await db.companyProduct.create({ data: { companyId: mine.id, locationId: (await db.companyLocation.findFirstOrThrow({ where: { companyId: mine.id }, select: { id: true } })).id, itemId: (await db.item.findFirstOrThrow({ select: { id: true } })).id, addedByUserId: seller.id, quantity: 1 }, select: { id: true } });
    const customerIds = async (p: Record<string, string>) => (await listCustomersPaged({ page: 1, pageSize: 200, search: mine!.name, ...p })).rows.map((r) => r.id);
    ok("Customers list: by what they use", (await customerIds({ elsewhere: "SECURITY" })).includes(mine.id) && (await customerIds({ elsewhere: "any" })).includes(mine.id) && !(await customerIds({ elsewhere: "ZZ_NO_SUCH" })).includes(mine.id));
    const renewsIn30 = (await db.installedElsewhere.count({ where: { companyId: mine.id, renewsOn: { gte: today, lte: new Date(today.getTime() + 30 * DAY) } } })) > 0;
    ok("  by an outside renewal coming up", (await customerIds({ elsewhereRenewal: "90" })).includes(mine.id) && (await customerIds({ elsewhereRenewal: "30" })).includes(mine.id) === renewsIn30);
    if (made1) await db.companyProduct.delete({ where: { id: made1.id } });

    section("5. The Excel, and removing");
    // Security audit, Nov 2026: the file needs data.exportCrm, as every other CRM export does — and nobody holds it by default.
    const { can } = await import("../src/lib/authz/resolve");
    if (!(await can(actor!.id, "data.exportCrm"))) {
      const withoutExport = await GET(new Request("http://x/api/customers/elsewhere-export?q=ZZ"));
      ok("without data.exportCrm, the Excel is 404", withoutExport.status === 404, withoutExport.status);
      await db.userPermission.create({ data: { userId: actor!.id, permission: "data.exportCrm", allowed: true, reason: "check:installed-elsewhere" } });
    }
    ok("  given data.exportCrm, it can be downloaded", await can(actor!.id, "data.exportCrm"));
    const res = await GET(new Request("http://x/api/customers/elsewhere-export?q=ZZ"));
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await res.arrayBuffer());
    const names: string[] = [];
    book.worksheets[0]!.eachRow((row, n) => n > 1 && names.push(String(row.getCell(4).value)));
    ok("the filtered list, only what this person may see", res.status === 200 && names.includes("ZZ Sophos XGS 136") && !names.includes("ZZ Hidden firewall"), names);
    const gone = await deleteElsewhere(sophosId);
    ok("removed", gone.ok && !(await db.installedElsewhere.findUnique({ where: { id: sophosId } })));
    const otherDelete = await db.installedElsewhere.findFirst({ where: { productName: "ZZ Hidden firewall" }, select: { id: true } });
    if (otherDelete) {
      const refused = await deleteElsewhere(otherDelete.id);
      ok("  refused on a customer out of reach", !refused.ok);
    }
  } finally {
    await db.userPermission.deleteMany({ where: { permission: "data.exportCrm", reason: "check:installed-elsewhere" } });
    await db.task.deleteMany({ where: { createdAt: { gte: startedAt }, title: { startsWith: "Renewal elsewhere: ZZ " } } });
    await db.installedElsewhere.deleteMany({ where: { OR: [{ id: { in: made } }, { productName: { startsWith: "ZZ " } }] } });
    await db.elsewhereCategoryOption.deleteMany({ where: { key: { startsWith: "ZZ_" } } });
    await db.auditLog.deleteMany({ where: { createdAt: { gte: startedAt }, entityType: "ElsewhereCategoryOption" } });
    await db.auditLog.deleteMany({ where: { createdAt: { gte: startedAt }, OR: [{ entityLabel: { contains: "installed elsewhere — ZZ " } }, { entityId: "installed-elsewhere" }] } });
    if (item) await db.auditLog.deleteMany({ where: { createdAt: { gte: startedAt }, entityLabel: { contains: `installed elsewhere — ${item.name.toUpperCase()}` } } });
  }

  console.log(failures === 0 ? `\nAll ${passes} installed elsewhere checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
