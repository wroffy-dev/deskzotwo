/**
 * Every session-bearing /api route passes the access gate.
 *
 * `/api` is outside the proxy's matcher, so a route there that reads the session itself — `auth()` from
 * "@/lib/auth" — skips everything the gate asks: whether the person is switched off, the session was ended, a
 * support grant still holds, a lock, a network rule. src/lib/session.ts says every read there goes through
 * requireUser or currentUser instead. Security audit, Nov 2026: the user-photo and chat-icon routes didn't.
 *
 * This fails when any file under src/app/api imports from "@/lib/auth" — except the NextAuth handler route, which
 * imports `handlers` and nothing else — or from "@/lib/auth-edge".
 *
 *   npm run check:api-session-gate
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

let failures = 0;
function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}

const root = join(__dirname, "..");
const api = join(root, "src/app/api");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const HANDLER = "src/app/api/auth/[...nextauth]/route.ts";
/** Every import statement's named bindings and source, multi-line ones included. */
const IMPORT = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;

console.log("\n— /api routes and the access gate —\n");

const files = walk(api);
ok("the /api routes are found", files.length > 50, `${files.length}`);
const offenders: string[] = [];
for (const file of files) {
  const rel = relative(root, file);
  const source = readFileSync(file, "utf8");
  for (const [, bindings, from] of source.matchAll(IMPORT)) {
    if (from === "@/lib/auth-edge") offenders.push(`${rel}: imports ${from}`);
    if (from !== "@/lib/auth") continue;
    if (rel === HANDLER && /^\{\s*handlers\s*\}$/.test(bindings.trim())) continue;
    offenders.push(`${rel}: imports ${bindings.trim()} from ${from}`);
  }
  // A dynamic import gets round the static one.
  if (/import\(\s*["']@\/lib\/auth["']\s*\)/.test(source) && rel !== HANDLER) offenders.push(`${rel}: imports @/lib/auth dynamically`);
}
ok("no /api route reads the session itself — currentUser or requireUser instead", offenders.length === 0, offenders.join("; "));

const photo = readFileSync(join(api, "users/[id]/photo/route.ts"), "utf8");
const icon = readFileSync(join(api, "chat/icons/[id]/route.ts"), "utf8");
ok("the user-photo route asks currentUser", /const user = await currentUser\(\);\s*if \(!user\) \{\s*return new NextResponse\("Not found", \{ status: 404 \}\);/.test(photo));
ok("the chat-icon route asks currentUser, and still checks membership", /const userId = \(await currentUser\(\)\)\?\.id;/.test(icon) && /chatMember\.findUnique\(\{ where: \{ chatId_userId: \{ chatId: id, userId \} \}/.test(icon));

console.log(failures === 0 ? "\nAll /api session-gate checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
