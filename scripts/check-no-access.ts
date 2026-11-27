/**
 * check:no-access — a page refused while it loads says so, rather than "something went wrong" (owner, 26 Nov 2026: "if
 * error page comes because of no permission then show you have no permission to view instead"; src/lib/no-access.ts,
 * src/components/layout/page-error.tsx).
 *
 *   · The module refusals, and the permission ones pages meet, carry a digest that says which they are — the one thing of
 *     an error Next sends the browser — each still its own, for the server's log.
 *   · Next keeps a digest an error already has (so the kind gets there at all).
 *   · The error page: a refusal reads as one, with no "Try again"; any other failure is as it was.
 *
 *   npm run check:no-access
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Module from "node:module";
import { readFileSync } from "node:fs";

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  // The page's wording comes from the workspace's; its defaults are enough here.
  if (request === "@/components/terms/wording-provider") return { useWording: () => ({}) };
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
  const { NoAccessError, noAccessKind } = await import("../src/lib/no-access");
  const { ModuleNotOpen, ModuleNotInPlan } = await import("../src/lib/modules-access");
  const { PageError } = await import("../src/components/layout/page-error");

  console.log("\n— The refusals —\n");
  const open = new ModuleNotOpen("Tasks isn't open to you.");
  const plan = new ModuleNotInPlan("Payroll is not part of this workspace's plan.");
  ok("a module not open to them is a refusal of permission", noAccessKind(open.digest) === "permission" && open instanceof NoAccessError && open instanceof ModuleNotOpen);
  ok("  one outside the plan, a refusal of the plan", noAccessKind(plan.digest) === "plan" && plan.message.includes("Payroll"));
  ok("  each its own, for the server's log", new ModuleNotOpen("x").digest !== new ModuleNotOpen("x").digest);
  ok("  anything else isn't one", noAccessKind(undefined) === null && noAccessKind("1234567") === null && noAccessKind("NEXT_HTTP_ERROR_FALLBACK;404") === null);
  for (const [file, what] of [["src/actions/revenue.ts", "revenue recognition"], ["src/actions/revenue-screens.ts", "revenue recognition"], ["src/actions/tax-reports.ts", "the books"]] as const) {
    const text = readFileSync(file, "utf8");
    ok(`  ${file}: "${what}" is a refusal`, text.includes(`throw new NoAccessError("You don't have permission to see ${what}.")`) && !text.includes(`throw new Error("You don't have permission`));
  }
  const handler = readFileSync("node_modules/next/dist/server/app-render/create-error-handler.js", "utf8");
  ok("Next keeps a digest an error already has", /If the error already has a digest, respect the original digest/.test(handler));

  console.log("\n— The error page —\n");
  const draw = (error: Error) => renderToStaticMarkup(createElement(PageError, { error, retry: () => {} }));
  const refused = draw(open);
  ok("refused: says they don't have permission, and to ask their admin", refused.includes("You don&#x27;t have permission to view this") && refused.includes("ask your admin"));
  ok("  no \"Try again\", no \"something went wrong\", no reference", !refused.includes("Try again") && !refused.includes("Something went wrong") && !refused.includes("Reference"));
  ok("  a way back", refused.includes('href="/dashboard"'));
  const outside = draw(plan);
  ok("outside the plan: says so, and where it's added", outside.includes("This isn&#x27;t part of your plan") && outside.includes("Plan &amp; billing"));
  const broken = Object.assign(new Error("connection reset"), { digest: "2938475" });
  const failed = draw(broken);
  ok("anything else: as it was, with Try again and its reference", failed.includes("This page couldn&#x27;t be loaded") && failed.includes("Try again") && failed.includes("2938475") && !failed.includes("permission"));
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
