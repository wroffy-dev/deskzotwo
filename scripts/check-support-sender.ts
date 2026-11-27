/**
 * A support email counts as from its From address only when sender authentication backs it.
 *
 * Security audit, Nov 2026: receiveEmail took the From header — whatever the sender typed — as who sent it, so a
 * forged From could add a REPLY to a customer's ticket and open it again, or file a ticket under the contact's
 * company. Now the mail receiver sends Cloudflare's SPF/DKIM/DMARC results, signed, and an email whose From isn't
 * backed by DMARC or an aligned DKIM signature waits in the Support inbox, flagged "Unverified sender".
 *
 * A static check, so it needs no database (check:support-email exercises the same rule against one).
 *
 *   npm run check:support-sender
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

async function main() {
  console.log("\n— Who a support email is from —\n");

  const worker = read("deploy/cloudflare/inbound-email-worker.js");
  ok("the mail receiver sends Cloudflare's authentication results, inside the signed body", /auth: authResults\(raw\)/.test(worker) && /JSON\.stringify\(\{ recipient: message\.to, sender: message\.from, raw: base64\(raw\), auth: authResults\(raw\) \}\)/.test(worker));
  ok("  read from the topmost results header only, and only when it is Cloudflare's", /lines\.find\(\(l\) => l\.toLowerCase\(\)\.startsWith/.test(worker) && /if \(authservId !== "mx\.cloudflare\.net"\) return null;/.test(worker));

  const inbound = read("src/lib/support-mail/inbound.ts");
  ok("the door checks the sender before receiving the email", /const check = checkSender\(readAuth\(payload\.auth\), mail\.from\?\.address \?\? ""\);/.test(inbound) && /receiveEmail\(\{ \.\.\.mail, senderVerified: check\.verified, senderCheck: check\.why \}\)/.test(inbound));

  const receive = read("src/lib/support-mail/receive.ts");
  const gate = receive.search(/if \(mail\.senderVerified !== true\) \{/);
  const reply = receive.indexOf("// ── 3. A reply");
  const contact = receive.indexOf("// ── 4. A new ticket");
  ok("receiveEmail sends an unverified sender to the inbox", gate >= 0 && /return waiting\(`Unverified sender: /.test(receive.slice(gate, gate + 400)));
  ok("  before it can be a reply or open a ticket again", gate >= 0 && reply > gate);
  ok("  and before it is matched to a contact or a company", gate >= 0 && contact > gate);
  ok("every caller has to say whether the sender is verified", /export type SenderTrust = \{ senderVerified: boolean; senderCheck: string \};/.test(read("src/lib/support-mail/parse.ts")) && /mail: IncomingEmail & SenderTrust/.test(receive));

  // The rule itself, run.
  const path = join(root, "src/lib/support-mail/sender-auth.ts");
  if (!read("src/lib/support-mail/sender-auth.ts")) {
    ok("sender-auth.ts exists", false);
  } else {
    // A file URL, not a path: on Windows a path's drive letter reads as a URL scheme to the ESM loader.
    const sa = (await import(pathToFileURL(path).href)) as typeof import("../src/lib/support-mail/sender-auth");
    const cf = (over: Record<string, unknown>) => sa.readAuth({ authservId: "mx.cloudflare.net", dmarc: null, dmarcDomain: null, dkim: [], spf: null, ...over });
    ok("DMARC pass for the From domain is verified", sa.checkSender(cf({ dmarc: "pass", dmarcDomain: "acme.test" }), "a@acme.test").verified);
    ok("an aligned DKIM pass is verified", sa.checkSender(cf({ dkim: [{ result: "pass", domain: "acme.test" }] }), "a@sub.acme.test").verified);
    ok("SPF alone is not", !sa.checkSender(cf({ spf: "pass" }), "a@acme.test").verified);
    ok("a DKIM pass for another domain is not", !sa.checkSender(cf({ dkim: [{ result: "pass", domain: "evil.test" }] }), "a@acme.test").verified);
    ok("results from another server are not", !sa.checkSender(sa.readAuth({ authservId: "mx.evil.test", dmarc: "pass", dmarcDomain: "acme.test", dkim: [] }), "a@acme.test").verified);
    ok("no results are not", !sa.checkSender(null, "a@acme.test").verified);
  }

  console.log(failures === 0 ? "\nAll support sender checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
