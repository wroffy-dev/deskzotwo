/**
 * That every page in the app has something to show the moment its link is clicked, and something to
 * show if it fails.
 *
 * A `loading.tsx` only shows when the route segment directly below its folder changes. So one at the
 * top of src/app/(dashboard) answers a move from Leads to Orders, and nothing else: from a lead back
 * to the list, or from one accounting report to the next, the old page simply sat there until the new
 * one was ready — which reads as a click that was missed. The fix is a file in the right folders, and
 * a folder added next month without one is exactly the gap this was written to close, so it is held
 * here rather than remembered:
 *
 *   - (dashboard) itself has a loading.tsx and an error.tsx;
 *   - every folder with routes inside it has a loading.tsx;
 *   - every record (`[id]`) and every "new" form has its own, in its own shape
 *     (src/components/ui/skeleton.tsx);
 *   - every error.tsx is a client component — Next requires it, and it fails only at runtime.
 *
 *   npm run check:loading
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

let failures = 0;
function ok(label: string, pass: boolean, detail: string | number | null = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}

const ROOT = join(process.cwd(), "src/app/(dashboard)");

function subfolders(dir: string): string[] {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory());
}

/** Whether a page lives anywhere below this folder — not in the folder itself. */
function hasNestedRoutes(dir: string): boolean {
  return subfolders(dir).some((sub) => existsSync(join(sub, "page.tsx")) || hasNestedRoutes(sub));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const sub of subfolders(dir)) {
    out.push(sub);
    walk(sub, out);
  }
  return out;
}

const folders = walk(ROOT);
const name = (dir: string) => `(dashboard)/${relative(ROOT, dir)}`;

ok("(dashboard) has a loading.tsx", existsSync(join(ROOT, "loading.tsx")));
ok("(dashboard) has an error.tsx", existsSync(join(ROOT, "error.tsx")));

const isRecord = (dir: string) => /^\[.+\]$/.test(basename(dir));
const isNewForm = (dir: string) => basename(dir) === "new" && existsSync(join(dir, "page.tsx"));

const missing = folders.filter((dir) => (hasNestedRoutes(dir) || isRecord(dir) || isNewForm(dir)) && !existsSync(join(dir, "loading.tsx")));
ok(
  "every folder with routes inside it, every record and every new form has a loading.tsx",
  missing.length === 0,
  missing.length ? missing.map(name).join(", ") : `${folders.filter((d) => existsSync(join(d, "loading.tsx"))).length} folders`,
);

const errorFiles = [ROOT, ...folders].map((dir) => join(dir, "error.tsx")).filter((path) => existsSync(path));
const serverErrors = errorFiles.filter((path) => !/^\s*["']use client["'];?/.test(readFileSync(path, "utf8")));
ok("every error.tsx is a client component", serverErrors.length === 0, serverErrors.length ? serverErrors.map((p) => relative(process.cwd(), p)).join(", ") : `${errorFiles.length} files`);

if (failures > 0) {
  console.log(`\n${failures} failed.`);
  process.exit(1);
}
console.log("\nAll passed.");
