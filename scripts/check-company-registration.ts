/**
 * check:company-registration — a company's CIN (India) and trade licence (UAE) (owner, 20 Nov 2026 —
 * src/lib/companies/registration-rules.ts, src/actions/company-registration.ts).
 *
 *   1. CIN and LLPIN: spaces and case forgiven, any other shape refused, empty clears it.
 *   2. Trade licence: number, who issued it and its expiry tidied or refused.
 *   3. Where a licence stands: valid, expiring within 30 days, expired.
 *   4. The tax numbers on its addresses, once each.
 *   5. Wiring: the action guards edits and keeps PAN finance's; merge and reset know the table; the card is on Details.
 *
 * Pure: no database.
 *
 *   npm run check:company-registration
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  addressTaxNumbers,
  cinRefusal,
  cleanAuthority,
  cleanDay,
  cleanLicenceNumber,
  licenceNumberRefusal,
  licenceStanding,
  normaliseCin,
} from "../src/lib/companies/registration-rules";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
const read = (p: string) => fs.readFileSync(p, "utf8");

console.log("1. CIN and LLPIN");
test("a CIN with spaces and lower case is taken, tidied", () => {
  assert.equal(normaliseCin(" u72200dl2010ptc 123456 "), "U72200DL2010PTC123456");
  assert.equal(cinRefusal("u72200dl2010ptc123456"), null);
  assert.equal(cinRefusal("L17110MH1973PLC019786"), null);
});
test("an LLPIN is taken", () => {
  assert.equal(cinRefusal("aab-1234"), null);
});
test("empty clears it", () => assert.equal(cinRefusal("  "), null));
test("other shapes are refused", () => {
  assert.ok(cinRefusal("U72200DL2010PTC12345"));
  assert.ok(cinRefusal("X72200DL2010PTC123456"));
  assert.ok(cinRefusal("ABCDE1234F"));
  assert.ok(cinRefusal("AB-1234"));
});

console.log("2. Trade licence");
test("its number is tidied and upper-cased", () => {
  assert.equal(cleanLicenceNumber("  cn-1234567  "), "CN-1234567");
  assert.equal(licenceNumberRefusal("cn 1234/567.8"), null);
  assert.equal(licenceNumberRefusal(""), null);
});
test("markup and over-long numbers are refused", () => {
  assert.ok(licenceNumberRefusal("<script>"));
  assert.ok(licenceNumberRefusal("A".repeat(41)));
  assert.ok(licenceNumberRefusal("-123"));
});
test("who issued it keeps its words, without angle brackets, and is cut at 80", () => {
  assert.equal(cleanAuthority("  DED   Dubai "), "DED Dubai");
  assert.equal(cleanAuthority("<b>DMCC</b>"), "b DMCC /b");
  assert.equal(cleanAuthority("x".repeat(100)).length, 80);
});
test("its expiry must be a real day", () => {
  assert.equal(cleanDay("2027-02-28"), "2027-02-28");
  assert.equal(cleanDay(""), "");
  assert.equal(cleanDay("2027-02-30"), null);
  assert.equal(cleanDay("28/02/2027"), null);
});

console.log("3. Where a licence stands");
test("valid, expiring soon, expired — on the workspace's day", () => {
  assert.equal(licenceStanding(null, "2026-11-20"), null);
  assert.equal(licenceStanding("2027-06-01", "2026-11-20"), "valid");
  assert.equal(licenceStanding("2026-12-20", "2026-11-20"), "soon");
  assert.equal(licenceStanding("2026-12-21", "2026-11-20"), "valid");
  assert.equal(licenceStanding("2026-11-20", "2026-11-20"), "soon");
  assert.equal(licenceStanding("2026-11-19", "2026-11-20"), "expired");
});

console.log("4. Tax numbers on its addresses");
test("once each, blanks left out", () => {
  assert.deepEqual(addressTaxNumbers([{ gstNumber: "100123456700003" }, { gstNumber: null }, { gstNumber: " 100123456700003 " }, { gstNumber: "07aaacw1234a1z5" }]), ["100123456700003", "07AAACW1234A1Z5"]);
});

console.log("5. Wiring");
const action = read("src/actions/company-registration.ts");
test("the action needs edit rights on a company the person can see, and refuses while viewing as", () => {
  assert.ok(/canSeeCompany\(user\.id, company\)/.test(action));
  assert.ok(/mayAccess\(user\.id, "companies", "edit", company\.id\)/.test(action));
  assert.ok(/refuseWhileViewingAs\(\)/.test(action));
});
test("a PAN change stays finance's, never by somebody it is masked for, and only in India", () => {
  assert.ok(/payments\.manage/.test(action));
  assert.ok(/flags\.pan/.test(action));
  const indiaBranch = action.slice(action.indexOf("if (india)"), action.indexOf("} else {"));
  assert.ok(/panNumber/.test(indiaBranch));
});
test("merge and reset know the table; the migration makes it", () => {
  assert.ok(read("src/lib/companies/merge.ts").includes(`"CompanyRegistration.companyId"`));
  assert.ok(read("src/lib/reset-classes.ts").includes(`"CompanyRegistration"`));
  assert.ok(read("prisma/migrations/20261220800000_company_registration/migration.sql").includes(`CREATE TABLE "company_registrations"`));
});
test("Details shows the card, and the address line names its number", () => {
  const detail = read("src/components/companies/company-detail.tsx");
  assert.ok(detail.includes("<RegistrationCard"));
  assert.ok(/workspacePack\(\)\.india \? "GSTIN" : "TRN"/.test(detail));
});

console.log(`\nAll ${passed} company registration checks passed.`);
