/**
 * Every page answers for the person being viewed (owner, 25 Nov 2026 — "new ticket button is not showing to anyone").
 *
 * While somebody views as somebody else there are two accounts: the one signed in (`auth()`), and the one being viewed
 * (`requireUser()` / `currentUser()`, src/lib/session.ts). A page that asked the first was wrong both ways — with
 * `hasEffectivePermission` it hid what the person may do from everybody viewed, and with `can` it offered the viewer's
 * own rights as theirs.
 *
 *   1. No page or component reads `auth()`, but for those listed here with why they must.
 *   2. The Tickets page, drawn while the super admin views somebody: New ticket for whoever may create tickets, and not
 *      for whoever mayn't.
 *
 * Fixtures are named ZZVIEWAS / @zzviewas-check.invalid and removed in a finally; the super admin is only read.
 *
 *   npm run check:view-as-pages
 */
import "dotenv/config";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";

const TAG = "ZZVIEWAS";
const MAIL = "@zzviewas-check.invalid";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

/** Where the account really signed in is the question, and why. */
const SIGNED_IN: Record<string, string> = {
  "src/app/(auth)/access/page.tsx": "the access gate, before anybody is let in",
  "src/app/(auth)/link/confirm/page.tsx": "linking one's own accounts, refused while viewing as",
  "src/app/(auth)/link/start/page.tsx": "linking one's own accounts, refused while viewing as",
  "src/app/(dashboard)/layout.tsx": "the shell, which shows the viewed person and says who is viewing",
  "src/app/(dashboard)/profile/page.tsx": "how this very session was signed in",
  "src/app/(tv)/tv/page.tsx": "a TV screen, whether anybody is signed in",
  "src/app/(tv)/tv/wins/page.tsx": "a TV screen, whether anybody is signed in",
};

type Person = { id: string; name: string; email: string; role: string };
let signedIn: Person | null = null;
let viewed: Person | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") return { cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() };
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/tickets",
      useSearchParams: () => new URLSearchParams(),
      notFound: () => {
        throw new Error("NOT_FOUND");
      },
      redirect: (to: string) => {
        throw new Error(`REDIRECT to ${to}`);
      },
    };
  }
  if (request === "@/lib/auth") return { auth: async () => (signedIn ? { user: { ...signedIn, sid: `${TAG}-sid` } } : null), signIn: async () => {}, signOut: async () => {}, handlers: {} };
  if (request === "@/lib/session" || request.endsWith("/lib/session")) {
    class UnauthorizedError extends Error {}
    const me = () => viewed ?? signedIn;
    return {
      UnauthorizedError,
      requireUser: async () => {
        const u = me();
        if (!u) throw new UnauthorizedError("signed out");
        return u;
      },
      currentUser: async () => me(),
      viewAsContext: async () => (viewed ? { user: viewed } : null),
      refuseWhileViewingAs: async () => (viewed ? "Not while viewing as somebody else." : null),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

function* files(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.tsx$/.test(e.name)) yield p;
  }
}

async function main() {
  section("1. Who the pages ask about");
  const reading = [...files("src/app"), ...files("src/components")]
    .map((f) => f.split(path.sep).join("/"))
    .filter((f) => /import\s*\{[^}]*\bauth\b[^}]*\}\s*from\s*"@\/lib\/auth"/.test(fs.readFileSync(f, "utf8")));
  const unexpected = reading.filter((f) => !(f in SIGNED_IN));
  ok("no page or component asks the signed-in account instead of the viewed person", unexpected.length === 0, `${unexpected.join(", ")} — use requireUser() or currentUser() from @/lib/session, or list it here with why`);
  const gone = Object.keys(SIGNED_IN).filter((f) => !reading.includes(f));
  ok("  and every page listed here still does", gone.length === 0, gone);

  section("2. The Tickets page, viewing as somebody");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
  const TicketsPage = (require("../src/app/(dashboard)/tickets/page") as { default: (p: { searchParams: Promise<Record<string, string>> }) => Promise<unknown> }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */
  const cleanup = async () => {
    const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  };
  await cleanup();
  try {
    const admin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true, role: true } });
    if (!admin) throw new Error("no super admin");
    const mk = async (local: string, create: boolean) => {
      const u = await db.user.create({ data: { name: `${TAG} ${local}`, email: `${local}${MAIL}`, role: "SUPPORT", passwordHash: "zz-fixture-placeholder" }, select: { id: true, name: true, email: true, role: true } });
      // Their own answers, whatever this workspace's Support role says.
      for (const [permission, allowed] of [["tickets.view", true], ["section.helpdesk", true], ["tickets.create", create]] as const)
        await db.userPermission.create({ data: { userId: u.id, permission, allowed, grantedById: admin.id } });
      return u;
    };
    const may = await mk("may", true);
    const mayNot = await mk("maynot", false);
    signedIn = admin;
    const page = async (person: Person | null) => {
      viewed = person;
      return renderHtml(await TicketsPage({ searchParams: Promise.resolve({ q: `${TAG}-none` }) }));
    };
    const asMay = await page(may);
    ok("somebody who may create tickets: New ticket is there", asMay.includes('href="/tickets/new"'), asMay.slice(0, 300));
    const asMayNot = await page(mayNot);
    ok("  somebody who mayn't: it isn't — though the viewer may", !asMayNot.includes('href="/tickets/new"') && asMayNot.includes("total"));
    const asSelf = await page(null);
    ok("  as themselves, the super admin: there", asSelf.includes('href="/tickets/new"'));
    viewed = null;
    signedIn = may;
    ok("  and signed in as the person, not viewing: there", (await page(null)).includes('href="/tickets/new"'));
  } finally {
    signedIn = viewed = null;
    await cleanup();
    ok("the fixtures are gone", (await db.user.count({ where: { email: { endsWith: MAIL } } })) === 0);
  }
  console.log(failures === 0 ? `\nAll ${passes} view-as page checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
