/**
 * A record's tabs in one row with the rest under More, and the Products & Subscriptions views (owner, 13 Nov 2026).
 * No database: the pin rules (src/lib/tab-pins.ts), the row as drawn (src/components/ui/tab-row.tsx), and which view
 * each order falls in (src/components/companies/company-products-list.tsx).
 *
 *   npx tsx scripts/check-tab-row.ts
 */
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const load = (Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown })._load;
(Module as unknown as { _load: unknown })._load = function (req: string, ...rest: unknown[]) {
  if (req === "next/navigation") return { useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() };
  return load.call(this, req, ...rest);
};

let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${name}`, detail ?? "");
  }
}

(async () => {
  const { pinnedTabs, MAX_PINNED_TABS } = await import("../src/lib/tab-pins");
  const { TabRow } = await import("../src/components/ui/tab-row");
  const { productStanding, inProductView } = await import("../src/components/companies/company-products-list");

  const tabs = ["details", "products", "documents", "payments", "renewals", "contacts", "calls", "tickets", "tasks", "portal"].map((key) => ({ key, label: key[0]!.toUpperCase() + key.slice(1) }));
  const usual = ["details", "products", "documents", "payments", "renewals", "contacts", "calls"];

  console.log("Which tabs are in the row");
  ok("no cookie: the usual ones, in the record's order", pinnedTabs(tabs, undefined, [...usual].reverse()).join() === usual.join());
  ok("a saved choice wins, in the record's order", pinnedTabs(tabs, "tickets,details", usual).join() === "details,tickets");
  ok("a saved choice is read encoded", pinnedTabs(tabs, encodeURIComponent("tasks,calls"), usual).join() === "calls,tasks");
  ok("tabs this record doesn't have are left out", pinnedTabs(tabs, "details,commission", usual).join() === "details");
  ok(`never more than ${MAX_PINNED_TABS}`, pinnedTabs(tabs, tabs.map((t) => t.key).join(), usual).length === MAX_PINNED_TABS);
  ok("never an empty row", pinnedTabs(tabs, "nothing", ["nothing"]).length === 5);

  console.log("The row as drawn");
  const html = (activeKey: string) =>
    renderToStaticMarkup(createElement(TabRow, { tabs, activeKey, pinned: pinnedTabs(tabs, undefined, usual), cookieName: "deskzo.tabs.company", basePath: "/companies/7" }));
  const row = html("details");
  ok("the pinned tabs are links", usual.every((k) => row.includes(`?tab=${k}`) || k === "details"));
  ok("an unpinned tab isn't in the row", !row.includes("?tab=tickets"));
  ok("More says how many are under it", row.includes("More 3"), row.slice(0, 400));
  const open = html("tickets");
  ok("the open tab shows in the row though it isn't pinned", open.includes("?tab=tickets"));
  ok("…and More then counts the rest", open.includes("More 2"));

  console.log("Products & Subscriptions views");
  const day = (n: number) => new Date(Date.now() + n * 86_400_000);
  const sub = (endDate: Date | null, orderStatus = "FULFILLED") => ({ orderStatus: orderStatus as never, endDate, item: { type: "SUBSCRIPTION" } });
  ok("running a year: active", productStanding(sub(day(365))) === "active");
  ok("ending in 10 days: expiring", productStanding(sub(day(10))) === "expiring");
  ok("ended yesterday: expired", productStanding(sub(day(-1))) === "expired");
  ok("no end date set: active", productStanding(sub(null)) === "active");
  ok("cancelled, though running: expired", productStanding(sub(day(200), "CANCELLED")) === "expired");
  ok("rejected: expired", productStanding(sub(day(200), "REJECTED")) === "expired");
  ok("a one-time product: active", productStanding({ orderStatus: "FULFILLED" as never, endDate: day(-400), item: { type: "PRODUCT" } }) === "active");
  ok("Active includes Expiring soon", inProductView("expiring", "active"));
  ok("Active leaves out Expired", !inProductView("expired", "active"));
  ok("All has everything", ["active", "expiring", "expired"].every((s) => inProductView(s as never, "all")));

  console.log(failed ? `\n${failed} failed` : "\nAll passed");
  process.exit(failed ? 1 : 0);
})();
