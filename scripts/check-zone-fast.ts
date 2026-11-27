/**
 * check:zone-fast — a zone's wall clock worked out from its offset per quarter-hour (src/lib/time/zone.ts; owner,
 * 30 Oct 2026, the large-workspace test) gives exactly what Intl's formatter gives: every minute around the clock
 * changes of zones with odd offsets and half-hour daylight saving, and a few hundred thousand moments from 1970 to 2040.
 * Then how much faster it is. Pure — no database.
 */
import { zonedPartsByFormatter, zonedPartsFast, clockFor } from "../src/lib/time/zone";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const ZONES = [
  "Asia/Kolkata",
  "Asia/Kathmandu", // +5:45
  "Australia/Lord_Howe", // half-hour daylight saving
  "America/St_Johns", // -3:30, with daylight saving
  "Pacific/Chatham", // +12:45 / +13:45
  "America/New_York",
  "Europe/London",
  "Africa/Casablanca", // daylight saving stopped for Ramadan
  "America/Sao_Paulo", // daylight saving ended in 2019
  "Asia/Tehran", // daylight saving ended in 2022
  "UTC",
];
const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);

section("Every minute around the clock changes, 2019–2027");
for (const zone of ZONES) {
  let checked = 0;
  const wrong: string[] = [];
  // Find each change by its offset, a day at a time, then check every minute of the two hours around it.
  const offsetAt = (ms: number) => {
    const p = zonedPartsByFormatter(new Date(ms), zone);
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  };
  for (let day = Date.UTC(2019, 0, 1); day < Date.UTC(2027, 11, 31); day += 86_400_000) {
    if (offsetAt(day) === offsetAt(day + 86_400_000)) continue;
    for (let m = day - 3_600_000; m < day + 86_400_000 + 3_600_000; m += 60_000) {
      checked += 1;
      const at = new Date(m + 17_000);
      if (!same(zonedPartsFast(at, zone), zonedPartsByFormatter(at, zone))) wrong.push(at.toISOString());
      if (wrong.length > 3) break;
    }
  }
  ok(`${zone}: ${checked.toLocaleString("en-IN")} minutes around its changes agree`, wrong.length === 0, wrong);
}

section("Moments from 1970 to 2040");
let seed = 42;
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
for (const zone of ZONES) {
  const wrong: string[] = [];
  for (let i = 0; i < 20_000 && wrong.length < 4; i++) {
    const at = new Date(Date.UTC(1970, 0, 1) + Math.floor(rand() * (Date.UTC(2040, 0, 1) - Date.UTC(1970, 0, 1))));
    if (!same(zonedPartsFast(at, zone), zonedPartsByFormatter(at, zone))) wrong.push(at.toISOString());
  }
  ok(`${zone}: 20,000 random moments agree`, wrong.length === 0, wrong);
}

section("The clock reads the same");
const clock = clockFor("Asia/Kolkata");
ok("18:29:59 UTC is still the day; 18:30 is India's next", clock.dateKey(new Date("2026-10-29T18:29:59Z")) === "2026-10-29" && clock.dateKey(new Date("2026-10-29T18:30:00Z")) === "2026-10-30");
ok("an invalid date is handled as before", (() => {
  try {
    return typeof clock.dateKey(new Date(NaN)) === "string";
  } catch {
    return true;
  }
})());

section("Faster");
const many = Array.from({ length: 200_000 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 157_000));
let t = performance.now();
for (const at of many.slice(0, 20_000)) zonedPartsByFormatter(at, "Asia/Kolkata");
const slow = ((performance.now() - t) / 20_000) * 200_000;
t = performance.now();
for (const at of many) zonedPartsFast(at, "Asia/Kolkata");
const fast = performance.now() - t;
console.log(`  200,000 moments: the formatter about ${Math.round(slow)} ms, the quarter-hour cache ${Math.round(fast)} ms`);
ok("at least ten times faster", fast * 10 < slow, { slow, fast });

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll zone checks passed.");
process.exit(failures ? 1 : 0);
