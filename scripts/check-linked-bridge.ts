/**
 * A linked group doesn't outlive the account that bridged it.
 *
 * Security audit, Nov 2026: joinGroup merges groups on the two accounts proven in one link, and a switch is
 * allowed on a shared group. revokeMember removed only the account revoked — so somebody who linked to
 * account t kept switching into t's other accounts after t's owner changed the password to shut them out.
 * Now a revocation for a change of sign-in, or the account going (credentials, two-factor-reset,
 * deactivated, deleted), unlinks the whole group and tells every member; and when an account joins or groups
 * merge, everybody already in the group is told, not just the two that linked.
 *
 * A static check, so it needs no database (check:linked-signin exercises the same rule against one).
 *
 *   npm run check:linked-bridge
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

console.log("\n— Linked groups and the account that bridged them —\n");

const groups = read("src/lib/platform/linked/groups.ts");
const dissolves = /const DISSOLVES = new Set<RevokeReason>\(\[([^\]]*)\]\)/.exec(groups)?.[1] ?? "";
for (const reason of ["credentials", "two-factor-reset", "deactivated", "deleted"]) {
  ok(`a "${reason}" revocation unlinks the whole group`, dissolves.includes(`"${reason}"`), dissolves);
}
ok("  an ordinary unlink (user, left, admin) still takes one account", !/"user"|"left"|"admin"/.test(dissolves));

const revoke = body(groups, "export async function revokeMember(");
ok("revokeMember keeps the rest only when the reason doesn't dissolve", /const whole = DISSOLVES\.has\(reason\);/.test(revoke) && /if \(rest\.length >= 2 && !whole\) return/.test(revoke));
ok("  and tells every member it unlinked why", /const why = whole \? DISSOLVED_WHY/.test(revoke) && /for \(const other of dissolved\) await sendUnlinkNotice\(other, why, false\);/.test(revoke));

const intents = read("src/lib/platform/linked/intents.ts");
const complete = body(intents, "export async function completeLinkIntent(");
ok("a new link is announced to everybody already in the group", /\.\.\.\(await othersInGroup\(joined\.groupId, \[user\.email, other\.email\]\)\)/.test(complete));
ok("  othersInGroup reads the group's members", /linkMember\.findMany\(\{ where: \{ groupId \}/.test(body(intents, "async function othersInGroup(")));

console.log(failures === 0 ? "\nAll linked-bridge checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
