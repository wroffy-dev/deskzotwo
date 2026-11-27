/**
 * A one-time pass signs a browser in only when that browser means it.
 *
 * Security audit, Nov 2026: the Deskzo app's "app" pass was spent by the public /handoff page, which
 * spent any pass as soon as it opened. Spending checked only the workspace, the hash and the expiry, so
 * a colleague could send somebody /handoff?t=<their own pass> and sign that person's browser in as the
 * colleague (login CSRF). Now:
 *   - an "app" pass names the phone's device row, and is spent only by a browser holding that device's
 *     cookie (src/lib/platform/handoff-sign-in.ts), which the "handoff" sign-in reads from the request;
 *   - /handoff spends nothing on its own: it waits for "Continue", a POST from the page itself.
 *
 * A static check, so it needs no database (check:phone-app exercises the same rule against one).
 *
 *   npm run check:handoff-csrf
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

console.log("\n— One-time passes and the browser that spends them —\n");

const schema = read("prisma/control/schema.prisma");
const ticketModel = schema.slice(schema.indexOf("model PlatformHandoffTicket"), schema.indexOf("}", schema.indexOf("model PlatformHandoffTicket")));
ok("a pass can name the phone it was made for", /deviceId\s+String\?/.test(ticketModel));

const handoff = read("src/lib/platform/handoff.ts");
ok("an app pass must name its phone", /purpose === "app" && !options\.deviceId\) throw/.test(handoff));
ok("  and spending a pass gives back the phone it names", /deviceId: row\.deviceId/.test(handoff));

ok("the app's pages make their pass for the phone that opened them", /createHandoffTicket\(tenant\.id, person\.email, "app", \{ deviceId: phone\.userDeviceId \}\)/.test(read("src/lib/app/web-session.ts")));

const signIn = read("src/lib/platform/handoff-sign-in.ts");
const appBranch = signIn.slice(signIn.indexOf('pass.purpose === "app"'), signIn.indexOf('pass.purpose === "support"'));
ok("an app pass is spent only with the phone's device cookie", /holdsPhoneCookie\(pass\.deviceId, user\.id, presented\.deviceToken\)/.test(appBranch));
ok("  which is the device row's own secret, for that account, not revoked", /device\.tokenHash === hashDeviceToken\(deviceToken\)/.test(signIn) && /device\.userId !== userId/.test(signIn) && /REVOKED/.test(signIn));

ok("the handoff sign-in passes the browser's device cookie on", /handoffAccount\(ticket, tenant\.id, \{ deviceToken: await presentedDeviceToken\(request\) \}\)/.test(read("src/lib/auth.ts")));

const form = read("src/components/auth/handoff-form.tsx");
ok("/handoff no longer spends the pass when it opens", !/useEffect/.test(form));
ok("  it waits for Continue, a form the person submits", /<form[\s\S]*action=/.test(form) && /type="submit"/.test(form) && /handoffAction\(ticket, next\)/.test(form));

console.log(failures === 0 ? "\nAll handoff checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
