/**
 * check:vendor-msme — MSME vendors' 45-day limit (owner, 17 Nov 2026 — src/lib/payables/msme.ts).
 *
 *   1. The Udyam number: spaces and case forgiven, any other shape refused.
 *   2. The last day to pay: the bill's due date when within 45 days of the bill; 45 days when it is later; 15 days
 *      with none — on the workspace's calendar, so a bill entered late in the evening in India keeps its own day.
 *   3. Where a bill stands: quiet before the last week, "due soon" within it, "late" after, and the words for each.
 *   4. Only micro and small are held to the limit.
 *
 * Pure: no database.
 *
 *   npm run check:vendor-msme
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { clockFor } from "../src/lib/time/zone";
import { heldToLimit, msmeStanding, normaliseUdyam, standingWords, udyamRefusal } from "../src/lib/payables/msme";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const india = clockFor("Asia/Kolkata");
// 10 pm in India on 1 Oct 2026 is 16:30 UTC the same day; 3 am in India on 2 Oct is 21:30 UTC on 1 Oct.
const at = (iso: string) => new Date(iso);

console.log("1. Udyam number");
test("spaces and lower case are forgiven", () => {
  assert.equal(normaliseUdyam(" udyam-mh-19-0012345 "), "UDYAM-MH-19-0012345");
  assert.equal(udyamRefusal("udyam - mh - 19 - 0012345"), null);
});
test("other shapes are refused", () => {
  assert.ok(udyamRefusal(""));
  assert.ok(udyamRefusal("UDYAM-MH-19-001234"));
  assert.ok(udyamRefusal("UDYAM-M1-19-0012345"));
  assert.ok(udyamRefusal("UAM-MH-19-0012345"));
});

console.log("2. Last day to pay");
test("the bill's due date when within 45 days", () => {
  const s = msmeStanding({ issueDate: at("2026-10-01T06:30:00Z"), dueDate: at("2026-10-31T00:00:00Z") }, india, at("2026-10-05T06:30:00Z"));
  assert.equal(s.payBy, "2026-10-31");
  assert.equal(s.dueBeyondLimit, false);
  assert.equal(s.noDueDate, false);
});
test("45 days from the bill when its due date is later", () => {
  const s = msmeStanding({ issueDate: at("2026-10-01T06:30:00Z"), dueDate: at("2026-12-30T00:00:00Z") }, india, at("2026-10-05T06:30:00Z"));
  assert.equal(s.payBy, "2026-11-15");
  assert.equal(s.dueBeyondLimit, true);
});
test("15 days with no due date", () => {
  const s = msmeStanding({ issueDate: at("2026-10-01T06:30:00Z"), dueDate: null }, india, at("2026-10-05T06:30:00Z"));
  assert.equal(s.payBy, "2026-10-16");
  assert.equal(s.noDueDate, true);
});
test("a bill entered at 3 am India time keeps India's day", () => {
  // 21:30 UTC on 1 Oct is 3 am on 2 Oct in India: the bill is dated the 2nd, so 15 days is the 17th.
  const s = msmeStanding({ issueDate: at("2026-10-01T21:30:00Z"), dueDate: null }, india, at("2026-10-05T06:30:00Z"));
  assert.equal(s.payBy, "2026-10-17");
});

console.log("3. Standing");
const bill = { issueDate: at("2026-10-01T06:30:00Z"), dueDate: at("2026-10-31T00:00:00Z") };
test("quiet before the last week", () => {
  const s = msmeStanding(bill, india, at("2026-10-20T06:30:00Z"));
  assert.equal(s.state, "ok");
  assert.equal(s.daysLeft, 11);
  assert.equal(standingWords(s), "11 days left to pay");
});
test("due soon within the last week, and on the day", () => {
  assert.equal(msmeStanding(bill, india, at("2026-10-24T06:30:00Z")).state, "soon");
  const today = msmeStanding(bill, india, at("2026-10-31T06:30:00Z"));
  assert.equal(today.state, "soon");
  assert.equal(standingWords(today), "Last day to pay is today");
});
test("late the day after, counted in days", () => {
  const s = msmeStanding(bill, india, at("2026-11-01T06:30:00Z"));
  assert.equal(s.state, "late");
  assert.equal(standingWords(s), "1 day past the MSME limit");
  assert.equal(standingWords(msmeStanding(bill, india, at("2026-11-10T06:30:00Z"))), "10 days past the MSME limit");
});
test("late evening in India is still India's day", () => {
  // 20:00 UTC on 31 Oct is 1:30 am on 1 Nov in India — already past.
  assert.equal(msmeStanding(bill, india, at("2026-10-31T20:00:00Z")).state, "late");
});

console.log("4. Who is held to it");
test("micro and small, not medium", () => {
  assert.equal(heldToLimit("MICRO"), true);
  assert.equal(heldToLimit("SMALL"), true);
  assert.equal(heldToLimit("MEDIUM"), false);
  assert.equal(heldToLimit(null), false);
});

console.log(`\n${passed} passed`);
process.exit(0);
