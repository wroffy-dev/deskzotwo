/**
 * check:renewal-actions — Renewals offers only what the person looking may do (owner, 26 Nov 2026: "what if i want analyst
 * to see the renewal but can't do anything ! like actions column not accessible … stage also"; src/lib/renewal-actions.ts).
 *
 *   · Each answer is the permission its action asks: stage and renew — Edit products & subscriptions or Process orders;
 *     email — those or Send marketing; proposal — Create proposals; call — the Calls module.
 *   · Drawn: with none, no Actions column, no tick boxes and the stage a label; with each, just its button.
 *
 *   npm run check:renewal-actions
 */
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let held = new Set<string>();
let callsOn = false;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "@/actions/permission") return { viewerHas: async (key: string) => held.has(key) };
  if (request === "@/actions/module") return { isModuleEnabled: async (key: string) => key === "calls" && callsOn };
  if (request === "next/navigation") return { useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/renewals", useSearchParams: () => new URLSearchParams() };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};

async function main() {
  const { viewerRenewalActions, worksRenewals } = await import("../src/lib/renewal-actions");
  const { RenewalsTable } = await import("../src/components/renewals/renewals-table");

  console.log("\n— What each may do —\n");
  const as = async (keys: string[], calls = false) => {
    held = new Set(keys);
    callsOn = calls;
    return viewerRenewalActions();
  };
  const analyst = await as([]);
  ok("an analyst with none of them: nothing", !worksRenewals(analyst) && Object.values(analyst).every((v) => v === false), analyst);
  const editor = await as(["products.edit"]);
  ok("Edit products & subscriptions: stage, renew and email", editor.stage && editor.renew && editor.email && !editor.proposal && !editor.call, editor);
  const processor = await as(["orders.process"]);
  ok("Process orders: the same", processor.stage && processor.renew && processor.email, processor);
  const marketer = await as(["marketing.send"]);
  ok("Send marketing: email only", marketer.email && !marketer.stage && !marketer.renew, marketer);
  const proposer = await as(["docs.createProposal"]);
  ok("Create proposals: the proposal only", proposer.proposal && !proposer.email && !proposer.renew, proposer);
  const caller = await as([], true);
  ok("the Calls module: the call only", caller.call && !caller.email && worksRenewals(caller), caller);

  console.log("\n— Drawn —\n");
  const row = {
    id: "o1",
    orderSeq: 35669,
    quantity: 1,
    poNumber: null,
    startDate: "2025-08-28",
    endDate: "2026-08-28",
    company: { id: "c1", companySeq: 1, name: "Ikio Lighting Limited", owner: null, contacts: [] },
    endCustomer: null,
    item: { id: "i1", name: "Suite", unit: null },
    stage: { key: "NOT_STARTED", label: "Not started", pinned: false } as never,
  };
  const draw = (can: Awaited<ReturnType<typeof viewerRenewalActions>>, canSetManager = false) =>
    renderToStaticMarkup(createElement(RenewalsTable, { renewals: [row] as never, users: [], can, canSetManager }));
  const none = draw(analyst);
  ok("view only: no Actions column", !none.includes(">Actions<") && !none.includes('data-col="actions"'));
  ok("  no tick boxes", !none.includes('data-col="select"') && !none.includes('type="checkbox"'));
  ok("  the stage a label, not a picker", none.includes("Not started") && !/aria-haspopup|<select/.test(none.slice(none.indexOf("Not started") - 400, none.indexOf("Not started") + 50)));
  ok("  the row is still there", none.includes("Ikio Lighting Limited"));
  const sales = draw({ stage: true, renew: true, email: true, proposal: true, call: false }, true);
  ok("somebody who works renewals: the Actions column and tick boxes", sales.includes('data-col="actions"') && sales.includes('data-col="select"'));
  const proposalOnly = draw(proposer);
  ok("proposals only: an Actions column with just that button", proposalOnly.includes('data-col="actions"') && (proposalOnly.match(/<button/g) ?? []).length < (sales.match(/<button/g) ?? []).length);
  const managerOnly = draw(analyst, true);
  ok("may set the renewal manager but nothing else: tick boxes, no Actions column", managerOnly.includes('data-col="select"') && !managerOnly.includes('data-col="actions"'));
}

main()
  .catch((err) => {
    failures += 1;
    console.error(err);
  })
  .finally(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
