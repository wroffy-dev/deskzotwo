/**
 * Borrowing an account needs everything it holds: permission keys, record reach and field policy.
 *
 * Security audit, Nov 2026: holdsNothingBeyond (viewing as, src/lib/impersonation.ts) and
 * mayPassOnSetupLink (setup links and temporary passwords, src/lib/account-setup.ts) compared permission
 * keys only, so an admin who reached only their own leads, or saw lead emails masked, could borrow an
 * account that reached all leads or saw them in the clear. Both now ask targetWithinActorAuthority
 * (src/lib/authz/borrow.ts).
 *
 * A static check, so it needs no database (check:admin-password exercises the same rule against one).
 *
 *   npm run check:borrow-authority
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}

const root = join(__dirname, "..");
const read = (file: string) => {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return "";
  }
};
/** From a function's declaration to the closing brace at the start of a line. */
const body = (source: string, declaration: string) => {
  const start = source.indexOf(declaration);
  if (start < 0) return "";
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};

console.log("\n— Borrowing an account —\n");

const helper = body(read("src/lib/authz/borrow.ts"), "export async function targetWithinActorAuthority(");
ok("targetWithinActorAuthority exists", helper !== "");
ok("  a super admin passes", /if \(actor\.isSuperAdmin\) return true;/.test(helper));
ok("  every permission key the account holds must be grantable", /permissionsFor\(targetId\)/.test(helper) && /assertGrantWithinOwnAuthority\(actor, key\)/.test(helper));
ok("  every record type and action: their level within the actor's", /ACCESS_RECORDS/.test(helper) && /explainAccess\(targetId,/.test(helper) && /within\(theirs,/.test(helper));
ok("  the actor's \"as the account\" level read through their companies level", /own === "FOLLOW" \? \(await explainAccess\(actor\.id, "companies", action\)\)/.test(helper));
ok("  every field of every record type: their stored policy within the actor's", /FIELD_ENTITIES/.test(helper) && /resolveStoredFieldPolicies\(targetId, entity\)/.test(helper) && /withinPolicy\(field\.policy, own\)/.test(helper));

const viewAs = body(read("src/lib/impersonation.ts"), "export async function holdsNothingBeyond(");
ok("viewing as asks targetWithinActorAuthority", /return targetWithinActorAuthority\(actor, targetId\)/.test(viewAs));
ok("  and no longer stops at permission keys", !/permissionsFor\(/.test(viewAs));

const setup = body(read("src/lib/account-setup.ts"), "export async function mayPassOnSetupLink(");
ok("setup links and temporary passwords ask targetWithinActorAuthority", /return targetWithinActorAuthority\(actor, userId\)/.test(setup));
ok("  and no longer stop at permission keys", !/permissionsFor\(/.test(setup));

console.log(failures === 0 ? "\nAll borrow-authority checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
