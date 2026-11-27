/**
 * check:website-from-email — a company's website from its people's work email (owner, 18 Nov 2026; src/lib/companies/
 * website-from-email.ts).
 *
 *   · The domain most of its people share at work: free mail left out, and nothing when no one domain has more than half.
 *   · Filled only where there is no website; one already there, a person who has left, and a company kept for one
 *     person are left alone.
 *   · Wired into adding, editing and moving a contact, creating a company, and the heartbeat's daily sweep.
 *
 * Against the local database, on companies it makes and removes itself; it asserts only about those.
 *
 *   npm run check:website-from-email
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { websiteDomainFrom, websiteOf } from "../src/lib/companies/website-from-email";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};

async function main() {
  console.log("\n— The rule —\n");
  ok("one person at work: their domain", websiteDomainFrom(["asha@Acme.co.in"]) === "acme.co.in");
  ok("  free mail left out: gmail beside a work address is the work domain", websiteDomainFrom(["x@gmail.com", "y@yahoo.co.in", "asha@acme.co.in"]) === "acme.co.in");
  ok("  only free mail, or none: nothing", websiteDomainFrom(["x@gmail.com", "y@outlook.com"]) === null && websiteDomainFrom([null, "", "not-an-email"]) === null);
  ok("  most share one: theirs", websiteDomainFrom(["a@acme.com", "b@acme.com", "c@consult.in"]) === "acme.com");
  ok("  split evenly: nothing — the email can't say which", websiteDomainFrom(["a@acme.com", "c@consult.in"]) === null);
  ok("kept as a link", websiteOf("acme.co.in") === "https://acme.co.in");

  console.log("\n— On companies —\n");
  const { db } = await import("../src/lib/db");
  const { fillWebsitesFromEmail } = await import("../src/lib/companies/website-from-email");
  const run = Date.now().toString(36);
  const owner = await db.user.findFirst({ where: { active: true }, select: { id: true } });
  if (!owner) throw new Error("No user in the local database to own the test companies.");
  const made: string[] = [];
  const company = async (name: string, website: string | null, people: { email: string; left?: boolean }[]) => {
    const c = await db.company.create({ data: { name: `Zz Web ${run} ${name}`, normalizedName: `zz web ${run} ${name}`.toLowerCase(), website, createdById: owner.id }, select: { id: true } });
    made.push(c.id);
    for (const [i, p] of people.entries()) {
      await db.contact.create({ data: { companyId: c.id, name: `Zz ${i}`, email: p.email, leftAt: p.left ? new Date() : null } });
    }
    return c.id;
  };
  try {
    const plain = await company("Plain", null, [{ email: `asha@zzweb-${run}.in` }, { email: "x@gmail.com" }]);
    const typed = await company("Typed", "https://typed.example", [{ email: `asha@zzweb-${run}.in` }]);
    const blank = await company("Blank", "", [{ email: `ravi@zzweb2-${run}.in` }]);
    const gone = await company("Gone", null, [{ email: `left@zzweb3-${run}.in`, left: true }]);
    const split = await company("Split", null, [{ email: `a@zzweb4-${run}.in` }, { email: `b@zzweb5-${run}.in` }]);
    const single = await company("Asha (individual)", null, [{ email: `asha@zzweb6-${run}.in` }]);
    const filled = await fillWebsitesFromEmail(made);
    const site = async (id: string) => (await db.company.findUnique({ where: { id }, select: { website: true } }))?.website;
    ok("filled from the work email, gmail left out", (await site(plain)) === `https://zzweb-${run}.in`, await site(plain));
    ok("  an empty one filled too", (await site(blank)) === `https://zzweb2-${run}.in`);
    ok("  one already there kept", (await site(typed)) === "https://typed.example");
    ok("  a person who has left says nothing", (await site(gone)) === null);
    ok("  two domains evenly: left empty", (await site(split)) === null);
    ok("  a company kept for one person: left empty", (await site(single)) === null);
    ok("  two filled, as it says", filled === 2, filled);
    ok("run again: nothing more", (await fillWebsitesFromEmail(made)) === 0);
  } finally {
    await db.contact.deleteMany({ where: { companyId: { in: made } } });
    await db.company.deleteMany({ where: { id: { in: made } } });
  }

  console.log("\n— Where it runs —\n");
  const actions = readFileSync("src/actions/company.ts", "utf8");
  ok("adding, editing and moving a contact, and creating a company, fill it", (actions.match(/await fillWebsitesFromEmail\(\[/g) ?? []).length === 4);
  ok("  and the heartbeat's daily sweep, for imports and the rest", /await fillWebsitesFromEmail\(\);/.test(readFileSync("src/lib/marketing/heartbeat.ts", "utf8")));

  console.log(failures === 0 ? `\nAll ${passes} website-from-email checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
