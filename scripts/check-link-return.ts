/**
 * A linked sign-in's completion token only goes back to the source's platform subdomain.
 *
 * Security audit, Nov 2026: wayBack (src/lib/platform/linked/intents.ts) answered the host the person
 * asked from, or the source's primary host — either can be a custom domain whose DNS the source
 * workspace's owner controls — and proveLinkIntent puts the completion token in the URL to it. That
 * owner could catch it and finish a link to somebody else's account. wayBack now answers
 * subdomainHost(source.slug) only, and startLinkingWorkspace (src/actions/linked-sign-in.ts) refuses
 * any other host, so the `link` cookie that finishes it is set there too.
 *
 * A static check, so it needs no database (check:linked-signin exercises the same rule against one).
 *
 *   npm run check:link-return
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}

const root = join(__dirname, "..");
const intents = readFileSync(join(root, "src/lib/platform/linked/intents.ts"), "utf8");
const actions = readFileSync(join(root, "src/actions/linked-sign-in.ts"), "utf8");
const body = (source: string, declaration: string) => {
  const start = source.indexOf(declaration);
  if (start < 0) return "";
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};

console.log("\n— Where a link's completion goes back to —\n");

const way = body(intents, "function wayBack(");
ok("wayBack is found", way !== "");
ok("  it answers the source's platform subdomain", /subdomainHost\(source\.slug\)/.test(way));
ok("  and never a host from the request, the registry's host lookup or the primary host", !/tenantForHost|primaryHost|originOf|hostOf/.test(way));

const prove = body(intents, "export async function proveLinkIntent(");
ok("the completion URL is built on wayBack", /const back = wayBack\(source\);[\s\S]*\$\{back\.origin\}\/link\/complete#c=/.test(prove));
ok("the intent records wayBack as its origin, not the origin it was given", /const sourceOrigin = wayBack\(source\)\.origin;/.test(intents) && !/wayBack\(input\.origin/.test(intents));

const start = body(actions, "export async function startLinkingWorkspace(");
const refusal = start.search(/if \(at\.host !== own\) return \{ ok: false/);
const create = start.indexOf("createLinkIntent(");
ok("starting a link is refused on any host but the workspace's platform subdomain", /const own = subdomainHost\(at\.tenant\.slug\);/.test(start) && refusal >= 0);
ok("  before anything is asked or made", refusal >= 0 && create > refusal, `refusal at ${refusal}, create at ${create}`);
ok("  and the origin it passes on is that subdomain's", /origin: `\$\{protocolFor\(own\)\}:\/\/\$\{own\}`/.test(start) && !/tenantOrigin\(/.test(start));

console.log(failures === 0 ? "\nAll link-return checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
