/**
 * Phone numbers with their country (src/lib/phone.ts): read in whatever shape they were stored, kept as
 * "+91 98765 43210", and handed to the places that need them in another shape.
 *
 * What is checked, each for the way it would break quietly:
 *
 *   · **Old numbers read right.** Most stored numbers have no code at all ("98765 43210"), or a trunk 0
 *     ("098765-43210"), or "0091". Read wrongly, every existing contact's phone field would open on the
 *     wrong country, or with its digits shifted into the code.
 *   · **Shared codes.** +1 is the US, Canada and twenty-odd islands; a number saved under Canada must
 *     still open as Canada, not flip to the US the next time its form is opened.
 *   · **The last ten digits don't move,** because calls are matched to contacts by them (`phoneKey`).
 *   · **CallerDesk gets ten digits** for an Indian number, as it writes them itself.
 *   · **The app's copy of the country list** (mobile/src/lib/phone.ts) is the web's, entry for entry.
 *
 *   npm run check:phone-numbers
 */
import { PHONE_COUNTRIES, joinPhone, normalisePhone, phoneCountryForZone, splitPhone } from "../src/lib/phone";
import { phoneKey } from "../src/lib/companies/duplicates";
import { dialledNumber } from "../src/lib/telephony/callerdesk";
import * as app from "../mobile/src/lib/phone";

let failures = 0;
function ok(label: string, pass: boolean, detail: string | number | null = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const READS: [stored: string, fallback: string, country: string, national: string, kept: string][] = [
  ["98765 43210", "IN", "IN", "98765 43210", "+91 98765 43210"],
  ["098765-43210", "IN", "IN", "098765-43210", "+91 98765 43210"],
  ["+91 98765 43210", "IN", "IN", "98765 43210", "+91 98765 43210"],
  ["+919876543210", "IN", "IN", "9876543210", "+91 9876543210"],
  ["0091 98765 43210", "IN", "IN", "98765 43210", "+91 98765 43210"],
  ["+971 50 123 4567", "IN", "AE", "50 123 4567", "+971 50 123 4567"],
  ["+44 20 7946 0958", "IN", "GB", "20 7946 0958", "+44 20 7946 0958"],
  ["+1 415 555 0100", "IN", "US", "415 555 0100", "+1 415 555 0100"],
  ["+1 416 555 0100", "CA", "CA", "416 555 0100", "+1 416 555 0100"],
  ["+7 701 123 4567", "KZ", "KZ", "701 123 4567", "+7 701 123 4567"],
  ["+39 06 1234 5678", "IN", "IT", "06 1234 5678", "+39 06 1234 5678"],
  ["", "IN", "IN", "", ""],
];
for (const [stored, fallback, country, national, kept] of READS) {
  const split = splitPhone(stored, fallback);
  ok(`"${stored}" reads as ${country} "${national}" and is kept as "${kept}"`, split.country === country && split.national === national && normalisePhone(stored, fallback) === kept, `${JSON.stringify(split)} → "${normalisePhone(stored, fallback)}"`);
}

ok("a number with no digits is no number", joinPhone("IN", " - ") === "");
ok("Italy keeps its leading 0", joinPhone("IT", "06 1234 5678") === "+39 06 1234 5678");
ok(
  "the last ten digits, which calls are matched on, don't move",
  READS.filter(([s]) => s).every(([stored, fallback]) => phoneKey(stored) === phoneKey(normalisePhone(stored, fallback))),
);
ok("a new number starts in the workspace's country", phoneCountryForZone("Asia/Kolkata") === "IN" && phoneCountryForZone("Asia/Dubai") === "AE" && phoneCountryForZone("Mars/Base") === "IN");
ok("India is first in the list", PHONE_COUNTRIES[0]?.code === "IN" && PHONE_COUNTRIES[0]?.dial === "91");
ok("every code is one to three digits", PHONE_COUNTRIES.every((c) => /^\d{1,3}$/.test(c.dial)), PHONE_COUNTRIES.length);

ok("CallerDesk dials an Indian number as its ten digits", dialledNumber("+91 98765 43210") === "9876543210" && dialledNumber("098765 43210") === "9876543210");
ok("  and any other as it was kept", dialledNumber("+971 50 123 4567") === "+971 50 123 4567");

ok("the app's country list is the web's", same(app.PHONE_COUNTRIES, PHONE_COUNTRIES), `${app.PHONE_COUNTRIES.length} in the app, ${PHONE_COUNTRIES.length} on the web`);
ok(
  "  and reads and keeps numbers the same way",
  READS.every(([stored, fallback]) => same(app.splitPhone(stored, fallback), splitPhone(stored, fallback)) && same(app.joinPhone(...Object.values(app.splitPhone(stored, fallback)) as [string, string]), normalisePhone(stored, fallback))),
);

if (failures > 0) {
  console.log(`\n${failures} failed.`);
  process.exit(1);
}
console.log("\nAll passed.");
