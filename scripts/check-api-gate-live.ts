/**
 * The user-photo and chat-icon routes pass the access gate (security audit, Nov 2026).
 *
 * They read the bare NextAuth session, so a cookie kept working for them after its person was switched off or its
 * sign-in was ended. Now they ask currentUser — the real one here (src/lib/session.ts), with only NextAuth's
 * session and the request's headers played: an active person with a live sign-in gets the image; switched off,
 * or with the sign-in ended, the same cookie gets 404 from both.
 *
 * Against the workspace in DATABASE_URL; everything it makes is tagged and removed.
 *
 *   npm run check:api-gate-live
 */
import "dotenv/config";
import Module from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { directClient } from "../src/lib/tenancy/direct-client";

type Played = { id: string; name: string; email: string; role: string; sid: string } | null;
let played: Played = null;
const requestHeaders = new Headers({ "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) check:api-gate-live" });

const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return { headers: async () => requestHeaders, cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/auth" || request.endsWith(`${path.sep}lib${path.sep}auth`) || request.endsWith(`${path.sep}lib${path.sep}auth.ts`)) {
    return { auth: async () => (played ? { user: played } : null) };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

const TAG = "zz-api-gate";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function cleanup() {
  await db.chat.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.user.deleteMany({ where: { email: { endsWith: `@${TAG}.invalid` } } });
}

async function main() {
  await cleanup();
  /* eslint-disable @typescript-eslint/no-require-imports */
  const photoRoute = require("../src/app/api/users/[id]/photo/route") as typeof import("../src/app/api/users/[id]/photo/route");
  const iconRoute = require("../src/app/api/chat/icons/[id]/route") as typeof import("../src/app/api/chat/icons/[id]/route");
  const { clearAccessCache } = require("../src/lib/access/gate") as typeof import("../src/lib/access/gate");
  /* eslint-enable @typescript-eslint/no-require-imports */

  try {
    const person = await db.user.create({ data: { name: "Zz Gate", email: `gate@${TAG}.invalid`, passwordHash: "!", role: "SALES" }, select: { id: true, name: true, email: true, role: true } });
    await db.userPhoto.create({ data: { userId: person.id, dataUrl: PNG, mimeType: "image/png", byteSize: 68 } });
    const chat = await db.chat.create({ data: { kind: "GROUP", name: `${TAG} group`, createdById: person.id }, select: { id: true } });
    await db.chatMember.create({ data: { chatId: chat.id, userId: person.id, isAdmin: true } });
    await db.chatIcon.create({ data: { chatId: chat.id, dataUrl: PNG, mimeType: "image/png", byteSize: 68, setById: person.id } });
    const sid = randomUUID();
    await db.signIn.create({ data: { sid, userId: person.id, provider: "credentials" } });
    played = { id: person.id, name: person.name, email: person.email!, role: person.role, sid };

    const statuses = async () => {
      clearAccessCache();
      const photo = await photoRoute.GET(new Request(`http://localhost/api/users/${person.id}/photo`), { params: Promise.resolve({ id: person.id }) });
      const icon = await iconRoute.GET(new Request(`http://localhost/api/chat/icons/${chat.id}`), { params: Promise.resolve({ id: chat.id }) });
      return [photo.status, icon.status];
    };

    ok("an active person with a live sign-in: the photo and the group picture", JSON.stringify(await statuses()) === "[200,200]", await statuses());

    await db.user.update({ where: { id: person.id }, data: { active: false } });
    ok("switched off, the same cookie: 404 from both", JSON.stringify(await statuses()) === "[404,404]", await statuses());
    await db.user.update({ where: { id: person.id }, data: { active: true } });
    ok("  (switched on again: served)", JSON.stringify(await statuses()) === "[200,200]", await statuses());

    await db.signIn.update({ where: { sid }, data: { endedAt: new Date() } });
    ok("its sign-in ended, the same cookie: 404 from both", JSON.stringify(await statuses()) === "[404,404]", await statuses());

    played = null;
    ok("nobody signed in: 404 from both", JSON.stringify(await statuses()) === "[404,404]", await statuses());
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures === 0 ? "\nAll /api gate checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
