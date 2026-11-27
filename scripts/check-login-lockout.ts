/**
 * The sign-in lockout must count wrong authenticator codes all the way to a lock.
 *
 * Security audit, Nov 2026: checkCredentials (src/actions/auth.ts) — the sign-in form's
 * password pre-check — used to clear the account and caller lockout buckets as soon as the
 * password was right. Those are the same buckets authorize() (src/lib/auth.ts) counts wrong
 * authenticator codes under, so whoever held the password could try seven codes, run the
 * pre-check once to reset the count, and repeat for ever.
 *
 * Checked two ways, neither needing a database: the pre-check's source no longer clears the
 * buckets, and the lockout itself locks after MAX_FAILURES with no clear in between.
 *
 * And (security review, 15 Nov 2026 — RL-07): the eight are per (account + caller), the account is locked
 * everywhere only at ACCOUNT_WIDE_MAX_FAILURES, the same for authenticator codes, and reset asks per
 * (address + caller) with the address capped across callers at three times that.
 *
 *   npm run check:login-lockout
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNT_WIDE_MAX_FAILURES,
  clearFailures,
  lockoutState,
  MAX_FAILURES,
  perCallerLockKeys,
  recordFailure,
  resetLockouts,
  twoFactorLockKey,
} from "../src/lib/security/lockout";

let failures = 0;
function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}

console.log("\n— The password pre-check never clears the lockout —\n");

const source = readFileSync(join(__dirname, "../src/actions/auth.ts"), "utf8");
const start = source.indexOf("export async function checkCredentials");
const end = source.indexOf("\nexport ", start + 1);
const body = start >= 0 ? source.slice(start, end > 0 ? end : undefined) : "";
ok("checkCredentials is found", body.length > 0);
// Comments may mention the name; only a call counts.
const code = body.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
ok("checkCredentials does not call clearFailures", !/clearFailures\s*\(/.test(code));

const authLib = readFileSync(join(__dirname, "../src/lib/auth.ts"), "utf8");
const totpAt = authLib.indexOf("verifyTotpCode(");
const clearAt = authLib.indexOf("clearFailures(");
ok(
  "authorize() clears the buckets only after the authenticator code is checked",
  totpAt > 0 && clearAt > totpAt,
);

console.log("\n— Wrong codes add up to a lock —\n");

resetLockouts();
const keys = ["t1|account:someone@example.test", "t1|caller:203.0.113.9"];
for (let i = 0; i < MAX_FAILURES - 1; i++) recordFailure(keys);
ok(`${MAX_FAILURES - 1} wrong codes: not locked yet`, !lockoutState(keys).lockedOut);
// Formerly: checkCredentials ran here with the right password and wiped the count.
recordFailure(keys);
ok(`the ${MAX_FAILURES}th wrong code locks the account`, lockoutState(keys).lockedOut);
resetLockouts();

console.log("\n— Per account and caller (security review, 15 Nov 2026 — RL-07) —\n");

/** The keys sign-in builds (src/lib/auth.ts, src/actions/auth.ts) for one caller. */
const signInKeys = (address: string, caller: string | null) => [
  ...perCallerLockKeys(`t1|account:${address}`, caller),
  ...(caller ? [`t1|caller:${caller}`] : []),
];
const victim = "victim@example.test";
const callerA = "203.0.113.10";
const callerB = "198.51.100.20";

resetLockouts();
for (let i = 0; i < MAX_FAILURES; i++) recordFailure(signInKeys(victim, callerA));
ok(`${MAX_FAILURES} failures from caller A lock caller A`, lockoutState(signInKeys(victim, callerA)).lockedOut);
ok("…but not caller B, for the same account", !lockoutState(signInKeys(victim, callerB)).lockedOut);
ok("…and not the account everywhere", !lockoutState([`t1|account:${victim}`]).lockedOut);

resetLockouts();
const many = Array.from({ length: ACCOUNT_WIDE_MAX_FAILURES }, (_, i) => `192.0.2.${i + 1}`);
for (const caller of many.slice(0, -1)) recordFailure(signInKeys(victim, caller));
ok(`${ACCOUNT_WIDE_MAX_FAILURES - 1} failures from as many callers: nobody locked yet`, !lockoutState(signInKeys(victim, callerB)).lockedOut);
recordFailure(signInKeys(victim, many[many.length - 1]));
ok(`${ACCOUNT_WIDE_MAX_FAILURES} failures from many callers lock everyone out of the account`, lockoutState(signInKeys(victim, callerB)).lockedOut);
ok("…and only that account", !lockoutState(signInKeys("other@example.test", callerB)).lockedOut);

resetLockouts();
for (let i = 0; i < MAX_FAILURES - 1; i++) recordFailure(signInKeys(victim, callerA));
// What a complete sign-in clears: the plain-string keys, never the account-wide one.
clearFailures(signInKeys(victim, callerA).filter((key) => typeof key === "string"));
recordFailure(signInKeys(victim, callerA));
ok("a successful sign-in clears the (account + caller) count", !lockoutState(signInKeys(victim, callerA)).lockedOut);

resetLockouts();
const v6a = "2001:db8:1:2::1";
const v6b = "2001:db8:1:2::ffff";
for (let i = 0; i < MAX_FAILURES; i++) recordFailure(signInKeys(victim, v6a));
ok("an IPv6 caller is one caller per /64", lockoutState(signInKeys(victim, v6b)).lockedOut);

resetLockouts();
for (let i = 0; i < MAX_FAILURES; i++) recordFailure(signInKeys(victim, null));
ok(`no known caller: the account key alone locks at ${MAX_FAILURES}, as before`, lockoutState(signInKeys(victim, null)).lockedOut);
ok("…which is the account-wide key every caller checks", lockoutState(signInKeys(victim, callerB)).lockedOut);

resetLockouts();
const codeKeys = (caller: string) => perCallerLockKeys(twoFactorLockKey("t1", victim), caller);
for (let i = 0; i < MAX_FAILURES; i++) recordFailure(codeKeys(callerA));
ok("wrong codes: caller A is locked", lockoutState(codeKeys(callerA)).lockedOut);
ok("…caller B is not", !lockoutState(codeKeys(callerB)).lockedOut);
resetLockouts();
for (const caller of many) recordFailure(codeKeys(caller));
ok(`wrong codes from ${ACCOUNT_WIDE_MAX_FAILURES} callers lock the code everywhere`, lockoutState(codeKeys(callerB)).lockedOut);

resetLockouts();
const resetKeys = (caller: string) => perCallerLockKeys(`t1|reset:${victim}`, caller, 3 * MAX_FAILURES);
for (let i = 0; i < MAX_FAILURES; i++) recordFailure(resetKeys(callerA));
ok(`reset: ${MAX_FAILURES} asks from caller A stop caller A`, lockoutState(resetKeys(callerA)).lockedOut);
ok("…but the owner, elsewhere, can still ask", !lockoutState(resetKeys(callerB)).lockedOut);
resetLockouts();
for (let i = 0; i < 3 * MAX_FAILURES; i++) recordFailure(resetKeys(`192.0.2.${i + 1}`));
ok(`reset: ${3 * MAX_FAILURES} asks across callers stop the address everywhere`, lockoutState(resetKeys(callerB)).lockedOut);
resetLockouts();

const resetSource = readFileSync(join(__dirname, "../src/actions/password-reset.ts"), "utf8");
const actionSource = readFileSync(join(__dirname, "../src/actions/auth.ts"), "utf8");
ok("authorize() builds its keys with perCallerLockKeys", /perCallerLockKeys\(`\$\{tenantId\}\|account:/.test(authLib) && /perCallerLockKeys\(twoFactorLockKey\(/.test(authLib));
ok("checkCredentials builds its keys with perCallerLockKeys", /perCallerLockKeys\(`\$\{workspace\}\|account:/.test(actionSource));
ok("password reset builds its keys with perCallerLockKeys at 3×", /perCallerLockKeys\(`\$\{workspace\}\|reset:\$\{email\}`, ip, 3 \* MAX_FAILURES\)/.test(resetSource));

console.log(failures === 0 ? "\nAll login-lockout checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
