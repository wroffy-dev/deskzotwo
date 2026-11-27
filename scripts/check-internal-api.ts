/**
 * The CRM's internal API, the one way the separate admin app controls the CRM (docs/internal-api.md):
 * the signature, the replay guard, the codec, where it answers, and what it can be asked to do.
 *
 * No database: the pieces are pure, and the operation table is read as source.
 *
 *   npm run check:internal-api
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { decode, encode } from "../src/lib/internal-api/codec";
import { internalApiReachable } from "../src/lib/internal-api/gate";
import { MAX_SKEW_MS, acceptedSecrets, sign, signaturesMatch, spendNonce } from "../src/lib/internal-api/signing";

let failures = 0;
function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}
const root = join(__dirname, "..");

console.log("\n— Signature —\n");
{
  const secret = randomBytes(32).toString("hex");
  const base = { method: "POST", path: "/api/internal/v1/rpc", ts: String(Date.now()), nonce: randomBytes(16).toString("hex"), actor: "eyJpZCI6IngifQ", body: '{"op":"x","args":[]}' };
  const sig = sign(secret, base);
  ok("the same call signs the same", signaturesMatch(sig, sign(secret, base)));
  for (const field of ["method", "path", "ts", "nonce", "actor", "body"] as const) {
    ok(`changing the ${field} breaks it`, !signaturesMatch(sig, sign(secret, { ...base, [field]: base[field] + "1" })));
  }
  ok("another secret does not verify", !signaturesMatch(sig, sign(randomBytes(32).toString("hex"), base)));
  ok("a different length is refused without throwing", !signaturesMatch(sig, sig.slice(1)));
  ok("the skew window is a minute", MAX_SKEW_MS === 60_000);
}

console.log("\n— Secrets —\n");
{
  ok("no secret, nothing accepted", acceptedSecrets({}).size === 0);
  ok("a short secret is refused", acceptedSecrets({ DESKZO_INTERNAL_API_SECRET: "short" }).size === 0);
  const two = acceptedSecrets({ DESKZO_INTERNAL_API_SECRET: "a".repeat(40), DESKZO_INTERNAL_API_KEY_ID: "k2", DESKZO_INTERNAL_API_PREVIOUS_SECRET: "b".repeat(40), DESKZO_INTERNAL_API_PREVIOUS_KEY_ID: "k1" });
  ok("the current and previous secrets while rotating", two.get("k2") === "a".repeat(40) && two.get("k1") === "b".repeat(40));
  ok("the key id defaults to k1", acceptedSecrets({ DESKZO_INTERNAL_API_SECRET: "a".repeat(40) }).has("k1"));
}

console.log("\n— Replay —\n");
{
  const n = randomBytes(16).toString("hex");
  ok("a nonce is spent once", spendNonce(n) === true);
  ok("and refused the second time", spendNonce(n) === false);
}

console.log("\n— Codec —\n");
{
  const when = new Date("2026-11-27T10:00:00.000Z");
  const value = { at: when, n: 5n, buf: Buffer.from("hi"), list: [when, null, "x"], skip: undefined, nested: { ok: true } };
  const back = decode(JSON.parse(JSON.stringify(encode(value)))) as typeof value;
  ok("a Date comes back a Date", back.at instanceof Date && back.at.getTime() === when.getTime());
  ok("a BigInt comes back a BigInt", back.n === 5n);
  ok("bytes come back bytes", Buffer.isBuffer(back.buf) && back.buf.toString() === "hi");
  ok("in arrays too", back.list[0] instanceof Date && back.list[1] === null);
  ok("undefined is left out", !("skip" in back));
  ok("plain values unchanged", back.nested.ok === true);
}

console.log("\n— Where it answers —\n");
{
  const env = { DESKZO_INTERNAL_API: "on", DESKZO_INTERNAL_API_HOST: "crm-internal:3000" } as NodeJS.ProcessEnv;
  const h = (pairs: Record<string, string>) => new Headers(pairs);
  ok("on its host, from the private network", internalApiReachable("crm-internal:3000", h({ "x-forwarded-for": "10.0.1.5" }), env));
  ok("not when switched off", !internalApiReachable("crm-internal:3000", h({ "x-forwarded-for": "10.0.1.5" }), { ...env, DESKZO_INTERNAL_API: "" }));
  ok("not without a host set", !internalApiReachable("crm-internal:3000", h({ "x-forwarded-for": "10.0.1.5" }), { DESKZO_INTERNAL_API: "on" } as NodeJS.ProcessEnv));
  ok("not on a workspace's address", !internalApiReachable("acme.deskzo.com", h({ "x-forwarded-for": "10.0.1.5" }), env));
  ok("not from the internet", !internalApiReachable("crm-internal:3000", h({ "x-forwarded-for": "203.0.113.7" }), env));
  ok("not through a CDN", !internalApiReachable("crm-internal:3000", h({ "x-forwarded-for": "10.0.1.5", "cf-connecting-ip": "10.0.1.5" }), env));
}

console.log("\n— What it can be asked —\n");
{
  const ops = readFileSync(join(root, "src/lib/internal-api/ops.ts"), "utf8");
  for (const name of ["consoleAddStaff", "consoleSetStaffRole", "consoleResetStaffTwoFactor", "consoleNewSetupLink", "consoleReactivateStaff", "consoleSetStaffTwoFactor"]) {
    ok(`${name} stays with the admin app`, new RegExp(`"${name}"`).test(ops));
  }
  ok("staff sign-in is never an operation", !/actions\/platform\/staff-auth/.test(ops));
  ok("the public site's actions are never operations", !/actions\/platform\/(site|signup|partner-site|live-demo)"/.test(ops));
  const route = readFileSync(join(root, "src/app/api/internal/v1/rpc/route.ts"), "utf8");
  ok("the route checks the gate itself too", route.includes("internalApiReachable("));
  ok("the route checks loader roles", route.includes('op.kind === "loader" && !op.roles.includes(actor.role)'));
  ok("the route spends the nonce after the signature", route.indexOf("signaturesMatch(") < route.indexOf("spendNonce("));
  const proxy = readFileSync(join(root, "src/proxy.ts"), "utf8");
  ok("the proxy gates /api/internal before any workspace lookup", proxy.indexOf("INTERNAL_API_PATH.test(pathname)") > 0 && proxy.indexOf("INTERNAL_API_PATH.test(pathname)") < proxy.indexOf("await tenantForKind(kind)"));
  const session = readFileSync(join(root, "src/lib/platform/staff-session.ts"), "utf8");
  ok("requireStaff sees the admin app's staff member", session.includes("internalActor()"));
  const stepUp = readFileSync(join(root, "src/lib/platform/step-up.ts"), "utf8");
  ok("step-up codes are vouched for by the admin app, inside the window", stepUp.includes("actor.stepUpAt") && stepUp.includes("STEP_UP_WINDOW_MS"));
}

console.log(failures ? `\n${failures} failed.\n` : "\nAll passed.\n");
process.exit(failures ? 1 : 0);
