/**
 * Deleting every lead to import them again (owner, 30 Oct 2026 — src/lib/leads/delete-all.ts), and the fresh import
 * putting back a contact's phone Excel had shortened (src/lib/portability/importers/leads.ts).
 *
 * Its own fixture only: the batches are kept to its own leads (`only`), so the database's real leads are never
 * touched, and the backup — a whole-database pg_dump — is not taken here. Everything it makes it removes.
 *
 *   npm run check:delete-all-leads
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { CONFIRM_WORDS, deleteLeadBatch } from "../src/lib/leads/delete-all";
import { apply, plan } from "../src/lib/portability/import";

const TAG = "ZZPROBE_DELALL";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function main() {
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true, name: true } });
  if (!admin) throw new Error("no super admin to act as");
  ok("The words to type are spelled out", CONFIRM_WORDS === "DELETE ALL LEADS");

  const created = { companies: [] as string[], contacts: [] as string[], leads: [] as string[] };
  try {
    const company = await db.company.create({
      data: { name: `${TAG} Sova Solar`, normalizedName: `${TAG.toLowerCase()} sova solar`, createdById: admin.id, ownerUserId: admin.id },
      select: { id: true },
    });
    created.companies.push(company.id);
    const email = `it.${TAG.toLowerCase()}@example.com`;
    const contact = await db.contact.create({ data: { companyId: company.id, name: `${TAG} IT`, email, phone: "9.19E+11", createdByUserId: admin.id }, select: { id: true } });
    created.contacts.push(contact.id);
    for (let i = 1; i <= 7; i++) {
      const lead = await db.lead.create({ data: { title: `${TAG} old lead ${i}`, companyId: company.id, contactId: contact.id, ownerUserId: admin.id }, select: { id: true } });
      created.leads.push(lead.id);
    }
    const before = await db.lead.count();

    console.log("\n— Deleting, a batch at a time —\n");
    const first = await deleteLeadBatch(admin.id, 5, created.leads);
    ok("A batch takes its size", first.deleted === 5 && first.left === 2, JSON.stringify(first));
    const second = await deleteLeadBatch(admin.id, 5, created.leads);
    ok("  the next takes the rest", second.deleted === 2 && second.left === 0, JSON.stringify(second));
    const third = await deleteLeadBatch(admin.id, 5, created.leads);
    ok("  and then there is nothing left to take", third.deleted === 0);
    ok("No lead outside the fixture was touched", (await db.lead.count()) === before - 7);
    ok("The company and contact stay", !!(await db.company.findUnique({ where: { id: company.id } })) && !!(await db.contact.findUnique({ where: { id: contact.id } })));

    console.log("\n— The fresh import puts the phone back —\n");
    const result = await apply("leads", [{ Title: `${TAG} fresh lead`, Company: `${TAG} Sova Solar`, Contact: `${TAG} IT`, "Contact email": email, "Contact phone": "+91 91900 11223" }], admin.id);
    ok("The lead is imported", result.created === 1 && result.failed.length === 0, JSON.stringify(result.failed));
    created.leads.push(...(await db.lead.findMany({ where: { title: `${TAG} fresh lead` }, select: { id: true } })).map((l) => l.id));
    const fixed = await db.contact.findUniqueOrThrow({ where: { id: contact.id }, select: { phone: true } });
    ok("  onto the contact already there, whose shortened phone is put back", fixed.phone === "+91 91900 11223", fixed.phone);
    ok("  without a second contact", (await db.contact.count({ where: { companyId: company.id } })) === 1);

    await db.contact.update({ where: { id: contact.id }, data: { phone: "+91 98000 00000" } });
    await apply("leads", [{ Title: `${TAG} another lead`, Company: `${TAG} Sova Solar`, Contact: `${TAG} IT`, "Contact email": email, "Contact phone": "+91 91900 99999" }], admin.id);
    created.leads.push(...(await db.lead.findMany({ where: { title: `${TAG} another lead` }, select: { id: true } })).map((l) => l.id));
    const kept = await db.contact.findUniqueOrThrow({ where: { id: contact.id }, select: { phone: true } });
    ok("A phone that isn't shortened is never replaced", kept.phone === "+91 98000 00000", kept.phone);

    console.log("\n— A won deal with no close date, and the same file twice —\n");
    // As the NIDO Machineries row came: won, no Closed on or Expected close, no title, no old system ID.
    const won = [{ Company: `${TAG} Sova Solar`, Stage: "Closed Won", "Created on": "2025-06-14", "Contact email": email }];
    const once = await apply("leads", won, admin.id);
    ok("It is imported, not refused", once.created === 1 && once.failed.length === 0, JSON.stringify(once.failed));
    const wonLead = await db.lead.findFirst({ where: { companyId: company.id, title: `${TAG} Sova Solar` }, select: { id: true, stageChangedAt: true } });
    if (wonLead) created.leads.push(wonLead.id);
    ok("  won on the day it was created, not today", wonLead?.stageChangedAt?.toISOString().slice(0, 10) === "2025-06-13" || wonLead?.stageChangedAt?.toISOString().slice(0, 10) === "2025-06-14", wonLead?.stageChangedAt?.toISOString());
    const twice = await apply("leads", won, admin.id);
    ok("The same row again makes no second lead", twice.created === 0 && (await db.lead.count({ where: { companyId: company.id, title: `${TAG} Sova Solar` } })) === 1, JSON.stringify(twice));
    const modified = await apply("leads", [{ Title: `${TAG} modified deal`, Company: `${TAG} Sova Solar`, Stage: "Closed Won", "Modified Time": "2025-09-02", "Created on": "2025-01-05" }], admin.id);
    const modLead = await db.lead.findFirst({ where: { title: `${TAG} modified deal` }, select: { id: true, stageChangedAt: true } });
    if (modLead) created.leads.push(modLead.id);
    console.log("\n— A large file, a window at a time —\n");
    const many = Array.from({ length: 7 }, (_, i) => ({ Title: `${TAG} window ${i + 1}`, Company: `${TAG} Sova Solar` }));
    many[4] = { Title: "", Company: "", Stage: "Banana" } as never; // row 6 of the file: nothing to name a company after
    const whole = await plan("leads", many, admin.id);
    const parts = [await plan("leads", many, admin.id, { from: 0, count: 3 }), await plan("leads", many, admin.id, { from: 3, count: 3 }), await plan("leads", many, admin.id, { from: 6, count: 3 })];
    ok("The windows together are the whole file", parts.reduce((t, p) => t + p.rows.length, 0) === whole.rows.length && parts.every((p) => p.totalRows === 7));
    ok("  each row keeps its own row number", parts.flatMap((p) => p.rows.map((r) => r.line)).join(",") === "2,3,4,5,6,7,8");
    const firstHalf = await apply("leads", many, admin.id, { from: 0, count: 4 });
    const rest = await apply("leads", many, admin.id, { from: 4, count: 4 });
    created.leads.push(...(await db.lead.findMany({ where: { title: { startsWith: `${TAG} window` } }, select: { id: true } })).map((l) => l.id));
    ok("Imported in two windows: six in, one failed", firstHalf.created + rest.created === 6 && firstHalf.failed.length + rest.failed.length === 1, JSON.stringify({ firstHalf, rest }));
    ok("  the failed row says which row it was and carries its cells", rest.failed[0]?.line === 6 && rest.failed[0]?.row?.Stage === "Banana", JSON.stringify(rest.failed[0]));

    console.log("\n— A row with no company —\n");
    const orphan = [{ Title: `${TAG} Karyarambh Digital`, Contact: `${TAG} Owner`, "Contact email": `owner.${TAG.toLowerCase()}@example.com` }];
    const noCo = await apply("leads", orphan, admin.id);
    const madeCo = await db.company.findFirst({ where: { name: `${TAG} Karyarambh Digital (no company)` }, select: { id: true } });
    if (madeCo) created.companies.push(madeCo.id);
    const orphanLead = await db.lead.findFirst({ where: { title: `${TAG} Karyarambh Digital` }, select: { id: true, companyId: true } });
    if (orphanLead) created.leads.push(orphanLead.id);
    ok("It is imported, at a company named for it and marked (no company)", noCo.created === 1 && !!madeCo && orphanLead?.companyId === madeCo.id, JSON.stringify(noCo.failed));
    const noCoAgain = await apply("leads", orphan, admin.id);
    ok("  again, no second lead or company", noCoAgain.created === 0 && (await db.company.count({ where: { name: { startsWith: `${TAG} Karyarambh` } } })) === 1);
    const titledRow = await apply("leads", [{ Title: `${TAG} Sova Solar`, Stage: "Qualified", "Contact email": `buyer.${TAG.toLowerCase()}@example.com` }], admin.id);
    const titledLead = await db.lead.findFirst({ where: { title: `${TAG} Sova Solar`, contact: { email: `buyer.${TAG.toLowerCase()}@example.com` } }, select: { id: true, companyId: true } });
    if (titledLead) created.leads.push(titledLead.id);
    ok("A title that is a company already here goes to that company", titledRow.created === 1 && titledLead?.companyId === company.id, JSON.stringify(titledRow.failed));
    ok("A modified date, where the file has one, is taken before the created date", modified.created === 1 && ["2025-09-01", "2025-09-02"].includes(modLead?.stageChangedAt?.toISOString().slice(0, 10) ?? ""), modLead?.stageChangedAt?.toISOString());
  } finally {
    if (created.leads.length) await db.lead.deleteMany({ where: { id: { in: created.leads } } });
    await db.contact.deleteMany({ where: { companyId: { in: created.companies } } });
    if (created.companies.length) await db.company.deleteMany({ where: { id: { in: created.companies } } });
  }

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll delete-all-leads checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
