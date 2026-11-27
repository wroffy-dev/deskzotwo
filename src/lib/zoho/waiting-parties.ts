import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { getOrganisation } from "@/lib/organisation";
import { applyRow } from "@/lib/legacy-import/apply";
import { buildLookups, companyKey, ensureCustomFields, RecordCache, type Ctx } from "@/lib/legacy-import/context";
import { defaultMapping, mapRow, type KindKey } from "@/lib/legacy-import/formats";
import { runningImport } from "@/lib/legacy-import/store";
import { MigrationRefused, type MigrationRow } from "@/lib/migration/state";
import type { ImportFailure } from "@/lib/migration/steps";
import { rematchArchive } from "@/lib/migration/archive";
import { loadConnection, ZohoBusy, zohoGet, ZohoRefused, type ZohoReply } from "./client";
import { contactRows } from "./rows";

/**
 * "Bring these from Zoho" on a section's waiting rows (owner, 26 Nov 2026 — six open quotes waiting for customers added in
 * Zoho after the customers came across): each customer or vendor a row names and Deskzo hasn't, found in Zoho by name,
 * read in full, and brought in the way the old-CRM import brings Zoho's master lists (src/lib/legacy-import/apply.ts
 * `zohoCompanies`) — one with the GSTIN or name Deskzo has already is joined to it rather than made twice. Kept as an
 * import of its own, so Settings › Data › Import undoes it like any other. The section then tries its waiting rows again.
 */

export type PartyList = "customers" | "vendors";
export type BroughtParties = {
  /** The names asked for. */
  asked: number;
  /** Made new in Deskzo. */
  created: string[];
  /** Deskzo had them already, by GSTIN or name: joined to that one. */
  linked: string[];
  /** Not in Zoho under that name — spelled differently in Deskzo, or the row's own. */
  notInZoho: string[];
  failed: { name: string; error: string }[];
  /** Zoho said wait: the rest another time. */
  busy: string | null;
  importId: string | null;
};

/** At most this many in one press — two calls each, of Zoho's day. */
export const MAX_PARTIES = 40;
const NAMED = /^No (?:company|customer|contact|vendor) named "(.+)"/;

/** The names a section's waiting rows wait for, once each, in the order they wait. */
export function waitingNames(failures: ImportFailure[], list: PartyList): string[] {
  const out: string[] = [];
  for (const f of failures) {
    if (f.waitFor !== list) continue;
    const name = NAMED.exec(f.error)?.[1]?.trim();
    if (name && !out.some((n) => companyKey(n) === companyKey(name))) out.push(name);
  }
  return out;
}

type J = Record<string, unknown>;
const zohoJson = async (path: string, query: Record<string, string | number> = {}) => (await zohoGet(path, query)) as ZohoReply;

/** Zoho's customer (or vendor) of exactly this name, as Deskzo compares company names — or null. */
async function findInZoho(name: string, list: PartyList): Promise<J | null> {
  const type = list === "customers" ? "customer" : "vendor";
  const same = (c: J) => [c.contact_name, c.company_name].some((v) => typeof v === "string" && companyKey(v) === companyKey(name));
  // Its exact name first; then a search, for "Pvt Ltd" written "Private Limited" and the like.
  const queries: Record<string, string>[] = [{ contact_name: name }, { search_text: name }];
  for (const query of queries) {
    const reply = await zohoJson("/contacts", { ...query, contact_type: type, per_page: 25 });
    const hit = ((reply.contacts ?? []) as J[]).find(same);
    if (hit) return hit;
  }
  return null;
}

export async function bringWaitingParties(m: MigrationRow, fileId: string, list: PartyList, userId: string): Promise<BroughtParties> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const file = await db.migrationFile.findFirst({ where: { id: fileId, migrationId: m.id }, select: { failures: true, filename: true } });
  if (!file) throw new MigrationRefused("That file isn't in this migration.");
  if (await runningImport()) throw new MigrationRefused("An import is running in Settings › Data. Let it finish first.");
  if (!(await loadConnection())?.refreshToken) throw new MigrationRefused("Deskzo isn't connected to Zoho. Connect it above first.");
  const names = waitingNames((file.failures as ImportFailure[] | null) ?? [], list).slice(0, MAX_PARTIES);
  const out: BroughtParties = { asked: names.length, created: [], linked: [], notInZoho: [], failed: [], busy: null, importId: null };
  if (names.length === 0) return out;

  // Found and read in full in Zoho, before anything is written.
  const found: { name: string; contact: Record<string, string>; people: Record<string, string>[] }[] = [];
  for (const name of names) {
    try {
      const hit = await findInZoho(name, list);
      if (!hit) {
        out.notInZoho.push(name);
        continue;
      }
      const detail = (await zohoJson(`/contacts/${String(hit.contact_id)}`)).contact as J | undefined;
      if (!detail) throw new ZohoRefused("Zoho didn't send it.");
      const rows = contactRows(detail, list === "vendors");
      found.push({ name, contact: rows.contact, people: rows.people });
    } catch (err) {
      if (err instanceof ZohoBusy) {
        out.busy = err.message;
        break;
      }
      if (err instanceof ZohoRefused) out.failed.push({ name, error: err.message });
      else throw err;
    }
  }
  if (found.length === 0) return out;

  // An import of their own: its files kept as Zoho's, every record logged against it, undone like any other.
  const contactsKind: KindKey = list === "customers" ? "zoho_contacts" : "zoho_vendors";
  const peopleKind: KindKey = list === "customers" ? "zoho_contact_persons" : "zoho_vendor_contact_persons";
  const files: { name: string; kind: KindKey; rows: Record<string, string>[] }[] = [
    { name: list === "customers" ? "Contacts.csv" : "Vendors.csv", kind: contactsKind, rows: found.map((f) => f.contact) },
    { name: list === "customers" ? "Contact_Persons.csv" : "Vendor_Contact_Persons.csv", kind: peopleKind, rows: found.flatMap((f) => f.people) },
  ].filter((f) => f.rows.length > 0);
  const run = await db.legacyImport.create({ data: { source: "zoho", createdById: userId, strategy: "NEW", status: "IMPORTING", startedAt: new Date() }, select: { id: true } });
  out.importId = run.id;
  const mapped: Record<string, { mapping: Record<string, string | null> }> = {};
  for (const f of files) {
    const headers = [...new Set(f.rows.flatMap((r) => Object.keys(r)))];
    const mapping = defaultMapping(f.kind, headers);
    mapped[f.name] = { mapping };
    const made = await db.legacyImportFile.create({ data: { importId: run.id, name: f.name, kind: f.kind, headers, mapping: mapping as Prisma.InputJsonValue, rowCount: f.rows.length }, select: { id: true } });
    await db.legacyImportChunk.create({ data: { fileId: made.id, seq: 0, rows: f.rows as Prisma.InputJsonValue } });
  }

  // Joined to a company Deskzo has of the same name, rather than one made twice — the master lists' "link".
  const decisions = { matches: { [contactsKind]: "link" as const } };
  const ctx: Ctx = {
    importId: run.id,
    actorId: userId,
    strategy: "NEW",
    decisions,
    lookups: await buildLookups(run.id),
    records: new RecordCache(),
    ownName: companyKey((await getOrganisation()).legalName || ""),
    withZoho: true,
  };
  await ensureCustomFields(ctx);
  const counts: Record<string, { created: number; linked: number; failed: number }> = {};
  for (const f of files) {
    const tally = (counts[f.kind] ??= { created: 0, linked: 0, failed: 0 });
    for (const [i, raw] of f.rows.entries()) {
      const outcome = await applyRow(f.kind, { row: mapRow(raw, mapped[f.name]!.mapping), file: f.name, line: i + 2 }, ctx);
      const asked = f.kind === contactsKind ? found[i]!.name : null;
      if (outcome.kind === "error") {
        tally.failed += 1;
        if (asked) out.failed.push({ name: asked, error: outcome.message });
        await db.legacyImportError.create({ data: { importId: run.id, kind: f.kind, file: f.name, line: i + 2, oldId: raw["Contact ID"] || raw["Contact Person ID"] || null, message: outcome.message } });
      } else if (outcome.kind === "created") {
        tally.created += 1;
        if (asked) out.created.push(asked);
      } else if (outcome.kind === "skipped") {
        tally.failed += 1;
        if (asked) out.failed.push({ name: asked, error: outcome.reason });
      } else {
        tally.linked += 1;
        if (asked) out.linked.push(asked);
      }
    }
  }
  await db.legacyImport.update({
    where: { id: run.id },
    data: { status: "DONE", finishedAt: new Date(), decisions: decisions as Prisma.InputJsonValue, progress: { phase: "done", step: 0, offset: 0, counts } as Prisma.InputJsonValue },
  });
  const what = list === "customers" ? "customer" : "vendor";
  await recordAudit({
    userId,
    action: "CREATE",
    entityType: "LegacyImport",
    entityId: run.id,
    entityLabel: `Brought ${found.length} ${what}${found.length === 1 ? "" : "s"} from Zoho for rows of ${file.filename} waiting for them: ${out.created.length} new, ${out.linked.length} joined to ones Deskzo had`,
  });
  // Earlier years' documents that waited for these find them too, as after any import (src/lib/legacy-import/run.ts).
  await rematchArchive(m.id).catch(() => undefined);
  return out;
}
