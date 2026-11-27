/**
 * Biometric uploads are taken only from a terminal's address list, or from any address when HR says so.
 *
 * Security audit, Nov 2026: /iclock believed the SN in the query string — printed on the device — and a terminal's
 * address list was empty by default, which meant any address. Anybody who knew a serial could post ATTLOG punches
 * that became attendance days. Now a terminal with no list has its uploads refused unless HR has ticked "accept
 * from any address" (BiometricDevice.acceptAnyAddress, off by default; terminals already sending were carried over
 * with it on, and Biometric warns about each).
 *
 * A static check, so it needs no database (check:biometric-devices exercises the same rule against one).
 *
 *   npm run check:iclock-uploads
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}

const root = join(__dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

console.log("\n— Biometric uploads —\n");

const schema = read("prisma/schema.prisma");
const model = schema.slice(schema.indexOf("model BiometricDevice"), schema.indexOf("@@map(\"biometric_devices\")"));
ok("a terminal has an explicit 'accept from any address', off by default", /acceptAnyAddress Boolean @default\(false\)/.test(model));

const migrations = readdirSync(join(root, "prisma/migrations")).filter((d) => d.endsWith("_biometric_accept_any_address"));
const sql = migrations[0] ? read(`prisma/migrations/${migrations[0]}/migration.sql`) : "";
ok("a migration adds it", /ADD COLUMN "acceptAnyAddress" BOOLEAN NOT NULL DEFAULT false/.test(sql));
ok("  and carries terminals already sending with no list over, switched on", /SET "acceptAnyAddress" = true WHERE cardinality\("allowedIps"\) = 0/.test(sql));

const route = read("src/app/api/biometric/iclock/[[...path]]/route.ts");
const post = route.slice(route.indexOf("async function handlePost("));
const refusal = post.search(/if \(device\.allowedIps\.length === 0 && !device\.acceptAnyAddress\) \{/);
const read403 = post.indexOf("readTextWithin(");
ok("an upload from a terminal with no list and no opt-in is refused", refusal >= 0 && /return text\([^)]*, 403\);/.test(post.slice(refusal, refusal + 500)));
ok("  before its body is read", refusal >= 0 && read403 > refusal, `refusal at ${refusal}, body read at ${read403}`);

const action = read("src/actions/biometric.ts");
ok("HR can tick it when saving a terminal", /acceptAnyAddress\?: boolean;/.test(action) && /typeof input\.acceptAnyAddress === "boolean" \? \{ acceptAnyAddress: input\.acceptAnyAddress \}/.test(action));
ok("  and the audit log says which", /row\.acceptAnyAddress \? "accepted from any address" : "uploads refused until it has an address list"/.test(action));

const ui = read("src/components/hr/biometric-devices.tsx");
ok("Biometric warns about every terminal accepted from any address", /d\.acceptAnyAddress \?/.test(ui) && /anyone who knows the serial can send punches/.test(ui));
ok("  and about every terminal whose punches are refused", /punches refused — give it an address list/.test(ui));
ok("  the form asks explicitly, and explains TRUST_PROXY", /Accept this terminal from any address/.test(ui) && /TRUST_PROXY=1/.test(ui));

console.log(failures === 0 ? "\nAll iclock upload checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
