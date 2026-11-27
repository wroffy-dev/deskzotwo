/**
 * check:chat-icon — a chat group's picture (owner, 26 Oct 2026 — setGroupIcon in src/actions/chat.ts).
 *
 *   1. Its admins set it: a raster image, never SVG, 96 KB at most; a member who isn't an admin can't.
 *   2. The chat list carries when it was set, so the picture's address changes with it; a group has it, a
 *      direct chat never does.
 *   3. The picture is served to the group's members only.
 *   4. Removed by an admin: gone from the list, the route, and said in the chat.
 *   5. A workspace not migrated yet: the list still loads, with no pictures.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:chat-icon
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
// The image route asks NextAuth who's signed in: the same actor.
const authModule = { auth: async () => (actor ? { user: { id: actor.id, name: actor.name, email: actor.email } } : null) };
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
  ["@/lib/auth", authModule],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/auth"), authModule],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

// A 1×1 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_chaticon`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const chat = require("../src/actions/chat") as typeof import("../src/actions/chat");
    const { summariesFor } = require("../src/lib/chat/server") as typeof import("../src/lib/chat/server");
    const route = require("../src/app/api/chat/icons/[id]/route") as typeof import("../src/app/api/chat/icons/[id]/route");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-chat.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const asha = await person("Asha Zz", { role: "ADMIN", isSuperAdmin: true });
    const bala = await person("Bala Zz");
    const outsider = await person("Chen Zz");
    const asActor = (u: { id: string; name: string; email: string | null; role: string }): Actor => ({ id: u.id, name: u.name, email: u.email!, role: u.role });
    const as = <T,>(who: { id: string; name: string; email: string | null; role: string }, work: () => Promise<T>) => {
      const before = actor;
      actor = asActor(who);
      return work().finally(() => {
        actor = before;
      });
    };

    const made = await as(asha, () => chat.createGroupChat({ name: "Zz Sales", memberIds: [bala.id] }));
    ok("Asha makes a group with Bala — she's its admin", made.ok, made.ok ? "" : made.error);
    if (!made.ok) throw new Error("no group");
    const chatId = made.data.chatId;

    section("1. Setting the picture");
    ok("Bala, a member but not an admin, can't", !(await as(bala, () => chat.setGroupIcon(chatId, PNG))).ok);
    const svg = await as(asha, () => chat.setGroupIcon(chatId, "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="));
    ok("  an SVG is refused", !svg.ok && svg.error.includes("SVG"));
    const huge = await as(asha, () => chat.setGroupIcon(chatId, `data:image/png;base64,${"A".repeat(140_000)}`));
    ok("  nor one over 96 KB", !huge.ok && huge.error.includes("96"));
    ok("  nor something that isn't an image", !(await as(asha, () => chat.setGroupIcon(chatId, "hello"))).ok);
    const set = await as(asha, () => chat.setGroupIcon(chatId, PNG));
    ok("Asha sets it", set.ok && (await db.chatIcon.count({ where: { chatId } })) === 1);
    ok("  and the chat says so", (await db.chatMessage.count({ where: { chatId, kind: "SYSTEM", body: { contains: "changed the group's picture" } } })) === 1);

    section("2. The list");
    const [forBala] = await summariesFor(bala.id, [chatId]);
    ok("Bala's list carries when it was set", !!forBala?.iconUpdatedAt);
    const direct = await as(asha, () => chat.startDirectChat(bala.id));
    const directId = direct.ok ? (direct.data as { chatId: string }).chatId : null;
    if (directId) await db.chat.update({ where: { id: directId }, data: { lastMessageAt: new Date() } });
    const directSummary = directId ? (await summariesFor(asha.id, [directId]))[0] : null;
    ok("  a direct chat never has one", !!directSummary && directSummary.iconUpdatedAt === null, directSummary);

    section("3. Who sees it");
    const get = (who: Actor | null) => {
      const before = actor;
      actor = who;
      return route.GET(new Request(`http://localhost:3000/api/chat/icons/${chatId}`), { params: Promise.resolve({ id: chatId }) }).finally(() => {
        actor = before;
      });
    };
    const seen = await get(asActor(bala));
    ok("a member: the image", seen.status === 200 && seen.headers.get("content-type") === "image/png" && seen.headers.get("cache-control")?.startsWith("private") === true);
    ok("  somebody not in the group: nothing", (await get(asActor(outsider))).status === 404);
    ok("  nobody signed in: nothing", (await get(null)).status === 404);

    section("4. Removing it");
    ok("Bala can't", !(await as(bala, () => chat.setGroupIcon(chatId, null))).ok);
    const removed = await as(asha, () => chat.setGroupIcon(chatId, null));
    ok("Asha can: gone from the list and the route, and said", removed.ok && !(await summariesFor(bala.id, [chatId]))[0]?.iconUpdatedAt && (await get(asActor(bala))).status === 404 && (await db.chatMessage.count({ where: { chatId, body: { contains: "removed the group's picture" } } })) === 1);

    section("5. A workspace not migrated yet");
    await as(asha, () => chat.setGroupIcon(chatId, PNG));
    await db.$executeRawUnsafe('DROP TABLE "chat_icons"');
    const bare = await summariesFor(bala.id, [chatId]);
    ok("the chat list still loads, with no picture", bare.length === 1 && bare[0]!.iconUpdatedAt === null);
    ok("  the route answers nothing, not an error", (await get(asActor(bala))).status === 404);
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} chat icon checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
