/**
 * check:page-ticks — a role's per-page ticks (owner, 2 Nov 2026): one menu page hidden from a role, left out of its
 * menu and refused at the door, while the rest of its section stays.
 *
 * Which page an address belongs to; hiding Delivery Challans from a role of its own (ZZPROBE_PT) and what that role's
 * person then sees; the super admin never held to it; who may change it. Removed in a finally.
 *
 *   npm run check:page-ticks
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
const ROLE = "ZZPROBE_PT";
const MAIL = "@zzprobe-pt.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.auditLog.deleteMany({ where: { entityType: "Role", entityId: { in: [ROLE, "ADMIN"] }, entityLabel: { contains: "Delivery Challans" }, createdAt: { gte: new Date(Date.now() - 30 * 60_000) } } });
  await db.roleHiddenPage.deleteMany({ where: { roleKey: ROLE } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.role.deleteMany({ where: { key: ROLE } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { pageOf, pagesOfSection } = require("../src/lib/staff/menu-pages") as typeof import("../src/lib/staff/menu-pages");
  const { hiddenPagesFor, pageHiddenFor } = require("../src/lib/staff/hidden-pages") as typeof import("../src/lib/staff/hidden-pages");
  const { setRolePageHidden } = require("../src/actions/role-pages") as typeof import("../src/actions/role-pages");
  const { buildNavigation } = require("../src/lib/navigation") as typeof import("../src/lib/navigation");

  console.log("\n— Which page an address belongs to —\n");
  ok("a page is its own", pageOf("/sales/challans") === "/sales/challans");
  ok("what sits under it is its", pageOf("/sales/challans/new") === "/sales/challans");
  ok("a deeper page is its own, not its parent's", pageOf("/items/brands") === "/items/brands" && pageOf("/items/abc123") === "/items");
  ok("a trailing slash changes nothing", pageOf("/receivables/credit/") === "/receivables/credit");
  ok("an address no page covers is nobody's", pageOf("/zz-nowhere") === null);
  ok("Quotes & Invoices lists Delivery Challans among its pages", pagesOfSection("section.salesDocuments").some((p) => p.href === "/sales/challans"));
  // Only the pages the workspace's country has (owner, 16 Nov 2026: "eway bills in uae?"), as the menu does.
  {
    const hrefs = (section: string, country: string) => pagesOfSection(section, country).map((p) => p.href);
    const inSales = hrefs("section.salesDocuments", "IN");
    const aeSales = hrefs("section.salesDocuments", "AE");
    ok("in India, Sales Documents offers E-Way Bills; in the UAE it doesn't, and keeps the rest", inSales.includes("/sales/eway-bills") && !aeSales.includes("/sales/eway-bills") && aeSales.includes("/sales/invoices") && aeSales.includes("/sales/challans"), aeSales);
    const inBooks = hrefs("section.accounting", "IN");
    const aeBooks = hrefs("section.accounting", "AE");
    ok(
      "Accounting offers GST Returns and TDS in India only, and the VAT Return and Corporate Tax in the UAE only",
      inBooks.includes("/accounting/gst") && inBooks.includes("/accounting/tds") && !inBooks.includes("/accounting/vat-return") && !inBooks.includes("/accounting/corporate-tax") &&
        aeBooks.includes("/accounting/vat-return") && aeBooks.includes("/accounting/corporate-tax") && !aeBooks.includes("/accounting/gst") && !aeBooks.includes("/accounting/tds"),
      { inBooks, aeBooks },
    );
    ok("with no country given, every page is listed, as before", hrefs("section.salesDocuments", "").includes("/sales/eway-bills") && pagesOfSection("section.accounting").some((p) => p.href === "/accounting/vat-return"));

    // The paper goods travel on is a delivery challan in India and a delivery note elsewhere ("rename for UAE").
    const { challanWords, setWorkspaceCountryResolver } = require("../src/lib/country-pack") as typeof import("../src/lib/country-pack");
    const { tradeDocumentLabels } = require("../src/lib/trade-documents") as typeof import("../src/lib/trade-documents");
    const label = () => pagesOfSection("section.salesDocuments").find((p) => p.href === "/sales/challans")?.label;
    let country = "IN";
    setWorkspaceCountryResolver(() => country);
    const india = [label(), tradeDocumentLabels.DELIVERY_CHALLAN, challanWords().many];
    country = "AE";
    const uae = [label(), tradeDocumentLabels.DELIVERY_CHALLAN, challanWords().many];
    ok(
      "India calls it a delivery challan; the UAE a delivery note — the menu, the document's name and the words",
      JSON.stringify(india) === JSON.stringify(["Delivery Challans", "Delivery challan", "delivery challans"]) && JSON.stringify(uae) === JSON.stringify(["Delivery Notes", "Delivery note", "delivery notes"]),
      { india, uae },
    );
    setWorkspaceCountryResolver(() => null);
  }

  await cleanup();
  try {
    const superAdmin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
    await db.role.create({ data: { key: ROLE, name: "Zzprobe page ticks" } });
    const person = await db.user.create({ data: { name: "Zzprobe Ticks", email: `person${MAIL}`, role: ROLE, passwordHash: "!" }, select: { id: true, name: true, email: true, role: true } });

    console.log("\n— Who may change it —\n");
    actor = person;
    let r = await setRolePageHidden(ROLE, "/sales/challans", true);
    ok("somebody without Manage permissions is refused", !r.ok, r);
    actor = superAdmin;
    r = await setRolePageHidden(ROLE, "/zz-nowhere", true);
    ok("a page not in the menu is refused", !r.ok, r);
    r = await setRolePageHidden(ROLE, "/sales/challans", true);
    ok("the super admin hides Delivery Challans for the role", r.ok, r);

    console.log("\n— What the role's person sees —\n");
    ok("it is among their hidden pages", (await hiddenPagesFor(person.id)).includes("/sales/challans"));
    ok("the page and what is under it are refused", (await pageHiddenFor(person.id, "/sales/challans")) && (await pageHiddenFor(person.id, "/sales/challans/abc")));
    ok("the rest of the section isn't", !(await pageHiddenFor(person.id, "/sales/invoices")) && !(await pageHiddenFor(person.id, "/sales/proposals")));
    const menu = buildNavigation({ openModules: ["sales_documents"], permissions: [], country: "IN", hiddenPages: ["/sales/challans"] }).flatMap((s) => s.items.map((i) => i.href));
    ok("the menu leaves it out and keeps its neighbours", !menu.includes("/sales/challans") && menu.includes("/sales/invoices"), menu);
    ok("the super admin is never held to it", (await hiddenPagesFor(superAdmin.id)).length === 0);

    r = await setRolePageHidden(ROLE, "/sales/challans", false);
    ok("ticked again, it's back", r.ok && !(await pageHiddenFor(person.id, "/sales/challans")));
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
