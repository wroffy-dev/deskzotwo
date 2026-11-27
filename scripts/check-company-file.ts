/**
 * check:company-file — the companies, customers and vendors file: offices with their GSTINs (owner, 28 Oct 2026;
 * src/lib/portability/importers/companies.ts, src/lib/portability/exporters/crm.ts).
 *
 * On a scratch workspace database of its own (<db>_company_file_check, built from the migrations and dropped at the end,
 * pass or fail):
 *
 *   · a vendor file brings GSTIN, address, PAN (from the GSTIN), payment terms and vendor code; two rows under one name
 *     are two offices — the head office and a branch, each with its GSTIN and its state;
 *   · a taken vendor code is refused; a bad GSTIN or PIN, or a state or PAN at odds with the GSTIN, is brought (the
 *     bad one left out), said on the preview; a customer's terms are passed over;
 *   · Zoho Books' Contacts reads as Zoho exports it: billing address, GSTIN, Display Name, Payment Terms in days;
 *   · the export writes the head office on the vendor's row and the branch on its own, and reads straight back unchanged.
 *
 * The session is a stand-in; nothing is written to any other database.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: "ADMIN", name: "Zz", email: `${actorId}@zzfile.invalid` } : null);
    return {
      requireUser: async () => {
        const u = await user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: user,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is needed.");
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("Only against a local database server.");
  const scratchName = `${new URL(url).pathname.slice(1)}_company_file_check`;
  const scratchUrl = withDatabase(url, scratchName);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from its migrations", true);
    // Off by value, never deleted, so a client re-reading .env can't put them back.
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = " ";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    await scenario();
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${scratchName}`;
    ok("the scratch workspace is dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }
  console.log(failures === 0 ? "\nAll company file checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

async function scenario() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const portability = require("../src/lib/portability/import") as typeof import("../src/lib/portability/import");
  const { EXPORTERS } = require("../src/lib/portability/exporters") as typeof import("../src/lib/portability/exporters");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const sa = await db.user.create({ data: { name: "Zz Super", email: "super@zzfile.invalid", role: "ADMIN", isSuperAdmin: true, passwordHash: "x".repeat(60) } });
  actorId = sa.id;

  section("A vendor file with GSTINs, two offices for one vendor");
  const file: Record<string, string>[] = [
    { Name: "Zz Ingram Micro India Pvt. Ltd.", GSTIN: "27AAACI1234A1Z5", Address: "Andheri East", City: "Mumbai", PIN: "400069", "Payment terms": "Net 30", "Vendor code": "ZZV-0042" },
    { Name: "Zz Ingram Micro India Pvt. Ltd.", GSTIN: "29AAACI1234A1Z3", City: "Bengaluru", PIN: "560001" },
    { Name: "Zz Plain Supplies", City: "Pune", State: "Maharashtra" },
  ];
  const planned = await portability.plan("vendors", file, sa.id);
  ok("planned: two vendors, the second office of the first as an update, nothing refused", planned.creates === 2 && planned.updates === 1 && planned.errors === 0, planned.rows.map((r) => `${r.line} ${r.action} ${"error" in r ? r.error : ""}`));
  const applied = await portability.apply("vendors", file, sa.id);
  ok("  applied without a failure", applied.failed.length === 0, applied.failed);
  const ingram = await db.company.findFirst({ where: { name: "Zz Ingram Micro India Pvt. Ltd." }, select: { id: true, relationshipType: true, panNumber: true, paymentTerms: true, vendorCode: true, locations: { select: { label: true, gstNumber: true, state: true, city: true, isPrimary: true, gstTreatment: true }, orderBy: { createdAt: "asc" } } } });
  ok("a vendor, its PAN from the GSTIN, its terms and code", ingram?.relationshipType === "VENDOR" && ingram.panNumber === "AAACI1234A" && ingram.paymentTerms === "NET_30" && ingram.vendorCode === "ZZV-0042", ingram);
  const [main, branch] = ingram?.locations ?? [];
  ok("  the head office: Maharashtra from its GSTIN, registered", main?.isPrimary === true && main.gstNumber === "27AAACI1234A1Z5" && main.state === "Maharashtra" && main.gstTreatment === "REGISTERED_REGULAR" && main.label === "Head Office", main);
  ok("  the Bengaluru office a branch of its own: Karnataka, its GSTIN", ingram?.locations.length === 2 && branch?.isPrimary === false && branch.gstNumber === "29AAACI1234A1Z3" && branch.state === "Karnataka" && branch.label === "Bengaluru", branch);

  section("Refused rows, and rows brought with a word");
  const bad = await portability.plan("vendors", [
    { Name: "Zz Bad Gst", GSTIN: "27ABC" },
    { Name: "Zz Wrong State", GSTIN: "27AAACI1234A1Z5", State: "Karnataka" },
    { Name: "Zz Wrong Pan", GSTIN: "27AAACI1234A1Z5", PAN: "BBBBB1234B" },
    { Name: "Zz Bad Pin", PIN: "4000" },
    { Name: "Zz Code Taken", "Vendor code": "ZZV-0042" },
  ], sa.id);
  const why = bad.rows.map((r) => ("error" in r && r.error ? String(r.error) : `${r.action}: ${r.notice ?? ""}`));
  ok("a code another vendor has is refused, saying whose", /Ingram/.test(why[4]!), why);
  ok("  a GSTIN or PIN that can't be one: the vendor brought without it, said on the preview", /^create: .*valid GSTIN — brought without it/.test(why[0]!) && /^create: .*six digits — brought without it/.test(why[3]!), why);
  ok("  a state or a PAN at odds with the GSTIN is brought, and said on the preview", /^create: .*GSTIN's state/.test(why[1]!) && /^create: .*PAN isn't the one in the GSTIN/.test(why[2]!), why);
  const customer = await portability.plan("customers", [{ Name: "Zz Customer Terms", "Payment terms": "Net 60" }], sa.id);
  ok("  a customer's payment terms are passed over — they're set on its page, where its credit is checked", customer.errors === 0 && customer.rows[0]?.changes.every((c) => c.field !== "Payment terms") === true, customer.rows);

  section("Zoho Books' Contacts, as Zoho exports it");
  const zoho: Record<string, string>[] = [
    { "Display Name": "Zz Acme Retail", "Company Name": "Zz Acme Retail Pvt Ltd", "Billing Address": "12 MG Road", "Billing City": "Gurugram", "Billing State": "Haryana", "Billing Country": "India", "Billing Code": "122 001", "GST Identification Number (GSTIN)": "06AAACZ1234A1Z5", "Payment Terms": "30", "Payment Terms Label": "Net 30", Website: "acme.example", Source: "user", Salutation: "Mr.", "First Name": "Ashok", "Last Name": "Mehta", EmailID: "Ashok@Acme.example", MobilePhone: "9810012345", Phone: "0124-400100", Designation: "IT Manager" },
    { "Display Name": "Zz Ravi Kumar", "Company Name": "", "Billing City": "Pune", "GST Identification Number (GSTIN)": "27ABCDE", "Payment Terms": "0", "Payment Terms Label": "Due on Receipt", Source: "csv", "First Name": "Ravi", "Last Name": "Kumar", EmailID: "ravi at mail" },
  ];
  const zp = await portability.plan("customers", zoho, sa.id);
  ok("every row reads — no refusal over Zoho's Payment Terms, a missing Company Name or a mistyped GSTIN", zp.errors === 0 && zp.creates === 2, zp.rows.map((r) => `${r.action} ${r.label} ${r.error ?? ""} ${r.notice ?? ""}`));
  await portability.apply("customers", zoho, sa.id);
  const acme = await db.company.findFirst({ where: { name: "Zz Acme Retail Pvt Ltd" }, select: { relationshipType: true, panNumber: true, website: true, paymentTerms: true, locations: { select: { address: true, city: true, state: true, pincode: true, gstNumber: true } } } });
  ok("  the company: its Company Name, billing address, GSTIN, PAN from it, its PIN without the space", acme?.relationshipType === "CLIENT" && acme.panNumber === "AAACZ1234A" && acme.locations[0]?.city === "Gurugram" && acme.locations[0]?.address === "12 MG Road" && acme.locations[0]?.pincode === "122001" && acme.locations[0]?.gstNumber === "06AAACZ1234A1Z5", acme);
  const ravi = await db.company.findFirst({ where: { name: "Zz Ravi Kumar" }, select: { locations: { select: { city: true, gstNumber: true } } } });
  ok(
    "  Zoho's Source — how the contact was made, \"user\" or \"csv\" — is left out with a word, never a refusal (owner, 28 Oct 2026)",
    zp.rows.every((r) => r.action === "create" && /Source "(user|csv)" isn't one of .* left out/.test(r.notice ?? "")),
    zp.rows.map((r) => r.notice),
  );
  const acmeContacts = await db.contact.findMany({ where: { company: { name: "Zz Acme Retail Pvt Ltd" } }, select: { name: true, email: true, phone: true, isPrimary: true, designation: true } });
  ok(
    "  its primary contact from Zoho's person columns: First + Last Name, EmailID, MobilePhone over Phone, Designation (owner, 28 Oct 2026)",
    acmeContacts.length === 1 && acmeContacts[0]!.name === "Ashok Mehta" && acmeContacts[0]!.email === "ashok@acme.example" && acmeContacts[0]!.phone === "9810012345" && acmeContacts[0]!.isPrimary && acmeContacts[0]!.designation === "IT_MANAGER",
    acmeContacts,
  );
  ok("  the preview showed it", zp.rows[0]!.changes.some((ch) => ch.field === "Contact" && /Ashok Mehta/.test(ch.to)), zp.rows[0]!.changes);
  const raviContacts = await db.contact.findMany({ where: { company: { name: "Zz Ravi Kumar" } }, select: { name: true, email: true } });
  ok("  an email that isn't one: the contact brought without it, said so", raviContacts.length === 1 && raviContacts[0]!.name === "Ravi Kumar" && raviContacts[0]!.email === null && /Email "ravi at mail" isn't an email/.test(zp.rows[1]!.notice ?? ""), { raviContacts, notice: zp.rows[1]!.notice });
  await portability.apply("customers", zoho, sa.id);
  ok("  the same file again: no second contact", (await db.contact.count({ where: { company: { name: "Zz Acme Retail Pvt Ltd" } } })) === 1 && (await db.contact.count({ where: { company: { name: "Zz Ravi Kumar" } } })) === 1);
  ok("  a person with no Company Name, by their Display Name, without the GSTIN that isn't one", ravi?.locations[0]?.city === "Pune" && !ravi.locations[0]?.gstNumber, ravi);
  const vz = await portability.plan("vendors", [{ "Display Name": "Zz Terms Vendor", "Payment Terms": "45" }, { "Display Name": "Zz Odd Terms", "Payment Terms": "90" }], sa.id);
  ok("  a vendor's Zoho terms by their days: 45 is Net 45; 90, which Deskzo hasn't, passed over with a word", vz.errors === 0 && vz.rows[0]!.changes.some((c) => c.field === "Payment terms" && c.to === "Net 45") && /aren't one of/.test(vz.rows[1]!.notice ?? ""), vz.rows);

  section("The export, and back");
  const out = await EXPORTERS.vendors!({ userId: sa.id, ownerUserIds: null });
  const rows = out.filter((r) => String(r.Name).startsWith("Zz Ingram"));
  ok("the vendor's row has its head office, PAN, terms and code; the branch is a row of its own", rows.length === 2 && rows[0]!.GSTIN === "27AAACI1234A1Z5" && rows[0]!.PAN === "AAACI1234A" && rows[0]!["Payment terms"] === "Net 30" && rows[0]!["Vendor code"] === "ZZV-0042" && rows[1]!.GSTIN === "29AAACI1234A1Z3" && rows[1]!.City === "Bengaluru", rows);
  const again = await portability.plan("vendors", out.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : String(v ?? "")]))), sa.id);
  ok("  the export read straight back changes nothing and adds no office", again.errors === 0 && again.creates === 0 && again.rows.every((r) => r.action !== "update" || ("changes" in r && (r.changes as unknown[]).length === 0)), again.rows.filter((r) => r.action !== "skip").map((r) => JSON.stringify(r).slice(0, 300)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
