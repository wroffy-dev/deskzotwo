/**
 * The "Installed elsewhere" Excel needs data.exportCrm, like every other CRM export.
 *
 * Security audit, Nov 2026: /api/customers/elsewhere-export checked only who was signed in and whether the companies
 * module was on, then gave out up to 2,000 rows of customer data as a file. data.exportCrm — which nobody holds by
 * default — guards every sibling CRM export, and the reporting sources map this very data to it.
 *
 * A static check, so it needs no database (check:installed-elsewhere exercises the same rule against one).
 *
 *   npm run check:elsewhere-export
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}

const root = join(__dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

console.log("\n— Installed elsewhere, as a file —\n");

const route = read("src/app/api/customers/elsewhere-export/route.ts");
const get = route.slice(route.indexOf("export async function GET("));
const gate = get.search(/if \(!\(await can\(user\.id, "data\.exportCrm"\)\)\) return new NextResponse\("Not found", \{ status: 404 \}\);/);
const listed = get.indexOf("listElsewhere(");
ok("the export refuses anybody without data.exportCrm, with a 404", gate >= 0);
ok("  before a single row is read", gate >= 0 && listed > gate, `gate at ${gate}, read at ${listed}`);

const page = read("src/app/(dashboard)/customers/elsewhere/page.tsx");
ok("the page asks for data.exportCrm", /can\(user\.id, "data\.exportCrm"\)/.test(page));
ok("  and shows the Excel link only to those who hold it", /data\.rows\.length > 0 && mayExport \?/.test(page));

console.log(failures === 0 ? "\nAll elsewhere-export checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
