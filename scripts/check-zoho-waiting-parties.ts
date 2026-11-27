/**
 * check:zoho-waiting-parties — "Bring these from Zoho" on a section's waiting rows (owner, 26 Nov 2026: six open quotes
 * waiting for customers added in Zoho after the customers came across).
 *
 * Against a Zoho that answers from this script: the names the waiting rows wait for, once each; each found by name,
 * read in full and brought in as the master lists bring Zoho's customers — a new one made with its office and people,
 * one Deskzo has by GSTIN joined to it, one Zoho hasn't said so; kept as an import of its own that undoes cleanly; and
 * the action is the super admin's. A migration, its file and the companies are made here and removed.
 *
 *   npm run check:zoho-waiting-parties
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; role: string; name: string; email: string } | null = null;
const calls: string[] = [];
const TAG = "Zzprobe zwp";
const GSTIN_KNOWN = "07ZZPRB1234Z1Z5";
type J = Record<string, unknown>;
const zohoContacts: J[] = [
  {
    contact_id: "9900000000001",
    contact_name: `${TAG} Dailus Retail Private Limited`,
    company_name: `${TAG} Dailus Retail Private Limited`,
    gst_no: "",
    billing_address: { address: "1 Probe Road", city: "Gurugram", state_code: "HR", country: "India", zip: "122001" },
    contact_persons: [
      { contact_person_id: "9900000000101", first_name: "Asha", last_name: "Probe", email: "asha@zzprobe-zwp.invalid", is_primary_contact: "true" },
      { contact_person_id: "9900000000102", first_name: "Ravi", last_name: "Probe", email: "ravi@zzprobe-zwp.invalid" },
    ],
  },
  { contact_id: "9900000000002", contact_name: `${TAG} Kataria Dental Clinic`, company_name: "", gst_no: GSTIN_KNOWN, billing_address: { state_code: "DL", country: "India" }, contact_persons: [] },
];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "./client" && String((parent as { filename?: string })?.filename ?? "").includes("waiting-parties")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      loadConnection: async () => ({ refreshToken: "x" }),
      zohoGet: async (path: string, query: Record<string, string> = {}) => {
        calls.push(`${path} ${JSON.stringify(query)}`);
        if (path === "/contacts") {
          const wanted = String(query.contact_name ?? query.search_text ?? "").toLowerCase();
          return { contacts: zohoContacts.filter((c) => String(c.contact_name).toLowerCase().includes(wanted)).map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== "contact_persons"))) };
        }
        const id = path.split("/").pop();
        return { contact: zohoContacts.find((c) => c.contact_id === id) };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { bringWaitingParties, waitingNames } = require("../src/lib/zoho/waiting-parties") as typeof import("../src/lib/zoho/waiting-parties");
  const { bringWaitingFromZoho } = require("../src/actions/migration") as typeof import("../src/actions/migration");
  const { undoPart } = require("../src/lib/legacy-import/undo") as typeof import("../src/lib/legacy-import/undo");
  const { openMigration } = require("../src/lib/migration/state") as typeof import("../src/lib/migration/state");

  console.log("\n— The names —\n");
  const wait = (error: string, waitFor: "customers" | "vendors" | "invoices" = "customers") => ({ line: 2, key: "QT", error, unit: 0, waitFor });
  const names = waitingNames(
    [
      wait('No company named "Fawia". Import Companies first, or correct the spelling.'),
      wait('No company named "fawia ". Import Companies first.'),
      wait('No customer named "Aorom Technology Pvt Ltd".'),
      wait('No vendor named "Some Vendor".', "vendors"),
      wait("Invoice INV-1 isn't in Deskzo.", "invoices"),
    ],
    "customers",
  );
  ok("each customer a section waits for, once, in order", JSON.stringify(names) === JSON.stringify(["Fawia", "Aorom Technology Pvt Ltd"]), names);

  if (await openMigration()) {
    console.log("\n  ..   a migration is open here — the rest needs a database without one");
    await db.$disconnect();
    process.exit(failures ? 1 : 0);
  }

  const owner = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true, role: true, name: true, email: true } });
  const clean = async () => {
    const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await db.contact.deleteMany({ where: { companyId: { in: companies } } });
    await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
    await db.legacyImport.deleteMany({ where: { source: "zoho", createdById: owner.id, files: { some: { name: "Contacts.csv", chunks: { some: { rows: { string_contains: TAG } } } } } } }).catch(() => {});
    await db.migration.deleteMany({ where: { source: TAG } });
    await db.user.deleteMany({ where: { role: "ZZPROBE_ZWP" } });
    await db.rolePermission.deleteMany({ where: { role: "ZZPROBE_ZWP" } });
    await db.role.deleteMany({ where: { key: "ZZPROBE_ZWP" } });
  };
  await clean();
  try {
    const known = await db.company.create({ data: { name: `${TAG} Kataria Dental Clinic (Delhi)`, normalizedName: `${TAG} kataria dental clinic delhi`.toLowerCase(), relationshipType: "CLIENT", createdById: owner.id }, select: { id: true } });
    await db.companyLocation.create({ data: { companyId: known.id, label: "Head office", gstNumber: GSTIN_KNOWN, isPrimary: true, isBilling: true } });
    const m = await db.migration.create({ data: { source: TAG, yearStart: new Date("2026-04-01"), switchDate: new Date("2026-11-01"), createdById: owner.id }, select: { id: true } });
    const err = (name: string) => `No company named "${name}". Import Companies first, or correct the spelling.`;
    const file = await db.migrationFile.create({
      data: {
        migrationId: m.id,
        step: "quotes",
        filename: "Quote.csv",
        rows: [],
        units: 3,
        createdById: owner.id,
        failures: [
          { line: 2, key: "QT-1", error: err(`${TAG} Dailus Retail Private Limited`), unit: 0, waitFor: "customers" },
          { line: 3, key: "QT-2", error: err(`${TAG} Kataria Dental Clinic`), unit: 1, waitFor: "customers" },
          { line: 4, key: "QT-3", error: err(`${TAG} Nobody At All`), unit: 2, waitFor: "customers" },
          { line: 5, key: "QT-4", error: err(`${TAG} Dailus Retail Private Limited`), unit: 3, waitFor: "customers" },
        ],
      },
      select: { id: true },
    });

    console.log("\n— Who may —\n");
    // Somebody who may bring the year across — posting and importing finance data — but isn't the super admin.
    await db.role.create({ data: { key: "ZZPROBE_ZWP", name: "Zzprobe zwp" } });
    for (const permission of ["ledger.post", "data.importFinance", "section.accounting"]) await db.rolePermission.create({ data: { role: "ZZPROBE_ZWP", permission, allowed: true } });
    actor = await db.user.create({ data: { name: `${TAG} accountant`, email: "acc@zzprobe-zwp.invalid", role: "ZZPROBE_ZWP", passwordHash: "x".repeat(60) }, select: { id: true, role: true, name: true, email: true } });
    const refused = await bringWaitingFromZoho(file.id, "customers");
    ok("an accountant who isn't the super admin is refused", !refused.ok && /super admin/.test(refused.error), refused.ok ? "" : refused.error);
    ok("  and Zoho isn't asked", calls.length === 0);

    console.log("\n— Bringing them —\n");
    const row = (await openMigration())!;
    const got = await bringWaitingParties(row, file.id, "customers", owner.id);
    ok("three names asked, once each", got.asked === 3, got);
    ok("one new in Deskzo", JSON.stringify(got.created) === JSON.stringify([`${TAG} Dailus Retail Private Limited`]));
    ok("one Deskzo had by its GSTIN, joined to it", JSON.stringify(got.linked) === JSON.stringify([`${TAG} Kataria Dental Clinic`]));
    ok("one Zoho hasn't by that name, said so", JSON.stringify(got.notInZoho) === JSON.stringify([`${TAG} Nobody At All`]) && got.failed.length === 0 && !got.busy);
    ok("Zoho asked by name, then each found one read in full", calls.some((c) => c.includes("contact_name")) && calls.filter((c) => c.startsWith("/contacts/")).length === 2, calls);
    const made = await db.company.findFirst({ where: { name: `${TAG} Dailus Retail Private Limited` }, select: { id: true, relationshipType: true, stage: true, locations: { select: { city: true, isBilling: true } }, contacts: { select: { name: true, isPrimary: true }, orderBy: { name: "asc" } } } });
    ok("  made a customer, with its office", !!made && made.relationshipType === "CLIENT" && made.stage === "CUSTOMER" && made.locations.some((l) => l.city === "Gurugram" && l.isBilling), made);
    ok("  and its people", !!made && made.contacts.length >= 2 && made.contacts.some((c) => c.isPrimary), made?.contacts);
    ok("the one Deskzo had is not made twice", (await db.company.count({ where: { name: { contains: `${TAG} Kataria` } } })) === 1);
    const run = got.importId ? await db.legacyImport.findUnique({ where: { id: got.importId }, select: { status: true, source: true, _count: { select: { files: true } } } }) : null;
    ok("kept as an import of its own, finished", run?.status === "DONE" && run.source === "zoho" && run._count.files === 2, run);
    ok("  with Zoho's ids logged, so the next pull passes them over", (await db.legacyImportRecord.count({ where: { importId: got.importId!, kind: "zoho_contacts", oldId: { in: ["9900000000001", "9900000000002"] } } })) === 2);
    ok("  and in the audit log", (await db.auditLog.count({ where: { entityType: "LegacyImport", entityId: got.importId! } })) === 1);

    const again = await bringWaitingParties(row, file.id, "customers", owner.id);
    ok("pressed again, nothing is made twice", again.created.length === 0 && (await db.company.count({ where: { name: `${TAG} Dailus Retail Private Limited` } })) === 1, again);

    console.log("\n— Undone —\n");
    for (const id of [again.importId, got.importId].filter(Boolean) as string[]) await undoPart(id, 20_000);
    ok("undoing the import takes the new customer away", (await db.company.count({ where: { name: `${TAG} Dailus Retail Private Limited` } })) === 0);
    ok("  and leaves the one Deskzo had", (await db.company.count({ where: { id: known.id } })) === 1);
  } finally {
    await clean();
    ok("nothing of the probe's is left", (await db.company.count({ where: { name: { startsWith: TAG } } })) === 0 && (await db.migration.count({ where: { source: TAG } })) === 0);
  }

  await db.$disconnect();
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
