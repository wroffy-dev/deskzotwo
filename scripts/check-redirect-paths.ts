/**
 * Redirect targets stay on this site.
 *
 * Security audit, Nov 2026: safeNext (src/lib/mail/connect-state.ts) refused only a leading "//" or "/\", and the
 * URL parser drops tab, CR and LF — so "/%09/evil.example" arrived as "//evil.example" and the mailbox connect flow
 * redirected off-site with new URL(next, origin). Now safeNext asks safeAppPath, both routes check the parsed URL's
 * origin, and /login's callbackUrl is held to safeLocalPath before it reaches signIn.
 *
 * Needs no database: the connect route runs with nobody signed in, the session and the workspace's address played.
 *
 *   npm run check:redirect-paths
 */
import Module from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const ORIGIN = "https://acme.deskzo.test";
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/session" || request.endsWith(`${path.sep}lib${path.sep}session`)) {
    return { currentUser: async () => null, requireUser: async () => null, refuseWhileViewingAs: async () => null, viewAsContext: async () => null };
  }
  if (request === "@/lib/tenancy/resolve" || request.endsWith(`${path.sep}tenancy${path.sep}resolve`)) {
    return { tenantOrigin: async () => ORIGIN, currentTenant: async () => ({ id: "t", slug: "acme" }), currentTenantOrNull: async () => null };
  }
  // The control plane's generated client isn't needed to work out a redirect, and may not be generated where this runs.
  if (request === "@deskzo/control-client" || request === "@prisma/client") {
    const anything: unknown = new Proxy(function () {}, { get: (_t, key) => (key === "then" ? undefined : anything), construct: () => anything as object, apply: () => anything });
    return new Proxy({}, { get: (_t, key) => (key === "__esModule" ? false : anything) });
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { safeNext, sameOriginRedirect } = require("../src/lib/mail/connect-state") as typeof import("../src/lib/mail/connect-state");
  const { safeLocalPath, safeAppPath } = require("../src/lib/app/paths") as typeof import("../src/lib/app/paths");
  const connect = require("../src/app/api/mail/[provider]/connect/route") as typeof import("../src/app/api/mail/[provider]/connect/route");
  /* eslint-enable @typescript-eslint/no-require-imports */

  console.log("\n— Where a redirect may go —\n");
  const tricks = ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/a\\b", "/\\evil.example", "//evil.example", "https://evil.example", "/ /x", "/\u007f/x", ""];
  ok("safeNext refuses every way off the site", tricks.every((p) => safeNext(p) === "/profile"), tricks.filter((p) => safeNext(p) !== "/profile"));
  ok("  and keeps an ordinary page, query and all", safeNext("/signatures/manage?tab=connection") === "/signatures/manage?tab=connection" && safeNext("/profile") === "/profile");
  ok("safeLocalPath refuses the same", tricks.every((p) => safeLocalPath(p) === null));
  ok("  but allows /link/confirm, which signing in comes back to", safeLocalPath("/link/confirm") === "/link/confirm" && safeAppPath("/link/confirm") === null);
  ok("sameOriginRedirect keeps an on-site path", sameOriginRedirect("/profile?mailbox=connected", ORIGIN).href === `${ORIGIN}/profile?mailbox=connected`);
  ok("  and turns anything off-site into Profile", sameOriginRedirect("//evil.example/x", ORIGIN).href === `${ORIGIN}/profile` && sameOriginRedirect("/\t/evil.example", ORIGIN).origin === ORIGIN);

  const go = await connect.GET(new NextRequest(`${ORIGIN}/api/mail/microsoft/connect?next=%2F%09%2Fexample.org`), { params: Promise.resolve({ provider: "microsoft" }) });
  const location = new URL(go.headers.get("location") ?? "about:blank");
  ok("the connect route with next=/%09/example.org redirects on this site", location.origin === ORIGIN, location.href);
  ok("  to sign in, coming back to Profile", location.pathname === "/login" && location.searchParams.get("callbackUrl") === "/profile", location.href);

  const root = join(__dirname, "..");
  const callback = readFileSync(join(root, "src/app/api/mail/[provider]/callback/route.ts"), "utf8");
  ok("the callback checks `next` again, and the redirect's origin", /const next = safeNext\(saved\?\.next\);/.test(callback) && /sameOriginRedirect\(/.test(callback) && !/NextResponse\.redirect\(new URL\(/.test(callback));
  const login = readFileSync(join(root, "src/app/(auth)/login/page.tsx"), "utf8");
  const action = readFileSync(join(root, "src/actions/auth.ts"), "utf8");
  ok("/login holds callbackUrl to safeLocalPath", /const callbackUrl = safeLocalPath\(params\.callbackUrl\) \?\? "\/dashboard";/.test(login));
  ok("  and so does the sign-in action, before signIn", /redirectTo: safeLocalPath\(input\.callbackUrl\) \?\? "\/dashboard",/.test(action));

  console.log(failures === 0 ? "\nAll redirect-path checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
