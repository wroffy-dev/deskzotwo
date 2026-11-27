/**
 * check:sidebar-order — each person's own order for the sidebar (owner, 17 Nov 2026 — src/lib/navigation-order.ts).
 *
 *   1. Sections in the person's order, each still under its own heading; pages in their order inside their section.
 *   2. A page never leaves its section, nor a split section's page its part, whatever is stored — the menu holds the
 *      same pages in every section as before. What was never placed keeps the app's order, after what was.
 *   3. A stored order is read tolerantly: junk is dropped, the app's order stands for it.
 *   4. The arranger draws every section with its handle and arrows, and Reset Sidebar as an icon named on hover.
 *   5. Saved and reset as the person; refused while viewing as somebody.
 *
 *   npm run check:sidebar-order
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let viewingAs = false;
let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request === "next/navigation") {
    return { useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }), usePathname: () => "/dashboard", useSearchParams: () => new URLSearchParams() };
  }
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return {
      requireUser: user,
      currentUser: user,
      viewAsContext: async () => (viewingAs ? { user: { id: "someone" } } : null),
      refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody else." : null),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

async function main() {
  const { getModuleDefinition } = await import("../src/lib/modules");
  const { buildNavigation, headedNavigation, navHeadingOf, openModuleKeys } = await import("../src/lib/navigation");
  const { PERMISSION_KEYS } = await import("../src/lib/permissions");
  const { applySidebarOrder, readSidebarOrder, orderOf, hasSidebarOrder, moved } = await import("../src/lib/navigation-order");

  const all = buildNavigation({
    openModules: openModuleKeys(() => ({ entitled: true, switchedOn: true }), new Set(PERMISSION_KEYS)).filter((k) => !getModuleDefinition(k)?.countries || getModuleDefinition(k)!.countries!.includes("IN")),
    permissions: [...PERMISSION_KEYS],
    country: "IN",
  });
  const groupsOf = (nav: typeof all) => nav.map((s) => s.group);
  const pagesBySection = (nav: typeof all) => Object.fromEntries(nav.map((s) => [s.group, s.items.map((i) => `${i.section ?? ""}|${i.href}`).sort()]));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  section("1. The person's order");
  ok("nothing stored: the app's order, as it was", same(applySidebarOrder(all, {}), all));
  const crm = headedNavigation(all).find((h) => h.heading === "CRM")!.sections.map((s) => s.group);
  const flippedCrm = [...crm].reverse();
  const byGroups = applySidebarOrder(all, { groups: flippedCrm });
  ok("the CRM sections in the person's order", same(headedNavigation(byGroups).find((h) => h.heading === "CRM")!.sections.map((s) => s.group), flippedCrm), headedNavigation(byGroups).find((h) => h.heading === "CRM")!.sections.map((s) => s.group));
  ok("  every section still under its own heading", byGroups.every((s) => navHeadingOf(s.group) === navHeadingOf(s.group)) && same(headedNavigation(byGroups).map((h) => h.heading), headedNavigation(all).map((h) => h.heading)));
  const sales = all.find((s) => s.group === "Sales")!;
  const salesFlipped = sales.items.map((i) => i.href).reverse();
  const byItems = applySidebarOrder(all, { items: { Sales: salesFlipped } });
  ok("a section's pages in the person's order", same(byItems.find((s) => s.group === "Sales")!.items.map((i) => i.href), salesFlipped));
  const accounts = all.find((s) => s.group === "Accounts")!;
  const parts = [...new Set(accounts.items.map((i) => i.section!))];
  const partsFlipped = [...parts].reverse();
  const byParts = applySidebarOrder(all, { parts: { Accounts: partsFlipped } });
  const partsAfter = [...new Set(byParts.find((s) => s.group === "Accounts")!.items.map((i) => i.section!))];
  ok("a split section's parts in the person's order, each whole", same(partsAfter, partsFlipped), partsAfter);
  const salesPart = accounts.items.filter((i) => i.section === "Sales").map((i) => i.href);
  const byPartPages = applySidebarOrder(all, { items: { Accounts: [...salesPart].reverse() } });
  const salesPartAfter = byPartPages.find((s) => s.group === "Accounts")!.items.filter((i) => i.section === "Sales").map((i) => i.href);
  ok("  and a part's pages in the person's order inside it", same(salesPartAfter, [...salesPart].reverse()), salesPartAfter);

  section("2. Nothing leaves where it lives");
  // A page of Accounts named first for Sales, Sales' pages for Accounts, a section that isn't there, a made-up page.
  const hostile = applySidebarOrder(all, {
    groups: ["Nope", "Accounts", ...crm],
    items: { Sales: ["/sales/invoices", "/accounting/vouchers", ...salesFlipped], Accounts: ["/leads", "/made-up", ...salesPart] },
    parts: { Accounts: ["Nope", ...partsFlipped] },
  });
  const before = pagesBySection(all);
  const afterHostile = pagesBySection(hostile);
  ok("every section holds exactly the pages it held, whatever is stored", Object.keys(before).every((g) => same(before[g], afterHostile[g])) && Object.keys(before).length === Object.keys(afterHostile).length, Object.keys(before).filter((g) => !same(before[g], afterHostile[g])));
  ok("  and the menu has the same sections", same([...groupsOf(hostile)].sort(), [...groupsOf(all)].sort()));
  const split = hostile.find((s) => s.group === "Accounts")!.items;
  const contiguous = split.every((item, i) => i === 0 || item.section === split[i - 1]!.section || !split.slice(i).some((x) => x.section === split[i - 1]!.section));
  ok("  a split section's parts stay whole — no part's pages scattered", contiguous);
  const someCrm = crm.slice(0, 2).reverse();
  const partial = applySidebarOrder(all, { groups: someCrm });
  const crmAfter = headedNavigation(partial).find((h) => h.heading === "CRM")!.sections.map((s) => s.group);
  ok("what was never placed keeps the app's order, after what was", same(crmAfter, [...someCrm, ...crm.filter((g) => !someCrm.includes(g))]), crmAfter);
  ok("orderOf and back gives the same menu", same(applySidebarOrder(all, orderOf(byItems)), byItems));
  ok("a move stays in its list", same(moved(["a", "b", "c"], 0, 2), ["b", "c", "a"]) && same(moved(["a", "b"], 0, 5), ["a", "b"]));

  section("3. Read tolerantly");
  ok("junk is nobody's order", !hasSidebarOrder(readSidebarOrder("x")) && !hasSidebarOrder(readSidebarOrder([1, 2])) && !hasSidebarOrder(readSidebarOrder(null)));
  const read = readSidebarOrder({ groups: ["Sales", 3, "Sales", " ", "x".repeat(500)], items: { Sales: ["/leads", null], "": ["/x"] }, parts: "nope", extra: true });
  ok("  strings kept once, the rest dropped", same(read, { groups: ["Sales"], items: { Sales: ["/leads"] } }), read);

  section("4. The arranger");
  const { SidebarArranger } = await import("../src/components/layout/sidebar-arranger");
  const { WordingProvider } = await import("../src/components/terms/wording-provider");
  const { DEFAULT_WORDING } = await import("../src/lib/terms/dictionary");
  const html = renderToStaticMarkup(createElement(WordingProvider, { initial: DEFAULT_WORDING } as never, createElement(SidebarArranger, { navigation: all, arranged: true, onClose: () => {} })));
  ok("every section, with its handle and its arrows", all.every((s) => html.includes(`>${s.group.replace(/&/g, "&amp;")}<`)) && html.includes('draggable="true"') && html.includes('aria-label="Move Sales up"'));
  ok("Reset Sidebar: an icon alone, its name on hover", /<button[^>]*title="Reset Sidebar"[^>]*aria-label="Reset Sidebar"[^>]*>\s*<svg/.test(html) && !/>\s*Reset Sidebar\s*</.test(html));
  const fresh = renderToStaticMarkup(createElement(WordingProvider, { initial: DEFAULT_WORDING } as never, createElement(SidebarArranger, { navigation: all, arranged: false, onClose: () => {} })));
  ok("  and nothing to reset with no order saved", /<button[^>]*title="Reset Sidebar"[^>]*disabled/.test(fresh) || /<button[^>]*disabled[^>]*title="Reset Sidebar"/.test(fresh));
  const { Sidebar } = await import("../src/components/layout/sidebar");
  const { DEFAULT_BRANDING } = await import("../src/lib/branding");
  const side = (arrangeable: boolean) => renderToStaticMarkup(createElement(WordingProvider, { initial: DEFAULT_WORDING } as never, createElement(Sidebar, { navigation: all, branding: DEFAULT_BRANDING, arrangeable })));
  ok("the sidebar offers Arrange sidebar to its person", side(true).includes('aria-label="Arrange sidebar"'));
  ok("  and not while viewing as somebody", !side(false).includes('aria-label="Arrange sidebar"'));

  section("5. Saved, as the person");
  if (!process.env.DATABASE_URL) {
    console.log("  (no database — skipped)");
    return;
  }
  const { db } = await import("../src/lib/db");
  const { saveSidebarOrder, resetSidebarOrder } = await import("../src/actions/sidebar-order");
  const probe = await db.user.create({ data: { name: "ZZPROBE_SIDEBAR", email: `zzprobe-sidebar-${Date.now()}@probe.test`, passwordHash: "!", role: "EMPLOYEE" } as never, select: { id: true } });
  actorId = probe.id;
  try {
    const saved = await saveSidebarOrder({ groups: flippedCrm, items: { Sales: salesFlipped }, junk: 1 });
    const stored = (await db.user.findUniqueOrThrow({ where: { id: probe.id }, select: { sidebarOrder: true } })).sidebarOrder;
    const asRead = readSidebarOrder(stored);
    ok("saved on the person, junk left out", saved.ok && same(asRead.groups, flippedCrm) && same(asRead.items, { Sales: salesFlipped }) && !asRead.parts && !("junk" in (stored as object)), stored);
    viewingAs = true;
    const borrowed = await saveSidebarOrder({ groups: crm });
    const borrowedReset = await resetSidebarOrder();
    viewingAs = false;
    const still = (await db.user.findUniqueOrThrow({ where: { id: probe.id }, select: { sidebarOrder: true } })).sidebarOrder;
    ok("  refused while viewing as somebody, saving and resetting alike", !borrowed.ok && !borrowedReset.ok && same(readSidebarOrder(still), asRead));
    const reset = await resetSidebarOrder();
    const after = (await db.user.findUniqueOrThrow({ where: { id: probe.id }, select: { sidebarOrder: true } })).sidebarOrder;
    ok("Reset Sidebar puts the app's order back", reset.ok && same(after, {}), after);
  } finally {
    await db.user.delete({ where: { id: probe.id } }).catch(() => {});
    await db.$disconnect();
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? `\nAll ${passes} sidebar order checks passed.` : `\n${failures} failed (${passes} passed).`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
