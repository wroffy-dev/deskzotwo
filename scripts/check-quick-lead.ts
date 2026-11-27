/**
 * check:quick-lead — Create › Quick lead (owner, 27 Oct 2026; src/actions/quick-lead.ts).
 *
 * On a scratch workspace database of its own (<db>_quick_lead_check, built from the migrations and dropped at the
 * end, pass or fail):
 *
 *   · a typed new company is made, with the person on it, and the lead with its products;
 *   · the same form sent again is the same lead — no second company, person or lead;
 *   · a company typed as it already exists (any capitals) is used, and the person found there by mobile;
 *   · a person found by email is not added twice; a mobile with no name is refused;
 *   · the company's Leads tab draws them as the Leads list does — IDs, the person's email and phone, stage, source.
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
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/companies",
    };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: "ADMIN", name: "Zz", email: `${actorId}@zzquick.invalid` } : null);
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
  const scratchName = `${new URL(url).pathname.slice(1)}_quick_lead_check`;
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
  console.log(failures === 0 ? "\nAll quick lead checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

async function scenario() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const quick = require("../src/actions/quick-lead") as typeof import("../src/actions/quick-lead");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const sa = await db.user.create({ data: { name: "Zz Super", email: "super@zzquick.invalid", role: "ADMIN", isSuperAdmin: true, passwordHash: "x".repeat(60) } });
  const item = await db.item.create({ data: { name: "Zz Licence", sku: "ZZ-Q1", type: "SUBSCRIPTION", sellingPrice: 100, createdById: sa.id } });
  actorId = sa.id;

  section("A new company, typed");
  const form = { companyName: "Zz Harbour Traders", contactName: "Zz Asha", phone: "+91 98765 43210", email: "", title: "Zz 20 licences", source: "CALLING" as const, requirements: [{ itemId: item.id, quantity: 20 }], requestId: "zz-quick-lead-0001" };
  const first = await quick.quickCreateLead(form);
  ok("saved", first.ok, first);
  if (!first.ok) return;
  const lead = await db.lead.findUnique({ where: { id: first.data.id }, select: { title: true, source: true, companyId: true, contactId: true, requirements: { select: { itemId: true, quantity: true } } } });
  const company = lead ? await db.company.findUnique({ where: { id: lead.companyId }, select: { name: true, contacts: { select: { id: true, name: true, phone: true } } } }) : null;
  ok("the company is made, with the person on it", company?.name === "Zz Harbour Traders" && company.contacts.length === 1 && company.contacts[0]!.id === lead?.contactId, company);
  ok("the lead has what they need, its source and its products", lead?.title === "Zz 20 licences" && lead.source === "CALLING" && lead.requirements.length === 1 && lead.requirements[0]!.quantity === 20, lead);

  section("Sent again");
  const again = await quick.quickCreateLead(form);
  ok("the same lead comes back", again.ok && again.data.id === first.data.id, again);
  ok("  and nothing was made twice", (await db.company.count({ where: { name: { startsWith: "Zz Harbour" } } })) === 1 && (await db.contact.count({ where: { name: "Zz Asha" } })) === 1 && (await db.lead.count({ where: { title: "Zz 20 licences" } })) === 1);

  section("A company that exists, a person already there");
  const existing = await quick.quickCreateLead({ companyName: "zz harbour TRADERS", contactName: "Asha (front desk)", phone: "9876543210", title: "Zz firewall renewal", requestId: "zz-quick-lead-0002" });
  const second = existing.ok ? await db.lead.findUnique({ where: { id: existing.data.id }, select: { companyId: true, contactId: true } }) : null;
  ok("the company is used, not made again", existing.ok && second?.companyId === lead!.companyId && (await db.company.count({ where: { name: { startsWith: "Zz Harbour" } } })) === 1, existing);
  ok("  and the person found by mobile", second?.contactId === lead!.contactId);

  const picked = await quick.quickCreateLead({ companyId: lead!.companyId, contactName: "Zz Ravi", email: "Ravi@Example.INVALID", title: "Zz backup", requestId: "zz-quick-lead-0003" });
  const again2 = await quick.quickCreateLead({ companyId: lead!.companyId, contactName: "Ravi K", email: "ravi@example.invalid", title: "Zz backup too", requestId: "zz-quick-lead-0004" });
  ok("a person found by email is not added twice", picked.ok && again2.ok && (await db.contact.count({ where: { companyId: lead!.companyId } })) === 2, { picked, again2 });

  section("Refused");
  const noName = await quick.quickCreateLead({ companyId: lead!.companyId, phone: "9000000000", title: "Zz nameless", requestId: "zz-quick-lead-0005" });
  ok("a mobile with no name", !noName.ok && /name/.test(noName.error), noName);
  const noCompany = await quick.quickCreateLead({ title: "Zz nowhere", requestId: "zz-quick-lead-0006" });
  ok("no company", !noCompany.ok, noCompany);

  section("The company's Leads tab");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const { CompanyLeads } = require("../src/components/leads/company-leads") as typeof import("../src/components/leads/company-leads");
  const { formatLeadId } = require("../src/lib/order-id") as typeof import("../src/lib/order-id");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const tab = renderToStaticMarkup(await CompanyLeads({ companyId: lead!.companyId, companyName: "Zz Harbour Traders", emptyMessage: "None" }));
  const seqs = (await db.lead.findMany({ where: { companyId: lead!.companyId }, select: { leadSeq: true } })).map((l) => formatLeadId(l.leadSeq));
  ok("every lead of the company, by its ID", seqs.length === 4 && seqs.every((id) => tab.includes(id)), seqs);
  ok("  with the person's email and phone, and the source", tab.includes("ravi@example.invalid") && tab.includes("98765") && tab.includes("Outbound call"));
  const quiet = await db.company.create({ data: { name: "Zz Quiet Co", normalizedName: "zz quiet co", relationshipType: "CLIENT", createdById: sa.id } });
  ok("  a company with none says so", renderToStaticMarkup(await CompanyLeads({ companyId: quiet.id, companyName: "Zz Quiet Co", emptyMessage: "No leads yet" })).includes("No leads yet"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
