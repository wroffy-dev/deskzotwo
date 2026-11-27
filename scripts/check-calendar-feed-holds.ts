/**
 * The calendar feed is held as the other bearer tokens are: locks and network rules apply.
 *
 * Security audit, Nov 2026: readFeed (src/lib/calendar/feed.ts) asked only whether the feed's person was switched on
 * and Calendar was on. A personal lock, a company lock and the network rules — which personRefusal enforces for API
 * keys and the phone app — didn't touch it, so locking somebody didn't stop their calendar. It now asks
 * personRefusal, with the calendar app's address, and answers a refusal with the same 404 as an unknown secret.
 *
 * A static check, so it needs no database (check:native-calendar exercises the same rule against one).
 *
 *   npm run check:calendar-feed-holds
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

console.log("\n— The calendar feed's holds —\n");

const feed = read("src/lib/calendar/feed.ts");
const body = feed.slice(feed.indexOf("export async function readFeed("));
ok("readFeed takes the calendar app's address", /export async function readFeed\(token: string, now = new Date\(\), ip: string \| null = null\)/.test(feed));
ok("  reads what personRefusal needs", /user: \{ select: \{ id: true, name: true, email: true, active: true, kind: true, role: true, isSuperAdmin: true, lockedAt: true, lockedUntil: true \} \}/.test(body));
const refusal = body.search(/if \(await personRefusal\(feed\.user, ip\)\) return \{ ok: false, status: 404 \};/);
const counted = body.indexOf("const windowOver");
const events = body.indexOf("calendarEvent.findMany");
ok("  refuses with the same 404 when personRefusal does", refusal >= 0);
ok("  before the read is counted or a single event read", refusal >= 0 && counted > refusal && events > refusal, `refusal ${refusal}, counted ${counted}, events ${events}`);

const route = read("src/app/api/calendar/feed/[token]/route.ts");
ok("the route passes the caller's address, as the proxy reports it", /readFeed\(token\.replace\(\/\\\.ics\$\/i, ""\), new Date\(\), clientIpFrom\(req\.headers\)\)/.test(route));

console.log(failures === 0 ? "\nAll calendar-feed hold checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
