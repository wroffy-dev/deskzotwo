/**
 * check:ticket-contacts — a company's people on New ticket (owner, 25 Nov 2026: support "can't see the contacts person
 * added on that company? also to if no contact person added option to add one there only").
 *
 * Whoever may log a ticket on a company they see gets its people's names, even with no Contacts access, and may add
 * one; nobody else gains anything, and the address book itself stays shut. The role, people and companies are made
 * here and removed.
 *
 *   npm run check:ticket-contacts
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; role: string; name: string; email: string } | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
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
  const ticket = require("../src/actions/ticket") as typeof import("../src/actions/ticket");
  const { companyContactOptions } = require("../src/actions/company-options") as typeof import("../src/actions/company-options");
  const { addContact, contactFieldSetup } = require("../src/actions/company") as typeof import("../src/actions/company");

  const ROLE = "ZZPROBE_TCON";
  const NAMES = { startsWith: "Zzprobe tcon" };
  const clean = async () => {
    const companies = (await db.company.findMany({ where: { name: NAMES }, select: { id: true } })).map((c) => c.id);
    const people = (await db.user.findMany({ where: { role: ROLE }, select: { id: true } })).map((u) => u.id);
    await db.ticket.deleteMany({ where: { companyId: { in: companies } } });
    await db.auditLog.deleteMany({ where: { userId: { in: people } } });
    await db.contact.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
    await db.user.deleteMany({ where: { id: { in: people } } });
    await db.role.deleteMany({ where: { key: ROLE } });
  };
  await clean();
  try {
    const owner = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
    await db.role.create({ data: { key: ROLE, name: "Zzprobe tcon" } });
    for (const [permission, allowed] of [["tickets.view", true], ["tickets.create", true], ["companies.viewAll", true], ["contacts.view", false], ["contacts.directory", false]] as const) {
      await db.rolePermission.create({ data: { role: ROLE, permission, allowed } });
    }
    await db.roleAccessLevel.create({ data: { role: ROLE, record: "companies", action: "edit", level: "NONE" } });
    const tickets = (level: "ALL" | "NONE") =>
      Promise.all(["view", "edit"].map((action) => db.roleAccessLevel.upsert({ where: { role_record_action: { role: ROLE, record: "tickets", action } }, create: { role: ROLE, record: "tickets", action, level }, update: { level } })));
    let n = 0;
    // A new person each time: what somebody may do is remembered for a while.
    const person = () => {
      n += 1;
      return db.user.create({ data: { name: `Zzprobe tcon ${n}`, email: `tcon-${n}@zzprobe-tcon.invalid`, role: ROLE, passwordHash: "x".repeat(60) }, select: { id: true, role: true, name: true, email: true } });
    };
    const make = (name: string) => db.company.create({ data: { name: `Zzprobe tcon ${name}`, normalizedName: `zzprobe tcon ${name}`, relationshipType: "CLIENT", ownerUserId: owner.id, createdById: owner.id } as never, select: { id: true } });
    const full = await make("full");
    const empty = await make("empty");
    const meera = await db.contact.create({ data: { companyId: full.id, name: "Meera Probe", email: "meera@zzprobe-tcon.invalid", phone: "9000000000", isPrimary: true } });
    await db.contact.create({ data: { companyId: full.id, name: "Anil Probe" } });
    await db.contact.create({ data: { companyId: full.id, name: "Gone Probe", leftAt: new Date() } });

    console.log("\n— Support that logs tickets, with no Contacts access —\n");
    await tickets("ALL");
    actor = await person();
    ok("the Contacts rule alone gives them nobody", (await companyContactOptions(full.id)).length === 0);
    const seen = await ticket.listTicketContacts(full.id);
    ok("New ticket gives them the company's people, primary first", seen.contacts.map((c) => c.name).join() === "Meera Probe,Anil Probe", seen.contacts.map((c) => c.name));
    ok("  one who has left isn't offered", !seen.contacts.some((c) => c.name === "Gone Probe"));
    ok("  names and designations only", seen.contacts.every((c) => Object.keys(c).sort().join() === "designation,id,name"));
    ok("  and may add one", seen.mayAdd);
    const none = await ticket.listTicketContacts(empty.id);
    ok("a company with nobody says so, and may be added to", none.contacts.length === 0 && none.mayAdd);

    console.log("\n— Adding one from there —\n");
    ok("the Contacts rule's own way is still shut", !(await addContact(empty.id, { name: "Back Door" })).ok && (await contactFieldSetup()).fields.length === 0);
    const added = await ticket.addTicketContact(empty.id, { name: "  Ravi Probe ", email: "ravi@zzprobe-tcon.invalid", phone: "9000000001", isPrimary: true, receivesDocuments: true });
    ok("one is added", added.ok, added.ok ? "" : added.error);
    if (added.ok) {
      const row = await db.contact.findUniqueOrThrow({ where: { id: added.data.id }, select: { name: true, companyId: true, isPrimary: true, receivesDocuments: true, createdByUserId: true, phone: true } });
      ok("  to that company, by them", row.companyId === empty.id && row.createdByUserId === actor.id && row.name === "Ravi Probe" && row.phone === "9000000001");
      ok("  never as primary, nor sent documents, whatever was posted", !row.isPrimary && !row.receivesDocuments);
      ok("  in the audit log", (await db.auditLog.count({ where: { userId: actor.id, entityType: "Contact", entityId: added.data.id, action: "CREATE" } })) === 1);
      ok("  offered from then on", (await ticket.listTicketContacts(empty.id)).contacts.some((c) => c.id === added.data.id));
      const made = await ticket.createTicket({ companyId: empty.id, contactId: added.data.id, title: "Zzprobe tcon", ticketType: "PRODUCT_SUPPORT", priority: "MEDIUM" });
      ok("  and a ticket is logged for them", made.ok, made.ok ? "" : made.error);
    }
    const again = await ticket.addTicketContact(full.id, { name: "meera probe" });
    ok("the same name again is picked, not added twice", !again.ok && /name/.test(again.error), again.ok ? "" : again.error);
    const mail = await ticket.addTicketContact(full.id, { name: "Somebody Else", email: "MEERA@zzprobe-tcon.invalid" });
    ok("the same email again, too — without saying whose", !mail.ok && /email/.test(mail.error) && !mail.error.includes("Meera"), mail.ok ? "" : mail.error);
    const back = await ticket.addTicketContact(full.id, { name: "Gone Probe" });
    ok("somebody who had left may be added afresh", back.ok, back.ok ? "" : back.error);
    const blank = await ticket.addTicketContact(full.id, { name: "  " });
    ok("a name is needed", !blank.ok);
    ok("a company that isn't there is not found", !(await ticket.addTicketContact("zz-none", { name: "X" })).ok && (await ticket.listTicketContacts("zz-none")).contacts.length === 0);

    console.log("\n— Nobody else gains anything —\n");
    await tickets("NONE");
    actor = await person();
    const shut = await ticket.listTicketContacts(full.id);
    ok("one who may not log tickets there: no people, no adding", shut.contacts.length === 0 && !shut.mayAdd);
    const refused = await ticket.addTicketContact(full.id, { name: "Not Me" });
    ok("  and is told why", !refused.ok && /can't add tickets/.test(refused.error), refused.ok ? "" : refused.error);

    await tickets("ALL");
    await db.rolePermission.updateMany({ where: { role: ROLE, permission: "tickets.create" }, data: { allowed: false } });
    actor = await person();
    ok("one without Create tickets: the same", (await ticket.listTicketContacts(full.id)).contacts.length === 0 && !(await ticket.addTicketContact(full.id, { name: "Not Me" })).ok);
    ok("  nor the workspace's contact fields", (await ticket.ticketContactFieldSetup()).fields.length === 0);

    await db.rolePermission.updateMany({ where: { role: ROLE, permission: "tickets.create" }, data: { allowed: true } });
    await db.rolePermission.updateMany({ where: { role: ROLE, permission: "companies.viewAll" }, data: { allowed: false } });
    actor = await person();
    const unseen = await ticket.listTicketContacts(full.id);
    ok("tickets at All doesn't reach a company they can't see", unseen.contacts.length === 0 && !unseen.mayAdd);
    const missing = await ticket.addTicketContact(full.id, { name: "Not Me" });
    ok("  which reads as not found", !missing.ok && missing.error === "Company not found.", missing.ok ? "" : missing.error);
    ok("no contact was made by any of these", (await db.contact.count({ where: { companyId: full.id, name: "Not Me" } })) === 0);
    ok("the first contact is as it was", (await db.contact.findUniqueOrThrow({ where: { id: meera.id } })).isPrimary);
  } finally {
    await clean();
  }

  await db.$disconnect();
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
