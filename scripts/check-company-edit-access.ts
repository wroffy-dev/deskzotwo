/**
 * Changing a company needs the edit level, not just the view level.
 *
 * Security audit, Nov 2026: updateCompany (src/actions/company.ts) authorised the write with
 * canSeeCompany — mayAccessAccount(userId, "view", …) — so a view-only role (SUPPORT_READONLY, or any
 * role with companies view and edit NONE) could change any company it could open, through the edit
 * form, PATCH /api/v1/companies/{ref} and PATCH /api/app/companies/{ref}. Its duplicate-name check
 * also ran before the reach check, naming companies outside the caller's reach.
 *
 * A static check, so it needs no database:
 *   - updateCompany asks mayAccessAccount(user.id, "edit", current) and not canSeeCompany;
 *   - the duplicate-name lookup comes after that check;
 *   - the edit page asks for the edit level too.
 *
 *   npm run check:company-edit-access
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}

const root = join(__dirname, "..");
const source = readFileSync(join(root, "src/actions/company.ts"), "utf8");

console.log("\n— Who may change a company —\n");

const start = source.indexOf("export async function updateCompany(");
ok("updateCompany is found", start >= 0);
const rest = source.slice(start + 1);
const end = rest.search(/\nexport (async )?function /);
const body = end >= 0 ? rest.slice(0, end) : rest;

const editCheck = body.search(/mayAccessAccount\(\s*user\.id\s*,\s*"edit"\s*,\s*current\s*\)/);
ok("updateCompany asks for the edit level on the company it changes", editCheck >= 0);
ok("updateCompany no longer settles for canSeeCompany (the view level)", !/canSeeCompany\(/.test(body));

const nameCheck = body.indexOf("companyNamedLike(");
ok("the duplicate-name check is still there", nameCheck >= 0);
ok("the duplicate-name check runs only after the edit check", editCheck >= 0 && nameCheck > editCheck, `edit at ${editCheck}, name at ${nameCheck}`);

const page = readFileSync(join(root, "src/app/(dashboard)/companies/[id]/edit/page.tsx"), "utf8");
ok("the edit page asks for the edit level before showing the form", /mayAccessAccount\(\s*user\.id\s*,\s*"edit"\s*,\s*company\s*\)/.test(page));

console.log(failures === 0 ? "\nAll company edit-access checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
