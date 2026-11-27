import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { buildLookups, companyKey, deletedInOldCrm } from "./context";
import { clean, COUNTED_MASTER, countedKind, DECIDED_KINDS, KINDS, kindDef, oldInstant, STEPS, type KindDef, type KindKey } from "./formats";
import { isValidGstin } from "@/lib/gst-engine";
import { PEOPLE_ONLY } from "@/lib/people";
import { filesOfKind, ImportRefused, rowsOf } from "./store";

/**
 * The preview (src/lib/legacy-import): reads every file of a draft as the import would and writes nothing. For each
 * table — how many rows, how many the old CRM deleted, how many an earlier import brought, how many meet a record
 * Deskzo already has, which can't come in and why — and for each old user, the Deskzo user they match by email.
 * Kept on the run; any change to the files or their columns throws it away.
 */

export type RowProblem = { file: string; line: number; oldId: string | null; message: string };

export type KindReport = {
  kind: KindKey;
  label: string;
  becomes: string;
  role: KindDef["role"];
  files: string[];
  rows: number;
  deleted: number;
  imported: number;
  matches: number;
  /** Of `matches`, those that attach on their own — a company Deskzo has with the same GSTIN or PAN, or one an earlier import made of that name — needing no choice. */
  linked?: number;
  fresh: number;
  problemRows: number;
  problems: RowProblem[];
  warnings: string[];
  sample: Record<string, string>[];
};

export type UserMatch = { oldId: string; name: string; email: string; active: boolean; roles: string[]; match: { id: string; name: string; email: string } | null; imported: boolean };

export type Analysis = {
  at: string;
  kinds: KindReport[];
  unknownFiles: string[];
  users: UserMatch[];
  deskzoUsers: { id: string; name: string; email: string; active: boolean }[];
  /** Tables with rows that meet Deskzo's own records: the preview must say whether to use those or leave the rows out. */
  needsDecision: KindKey[];
  notes: string[];
};

const PROBLEM_CAP = 300;

/** For each table, the columns it can't do without. */
const REQUIRED: Partial<Record<KindKey, string[]>> = {
  users: ["id", "email"],
  products: ["id", "name", "sku"],
  // A missing company name or product comes in with a stand-in marked "(to fix)" (apply.ts `nameOrStandIn`, owner 30 Oct 2026).
  customers: ["id"],
  billing_addresses: ["id", "customer_id"],
  shipping_addresses: ["id", "customer_id"],
  employees: ["id", "customer_id"],
  profilings: ["id"],
  leads: ["id"],
  lead_product: ["id", "lead_id"],
  customer_product: ["id", "customer_id"],
  product_tickets: ["id", "customer_id"],
  anonymous_tickets: ["id", "customer_id"],
  replies: ["id", "ticket_type", "ticket_id", "reply"],
  field_visits: ["id", "visit_date"],
  call_logs: ["id", "type", "type_id"],
};

/** What a row points at that must have come across first; `soft` ones only warn — the record comes in without the link. */
const REFS: Partial<Record<KindKey, { column: string; kind: KindKey | ((row: Record<string, string>) => KindKey | null); soft?: boolean }[]>> = {
  billing_addresses: [{ column: "customer_id", kind: "customers" }],
  shipping_addresses: [{ column: "customer_id", kind: "customers" }],
  employees: [{ column: "customer_id", kind: "customers" }],
  customer_product: [
    { column: "customer_id", kind: "customers" },
    { column: "product_id", kind: "products", soft: true },
    { column: "billing_address_id", kind: "billing_addresses", soft: true },
    { column: "parent_id", kind: "customer_product", soft: true },
    { column: "renewal_id", kind: "customer_product", soft: true },
  ],
  leads: [{ column: "product_id", kind: "products", soft: true }],
  lead_product: [
    { column: "lead_id", kind: "leads" },
    { column: "product_id", kind: "products", soft: true },
  ],
  product_tickets: [
    { column: "customer_id", kind: "customers" },
    { column: "customer_product_id", kind: "customer_product", soft: true },
    { column: "contact_person_id", kind: "employees", soft: true },
  ],
  anonymous_tickets: [
    { column: "customer_id", kind: "customers" },
    { column: "contact_person_id", kind: "employees", soft: true },
  ],
  replies: [{ column: "ticket_id", kind: (r) => ({ product: "product_tickets", anonymous: "anonymous_tickets" } as Record<string, KindKey>)[clean(r.ticket_type).toLowerCase()] ?? null }],
  field_visits: [{ column: "customer_id", kind: "customers" }],
  call_logs: [{ column: "type_id", kind: (r) => ({ lead: "leads", customer: "customers", profiling: "profilings", product_ticket: "product_tickets", anonymous_ticket: "anonymous_tickets", customer_product: "customer_product" } as Record<string, KindKey>)[clean(r.type).toLowerCase()] ?? null }],
};

/** The columns naming an old user, by table — a user the users file hasn't is warned about; their records go to whoever imports. */
const USER_COLUMNS: Partial<Record<KindKey, string[]>> = {
  customers: ["created_by"],
  profilings: ["assigned_to", "created_by"],
  leads: ["assigned_to", "created_by"],
  customer_product: ["created_by"],
  product_tickets: ["assigned_to", "created_by"],
  anonymous_tickets: ["assigned_to", "created_by"],
  replies: ["replier_id"],
  field_visits: ["created_by"],
  call_logs: ["called_by"],
};

export async function analyse(importId: string): Promise<Analysis> {
  const run = await db.legacyImport.findUnique({ where: { id: importId }, select: { status: true, files: { select: { name: true, kind: true, rowCount: true } } } });
  if (!run) throw new ImportRefused("That import isn't there.");
  if (run.status !== "DRAFT") throw new ImportRefused("Only an import that hasn't started is previewed.");
  if (run.files.length === 0) throw new ImportRefused("Upload the old CRM's files first.");

  const lookups = await buildLookups(importId);
  const present = new Set(run.files.map((f) => f.kind).filter(Boolean) as KindKey[]);

  // Each records table's live ids in the files, and the ids earlier imports brought.
  const liveIds = new Map<KindKey, Set<string>>();
  const importedIds = new Map<KindKey, Set<string>>();
  for (const kind of STEPS) {
    const ids = new Set<string>();
    if (present.has(kind)) for await (const { row } of rowsOf(importId, kind)) if (row.id && !clean(row.deletedAt)) ids.add(row.id);
    liveIds.set(kind, ids);
    const logged = await db.legacyImportRecord.findMany({ where: { kind }, select: { oldId: true } });
    importedIds.set(kind, new Set(logged.map((r) => r.oldId)));
  }
  const known = (kind: KindKey, id: string) => liveIds.get(kind)?.has(id) || importedIds.get(kind)?.has(id);

  // What Deskzo has that a row could meet, and which of it earlier imports made (that is never "a match").
  const madeByImport = new Set((await db.legacyImportRecord.findMany({ where: { action: { in: ["CREATED", "UPDATED", "KEPT"] } }, select: { recordId: true } })).map((r) => r.recordId));
  const skus = present.has("products") ? new Map((await db.item.findMany({ select: { id: true, sku: true } })).map((i) => [i.sku.toLowerCase(), i.id])) : new Map<string, string>();
  const names = present.has("customers") || present.has("employees") || COUNTED_MASTER.some((k) => present.has(k)) ? new Map((await db.company.findMany({ select: { id: true, normalizedName: true } })).map((c) => [c.normalizedName, c.id])) : new Map<string, string>();

  // A customer's company, where it is known before importing: an earlier import's, or one Deskzo has by name.
  const customerCompany = new Map<string, string>();
  if (present.has("employees")) {
    const logged = await db.legacyImportRecord.findMany({ where: { kind: "customers" }, select: { oldId: true, recordId: true } });
    for (const r of logged) customerCompany.set(r.oldId, r.recordId);
    if (present.has("customers")) for await (const { row } of rowsOf(importId, "customers")) if (row.id && !customerCompany.has(row.id) && names.has(companyKey(row.company ?? ""))) customerCompany.set(row.id, names.get(companyKey(row.company ?? ""))!);
  }
  const contactEmails = new Map<string, { id: string }>();
  if (customerCompany.size) {
    const ids = [...new Set(customerCompany.values())];
    for (let i = 0; i < ids.length; i += 1000) {
      for (const c of await db.contact.findMany({ where: { companyId: { in: ids.slice(i, i + 1000) }, email: { not: null } }, select: { id: true, companyId: true, email: true } })) contactEmails.set(`${c.companyId}|${c.email!.toLowerCase()}`, { id: c.id });
    }
  }

  const kinds: KindReport[] = [];
  const seenNames = new Map<string, string>();
  // Zoho's owners as Deskzo people, read as the import reads them (src/lib/legacy-import/apply.ts `zohoOwner`): null where two share a name.
  const personKey = (name: string) => clean(name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const people = new Map<string, string | null>();
  if (COUNTED_MASTER.some((k) => present.has(k))) {
    for (const p of await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, select: { id: true, name: true } })) people.set(personKey(p.name), people.has(personKey(p.name)) ? null : p.id);
  }
  // The companies Deskzo has by GSTIN and by PAN, as `companyByTaxId` (apply.ts) finds them.
  const byGst = new Map<string, Set<string>>();
  const byPan = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, id: string) => (map.get(key) ?? map.set(key, new Set()).get(key)!).add(id);
  if (COUNTED_MASTER.some((k) => present.has(k))) {
    for (const l of await db.companyLocation.findMany({ where: { gstNumber: { not: null } }, select: { companyId: true, gstNumber: true } })) {
      const g = l.gstNumber!.trim().toUpperCase();
      add(byGst, g, l.companyId);
      if (g.length === 15) add(byPan, g.slice(2, 12), l.companyId);
    }
    for (const c of await db.company.findMany({ where: { panNumber: { not: null } }, select: { id: true, panNumber: true } })) add(byPan, c.panNumber!.trim().toUpperCase(), c.id);
  }
  for (const def of KINDS) {
    const files = await filesOfKind(importId, def.key);
    if (files.length === 0) continue;
    const report: KindReport = { kind: def.key, label: def.label, becomes: def.becomes, role: def.role, files: files.map((f) => f.name), rows: 0, deleted: 0, imported: 0, matches: 0, linked: 0, fresh: 0, problemRows: 0, problems: [], warnings: [], sample: [] };
    const missingColumns = def.columns.filter((c) => files.some((f) => !f.mapping[c]) && (REQUIRED[def.key] ?? []).includes(c));
    if (missingColumns.length) report.warnings.push(`No heading is read for ${missingColumns.join(", ")} — map one, or every row will be refused.`);
    const unknownUsers = new Set<string>();
    const seen = new Set<string>();
    let softMissing = 0;
    /** Rows left behind with what they point at, which the old CRM deleted — by that table's name. */
    const withDeleted = new Map<string, number>();
    /** Zoho owners nobody in Deskzo answers to, and those two people do. */
    const ownersMissing = new Map<string, number>();
    const ownersTwice = new Map<string, number>();
    let owned = 0;
    /** Rows that attach to a company Deskzo has by GSTIN / PAN, and GSTINs an earlier row of the file brings in new. */
    const byTax = { GSTIN: 0, PAN: 0 };
    const freshGst = new Set<string>();
    for await (const { row, file, line } of rowsOf(importId, def.key)) {
      report.rows += 1;
      if (report.sample.length < 3) report.sample.push(Object.fromEntries(Object.entries(row).filter(([, v]) => v)));
      if (!countedKind(def)) continue;
      const problem = (message: string) => {
        report.problemRows += 1;
        if (report.problems.length < PROBLEM_CAP) report.problems.push({ file, line, oldId: row.id || row["Contact ID"] || null, message });
      };
      if (COUNTED_MASTER.includes(def.key)) {
        // Zoho's customers or vendors, as `zohoCompanies` (apply.ts) will take them.
        const zohoId = clean(row["Contact ID"]);
        if (!zohoId) {
          problem("No Contact ID.");
          continue;
        }
        if (/^\d(\.\d+)?E\+\d+$/i.test(zohoId)) {
          problem(`Its Contact ID (${zohoId}) was rounded by a spreadsheet — upload the file as Zoho exported it.`);
          continue;
        }
        const owner = clean(row["Owner Name"]);
        if (owner) {
          const who = people.get(personKey(owner));
          if (who === undefined) ownersMissing.set(owner, (ownersMissing.get(owner) ?? 0) + 1);
          else if (who === null) ownersTwice.set(owner, (ownersTwice.get(owner) ?? 0) + 1);
          else owned += 1;
        }
        if (seen.has(zohoId)) {
          problem(`Contact ID ${zohoId} is in the file twice; only the first comes in.`);
          continue;
        }
        seen.add(zohoId);
        if (importedIds.get(def.key)?.has(zohoId)) {
          report.imported += 1;
          continue;
        }
        const name = clean(row["Company Name"]) || clean(row["Display Name"]);
        if (!name) {
          problem("No name.");
          continue;
        }
        const gst = clean(row["GST Identification Number (GSTIN)"]).toUpperCase();
        if (gst && isValidGstin(gst)) {
          const sameGst = byGst.get(gst);
          const samePan = sameGst?.size ? null : byPan.get(gst.slice(2, 12));
          const by = sameGst?.size === 1 ? "GSTIN" : !sameGst?.size && samePan?.size === 1 ? "PAN" : null;
          if (by || freshGst.has(gst)) {
            if (by) byTax[by] += 1;
            report.matches += 1;
            report.linked! += 1;
            continue;
          }
          freshGst.add(gst);
        }
        const id = names.get(companyKey(name));
        if (id) {
          report.matches += 1;
          // One an earlier import made of that name is taken without asking.
          if (madeByImport.has(id)) report.linked! += 1;
        } else report.fresh += 1;
        continue;
      }
      // Deleted in the old CRM, or an empty placeholder contact ("N/A", no email, no phone): left behind.
      const placeholder = def.key === "employees" && ![row.first_name, row.last_name].some((v) => v && v !== "N/A") && !row.email && !row.phone;
      if (clean(row.deletedAt) || placeholder) {
        report.deleted += 1;
        continue;
      }
      const missing = (REQUIRED[def.key] ?? []).filter((c) => !row[c]);
      if (missing.length) {
        problem(`No ${missing.join(", ")}.`);
        continue;
      }
      if (seen.has(row.id!)) {
        problem(`Id ${row.id} is in the files twice; only the first comes in.`);
        continue;
      }
      seen.add(row.id!);
      if (importedIds.get(def.key)?.has(row.id!)) {
        report.imported += 1;
        continue;
      }
      let refused = false;
      for (const ref of REFS[def.key] ?? []) {
        const value = row[ref.column];
        if (!value) continue;
        const target = typeof ref.kind === "function" ? ref.kind(row) : ref.kind;
        if (target && known(target, value)) continue;
        if (!ref.soft && target && deletedInOldCrm(lookups, target, value)) {
          // Its customer or lead was deleted in the old CRM: it stays behind with it, as the import leaves it.
          report.deleted += 1;
          const label = kindDef(target)!.label.toLowerCase();
          withDeleted.set(label, (withDeleted.get(label) ?? 0) + 1);
          refused = true;
          break;
        }
        if (ref.soft) softMissing += 1;
        else {
          problem(target ? `Points at ${kindDef(target)!.label.toLowerCase()} ${value}, which isn't in the files or an earlier import.` : `Points at a "${row.type || row.ticket_type}" the tool doesn't know.`);
          refused = true;
          break;
        }
      }
      if (refused) continue;
      for (const column of USER_COLUMNS[def.key] ?? []) if (row[column] && !lookups.users[row[column]!]) unknownUsers.add(row[column]!);
      if (def.key === "field_visits" && !oldInstant(row.visit_date ?? "")) {
        problem("The visit date can't be read.");
        continue;
      }
      // Meeting what Deskzo already has.
      if (def.key === "products") {
        const id = skus.get(clean(row.sku).toLowerCase());
        if (id && !madeByImport.has(id)) {
          report.matches += 1;
          continue;
        }
      }
      if (def.key === "customers") {
        const key = companyKey(row.company ?? "");
        const id = names.get(key);
        if (id && !madeByImport.has(id)) {
          report.matches += 1;
          continue;
        }
        if (seenNames.has(key)) report.warnings.push(`${row.company} (id ${row.id}) has the same name as customer ${seenNames.get(key)}; both become one company.`);
        else seenNames.set(key, row.id!);
      }
      if (def.key === "employees" && row.email) {
        const company = customerCompany.get(row.customer_id!);
        const contact = company ? contactEmails.get(`${company}|${row.email.toLowerCase()}`) : null;
        if (contact && !madeByImport.has(contact.id)) {
          report.matches += 1;
          continue;
        }
      }
      report.fresh += 1;
    }
    for (const [label, count] of withDeleted) report.warnings.push(`${count.toLocaleString("en-IN")} row(s) point at ${label} the old CRM deleted; they stay behind with them (counted under Left behind).`);
    if (softMissing) report.warnings.push(`${softMissing} link(s) point at records not in the files (a billing address, a parent order, a contact, a product…); those rows come in without the link — a product on a stand-in marked (to fix).`);
    if (COUNTED_MASTER.includes(def.key) && report.rows) {
      const list = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => `${name} (${count.toLocaleString("en-IN")})`).join(", ") + (m.size > 8 ? "…" : "");
      if (byTax.GSTIN || byTax.PAN) report.warnings.push(`${(byTax.GSTIN + byTax.PAN).toLocaleString("en-IN")} are a company Deskzo already has — ${byTax.GSTIN.toLocaleString("en-IN")} by the same GSTIN, ${byTax.PAN.toLocaleString("en-IN")} by the same PAN (a branch in another state), whatever it is called there: no new company, only an empty account manager filled.`);
      if (owned) report.warnings.push(`${owned.toLocaleString("en-IN")} have an owner in Zoho who is a Deskzo person — their account manager, where the company has none yet.`);
      if (ownersMissing.size) report.warnings.push(`Owners in Zoho who aren't anyone working in Deskzo: ${list(ownersMissing)} — those come in without an account manager; add the person with the same name first, or set it after.`);
      if (ownersTwice.size) report.warnings.push(`Owners in Zoho more than one Deskzo person is called: ${list(ownersTwice)} — those come in without an account manager.`);
    }
    if (unknownUsers.size) report.warnings.push(`${unknownUsers.size} old user(s) aren't in the users file (${[...unknownUsers].slice(0, 8).join(", ")}${unknownUsers.size > 8 ? "…" : ""}); their records go to whoever runs the import.`);
    if (def.key === "profilings" && report.fresh) report.warnings.push(`Each profiling is a contact on its company — one Deskzo has by that name, else a new prospect company tagged Profiling.`);
    if (def.key === "leads" && report.fresh) report.warnings.push(`A lead's company is the one Deskzo has by that name, else a new prospect company.`);
    kinds.push(report);
  }

  const deskzoUsers = await db.user.findMany({ where: { kind: "MEMBER" }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true, active: true } });
  const byEmail = new Map(deskzoUsers.map((u) => [u.email.toLowerCase(), u]));
  const importedUsers = importedIds.get("users") ?? new Set<string>();
  const users: UserMatch[] = Object.entries(lookups.users).map(([oldId, u]) => {
    const match = byEmail.get(u.email);
    return { oldId, name: u.name, email: u.email, active: u.active, roles: u.roles, match: match ? { id: match.id, name: match.name, email: match.email } : null, imported: importedUsers.has(oldId) };
  });

  const notes: string[] = [];
  if (!present.has("users") && kinds.some((k) => k.role === "records")) notes.push("There's no users file: every owner, assignee and caller becomes whoever runs the import.");
  if (present.has("customer_product") && !present.has("products") && !(importedIds.get("products")?.size)) notes.push("Customer products need the products file — without it every order is refused.");
  if (!present.has("entity_tags") && (present.has("customers") || present.has("profilings"))) notes.push("There's no entity_tags file, so companies come in without their tags.");

  return {
    at: new Date().toISOString(),
    kinds,
    unknownFiles: run.files.filter((f) => !f.kind).map((f) => f.name),
    users,
    deskzoUsers,
    needsDecision: kinds.filter((k) => DECIDED_KINDS.includes(k.kind) && k.matches - (k.linked ?? 0) > 0).map((k) => k.kind),
    notes,
  };
}

/** Analyses a draft and keeps the result on it. */
export async function analyseAndKeep(importId: string): Promise<Analysis> {
  const analysis = await analyse(importId);
  await db.legacyImport.update({ where: { id: importId }, data: { analysis: analysis as unknown as Prisma.InputJsonValue } });
  return analysis;
}
