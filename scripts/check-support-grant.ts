/**
 * A support session's authority follows the workspace's live grant.
 *
 * Security audit, Nov 2026: a support account's role was set only when staff entered
 * (enterAsSupport), and the access gate asked only whether some grant was live. A new grant ended the
 * last one but left its support accounts active with their old role, so lowering ADMIN to READONLY
 * left an admin session running, and a session whose grant had expired came back with any later grant.
 *
 * A static check, so it needs no database (check:console exercises the same behaviour against one):
 *   - grantSupportAccess and endSupportAccess both end the support accounts and their sessions, and
 *     drop the gate's cached verdicts;
 *   - the gate lets a support account through only when its role is the live grant's, and ends its
 *     sessions when it isn't.
 *
 *   npm run check:support-grant
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}

const root = join(__dirname, "..");
const support = readFileSync(join(root, "src/lib/platform/support.ts"), "utf8");
const gate = readFileSync(join(root, "src/lib/access/gate.ts"), "utf8");

/** The body of a top-level function: from its declaration to the next top-level declaration. */
function body(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start < 0) return "";
  const rest = source.slice(start + declaration.length);
  const end = rest.search(/\n(export )?(async )?function |\n(export )?const |\n\/\*\*/);
  return end >= 0 ? rest.slice(0, end) : rest;
}

console.log("\n— Support sessions and the live grant —\n");

const ender = body(support, "async function endSupportSessions(");
ok("endSupportSessions switches the support accounts off", /db\.user\.updateMany\([\s\S]*active: false/.test(ender));
ok("  and ends every session they hold", /db\.signIn\.updateMany\([\s\S]*endedAt: null[\s\S]*endedAt: now/.test(ender));
ok("  and drops the gate's cached verdicts", /clearAccessCache\(\)/.test(ender));

ok("a new grant ends the support sessions of the last one", /await endSupportSessions\(\)/.test(body(support, "export async function grantSupportAccess(")));
ok("ending the grant ends them too", /await endSupportSessions\(\)/.test(body(support, "export async function endSupportAccess(")));
ok("entering as support takes its role from supportRoleFor", /const role = supportRoleFor\(grant\.level\)/.test(body(support, "export async function enterAsSupport(")));

const still = body(gate, "async function supportStillGranted(");
ok("the gate asks supportStillGranted for a support account", /support \? await supportStillGranted\(user, now\)/.test(gate));
ok("  which needs the account's role to be the live grant's", /user\.role === supportRoleFor\(grant\.level\)/.test(still));
ok("  asks again without the cache before refusing", /activeSupportGrant\(tenantId, true\)/.test(still));
ok("  and ends the account's sessions when it refuses", /db\.signIn\.updateMany\(\{ where: \{ userId: user\.id, endedAt: null \}/.test(still));
ok("the gate no longer settles for any live grant", !/!!\(await activeSupportGrant\(/.test(gate));

console.log(failures === 0 ? "\nAll support-grant checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
