/**
 * check:list-sorting — the Sort control on Customers, Companies, Leads and Renewals (owner, 31 Oct 2026 —
 * src/lib/tables/sort-options.ts, src/lib/tables/sorted-page.ts).
 *
 *   1. The URL made safe: an unknown key or direction falls back to the list's default; a customer-history sort only
 *      for those who may see orders; the leads list's old `sort=score` still means highest score first.
 *   2. Ranking by a worked-out value: those without one last whichever way round, ties in the list's default order.
 *   3. Pages follow on: page 2 is the next ranked ids, every id once across the pages.
 *
 * No database.
 *
 *   npm run check:list-sorting
 */
import { COMPANY_SORTS, LEAD_SORTS, RENEWAL_SORTS, orderByValues, resolveSort } from "../src/lib/tables/sort-options";
import { inIdOrder, pageOfRanked } from "../src/lib/tables/sorted-page";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

section("1. The URL made safe");
const none = resolveSort(COMPANY_SORTS, undefined, undefined, { canSeeOrders: true });
ok("nothing asked: added on, newest first, the default", none.key === "added" && none.dir === "desc" && none.isDefault, none);
ok("  an unknown key and direction fall back to it", JSON.stringify(resolveSort(COMPANY_SORTS, "drop table", "sideways", { canSeeOrders: true })) === JSON.stringify(none));
const lifetime = resolveSort(COMPANY_SORTS, "lifetime", undefined, { canSeeOrders: true });
ok("lifetime value opens highest first, and isn't the default", lifetime.key === "lifetime" && lifetime.dir === "desc" && !lifetime.isDefault, lifetime);
ok("  turned round, lowest first", resolveSort(COMPANY_SORTS, "lifetime", "asc", { canSeeOrders: true }).dir === "asc");
ok("  without orders.view a history sort isn't used", resolveSort(COMPANY_SORTS, "lifetime", "desc", { canSeeOrders: false }).key === "added");
ok("  last activity needs no orders", resolveSort(COMPANY_SORTS, "lastActivity", undefined).key === "lastActivity");
ok("pays in opens fastest first", resolveSort(COMPANY_SORTS, "paysIn", undefined, { canSeeOrders: true }).dir === "asc");
const score = resolveSort(LEAD_SORTS, "score", undefined);
ok("leads: the old sort=score still means highest score first", score.key === "score" && score.dir === "desc", score);
ok("  expected close and next follow-up open soonest first", resolveSort(LEAD_SORTS, "close", undefined).dir === "asc" && resolveSort(LEAD_SORTS, "nextFollowUp", undefined).dir === "asc");
ok("  no sort: recently updated", resolveSort(LEAD_SORTS, undefined, undefined).key === "updated");
ok("renewals: end date, soonest first, by default; value highest first", resolveSort(RENEWAL_SORTS, undefined, undefined).key === "ends" && resolveSort(RENEWAL_SORTS, undefined, undefined).dir === "asc" && resolveSort(RENEWAL_SORTS, "value", undefined).dir === "desc");
ok("every list's keys are its own, once each", [COMPANY_SORTS, LEAD_SORTS, RENEWAL_SORTS].every((list) => new Set(list.map((o) => o.key)).size === list.length));

section("2. Ranking by a worked-out value");
// a..f in the list's default order; b and e have no value.
const ids = ["a", "b", "c", "d", "e", "f"];
const values = new Map<string, number | null>([["a", 5], ["b", null], ["c", 9], ["d", 5], ["f", 1]]);
ok("highest first: 9, 5, 5, 1, then those without — ties as they came", orderByValues(ids, values, "desc").join("") === "cadfbe", orderByValues(ids, values, "desc").join(""));
ok("  lowest first: those without still last", orderByValues(ids, values, "asc").join("") === "fadcbe", orderByValues(ids, values, "asc").join(""));
ok("  a value of nothing but zero is a value, ranked", orderByValues(["x", "y"], new Map([["x", null], ["y", 0]]), "asc").join("") === "yx");

section("3. Pages follow on");
const many = Array.from({ length: 23 }, (_, i) => `id${i}`);
const ranks = new Map(many.map((id, i) => [id, i % 4 === 0 ? null : (i * 7) % 11]));
const pages = [1, 2, 3].map((p) => pageOfRanked(many, ranks, "desc", p, 10));
ok("10, 10 and 3 — every id once across the pages", pages.map((p) => p.length).join() === "10,10,3" && new Set(pages.flat()).size === 23, pages.map((p) => p.length));
ok("  page 2 starts where page 1 stopped", pages.flat().join() === orderByValues(many, ranks, "desc").join());
ok("rows fetched by id come back in the page's order", inIdOrder([{ id: "c" }, { id: "a" }, { id: "b" }], ["b", "c", "a"]).map((r) => r.id).join("") === "bca");

console.log(failures === 0 ? `\nAll ${passes} list sorting checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
process.exit(failures === 0 ? 0 : 1);
