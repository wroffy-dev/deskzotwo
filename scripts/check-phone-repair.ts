/**
 * That the phones Excel shortened are put back from the original file, and nothing else moves
 * (src/lib/leads/phone-repair.ts; owner, 30 Oct 2026 — 13,979 leads came in as 9.20E+11).
 *
 * Its own fixture: leads and contacts with shortened phones, one matched by old system ID, one by email, one the file
 * has nothing for, one whose email the file gives two phones, and one healthy phone that must not change. Counts are
 * read for the fixture alone, as the database may hold other shortened phones.
 *
 *   npm run check:phone-repair
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { applyPhoneRepair, planPhoneRepair } from "../src/lib/leads/phone-repair";
import { RowReader } from "../src/lib/portability/importers/types";

const TAG = "ZZPROBE_PHONEFIX";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function main() {
  console.log("\n— The import refuses a shortened phone —\n");
  const r = new RowReader({ Phone: "9.20E+11" });
  ok("9.20E+11 is refused, saying how to fix the file", r.phone("Phone") === "" && /shortened by Excel/.test(String((r as unknown as { failure: string }).failure)));
  ok("  a whole number is kept as typed", new RowReader({ Phone: "+91 98765 43210" }).phone("Phone") === "+91 98765 43210");

  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  const pipeline = await db.leadPipeline.findFirst({ select: { id: true } }).catch(() => null);

  const created = { companies: [] as string[], contacts: [] as string[], leads: [] as string[] };
  try {
    const company = await db.company.create({
      data: { name: `${TAG} Supply Valid`, normalizedName: `${TAG.toLowerCase()} supply valid`, createdById: admin.id, ownerUserId: admin.id },
      select: { id: true },
    });
    created.companies.push(company.id);
    const contact = async (name: string, email: string | null, phone: string) => {
      const c = await db.contact.create({ data: { companyId: company.id, name: `${TAG} ${name}`, email, phone, createdByUserId: admin.id }, select: { id: true } });
      created.contacts.push(c.id);
      return c.id;
    };
    const byId = await contact("Rakesh", `rakesh.${TAG.toLowerCase()}@example.com`, "9.20E+11");
    const byEmail = await contact("Avtar", `avtar.${TAG.toLowerCase()}@example.com`, "9.19E+11");
    const missing = await contact("Jaydeep", `jaydeep.${TAG.toLowerCase()}@example.com`, "9.12E+11");
    const twice = await contact("Twice", `twice.${TAG.toLowerCase()}@example.com`, "9.18E+11");
    const healthy = await contact("Healthy", `healthy.${TAG.toLowerCase()}@example.com`, "+91 98111 22233");
    const lead = await db.lead.create({
      data: { title: `${TAG} lead`, companyId: company.id, contactId: byId, externalId: `${TAG}-OLD-1`, ownerUserId: admin.id, ...(pipeline ? { pipelineId: pipeline.id } : {}) },
      select: { id: true },
    });
    created.leads.push(lead.id);

    const file = [
      { "Old system ID": `${TAG}-OLD-1`, "Contact email": "someone.else@example.com", "Contact phone": "919876543210" },
      { "Old system ID": "", "Contact email": `AVTAR.${TAG.toLowerCase()}@example.com`, "Contact phone": "+91 99887 76655" },
      { "Old system ID": "", "Contact email": `twice.${TAG.toLowerCase()}@example.com`, "Contact phone": "9811111111" },
      { "Old system ID": "", "Contact email": `twice.${TAG.toLowerCase()}@example.com`, "Contact phone": "9822222222" },
      { "Old system ID": "", "Contact email": `healthy.${TAG.toLowerCase()}@example.com`, "Contact phone": "9000000000" },
    ];

    console.log("\n— The preview —\n");
    const refused = await planPhoneRepair([{ "Contact email": "a@b.com", "Contact phone": "9.20E+11" }], created.contacts);
    ok("A file still holding 9.20E+11 is refused", "error" in refused && /shortened too/.test(refused.error));
    // Kept to the fixture: the database may hold other shortened phones, which a check must never change.
    const plan = await planPhoneRepair(file, created.contacts);
    if ("error" in plan) throw new Error(plan.error);
    const mine = new Set(created.contacts);
    const ours = plan.sample.filter((f) => mine.has(f.contactId));
    ok("The old system ID match comes first", ours.some((f) => f.contactId === byId && f.by === "old system ID" && f.to.replace(/\D/g, "").endsWith("9876543210")), JSON.stringify(ours.find((f) => f.contactId === byId)));
    ok("  then email, ignoring case", ours.some((f) => f.contactId === byEmail && f.by === "email"));
    ok("  an email with two phones is left", !ours.some((f) => f.contactId === twice) && plan.ambiguous >= 1);
    ok("  a healthy phone is never a candidate", !ours.some((f) => f.contactId === healthy));

    console.log("\n— Putting them back —\n");
    const applied = await applyPhoneRepair(file, admin.id, true, created.contacts);
    if ("error" in applied) throw new Error(applied.error);
    const after = Object.fromEntries((await db.contact.findMany({ where: { id: { in: created.contacts } }, select: { id: true, phone: true } })).map((c) => [c.id, c.phone]));
    ok("Matched by old system ID: put back", (after[byId] ?? "").replace(/\D/g, "").endsWith("9876543210"), after[byId]);
    ok("Matched by email: put back", (after[byEmail] ?? "").replace(/\D/g, "").endsWith("9988776655"), after[byEmail]);
    ok("Not in the file, clearing asked: cleared", after[missing] === null, after[missing]);
    ok("Two phones for one email: cleared too, as not fixable", after[twice] === null, after[twice]);
    ok("The healthy phone is untouched", after[healthy] === "+91 98111 22233", after[healthy]);
    const again = await planPhoneRepair(file, created.contacts);
    ok("Run again, nothing of the fixture is left to fix", !("error" in again) && !again.sample.some((f) => mine.has(f.contactId)));
  } finally {
    if (created.leads.length) await db.lead.deleteMany({ where: { id: { in: created.leads } } });
    if (created.contacts.length) await db.contact.deleteMany({ where: { id: { in: created.contacts } } });
    if (created.companies.length) await db.company.deleteMany({ where: { id: { in: created.companies } } });
  }

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll phone repair checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
