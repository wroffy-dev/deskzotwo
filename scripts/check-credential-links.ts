/**
 * Links that carry a credential are built on the platform subdomain, never on a custom domain.
 *
 * Security audit, Nov 2026: reset, setup and invitation links were built with tenantOrigin(), which
 * follows the request host and the workspace's primary domain. Staff can add, verify and make primary
 * a custom domain for any workspace from the console, so a reset token could be mailed to a host
 * somebody else controls and redeemed on the real workspace. credentialLinkOrigin()
 * (src/lib/tenancy/resolve.ts) always answers the workspace's own platform subdomain.
 *
 * A static check, so it needs no database: every line under src/ that builds a /reset-password link
 * must use credentialLinkOrigin, and none may use tenantOrigin.
 *
 *   npm run check:credential-links
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

let failures = 0;
function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}

const root = join(__dirname, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

console.log("\n— Reset, setup and invitation links —\n");

const builders: { file: string; line: number; text: string }[] = [];
for (const file of walk(join(root, "src"))) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((text, i) => {
      // A template literal that puts a token into a /reset-password URL.
      if (/\$\{[^}]*\}\/reset-password\?t=/.test(text)) builders.push({ file: relative(root, file), line: i + 1, text: text.trim() });
    });
}

ok("the reset-link builders are found", builders.length >= 4, `${builders.length}`);
for (const b of builders) {
  ok(`${b.file}:${b.line} uses credentialLinkOrigin`, b.text.includes("credentialLinkOrigin(") && !b.text.includes("tenantOrigin("), b.text);
}

const resolve = readFileSync(join(root, "src/lib/tenancy/resolve.ts"), "utf8");
const helper = resolve.slice(resolve.indexOf("export async function credentialLinkOrigin"));
ok("credentialLinkOrigin builds on subdomainHost, not on the request or primary host", /subdomainHost\(t\.slug\)/.test(helper) && !/primaryHost|requestHost/.test(helper.split("\n}")[0] ?? ""));

console.log(failures === 0 ? "\nAll credential-link checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
