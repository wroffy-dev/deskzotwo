/**
 * Ending a session is durable, and signing out ends it.
 *
 * Security audit, Nov 2026:
 *   - the access gate treated a sid with no SignIn row as a live session, and rows go (a workspace reset,
 *     the retention purge, a restore, a sign-in whose row couldn't be written) — each brought ended
 *     sessions back to life;
 *   - signing out only logged LOGOUT, so a copied cookie still worked afterwards.
 * Now a sid must have its row, a browser session must have a sid, a sign-in fails without its row,
 * signing out ends the row, a restore ends every row it brings back, and sessions last a day unused.
 *
 * A static check, so it needs no database (check:access exercises the same rules against one).
 *
 *   npm run check:session-revocation
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
const body = (source: string, declaration: string) => {
  const start = source.indexOf(declaration);
  if (start < 0) return "";
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};

console.log("\n— Sessions: ended means ended —\n");

const gate = read("src/lib/access/gate.ts");
const gone = body(gate, "function sessionRowGone(");
ok("the gate ends a session whose sid has no SignIn row", /if \(input\.sid\) return !signIn;/.test(gone));
ok("  and a browser session with no sid", /return input\.session === true;/.test(gone));
ok("  as part of what ends a session", /sessionEnded: [^\n]*sessionRowGone\(input, signIn\)/.test(gate));
ok("the proxy checks pages as a browser session", /sid: sessionUser\.sid \?\? null,\s*session: true,/.test(read("src/proxy.ts")));
ok("auth() refuses a session without a sid", /if \(!session\.user\.sid\) return null;/.test(body(read("src/lib/auth.ts"), "export async function auth(")));

const record = read("src/lib/access/record.ts");
const recordSignIn = body(record, "export async function recordSignIn(");
ok("a sign-in whose row can't be written fails", /recorded = true;/.test(recordSignIn) && /if \(!recorded\) throw err;/.test(recordSignIn));
ok("  and one for an account that isn't there fails too", /if \(!user\) throw new Error/.test(recordSignIn));

const endSignIn = body(record, "export async function endSignIn(");
ok("endSignIn ends the sign-in and drops the gate's verdicts", /db\.signIn\.updateMany\(\{ where: \{ sid, endedAt: null \}, data: \{ endedAt: new Date\(\) \} \}\)/.test(endSignIn) && /clearAccessCache\(\)/.test(endSignIn));
const auth = read("src/lib/auth.ts");
const signOutEvent = auth.slice(auth.indexOf("signOut: async (message"), auth.indexOf("signOut: async (message") + 1200);
ok("signing out calls endSignIn with the token's sid", /if \(token\?\.sid\) await endSignIn\(token\.sid\);/.test(signOutEvent));

ok("a session lasts a day unused, set explicitly", /SESSION_MAX_AGE_SECONDS = 24 \* 60 \* 60/.test(read("src/lib/session-lifetime.ts")) && /maxAge: SESSION_MAX_AGE_SECONDS/.test(read("src/lib/auth-session.ts")));
ok("the retention purge keeps an open sign-in a session could still be using", /lastSeenAt: \{ lt: idleBefore \}/.test(read("src/lib/security/retention.ts")) && /SESSION_MAX_AGE_SECONDS/.test(read("src/lib/security/retention.ts")));
ok("a restore ends every sign-in the backup brought back", /db\.signIn\.updateMany\(\{ where: \{ endedAt: null \}, data: \{ endedAt: new Date\(\) \} \}\)/.test(read("scripts/restore-worker.ts")));

console.log(failures === 0 ? "\nAll session-revocation checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
