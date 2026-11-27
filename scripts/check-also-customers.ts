/**
 * check:also-customers — the review of vendors marked "Also a customer" (owner, 5 Nov 2026).
 *
 *   1. The list: only marked vendors, those with no sales first; a lead counts as a sale. Marked by the Zoho import is
 *      said, where the workspace has an import to try it on.
 *   2. Taking it off: only vendors with no sales, whatever is asked; the vendor stays, leaves the customer side, and
 *      the change is on the record. Refused without the right to, and while viewing as somebody.
 *   3. The page: for whoever may change a company's role, a 404 otherwise.
 *
 * Makes its own companies in the dev workspace and removes them.
 *
 *   npm run check:also-customers
 */
import "dotenv/config";
import Module from "node:module";
import type { ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let viewingAs = false;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return {
      requireUser: async () => actor,
      currentUser: async () => actor,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody." : null),
    };
  }
  if (request === "@/actions/module" || request.endsWith("actions/module")) return { isModuleEnabled: async () => true };
  if (request === "next/navigation") {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, useRouter: () => ({ push() {}, refresh() {}, replace() {} }), usePathname: () => "/vendors/also-customers", useSearchParams: () => new URLSearchParams() };
  }
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const db = directClient();
const TAG = "zzalsocust";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function main() {
  const { renderToStaticMarkup } = await import("react-dom/server");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { vendorsMarkedAsCustomers } = require("../src/lib/companies/also-customers") as typeof import("../src/lib/companies/also-customers");
  const { removeCustomerMarks } = require("../src/actions/also-customers") as typeof import("../src/actions/also-customers");
  const { clientSide } = require("../src/lib/companies/roles") as typeof import("../src/lib/companies/roles");
  const NewPage = (require("../src/app/(dashboard)/vendors/also-customers/page") as { default: () => Promise<ReactElement> }).default;

  const companies: string[] = [];
  const users: string[] = [];
  const legacy: string[] = [];
  let imported: string | null = null;
  try {
    const boss = await db.user.create({ data: { name: "Zz Boss", email: `${TAG}.boss@example.invalid`, role: "ADMIN", passwordHash: "x".repeat(60), permissionGrants: { create: [{ permission: "companies.changeRole", allowed: true, reason: TAG }] } }, select: { id: true, role: true, name: true, email: true } });
    users.push(boss.id);
    const plain = await db.user.create({ data: { name: "Zz Plain", email: `${TAG}.plain@example.invalid`, role: "ADMIN", passwordHash: "x".repeat(60), permissionGrants: { create: [{ permission: "companies.changeRole", allowed: false, reason: TAG }] } }, select: { id: true, role: true, name: true, email: true } });
    users.push(plain.id);
    actor = boss;

    const company = async (name: string, relationshipType: string, alsoCustomer: boolean) => {
      const row = await db.company.create({ data: { name: `Zz ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), relationshipType: relationshipType as never, alsoCustomer, createdById: boss.id, ownerUserId: boss.id }, select: { id: true, companySeq: true } });
      companies.push(row.id);
      return row;
    };
    const bare = await company("Bare", "VENDOR", true);
    const withLead = await company("Lead", "VENDOR", true);
    const notMarked = await company("Not marked", "VENDOR", false);
    const client = await company("Client", "CLIENT", false);
    await db.lead.create({ data: { title: "Zz lead", companyId: withLead.id, createdByUserId: boss.id, ownerUserId: boss.id } });

    section("1. The list");
    const review = () => vendorsMarkedAsCustomers({}, companies);
    let rows = await review();
    const row = (id: string) => rows.find((r) => r.id === id);
    ok("only marked vendors", rows.length === 2 && !row(notMarked.id) && !row(client.id), rows.map((r) => r.name));
    ok("  those with no sales first", rows[0]?.id === bare.id && rows[0].noSales);
    ok("  a lead counts as a sale", row(withLead.id)?.noSales === false && row(withLead.id)?.leads === 1, row(withLead.id));

    const imp = await db.legacyImport.findFirst({ select: { id: true } });
    imported = imp?.id ?? null;
    if (imported) {
      const made = await db.legacyImportRecord.create({ data: { importId: imported, kind: "zoho_contacts", oldId: `${TAG}-${bare.id}`, recordId: bare.id, action: "LINKED" }, select: { id: true } });
      legacy.push(made.id);
      rows = await review();
      ok("marked by the Zoho import is said", row(bare.id)?.fromZoho === true);
    } else {
      console.log("  --   no import in this workspace, so the Zoho wording wasn't tried");
    }

    section("2. Taking it off");
    viewingAs = true;
    let r = await removeCustomerMarks([bare.id]);
    ok("refused while viewing as somebody", !r.ok, r);
    viewingAs = false;
    actor = plain;
    r = await removeCustomerMarks([bare.id]);
    ok("refused without the right to", !r.ok, r);
    actor = boss;
    r = await removeCustomerMarks([]);
    ok("nothing ticked is said", !r.ok, r);
    r = await removeCustomerMarks([bare.id, withLead.id]);
    ok("only the one with no sales comes off", r.ok && r.removed === 1 && r.skipped === 1, r);
    const after = await db.company.findMany({ where: { id: { in: [bare.id, withLead.id] } }, select: { id: true, alsoCustomer: true, relationshipType: true } });
    ok("  the vendor stays a vendor, unmarked", after.find((c) => c.id === bare.id)?.alsoCustomer === false && after.find((c) => c.id === bare.id)?.relationshipType === "VENDOR");
    ok("  the one with a lead keeps it", after.find((c) => c.id === withLead.id)?.alsoCustomer === true);
    ok("  it has left the Customer list", (await db.company.count({ where: { AND: [await clientSide(), { id: bare.id }] } })) === 0);
    ok("  and the change is on the record", (await db.auditLog.count({ where: { userId: boss.id, entityId: bare.id, entityLabel: { contains: "no longer a customer" } } })) === 1);

    section("3. The page");
    let html = renderToStaticMarkup(await NewPage());
    ok("whoever may change a role sees it", html.includes("Vendors marked as customers") && html.includes("Zz Lead"));
    actor = plain;
    let refused = false;
    try {
      html = renderToStaticMarkup(await NewPage());
    } catch (err) {
      refused = String((err as { digest?: string }).digest ?? err).includes("404");
    }
    ok("anybody else gets a 404", refused);
  } finally {
    actor = null;
    await db.legacyImportRecord.deleteMany({ where: { id: { in: legacy } } }).catch(() => undefined);
    await db.lead.deleteMany({ where: { companyId: { in: companies } } }).catch((e: unknown) => console.error("cleanup", String(e).slice(0, 200)));
    await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: users } }, { entityId: { in: companies } }] } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: { in: companies } } }).catch((e: unknown) => console.error("cleanup", String(e).slice(0, 200)));
    await db.userPermission.deleteMany({ where: { userId: { in: users } } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: users } } }).catch((e: unknown) => console.error("cleanup", String(e).slice(0, 200)));
  }
  console.log(failures === 0 ? `\nAll ${passes} review checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
