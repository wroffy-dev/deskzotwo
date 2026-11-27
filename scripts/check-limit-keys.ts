/**
 * Rate-limit keys count an IPv6 subscriber once, not once per address (security review, 15 Nov 2026 — RL-01, RL-04).
 * A home or office is given a whole /64, so a key on the full address let one subscriber take a fresh allowance for
 * every try. No database: src/lib/client-ip.ts (groupKeyIps), src/lib/security/lockout.ts (lockoutKey),
 * src/lib/platform/find-workspaces.ts (siteAllowance), src/lib/security/caller-budget.ts (withinCallerBudget).
 *
 *   npx tsx scripts/check-limit-keys.ts
 */
import { groupKeyIps } from "../src/lib/client-ip";
import { lockoutKey } from "../src/lib/security/lockout";
import { siteAllowance } from "../src/lib/platform/find-workspaces";
import { withinCallerBudget } from "../src/lib/security/caller-budget";

let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!cond) failed += 1;
}

const A = "2001:db8:1234:5678:aaaa:bbbb:cccc:0001";
const B = "2001:db8:1234:5678:9999:8888:7777:0002"; // the same /64
const C = "2001:db8:1234:9999::1"; // another /64

console.log("Keys");
ok("an address after a name and a colon is grouped", groupKeyIps(`platform|signup:${A}`) === groupKeyIps(`platform|signup:${B}`), [groupKeyIps(`platform|signup:${A}`)]);
ok("  a whole part that is an address too", groupKeyIps(`t1|api|${A}`) === groupKeyIps(`t1|api|${B}`));
ok("  another /64 stays apart", groupKeyIps(`t1|api|${A}`) !== groupKeyIps(`t1|api|${C}`));
ok("  IPv4 is left as it is", groupKeyIps("t1|api|203.0.113.7") === "t1|api|203.0.113.7");
ok("  text without an address is left as it is", groupKeyIps("platform|find:all") === "platform|find:all");
ok("lockout: the old signup key form is grouped", lockoutKey(`platform|signup:${A}`) === lockoutKey(`platform|signup:${B}`));
ok("  the new one (caller:) too", lockoutKey(`platform|signup|caller:${A}`) === lockoutKey(`platform|signup|caller:${B}`));
ok("  iclock, app and api keys", lockoutKey(`iclock-miss|${A}`) === lockoutKey(`iclock-miss|${B}`) && lockoutKey(`t|app|${A}`) === lockoutKey(`t|app|${B}`));

console.log("Allowances");
const now = Date.now();
const site = (ip: string) => siteAllowance([{ key: `zz-limit-test|caller:${ip}`, max: 2 }], 60_000, now);
ok("siteAllowance: two from one /64 fit…", site(A) && site(B));
ok("  …the third, from a fresh address in it, doesn't", !site("2001:db8:1234:5678::ffff"));
ok("  another /64 has its own", site(C));
const budget = (ip: string) => withinCallerBudget([{ key: `zz-budget-test:${ip}`, max: 1 }], 60_000, now);
ok("withinCallerBudget: one from the /64…", budget(A));
ok("  …and the next address in it is refused", !budget(B));

console.log(failed ? `\n${failed} failed` : "\nAll limit-key checks passed.");
process.exit(failed ? 1 : 0);
