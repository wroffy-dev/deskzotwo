/**
 * Import checks.
 *
 * These run against a real database because the property that matters cannot be checked any other
 * way: **the preview must describe the write**. A planner that reports "Stage: → CUSTOMER" and a
 * writer that ignores the Stage column both look correct in isolation and in a type check. What
 * exposes the disagreement is importing a file, importing it a second time, and finding that the
 * second run still wants to make changes — a file that has just been imported must be a no-op.
 *
 * Every area is put through the same five questions rather than each being spot-checked, because the
 * defect this catches is one an author is by definition not looking for:
 *
 *   1. Does planning write anything? (It must not — including lookup rows.)
 *   2. Do the creates land?
 *   3. Is re-importing the same file a no-op?          ← the convergence property
 *   4. Does exporting and re-importing change nothing? ← the round trip
 *   5. Are the rows that should be refused, refused, for the stated reason?
 *
 * And, for leads, whose (owner, 2 Nov 2026 — "Phase 1 security fixes", audit H-6): an importer who isn't the super
 * admin may change only the leads they may change, create only with "Create leads", hand a lead on only as the
 * reassign rules allow — and the preview never reads out a lead they can't see (`leadScopeChecks` below).
 *
 * And for the other CRM importers that match existing records — companies, contacts, tickets, visits (owner, 3 Nov
 * 2026 — "Phase 2 permission fixes", audit H-6 follow-up): a record out of the importer's sight answers as no such
 * record and nothing of it is in the preview; one they may see but not change is refused, saying so; a new one needs
 * what the screens ask to make one (`crmScopeChecks` below).
 *
 * Everything creates rows under a reserved prefix and removes them again, so it is safe to run
 * against a database with real data in it.
 */
import { db } from "../src/lib/db";
import { parseFile, plan, apply, TEMPLATE_COLUMNS } from "../src/lib/portability/import";
import { IMPLEMENTED_IMPORTS } from "../src/lib/portability/importers";
import { parseDate } from "../src/lib/portability/importers/types";
import { areaRows, toWorkbookBuffer, toCsv } from "../src/lib/portability/export";
import { EXPORTERS } from "../src/lib/portability/exporters";
import { PORTABLE_AREAS } from "../src/lib/portability/areas";

const PREFIX = "ZZImportCheck";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function note(text: string) {
  console.log(`  ..    ${text}`);
}

/** Turns rows-as-objects into the base64 CSV the import action receives. */
function csvOf(columns: string[], rows: Record<string, string>[]): string {
  const escape = (v: string) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const body = [columns.join(","), ...rows.map((r) => columns.map((c) => escape(r[c] ?? "")).join(","))];
  return Buffer.from(body.join("\n"), "utf8").toString("base64");
}

type Refusal = { label: string; row: Record<string, string>; expect: RegExp };

type Fixture = {
  area: string;
  /** Prerequisites — companies, users — created before the fixture rows are imported. */
  setup?: () => Promise<void>;
  rows: Record<string, string>[];
  /** How many of `rows` should create a record. The rest are expected refusals. */
  creates: number;
  /** One field edited, to prove an update is detected and its before/after shown. */
  edit?: { column: string; to: string; expectField: string };
  /**
   * The rows carry no key of their own, so re-importing the same file legitimately creates again —
   * a ticket or a visit has nothing to match on until it has been given a number. For those, the
   * convergence property is proven against the *exported* file, which does carry keys, and the
   * same-file check is skipped rather than quietly weakened.
   */
  keyedOnExportOnly?: boolean;
  refusals?: Refusal[];
  cleanup: () => Promise<void>;
};

// ── The lookup tables a planner might be tempted to write to ────────────────────────────────────
async function lookupCounts() {
  const [industries, brands, families, departments, accounts] = await Promise.all([
    db.industry.count(),
    db.brand.count(),
    db.productFamily.count(),
    db.department.count(),
    db.ledgerAccount.count(),
  ]);
  return { industries, brands, families, departments, accounts };
}

// ── The driver ──────────────────────────────────────────────────────────────────────────────────

async function runFixture(f: Fixture, actorUserId: string) {
  const columns = TEMPLATE_COLUMNS[f.area] ?? [];
  console.log(`\n— ${f.area} —\n`);

  if (columns.length === 0) {
    ok(`${f.area} has template columns`, false, "no importer registered");
    return;
  }

  await f.cleanup();
  if (f.setup) await f.setup();

  const file = csvOf(columns, f.rows);
  const parsed = await parseFile(file, "check.csv");

  // 1. Planning writes nothing.
  const before = await lookupCounts();
  const p1 = await plan(f.area, parsed, actorUserId);
  const after = await lookupCounts();
  ok(
    "planning writes nothing",
    JSON.stringify(before) === JSON.stringify(after),
    "a preview somebody abandons must leave no industries, brands or departments behind",
  );
  ok("  the file is understood", p1.unknownColumns.length === 0, p1.unknownColumns.join(", ") || `${columns.length} columns`);
  ok("  creates are counted", p1.creates === f.creates, `${p1.creates} creates, expected ${f.creates}`);
  if (p1.errors > 0) {
    note(`unexpected error rows: ${p1.rows.filter((r) => r.action === "error").map((r) => `line ${r.line}: ${r.error}`).join(" | ")}`);
  }
  ok("  with nothing unusable", p1.errors === 0);

  // 2. The creates land.
  const r1 = await apply(f.area, parsed, actorUserId);
  if (r1.failed.length) {
    note(`write failures: ${r1.failed.map((x) => `line ${x.line}: ${x.error}`).join(" | ")}`);
  }
  ok("applying creates the records", r1.created === f.creates && r1.failed.length === 0, `${r1.created} created, ${r1.failed.length} failed`);

  // 3. Re-importing is a no-op. The property everything rests on.
  if (f.keyedOnExportOnly) {
    note("rows carry no key of their own — convergence is checked against the exported file below");
  } else {
  const p2 = await plan(f.area, parsed, actorUserId);
  if (p2.creates + p2.updates > 0) {
    note(
      `still wants to change: ${p2.rows
        .filter((r) => r.action !== "skip")
        .map((r) => `${r.action} ${r.label} [${r.changes.map((c) => `${c.field}: ${c.from}→${c.to}`).join(", ")}]`)
        .join(" | ")}`,
    );
  }
  ok(
    "re-importing the same file is a no-op",
    p2.creates === 0 && p2.updates === 0,
    p2.creates + p2.updates === 0
      ? `${p2.skips} already match`
      : "the preview is describing a write that isn't happening — plan() and apply() disagree",
  );
  }

  // 4. Export, then import what was exported.
  if (EXPORTERS[f.area]) {
    const exported = await areaRows(actorUserId, f.area);
    if (exported.length === 0) {
      ok("  the exporter returns rows", false, "exported nothing after importing records");
    } else {
      const headings = Object.keys(exported[0]!);
      const missing = columns.filter((c) => !headings.includes(c));
      ok(
        "  every importable column is exported",
        missing.length === 0,
        missing.length ? `missing: ${missing.join(", ")}` : `${headings.length} columns`,
      );

      const workbook = await toWorkbookBuffer([{ name: f.area, rows: exported }], {
        title: f.area,
        by: "check",
        generatedAt: new Date(),
      });
      const reparsed = await parseFile(workbook.toString("base64"), "x.xlsx");
      const p3 = await plan(f.area, reparsed, actorUserId);
      if (p3.creates + p3.updates > 0) {
        note(
          `round trip differs: ${p3.rows
            .filter((r) => r.action !== "skip")
            .slice(0, 4)
            .map((r) => `${r.action} ${r.label} [${r.changes.map((c) => `${c.field}: ${c.from}→${c.to}`).join(", ")}]`)
            .join(" | ")}`,
        );
      }
      ok(
        "  an exported file re-imports unchanged",
        p3.creates === 0 && p3.updates === 0 && p3.errors === 0,
        p3.errors ? `${p3.errors} rows the exporter wrote cannot be read back` : `${p3.skips} already match`,
      );

      // CSV is the other half of the promise, and quotes and commas break it differently.
      const asCsv = Buffer.from(toCsv(exported), "utf8").toString("base64");
      const p4 = await plan(f.area, await parseFile(asCsv, "x.csv"), actorUserId);
      ok("  and so does the CSV", p4.creates === 0 && p4.updates === 0 && p4.errors === 0, `${p4.skips} match`);
    }
  }

  // 5. An edit shows as an edit, and only that field changes.
  if (f.edit) {
    const first = { ...f.rows[0]! };
    first[f.edit.column] = f.edit.to;
    const p5 = await plan(f.area, await parseFile(csvOf(columns, [first]), "x.csv"), actorUserId);
    ok("an edited cell is an update", p5.updates === 1, `${p5.updates} update, ${p5.errors} errors`);
    const changes = p5.rows[0]?.changes ?? [];
    ok(
      "  naming the field and both values",
      changes.length === 1 && changes[0]!.field === f.edit.expectField,
      changes.map((c) => `${c.field}: ${c.from}→${c.to}`).join(", ") || "no changes reported",
    );
  }

  // 6. What must be refused, is refused.
  for (const refusal of f.refusals ?? []) {
    const p = await plan(f.area, await parseFile(csvOf(columns, [refusal.row]), "x.csv"), actorUserId);
    const message = p.rows[0]?.error ?? "";
    ok(`refuses ${refusal.label}`, p.errors === 1 && refusal.expect.test(message), message || `action was "${p.rows[0]?.action}"`);
  }

  await f.cleanup();
}

// ── Everything the check creates, removed again ─────────────────────────────────────────────────
// One function rather than per-fixture teardown: it is idempotent, it runs before and after every
// fixture, and it means a fixture that fails half way through still leaves the database clean.

const MARK = "zzimportcheck";

async function cleanupAll() {
  const companies = await db.company.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  const probeUsers = await db.user.findMany({ where: { email: { contains: MARK } }, select: { id: true } });
  const userIds = probeUsers.map((u) => u.id);

  await db.expense.deleteMany({ where: { description: { startsWith: PREFIX } } });
  await db.asset.deleteMany({ where: { assetTag: { startsWith: PREFIX } } });
  await db.verifiableDocument.deleteMany({ where: { number: { startsWith: PREFIX } } });
  if (companyIds.length) {
    await db.visit.deleteMany({ where: { companyId: { in: companyIds } } });
    await db.ticket.deleteMany({ where: { companyId: { in: companyIds } } });
    await db.contact.deleteMany({ where: { companyId: { in: companyIds } } });
  }
  await db.workbookAssignee.deleteMany({ where: { workbook: { name: { startsWith: PREFIX } } } });
  await db.workbook.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.suppression.deleteMany({ where: { value: { contains: MARK } } });
  await db.candidate.deleteMany({ where: { email: { contains: MARK } } });
  await db.ledgerAccount.deleteMany({ where: { code: { contains: "ZZIC" }, isGroup: false } });
  await db.ledgerAccount.deleteMany({ where: { code: { contains: "ZZIC" } } });
  await db.item.deleteMany({ where: { sku: { contains: "ZZIC" } } });
  await db.productFamily.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.brand.deleteMany({ where: { name: { startsWith: PREFIX } } });
  if (companyIds.length) await db.company.deleteMany({ where: { id: { in: companyIds } } });
  if (userIds.length) {
    await db.employeeProfile.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.employeeProfile.deleteMany({ where: { employeeCode: { startsWith: "ZZIC" } } });
  await db.department.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.industry.deleteMany({ where: { name: { startsWith: PREFIX } } });
  // The leads import writes an audit line for each lead it makes or changes, the super admin's included (owner, 3 Nov 2026).
  await db.auditLog.deleteMany({ where: { entityType: "Lead", entityLabel: { startsWith: PREFIX } } });
}

/** The account most fixtures hang off. Created directly rather than through an importer. */
async function probeCompany(ownerUserId: string) {
  return db.company.upsert({
    where: { normalizedName: `${PREFIX.toLowerCase()} alpha` },
    update: {},
    create: {
      name: `${PREFIX} Alpha`,
      normalizedName: `${PREFIX.toLowerCase()} alpha`,
      relationshipType: "CLIENT",
      stage: "CUSTOMER",
      ownerUserId,
      createdById: ownerUserId,
    },
  });
}

/** A colleague for the columns that name somebody other than the importer. */
async function probeUser(name: string, role: "SALES" | "SUPPORT" = "SALES") {
  const email = `${MARK}.${name.toLowerCase().replace(/\W+/g, "")}@example.invalid`;
  return db.user.upsert({
    where: { email },
    update: {},
    create: { name: `${PREFIX} ${name}`, email, role, passwordHash: "x".repeat(60), active: true },
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

function fixtures(actor: { id: string; name: string }): Fixture[] {
  const owner = actor.name;

  return [
    {
      area: "companies",
      rows: [
        {
          Name: `${PREFIX} Alpha`,
          Stage: "customer",
          Source: "Referral",
          Industry: `${PREFIX} Industry`,
          Website: "https://alpha.test",
          "Account manager": owner,
        },
        { Name: `${PREFIX} Beta`, Stage: "LEAD", Source: "INBOUND", Website: "-dash-leading.test" },
      ],
      creates: 2,
      edit: { column: "Website", to: "https://changed.test", expectField: "Website" },
      refusals: [
        { label: "a row with no name", row: { Stage: "LEAD" }, expect: /Name is required/i },
        { label: "an unrecognised stage", row: { Name: `${PREFIX} Alpha`, Stage: "Custommer" }, expect: /isn't one of/i },
        {
          label: "an account manager who doesn't exist",
          row: { Name: `${PREFIX} Alpha`, "Account manager": "Nobody At All" },
          expect: /No active user matches/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "contacts",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          Name: `${PREFIX} Priya`,
          Company: `${PREFIX} Alpha`,
          Designation: "Purchase Manager",
          Email: `${MARK}.priya@example.invalid`,
          Phone: "9876543210",
        },
      ],
      creates: 1,
      edit: { column: "Phone", to: "9000000000", expectField: "Phone" },
      refusals: [
        {
          label: "a contact at an unknown company",
          row: { Name: "Orphan", Company: "No Such Company Ltd" },
          expect: /No company named/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      // As another CRM exports them: its stage words, its record ids, a company Deskzo doesn't have yet,
      // and an owner who isn't a Deskzo user (src/lib/portability/importers/leads.ts).
      area: "leads",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          "Old system ID": "ZZIC-L1",
          Title: `${PREFIX} Laptop refresh`,
          Company: `${PREFIX} Alpha`,
          Contact: `${PREFIX} Ravi`,
          "Contact email": `${MARK}.ravi@example.invalid`,
          Stage: "Proposal/Price Quote",
          Owner: owner,
          Value: "2,50,000",
          "Expected close": "15/12/2026",
          Source: "Web Site",
          Description: "From the old CRM",
        },
        {
          "Old system ID": "ZZIC-L2",
          Title: `${PREFIX} Firewall`,
          Company: `${PREFIX} Gamma Traders`,
          Contact: `${PREFIX} Meena`,
          Stage: "Closed Won",
          "Closed on": "2026-03-10",
          Value: "90000",
          Owner: "Somebody Who Left",
          Source: "Trade fair stall",
        },
      ],
      creates: 2,
      edit: { column: "Value", to: "260000", expectField: "Value" },
      refusals: [
        { label: "a won deal with no day it was won", row: { Title: "x", Company: `${PREFIX} Alpha`, Stage: "Closed Won" }, expect: /needs the day it was won/i },
        { label: "a stage nothing can place", row: { Title: "x", Company: `${PREFIX} Alpha`, Stage: "Banana" }, expect: /isn't one Deskzo can place/i },
        { label: "a lead key naming nothing", row: { Key: "LEAD-999999", Title: "x" }, expect: /No lead with key/i },
        // A row with no company gets one named after it (owner, 30 Oct 2026); only a row with nothing to name it after is refused.
        { label: "a lead with no company and nothing to name one after", row: { Stage: "Qualified", Value: "100" }, expect: /needs a company/i },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "items",
      rows: [
        {
          Name: `${PREFIX} Laptop`,
          SKU: "ZZIC-SKU-1",
          Type: "GOOD",
          Brand: `${PREFIX} Brand`,
          Family: `${PREFIX} Family`,
          Unit: "Nos",
          Price: "72500",
          "Tax %": "18",
        },
        // A part number Excel would read as a formula. This is the round-trip canary.
        { Name: `${PREFIX} Cable`, SKU: "-ZZIC-SKU-2", Type: "GOOD", Price: "450", "Tax %": "18" },
      ],
      creates: 2,
      edit: { column: "Price", to: "69999", expectField: "Price" },
      refusals: [
        { label: "an item key naming nothing", row: { Key: "ITM-999999", Name: "x" }, expect: /No item with key/i },
        { label: "an unrecognised type", row: { Name: "x", SKU: "ZZIC-SKU-9", Type: "Widget" }, expect: /isn't one of/i },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "suppression",
      rows: [
        { Scope: "EMAIL", Value: `${MARK}.optout@example.invalid`, Reason: "UNSUBSCRIBED", Added: "2026-01-15" },
        { Scope: "DOMAIN", Value: `${MARK}.example.invalid`, Reason: "MANUAL", Added: "2026-02-01", Expires: "2027-01-01" },
      ],
      creates: 2,
      refusals: [
        {
          label: "an unrecognised scope",
          row: { Scope: "PIGEON", Value: `${MARK}.x@example.invalid`, Reason: "MANUAL" },
          expect: /isn't one of/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "tickets",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          Company: `${PREFIX} Alpha`,
          Title: `${PREFIX} Printer offline`,
          Status: "OPEN",
          Priority: "HIGH",
          "Assigned to": owner,
          Raised: "2026-01-15",
        },
      ],
      creates: 1,
      // A blank key always creates — see the module comment. Convergence is proven by the round
      // trip below, where the exported file carries TKT- numbers.
      keyedOnExportOnly: true,
      refusals: [
        {
          label: "a ticket key naming nothing",
          row: { Ticket: "TKT-999999", Company: `${PREFIX} Alpha`, Title: "x" },
          expect: /No ticket|isn't a ticket/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "verifiable-documents",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          Number: `${PREFIX}-CERT-1`,
          Type: "Certificate",
          For: "ISO 9001:2015",
          "Issued to": `${PREFIX} Alpha`,
          "Issued on": "2026-01-15",
          "Valid until": "2029-01-14",
          Customer: `${PREFIX} Alpha`,
        },
      ],
      creates: 1,
      refusals: [{ label: "a new document with no type, title or holder", row: { Number: `${PREFIX}-CERT-2` }, expect: /required/ }],
      cleanup: cleanupAll,
    },

    {
      area: "visits",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          Company: `${PREFIX} Alpha`,
          By: owner,
          Purpose: "Product demo",
          Status: "COMPLETED",
          "Scheduled for": "2026-03-04",
          "Checked in": "2026-03-04",
          "Checked out": "2026-03-04",
          Address: "Sector 62, Noida",
          Outcome: `${PREFIX} demo went well`,
        },
      ],
      creates: 1,
      keyedOnExportOnly: true,
      refusals: [
        {
          label: "a checked-in visit with no check-in time",
          row: { Company: `${PREFIX} Alpha`, By: owner, Status: "CHECKED_IN", "Scheduled for": "2026-09-22" },
          expect: /check|time/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "assets",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          "Asset tag": `${PREFIX}-AST-1`,
          "Serial number": "ZZICSN0001",
          Name: `${PREFIX} ThinkPad`,
          Kind: "LAPTOP",
          Status: "ASSIGNED",
          Ownership: "CLIENT_OWNED",
          "Owner company": `${PREFIX} Alpha`,
          Custodian: owner,
          Make: "Lenovo",
          Model: "T14",
          "Warranty ends": "2027-06-30",
        },
      ],
      creates: 1,
      edit: { column: "Model", to: "T14s", expectField: "Model" },
      refusals: [
        {
          label: "an unrecognised kind",
          row: { "Asset tag": `${PREFIX}-AST-9`, Name: "x", Kind: "Toaster" },
          expect: /isn't one of/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "ledger",
      rows: [
        { Code: "ZZIC-100", Name: `${PREFIX} Current assets`, Type: "ASSET", Group: "yes", Active: "yes" },
        { Code: "ZZIC-110", Name: `${PREFIX} Petty cash`, Type: "ASSET", Parent: "ZZIC-100", Active: "yes" },
      ],
      creates: 2,
      edit: { column: "Name", to: `${PREFIX} Current assets (India)`, expectField: "Name" },
      refusals: [
        { label: "an unknown parent", row: { Code: "ZZIC-120", Name: "x", Type: "ASSET", Parent: "ZZIC-999" }, expect: /parent|ZZIC-999/i },
        { label: "an unrecognised account type", row: { Code: "ZZIC-130", Name: "x", Type: "Revenue" }, expect: /isn't one of/i },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "expenses",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          Person: owner,
          Category: "TRAVEL",
          Amount: "2450",
          Tax: "0",
          "Spent on": "2026-02-11",
          Description: `${PREFIX} cab to client site`,
          "Payment mode": "UPI",
          Reimbursable: "yes",
          Status: "SUBMITTED",
          Company: `${PREFIX} Alpha`,
        },
      ],
      creates: 1,
      keyedOnExportOnly: true,
      refusals: [
        {
          label: "a claim that was already reimbursed",
          row: {
            Person: owner,
            Category: "TRAVEL",
            Amount: "100",
            "Spent on": "2026-02-11",
            Description: `${PREFIX} already paid`,
            Status: "REIMBURSED",
          },
          expect: /reimburse|decid|approv/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "hiring",
      rows: [
        {
          Email: `${MARK}.candidate@example.invalid`,
          Name: `${PREFIX} Candidate`,
          Phone: "9811111111",
          Designation: "Sales Executive",
          Department: `${PREFIX} Sales`,
          "Employment type": "FULL_TIME",
          Status: "PROSPECT",
          Source: "Referral",
          Owner: owner,
          "Expected joining": "2026-05-01",
        },
      ],
      creates: 1,
      edit: { column: "Status", to: "OFFERED", expectField: "Status" },
      refusals: [
        { label: "an unrecognised status", row: { Email: `${MARK}.c2@example.invalid`, Name: "x", Status: "Maybe" }, expect: /isn't one of/i },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "people",
      setup: async () => void (await probeUser("Employee")),
      rows: [
        {
          User: `${PREFIX} Employee`,
          "Employee code": "ZZIC-EMP-1",
          Designation: "Sales Executive",
          "Employment type": "FULL_TIME",
          "Work location": "Noida",
          "Joined on": "2024-07-01",
          "Date of birth": "1995-03-12",
          Gender: "FEMALE",
          "Personal email": `${MARK}.personal@example.invalid`,
          "Personal phone": "9822222222",
          City: "Noida",
          State: "Uttar Pradesh",
        },
      ],
      creates: 1,
      edit: { column: "Work location", to: "Gurugram", expectField: "Work location" },
      refusals: [
        { label: "a profile for somebody with no account", row: { User: "Nobody At All" }, expect: /No (active )?user matches/i },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "users",
      rows: [
        {
          Name: `${PREFIX} Newjoiner`,
          Email: `${MARK}.newjoiner@example.invalid`,
          Role: "SALES",
          "Super admin": "false",
          Active: "true",
          Department: `${PREFIX} Sales`,
        },
      ],
      creates: 1,
      edit: { column: "Role", to: "SUPPORT", expectField: "Role" },
      refusals: [
        {
          label: "a row trying to grant super admin",
          row: {
            Name: `${PREFIX} Newjoiner`,
            Email: `${MARK}.newjoiner@example.invalid`,
            Role: "SALES",
            "Super admin": "true",
          },
          expect: /super admin/i,
        },
        {
          label: "a user key naming nothing",
          row: { Key: "USR-999999", Name: "x", Email: `${MARK}.x@example.invalid`, Role: "SALES" },
          expect: /No user|isn't a user/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "workspace",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          Name: `${PREFIX} Delhi manufacturers`,
          Description: "Cold calling list",
          Owner: owner,
          Shared: "yes",
          Mode: "LIST",
          Filters: JSON.stringify({ stage: ["LEAD"] }),
        },
      ],
      creates: 1,
      edit: { column: "Description", to: "Q2 calling list", expectField: "Description" },
      refusals: [
        {
          label: "filters that are not valid JSON",
          row: { Name: `${PREFIX} Broken`, Owner: owner, Filters: "{not json" },
          expect: /filter|json/i,
        },
      ],
      cleanup: cleanupAll,
    },
  ];
}

// ── Whose leads an import may touch (audit H-6) ─────────────────────────────────────────────────

/**
 * The leads importer as somebody other than the super admin: a salesperson holding "Import CRM data", who sees the
 * accounts they manage and nobody else's. A lead on the super admin's account is out of their sight — its Key answers
 * as a made-up one, and neither its Old system ID nor its title at its company matches it — and nothing of it is in
 * the preview. A lead they may see but not change is refused, saying so; a new lead needs "Create leads"; a new owner
 * needs the reassign rules. Their own lead they may change, and hand off once they may hand off their own.
 */
async function leadScopeChecks(superAdmin: { id: string; name: string }) {
  console.log("\n— leads: whose leads an import may touch (audit H-6) —\n");
  await cleanupAll();
  const columns = TEMPLATE_COLUMNS.leads ?? [];
  const fileOf = (row: Record<string, string>) => parseFile(csvOf(columns, [row]), "h6.csv");
  const planAs = async (userId: string, row: Record<string, string>) => (await plan("leads", await fileOf(row), userId)).rows[0];
  const applyAs = async (userId: string, row: Record<string, string>) => apply("leads", await fileOf(row), userId);
  const describe = (r: Awaited<ReturnType<typeof planAs>>) => (r ? `${r.action}${r.error ? `: ${r.error}` : ""}${r.changes.length ? ` [${r.changes.map((c) => `${c.field}: ${c.from}→${c.to}`).join(", ")}]` : ""}` : "no row");

  // The super admin's account, out of the importer's sight; the importer's own; and a colleague.
  const alpha = await probeCompany(superAdmin.id);
  const importer = await probeUser("H6 Importer");
  const colleague = await probeUser("H6 Colleague");
  const grants: Record<string, boolean> = {
    "data.importCrm": true,
    "leads.view": true,
    "leads.create": false,
    "companies.viewAll": false,
    "accounts.reassign": false,
    "accounts.handOffOwn": false,
    "leads.assign": false,
    "section.companies": true,
  };
  await db.userPermission.createMany({ data: Object.entries(grants).map(([permission, allowed]) => ({ userId: importer.id, permission, allowed, reason: PREFIX })) });
  const grant = (permission: string, allowed: boolean) => db.userPermission.updateMany({ where: { userId: importer.id, permission }, data: { allowed } });
  const beta = await db.company.create({
    data: { name: `${PREFIX} H6 Beta`, normalizedName: `${PREFIX.toLowerCase()} h6 beta`, relationshipType: "CLIENT", stage: "CUSTOMER", ownerUserId: importer.id, createdById: importer.id },
    select: { id: true, name: true },
  });
  const lead = (title: string, companyId: string, ownerUserId: string, extra: { estimatedValue?: number; externalId?: string; description?: string } = {}) =>
    db.lead.create({ data: { title, companyId, ownerUserId, createdByUserId: superAdmin.id, ...extra }, select: { id: true, leadSeq: true, title: true } });
  const SECRET_VALUE = 424242;
  const SECRET_TEXT = "zz-h6 nobody outside may read this";
  const hidden = await lead(`${PREFIX} H6 Hidden deal`, alpha.id, superAdmin.id, { estimatedValue: SECRET_VALUE, externalId: "ZZIC-H6-1", description: SECRET_TEXT });
  const theirs = await lead(`${PREFIX} H6 Colleague deal`, beta.id, colleague.id);
  const mine = await lead(`${PREFIX} H6 My deal`, beta.id, importer.id);
  const key = (seq: number) => `LEAD-${String(seq).padStart(6, "0")}`;
  const stateOf = async (id: string) => JSON.stringify(await db.lead.findUnique({ where: { id }, select: { title: true, estimatedValue: true, description: true, ownerUserId: true, companyId: true, externalId: true } }));
  // What the preview must never carry of a lead out of sight: its value, its description, whose it is.
  const leaks = (r: unknown) => {
    const text = JSON.stringify(r);
    return [String(SECRET_VALUE), SECRET_VALUE.toLocaleString("en-IN"), SECRET_TEXT, superAdmin.name].some((v) => text.includes(v));
  };
  const hiddenBefore = await stateOf(hidden.id);

  // By Key: the same answer as a made-up key, and nothing of it in the preview.
  const byKey = await planAs(importer.id, { Key: key(hidden.leadSeq), Value: "1", Description: "probe" });
  const madeUp = await planAs(importer.id, { Key: "LEAD-999999", Value: "1", Description: "probe" });
  ok(
    "a lead out of the importer's sight: its Key answers as a made-up one does",
    byKey?.action === "error" && /No lead with key/.test(byKey.error ?? "") && byKey.error?.replace(key(hidden.leadSeq), "") === madeUp?.error?.replace("LEAD-999999", ""),
    describe(byKey),
  );
  ok("  and the preview carries none of its values", !!byKey && byKey.changes.length === 0 && !leaks(byKey), describe(byKey));
  const keyApplied = await applyAs(importer.id, { Key: key(hidden.leadSeq), Value: "1", Description: "probe" });
  ok("  applying it changes nothing", keyApplied.updated === 0 && keyApplied.failed.length === 1 && (await stateOf(hidden.id)) === hiddenBefore, JSON.stringify(keyApplied.failed));

  // By Old system ID and by title at its company: no match — so the row would create, which needs "Create leads".
  const byOldId = await planAs(importer.id, { "Old system ID": "ZZIC-H6-1", Title: `${PREFIX} H6 probe`, Company: beta.name, Value: "1", Description: "probe" });
  ok("  its Old system ID doesn't match it — the row would create a lead, and without Create leads it's refused", byOldId?.action === "error" && /can't create leads/.test(byOldId.error ?? "") && !leaks(byOldId), describe(byOldId));
  const byTitle = await planAs(importer.id, { Title: hidden.title, Company: `${PREFIX} Alpha`, Value: "1", Description: "probe" });
  ok("  nor does its title at its company", byTitle?.action === "error" && /can't create leads/.test(byTitle.error ?? "") && !leaks(byTitle), describe(byTitle));
  const oldIdApplied = await applyAs(importer.id, { "Old system ID": "ZZIC-H6-1", Title: `${PREFIX} H6 probe`, Company: beta.name, Value: "1" });
  ok("  applying either writes nothing", oldIdApplied.created + oldIdApplied.updated === 0 && (await stateOf(hidden.id)) === hiddenBefore && (await db.lead.count({ where: { title: `${PREFIX} H6 probe` } })) === 0);

  // Seen but not changeable: their Leads edit level is their own leads only.
  await db.userAccessLevel.createMany({
    data: (["edit", "delete", "assign"] as const).map((action) => ({ userId: importer.id, record: "leads", action, level: "OWN" as const, reason: PREFIX })),
  });
  const theirsBefore = await stateOf(theirs.id);
  const seenOnly = await planAs(importer.id, { Key: key(theirs.leadSeq), Value: "5" });
  ok("a colleague's lead they may see but not change is refused, saying so", seenOnly?.action === "error" && /may see but not change/.test(seenOnly.error ?? ""), describe(seenOnly));
  const seenApplied = await applyAs(importer.id, { Key: key(theirs.leadSeq), Value: "5" });
  ok("  and left as it was", seenApplied.updated === 0 && (await stateOf(theirs.id)) === theirsBefore, JSON.stringify(seenApplied.failed));
  const ownPlanned = await planAs(importer.id, { Key: key(mine.leadSeq), Value: "777" });
  ok("their own lead they may change", ownPlanned?.action === "update" && ownPlanned.changes.some((c) => c.field === "Value"), describe(ownPlanned));
  const ownApplied = await applyAs(importer.id, { Key: key(mine.leadSeq), Value: "777" });
  ok("  and it is changed", ownApplied.updated === 1 && Number((await db.lead.findUnique({ where: { id: mine.id }, select: { estimatedValue: true } }))?.estimatedValue) === 777, JSON.stringify(ownApplied.failed));

  // A new owner: the reassign rules.
  const handOff = { Key: key(mine.leadSeq), Owner: colleague.name };
  const noRight = await planAs(importer.id, handOff);
  ok("handing their own lead to a colleague without a hand-off right is refused", noRight?.action === "error" && /can't change who/.test(noRight.error ?? ""), describe(noRight));
  await applyAs(importer.id, handOff);
  ok("  and it stays theirs", (await db.lead.findUnique({ where: { id: mine.id }, select: { ownerUserId: true } }))?.ownerUserId === importer.id);
  await grant("accounts.handOffOwn", true);
  const withRight = await planAs(importer.id, handOff);
  ok("  with Hand off your own, it goes", withRight?.action === "update" && withRight.changes.some((c) => c.field === "Owner"), describe(withRight));
  const handedOff = await applyAs(importer.id, handOff);
  ok("  and is the colleague's now", handedOff.updated === 1 && (await db.lead.findUnique({ where: { id: mine.id }, select: { ownerUserId: true } }))?.ownerUserId === colleague.id, JSON.stringify(handedOff.failed));
  // Every lead on their account is theirs to change again — but handing on only their own.
  await db.userAccessLevel.deleteMany({ where: { userId: importer.id, record: "leads" } });
  const notTheirs = await planAs(importer.id, { Key: key(theirs.leadSeq), Owner: importer.name });
  ok("  but not a colleague's lead, even one they may change", notTheirs?.action === "error" && /only leads you own/.test(notTheirs.error ?? ""), describe(notTheirs));
  ok("    which stays the colleague's", (await stateOf(theirs.id)) === theirsBefore);

  // Creating, once they may.
  await grant("leads.create", true);
  const created = await planAs(importer.id, { Title: `${PREFIX} H6 New deal`, Company: beta.name });
  ok("with Create leads, a new lead is planned", created?.action === "create", describe(created));

  // Whose company, and who owns a new lead (owner, 3 Nov 2026 — "Phase 2 permission fixes", audit H-6 follow-up).
  const alphaLeads = () => db.lead.count({ where: { companyId: alpha.id } });
  const alphaBefore = await alphaLeads();
  const onAlpha = { Title: `${PREFIX} H6 On alpha`, Company: alpha.name };
  const onHidden = await planAs(importer.id, onAlpha);
  ok("a new lead on an account out of the importer's sight is refused", onHidden?.action === "error" && /company you can't open/.test(onHidden.error ?? "") && !leaks(onHidden), describe(onHidden));
  const onHiddenApplied = await applyAs(importer.id, onAlpha);
  ok("  and applying it makes nothing there", onHiddenApplied.created === 0 && (await alphaLeads()) === alphaBefore, JSON.stringify(onHiddenApplied.failed));
  const movable = await lead(`${PREFIX} H6 Movable deal`, beta.id, importer.id);
  const moveToAlpha = { Key: key(movable.leadSeq), Company: alpha.name };
  const moving = await planAs(importer.id, moveToAlpha);
  ok("  nor may their own lead move to it", moving?.action === "error" && /can't open, so a lead can't move to it/.test(moving.error ?? ""), describe(moving));
  await applyAs(importer.id, moveToAlpha);
  ok("    and it stays where it was", (await db.lead.findUnique({ where: { id: movable.id }, select: { companyId: true } }))?.companyId === beta.id);
  await grant("section.companies", false);
  const newCompany = await planAs(importer.id, { Title: `${PREFIX} H6 Fresh deal`, Company: `${PREFIX} H6 Brand new` });
  ok("a row that would create a company needs what New company needs", newCompany?.action === "error" && /can't create companies/.test(newCompany.error ?? ""), describe(newCompany));
  await grant("section.companies", true);
  const newCompanyOk = await planAs(importer.id, { Title: `${PREFIX} H6 Fresh deal`, Company: `${PREFIX} H6 Brand new` });
  ok("  and with it, the company and the lead are planned", newCompanyOk?.action === "create" && newCompanyOk.changes.some((c) => c.field === "Company" && /new company/.test(c.to)), describe(newCompanyOk));
  const forColleague = { Title: `${PREFIX} H6 For a colleague`, Company: beta.name, Owner: colleague.name };
  const assigned = await planAs(importer.id, forColleague);
  ok("a new lead's Owner may name somebody else only for whoever may assign leads", assigned?.action === "error" && /can't assign leads to other people/.test(assigned.error ?? ""), describe(assigned));
  const assignedApplied = await applyAs(importer.id, forColleague);
  ok("  and applying it makes nothing", assignedApplied.created === 0 && (await db.lead.count({ where: { title: forColleague.Title } })) === 0, JSON.stringify(assignedApplied.failed));
  const forSelf = await planAs(importer.id, { ...forColleague, Owner: importer.name });
  ok("  naming themselves is fine", forSelf?.action === "create", describe(forSelf));
  await grant("leads.assign", true);
  const assignable = await planAs(importer.id, forColleague);
  ok("  and with Assign leads, so is the colleague", assignable?.action === "create" && assignable.changes.some((c) => c.field === "Owner" && c.to.includes(colleague.name)), describe(assignable));
  ok("the super admin's lead out of sight is untouched throughout", (await stateOf(hidden.id)) === hiddenBefore);

  await cleanupAll();
}

// ── Whose companies, contacts, tickets and visits an import may touch (audit H-6 follow-up) ─────────────────

/**
 * The companies, contacts, tickets and visits importers as a salesperson holding "Import CRM data", who sees the
 * accounts they manage and nobody else's: the super admin's account and everything on it is out of their sight. Its
 * contact, ticket and visit answer by key as made-up ones do, its name is refused without a value of it, and nothing
 * of any of them reaches the preview. Levels narrowing edit below view make records seen but not changeable, refused;
 * and making one needs what the screens ask.
 */
async function crmScopeChecks(superAdmin: { id: string; name: string }) {
  console.log("\n— companies, contacts, tickets and visits: whose records an import may touch (audit H-6 follow-up) —\n");
  await cleanupAll();
  const fileOf = (area: string, row: Record<string, string>, extra: string[] = []) => parseFile(csvOf([...(TEMPLATE_COLUMNS[area] ?? []), ...extra], [row]), "crm.csv");
  const planAs = async (userId: string, area: string, row: Record<string, string>, extra: string[] = []) => (await plan(area, await fileOf(area, row, extra), userId)).rows[0];
  const applyAs = async (userId: string, area: string, row: Record<string, string>) => apply(area, await fileOf(area, row), userId);
  const describe = (r: Awaited<ReturnType<typeof planAs>>) => (r ? `${r.action}${r.error ? `: ${r.error}` : ""}${r.changes.length ? ` [${r.changes.map((c) => `${c.field}: ${c.from}→${c.to}`).join(", ")}]` : ""}${r.notice ? ` (${r.notice})` : ""}` : "no row");
  const sameAnswer = (a: Awaited<ReturnType<typeof planAs>>, b: Awaited<ReturnType<typeof planAs>>, real: string, madeUp: string) =>
    a?.action === "error" && b?.action === "error" && (a.error ?? "").replace(real, "") === (b.error ?? "").replace(madeUp, "");
  const pad = (prefix: string, seq: number) => `${prefix}-${String(seq).padStart(6, "0")}`;

  // The super admin's account, out of sight, with a contact, a ticket and a visit on it that nobody else may read.
  const SECRET = "zz-crm nobody outside may read this";
  const alpha = await probeCompany(superAdmin.id);
  await db.company.update({ where: { id: alpha.id }, data: { website: "https://zz-crm-secret.test" } });
  const secretContact = await db.contact.create({ data: { companyId: alpha.id, name: `${PREFIX} Crm Secret person`, email: `${MARK}.crmsecret@example.invalid`, phone: "9800000007" }, select: { id: true, contactSeq: true } });
  const secretTicket = await db.ticket.create({ data: { title: `${PREFIX} ${SECRET}`, companyId: alpha.id, createdByUserId: superAdmin.id, assignedToUserId: superAdmin.id, status: "OPEN" }, select: { id: true, ticketSeq: true } });
  const secretVisit = await db.visit.create({ data: { companyId: alpha.id, userId: superAdmin.id, scheduledFor: new Date("2026-02-02T04:30:00Z"), outcome: SECRET }, select: { id: true, visitSeq: true } });
  const leaks = (r: unknown) => {
    const text = JSON.stringify(r);
    return [SECRET, "zz-crm-secret.test", `${MARK}.crmsecret`, "9800000007", "Crm Secret person", superAdmin.name].some((v) => text.includes(v));
  };

  const importer = await probeUser("Crm Importer");
  const colleague = await probeUser("Crm Colleague");
  const grants: Record<string, boolean> = {
    "data.importCrm": true,
    "companies.viewAll": false,
    "contacts.view": true,
    "tickets.view": true,
    "tickets.create": false,
    "visits.view": true,
    "section.companies": true,
  };
  await db.userPermission.createMany({ data: Object.entries(grants).map(([permission, allowed]) => ({ userId: importer.id, permission, allowed, reason: PREFIX })) });
  const grant = (permission: string, allowed: boolean) => db.userPermission.updateMany({ where: { userId: importer.id, permission }, data: { allowed } });
  // Every record but view set narrower — only the actions each record has (src/lib/authz/access.ts).
  const ACTIONS: Record<string, ("view" | "edit" | "delete" | "assign")[]> = {
    companies: ["view", "edit", "delete", "assign"],
    contacts: ["view", "edit", "delete", "assign"],
    tickets: ["view", "edit", "assign"],
    visits: ["view", "edit", "delete"],
  };
  const levels = async (record: string, view: "ALL" | null, narrower: "OWN" | "NONE") => {
    await db.userAccessLevel.deleteMany({ where: { userId: importer.id, record } });
    if (!view) return;
    await db.userAccessLevel.createMany({
      data: ACTIONS[record]!.map((action) => ({ userId: importer.id, record, action, level: action === "view" ? view : narrower, reason: PREFIX })),
    });
  };
  // The importer's own account, and a colleague's ticket and visit on it.
  const mine = await db.company.create({
    data: { name: `${PREFIX} Crm Mine`, normalizedName: `${PREFIX.toLowerCase()} crm mine`, relationshipType: "CLIENT", stage: "CUSTOMER", ownerUserId: importer.id, createdById: importer.id },
    select: { id: true, name: true },
  });
  const theirTicket = await db.ticket.create({ data: { title: `${PREFIX} Crm Colleague ticket`, companyId: mine.id, createdByUserId: colleague.id, assignedToUserId: colleague.id, status: "OPEN" }, select: { id: true, ticketSeq: true } });
  const theirVisit = await db.visit.create({ data: { companyId: mine.id, userId: colleague.id, scheduledFor: new Date("2026-02-03T04:30:00Z") }, select: { id: true, visitSeq: true } });
  const stateOf = async () =>
    JSON.stringify([
      await db.company.findUnique({ where: { id: alpha.id }, select: { website: true, name: true } }),
      await db.contact.findUnique({ where: { id: secretContact.id }, select: { name: true, email: true, phone: true } }),
      await db.ticket.findUnique({ where: { id: secretTicket.id }, select: { title: true, status: true } }),
      await db.visit.findUnique({ where: { id: secretVisit.id }, select: { outcome: true, status: true } }),
      await db.ticket.findUnique({ where: { id: theirTicket.id }, select: { title: true } }),
      await db.visit.findUnique({ where: { id: theirVisit.id }, select: { outcome: true } }),
    ]);
  const before = await stateOf();

  // ── Companies ──
  const alphaRow = { Name: alpha.name, Website: "https://probe.test" };
  const alphaPlanned = await planAs(importer.id, "companies", alphaRow);
  ok("companies: a company out of sight is refused, saying only that the name is taken", alphaPlanned?.action === "error" && /already a company called .* that you can't open/.test(alphaPlanned.error ?? "") && !leaks(alphaPlanned), describe(alphaPlanned));
  const alphaApplied = await applyAs(importer.id, "companies", alphaRow);
  ok("  and applying it writes nothing to it", alphaApplied.updated + alphaApplied.created === 0 && (await stateOf()) === before, JSON.stringify(alphaApplied.failed));
  await levels("companies", "ALL", "OWN");
  const seenCompany = await planAs(importer.id, "companies", alphaRow);
  ok("  one they may see but not change is refused, saying so", seenCompany?.action === "error" && /may see but not change/.test(seenCompany.error ?? ""), describe(seenCompany));
  await levels("companies", null, "OWN");
  await grant("section.companies", false);
  const freshRow = { Name: `${PREFIX} Crm Fresh` };
  const noCreate = await planAs(importer.id, "companies", freshRow);
  ok("  a new one needs what New company needs", noCreate?.action === "error" && /can't create companies/.test(noCreate.error ?? ""), describe(noCreate));
  const noCreateApplied = await applyAs(importer.id, "companies", freshRow);
  ok("    and applying it makes none", noCreateApplied.created === 0 && (await db.company.count({ where: { name: freshRow.Name } })) === 0, JSON.stringify(noCreateApplied.failed));
  await grant("section.companies", true);
  ok("    with it, the company is planned", (await planAs(importer.id, "companies", freshRow))?.action === "create");
  // A vendor code another company holds is named only to whoever may open that company.
  await db.company.update({ where: { id: alpha.id }, data: { vendorCode: "ZZCRM-V1" } });
  const codeTaken = await planAs(importer.id, "vendors", { Name: `${PREFIX} Crm Vendor`, "Vendor code": "ZZCRM-V1" });
  ok("  a vendor code held out of sight is refused without naming who holds it", codeTaken?.action === "error" && /is another company's/.test(codeTaken.error ?? "") && !(codeTaken.error ?? "").includes(alpha.name), describe(codeTaken));
  await grant("contacts.view", false);
  const person = await planAs(importer.id, "companies", { Name: mine.name, "First Name": "Zz", "Last Name": "Probe", Email: `${MARK}.crmperson@example.invalid` }, ["First Name", "Last Name", "Email"]);
  ok("  the row's person is left out without contacts, and the preview says so", person?.action !== "error" && !person?.changes.some((c) => c.field === "Contact") && /left out/.test(person?.notice ?? ""), describe(person));
  await grant("contacts.view", true);

  // ── Contacts ──
  const conKey = pad("CON", secretContact.contactSeq);
  const conRow = { Key: conKey, Name: `${PREFIX} probe`, Company: mine.name, Email: `${MARK}.probe@example.invalid` };
  const conHidden = await planAs(importer.id, "contacts", conRow);
  const conMadeUp = await planAs(importer.id, "contacts", { ...conRow, Key: "CON-999999" });
  // The contacts import names a key unpadded (CON-813) in its answer.
  ok("contacts: a contact out of sight answers by Key as a made-up one does", sameAnswer(conHidden, conMadeUp, `CON-${secretContact.contactSeq}`, "CON-999999") && !leaks(conHidden), describe(conHidden));
  const conApplied = await applyAs(importer.id, "contacts", conRow);
  ok("  and applying it changes nothing", conApplied.updated === 0 && (await stateOf()) === before, JSON.stringify(conApplied.failed));
  const atAlpha = await planAs(importer.id, "contacts", { Name: `${PREFIX} probe`, Company: alpha.name, Email: `${MARK}.crmsecret@example.invalid` });
  const atNowhere = await planAs(importer.id, "contacts", { Name: `${PREFIX} probe`, Company: `${PREFIX} Nowhere`, Email: `${MARK}.crmsecret@example.invalid` });
  ok("  a company out of sight answers as a name nobody has", sameAnswer(atAlpha, atNowhere, alpha.name, `${PREFIX} Nowhere`) && !leaks(atAlpha), describe(atAlpha));
  await levels("contacts", "ALL", "NONE");
  const conSeen = await planAs(importer.id, "contacts", conRow);
  ok("  one they may see but not change is refused, saying so", conSeen?.action === "error" && /may see but not change/.test(conSeen.error ?? ""), describe(conSeen));
  const conNew = await planAs(importer.id, "contacts", { Name: `${PREFIX} Crm New person`, Company: mine.name });
  ok("  a new one needs the company's contacts open to edit, as adding one does", conNew?.action === "error" && /can't add contacts at/.test(conNew.error ?? ""), describe(conNew));
  await levels("contacts", null, "NONE");
  ok("    and with them, it is planned", (await planAs(importer.id, "contacts", { Name: `${PREFIX} Crm New person`, Company: mine.name }))?.action === "create");
  await grant("contacts.view", false);
  const noContacts = await planAs(importer.id, "contacts", { Name: `${PREFIX} Crm New person`, Company: mine.name });
  ok("  and without contacts at all, nothing is", noContacts?.action === "error" && /access to contacts/.test(noContacts.error ?? ""), describe(noContacts));
  await grant("contacts.view", true);

  // ── Tickets ──
  const tktKey = pad("TKT", secretTicket.ticketSeq);
  const tktRow = { Ticket: tktKey, Company: mine.name, Title: `${PREFIX} probe`, Status: "CLOSED" };
  const tktHidden = await planAs(importer.id, "tickets", tktRow);
  const tktMadeUp = await planAs(importer.id, "tickets", { ...tktRow, Ticket: "TKT-999999" });
  ok("tickets: a ticket out of sight answers by key as a made-up one does", sameAnswer(tktHidden, tktMadeUp, tktKey, "TKT-999999") && !leaks(tktHidden), describe(tktHidden));
  const tktApplied = await applyAs(importer.id, "tickets", tktRow);
  ok("  and applying it changes nothing", tktApplied.updated === 0 && (await stateOf()) === before, JSON.stringify(tktApplied.failed));
  await levels("tickets", "ALL", "OWN");
  const tktSeen = await planAs(importer.id, "tickets", { Ticket: pad("TKT", theirTicket.ticketSeq), Company: mine.name, Title: `${PREFIX} probe` });
  ok("  a colleague's they may see but not change is refused, saying so", tktSeen?.action === "error" && /may see but not change/.test(tktSeen.error ?? ""), describe(tktSeen));
  await levels("tickets", null, "OWN");
  const tktNew = { Company: mine.name, Title: `${PREFIX} Crm New ticket` };
  const tktNoCreate = await planAs(importer.id, "tickets", tktNew);
  ok("  a new one needs Create tickets", tktNoCreate?.action === "error" && /can't create tickets/.test(tktNoCreate.error ?? ""), describe(tktNoCreate));
  const tktNoCreateApplied = await applyAs(importer.id, "tickets", tktNew);
  ok("    and applying it raises none", tktNoCreateApplied.created === 0 && (await db.ticket.count({ where: { title: tktNew.Title } })) === 0, JSON.stringify(tktNoCreateApplied.failed));
  await grant("tickets.create", true);
  ok("    with it, the ticket is planned", (await planAs(importer.id, "tickets", tktNew))?.action === "create");

  // ── Visits ──
  const visKey = pad("VIS", secretVisit.visitSeq);
  const visRow = { Visit: visKey, Company: mine.name, By: importer.name, Outcome: `${PREFIX} probe` };
  const visHidden = await planAs(importer.id, "visits", visRow);
  const visMadeUp = await planAs(importer.id, "visits", { ...visRow, Visit: "VIS-999999" });
  ok("visits: a visit out of sight answers by key as a made-up one does", sameAnswer(visHidden, visMadeUp, visKey, "VIS-999999") && !leaks(visHidden), describe(visHidden));
  const visApplied = await applyAs(importer.id, "visits", visRow);
  ok("  and applying it changes nothing", visApplied.updated === 0 && (await stateOf()) === before, JSON.stringify(visApplied.failed));
  await levels("visits", "ALL", "OWN");
  const visSeen = await planAs(importer.id, "visits", { Visit: pad("VIS", theirVisit.visitSeq), Company: mine.name, By: colleague.name, Outcome: `${PREFIX} probe` });
  ok("  a colleague's they may see but not change is refused, saying so", visSeen?.action === "error" && /may see but not change/.test(visSeen.error ?? ""), describe(visSeen));
  await levels("visits", null, "OWN");
  const visForColleague = { Company: mine.name, By: colleague.name, "Scheduled for": "2026-02-09" };
  const visOther = await planAs(importer.id, "visits", visForColleague);
  ok("  a new one only for themselves or somebody on their team, as planning one asks", visOther?.action === "error" && /only log visits for yourself or someone on your team/.test(visOther.error ?? ""), describe(visOther));
  const visOtherApplied = await applyAs(importer.id, "visits", visForColleague);
  ok("    and applying it logs none", visOtherApplied.created === 0 && (await db.visit.count({ where: { companyId: mine.id, userId: colleague.id } })) === 1, JSON.stringify(visOtherApplied.failed));
  ok("    for themselves, it is planned", (await planAs(importer.id, "visits", { ...visForColleague, By: importer.name }))?.action === "create");

  ok("everything out of sight is untouched throughout", (await stateOf()) === before);
  await cleanupAll();
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const actor = await db.user.findFirst({
    where: { active: true, isSuperAdmin: true },
    select: { id: true, name: true },
  });
  if (!actor) throw new Error("No active super admin. Run npm run db:bootstrap first.");

  console.log(`\nImporting as ${actor.name}\n`);
  console.log("— Wiring —\n");

  const importable = PORTABLE_AREAS.filter((a) => a.importPermission !== null).map((a) => a.key);
  ok(
    "Every built importer belongs to an importable area",
    IMPLEMENTED_IMPORTS.every((k) => importable.includes(k)),
    IMPLEMENTED_IMPORTS.filter((k) => !importable.includes(k)).join(", ") ||
      "an importer on an export-only area would be a button that refuses on click",
  );
  const notBuilt = importable.filter((k) => !IMPLEMENTED_IMPORTS.includes(k));
  ok(
    "Every importable area has an importer",
    notBuilt.length === 0,
    notBuilt.length ? `${notBuilt.join(", ")} would show a disabled button` : `${IMPLEMENTED_IMPORTS.length} importers`,
  );

  // A day-first date with a time after it, as old systems export a moment (owner, 30 Oct 2026): the day as written.
  console.log("\n— Dates with a time —\n");
  const day = (raw: string) => {
    const r = parseDate("Created on", raw);
    return r.value ? r.value.toISOString().slice(0, 10) : `error: ${r.error}`;
  };
  ok("26-05-2025 17.26 — the time by a dot — is 26 May 2025", day("26-05-2025 17.26") === "2025-05-26", day("26-05-2025 17.26"));
  ok("  03-06-2025 17:51 — by a colon — is 3 June 2025", day("03-06-2025 17:51") === "2025-06-03", day("03-06-2025 17:51"));
  ok("  with seconds and a.m./p.m., by either", day("27/05/2025 10.59.30 AM") === "2025-05-27" && day("27/05/2025 10:59:30 pm") === "2025-05-27");
  ok("  a bare day still reads", day("26-05-2025") === "2025-05-26");
  ok("  a month past 12 is still refused, time or not", day("13-13-2025 17.26").startsWith("error"));

  const all = fixtures(actor);
  const covered = new Set(all.map((f) => f.area));
  const uncovered = IMPLEMENTED_IMPORTS.filter((k) => !covered.has(k) && !["customers", "vendors", "resellers", "commission-parties"].includes(k));
  ok(
    "Every importer has a fixture here",
    uncovered.length === 0,
    uncovered.length ? `untested: ${uncovered.join(", ")}` : `${covered.size} areas exercised`,
  );

  await cleanupAll();
  for (const f of all) {
    try {
      await runFixture(f, actor.id);
    } catch (err) {
      ok(`${f.area} ran to completion`, false, err instanceof Error ? err.message : String(err));
      await cleanupAll();
    }
  }
  try {
    await leadScopeChecks(actor);
  } catch (err) {
    ok("leads scope checks ran to completion", false, err instanceof Error ? err.message : String(err));
  }
  try {
    await crmScopeChecks(actor);
  } catch (err) {
    ok("CRM scope checks ran to completion", false, err instanceof Error ? err.message : String(err));
  }
  await cleanupAll();

  console.log(failures === 0 ? "\nAll import checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanupAll().catch(() => {});
  process.exit(1);
});
