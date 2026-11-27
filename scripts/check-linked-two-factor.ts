/**
 * A two-factor change ends linked sign-in even when the account hook doesn't.
 *
 * Security audit, Nov 2026: a two-factor reset (resetUserTwoFactor, disableOwnTwoFactor) unlinked only through
 * accountsChanged, which swallows errors, and credentialStamp hashed only the id, address and password hash —
 * so neither the switch's checks nor the nightly sweep noticed a missed unlink, and a linked workspace could
 * switch into the reset account with no second factor. The stamp now covers two-factor too.
 *
 * A static check, so it needs no database (check:linked-signin exercises the same rule against one).
 *
 *   npm run check:linked-two-factor
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
const body = (source: string, declaration: string) => {
  const start = source.indexOf(declaration);
  if (start < 0) return "";
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};

console.log("\n— Linked sign-in and two-factor —\n");

const stamp = body(read("src/lib/platform/linked/keys.ts"), "export function credentialStamp(");
ok("credentialStamp takes the account's two-factor state", /twoFactorEnabledAt: Date \| null/.test(stamp));
ok("  and hashes it with the id, address and password", /user\.passwordHash, user\.twoFactorEnabledAt \? user\.twoFactorEnabledAt\.toISOString\(\) : "none"/.test(stamp));

// Every account read that feeds credentialStamp selects twoFactorEnabledAt, or the stamp is computed on "none".
const accountSelect = (file: string) => {
  const source = read(file);
  const start = source.indexOf("const ACCOUNT = {");
  return start < 0 ? "" : source.slice(start, source.indexOf("} as const;", start));
};
ok("link requests read two-factor with the account", /twoFactorEnabledAt: true/.test(accountSelect("src/lib/platform/linked/intents.ts")));
ok("switching reads two-factor with the account", /twoFactorEnabledAt: true/.test(accountSelect("src/lib/platform/linked/switch.ts")));
const sweep = read("src/lib/platform/linked/sweep.ts");
ok("the sweep reads two-factor with the accounts it checks", /select: \{ id: true, email: true, passwordHash: true, twoFactorEnabledAt: true, active: true, kind: true \}/.test(sweep));
ok("  and compares the stamp that covers it", /return credentialStamp\(tenantId, user\) === stamp \? null : "credentials";/.test(sweep));

const restamp = body(sweep, "export async function restampLegacyLinks(");
ok("links made before are moved onto the new stamp, once, only while the old one still matches", /m\.stamp !== legacyCredentialStamp\(tenant\.id, user\)\) continue;/.test(restamp) && /data: \{ stamp: credentialStamp\(tenant\.id, user\) \}/.test(restamp));
ok("  by npm run linked:restamp", /"linked:restamp": "tsx scripts\/linked-restamp\.ts"/.test(read("package.json")));

ok("the unlink email names two-factor as a reason", /credentials: "The password, email address or two-factor sign-in of your account there changed\."/.test(read("src/lib/platform/linked/groups.ts")));

console.log(failures === 0 ? "\nAll linked two-factor checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
