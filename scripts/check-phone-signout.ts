/**
 * Revoking a device, by any path, ends every session that began on it.
 *
 * Security audit, Nov 2026: unpairPhone (src/lib/app/pairing.ts) — what signing a phone out does, from
 * Settings or from the phone — only marked the device revoked. The browser sessions the phone had opened
 * stayed open, and the gate judged the device by the cookie sent, so a browser that dropped the device
 * cookie was given a new device and went on. Now unpairPhone ends those sign-ins as decideDevice does, and
 * the gate ends any session whose own device is revoked or rejected, whatever cookie comes with it.
 *
 * A static check, so it needs no database (check:phone-app exercises the same rules against one).
 *
 *   npm run check:phone-signout
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

console.log("\n— A revoked device's sessions —\n");

const unpair = body(read("src/lib/app/pairing.ts"), "export async function unpairPhone(");
ok("signing a phone out revokes its device", /status: "REVOKED"/.test(unpair));
ok("  ends every sign-in that began on it", /signIn\.updateMany\(\{ where: \{ deviceId: phone\.deviceId, endedAt: null \}, data: \{ endedAt: now \} \}\)/.test(unpair));
ok("  and drops the gate's cached verdicts", /clearAccessCache\(\)/.test(unpair));

const gate = read("src/lib/access/gate.ts");
ok("the gate reads the status of the device a session began on", /db\.signIn\.findUnique\(\{ where: \{ sid: input\.sid \}, select: \{[^}]*device: \{ select: \{ status: true \} \}/.test(gate));
const revoked = body(gate, "function signedInOnRevokedDevice(");
ok("  a revoked or rejected one ends the session", /status === "REVOKED" \|\| status === "REJECTED"/.test(revoked));
ok("  as part of what ends a session, whatever cookie is sent", /sessionEnded: [^\n]*signedInOnRevokedDevice\(signIn\)/.test(gate));

console.log(failures === 0 ? "\nAll phone sign-out checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
