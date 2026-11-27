import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { clean, type KindKey } from "./formats";
import type { ListKey, MatchRow, MatchStatus } from "./lists";
import { ImportRefused, rowsOf } from "./store";

/**
 * The master lists (owner, 26 Oct 2026; the plan "Pull from Zoho Books", phase 1): Zoho Books' customers, vendors,
 * items and contact persons beside WroffyCRM's customers, vendors, products and employees, so each company comes
 * into Deskzo once, carrying both old ids. Nothing is imported from either until the lists are settled.
 *
 * Matching, strongest evidence first — the first that settles it wins:
 *
 *   1. the same GSTIN — matched;
 *   2. the same PAN (GSTIN characters 3–12) in another state — matched, as a branch;
 *   3. the same name, ignoring case, spacing, punctuation and Pvt Ltd / Private Limited — matched if exactly one;
 *   4. the same email domain (not a mailbox provider's) or phone number — suggested only;
 *   5. a similar name — suggested only.
 *
 * Several WroffyCRM records may meet one Zoho record (the old CRM had duplicates); one WroffyCRM record meets at most
 * one. Products: the same SKU, else the same name; a similar name is suggested. Contacts, inside each matched pair of
 * companies: the same email, else mobile, else full name — the last flagged for a look.
 */

export { LISTS, type ListKey, type MatchRow, type MatchStatus } from "./lists";

export type Party = { id: string; label: string; name: string; gstins: string[]; emails: string[]; phones: string[]; sku?: string };
export type Pair = { zohoId: string | null; oldId: string | null; zohoLabel: string | null; oldLabel: string | null; status: MatchStatus; reason: string; flagged?: boolean };

// ─── Matching (pure) ─────────────────────────────────────────────────────────────────────────────

const SUFFIXES = /\b(private|pvt|limited|ltd|llp|inc|incorporated|opc|co|company|corp|corporation|the|and)\b/g;

/** A company's name as matching reads it: "Burda Media India Pvt. Ltd." and "BURDA MEDIA INDIA PRIVATE LIMITED" alike. */
export function looseName(name: string): string {
  return clean(name)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(opc\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A product's name as matching reads it: case, spacing and punctuation aside. */
export const looseItem = (name: string) => clean(name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
export function gstinOf(value: string): string | null {
  const g = clean(value).toUpperCase().replace(/\s/g, "");
  return GSTIN.test(g) ? g : null;
}
const panOfGstin = (gstin: string) => gstin.slice(2, 12);

const MAILBOX_PROVIDERS = new Set(["gmail.com", "yahoo.com", "yahoo.co.in", "hotmail.com", "outlook.com", "live.com", "rediffmail.com", "rediff.com", "icloud.com", "aol.com", "ymail.com", "protonmail.com", "zoho.com", "zohomail.in", "msn.com"]);
export function domainOf(email: string): string | null {
  const d = clean(email).toLowerCase().split("@")[1]?.trim();
  return d && d.includes(".") && !MAILBOX_PROVIDERS.has(d) ? d : null;
}
export function phoneOf(phone: string): string | null {
  const digits = clean(phone).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** How alike two names are, 0–1: the share of letter pairs they have in common. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const pairs = (s: string) => {
    const out = new Map<string, number>();
    const t = s.replace(/\s+/g, "");
    for (let i = 0; i < t.length - 1; i++) out.set(t.slice(i, i + 2), (out.get(t.slice(i, i + 2)) ?? 0) + 1);
    return out;
  };
  const pa = pairs(a);
  const pb = pairs(b);
  let common = 0;
  for (const [k, n] of pa) common += Math.min(n, pb.get(k) ?? 0);
  const total = [...pa.values()].reduce((t, n) => t + n, 0) + [...pb.values()].reduce((t, n) => t + n, 0);
  return total ? (2 * common) / total : 0;
}

const SIMILAR = 0.85;

function index<T>(items: T[], keys: (t: T) => (string | null)[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  items.forEach((item, i) => {
    for (const k of new Set(keys(item).filter((x): x is string => !!x))) (map.get(k) ?? map.set(k, []).get(k)!).push(i);
  });
  return map;
}

/** Companies: Zoho's beside WroffyCRM's, by the evidence above. */
export function matchCompanies(zoho: Party[], old: Party[]): Pair[] {
  const byGstin = index(zoho, (z) => z.gstins);
  const byPan = index(zoho, (z) => z.gstins.map(panOfGstin));
  const byName = index(zoho, (z) => [looseName(z.name)]);
  const byDomain = index(zoho, (z) => z.emails.map(domainOf));
  const byPhone = index(zoho, (z) => z.phones.map(phoneOf));
  const byFirstWord = index(zoho, (z) => [looseName(z.name).split(" ")[0] ?? null]);
  const used = new Set<number>();
  const pairs: Pair[] = [];
  const pair = (o: Party, zi: number, status: MatchStatus, reason: string) => {
    used.add(zi);
    pairs.push({ zohoId: zoho[zi]!.id, oldId: o.id, zohoLabel: zoho[zi]!.label, oldLabel: o.label, status, reason });
  };
  const union = (map: Map<string, number[]>, keys: (string | null)[]) => [...new Set(keys.flatMap((k) => (k ? (map.get(k) ?? []) : [])))];
  /** Of several candidates, the one whose name is nearest, when it is clearly nearest. */
  const nearest = (o: Party, cands: number[]) => {
    const name = looseName(o.name);
    const scored = cands.map((i) => ({ i, s: similarity(name, looseName(zoho[i]!.name)) })).sort((a, b) => b.s - a.s);
    return scored[0] && (scored.length === 1 || scored[0].s > scored[1]!.s) ? scored[0] : null;
  };

  // First the evidence that settles it (GSTIN, PAN, name), for every record; then, for what's left, the evidence that
  // only suggests — and only toward Zoho records nothing stronger has claimed.
  const leftover: Party[] = [];
  for (const o of old) {
    const name = looseName(o.name);
    const gst = union(byGstin, o.gstins);
    if (gst.length === 1) {
      pair(o, gst[0]!, "MATCHED", "Same GSTIN");
      continue;
    }
    if (gst.length > 1) {
      const best = nearest(o, gst) ?? { i: gst[0]!, s: 0 };
      pair(o, best.i, "SUGGESTED", `Same GSTIN as ${gst.length} Zoho records — the nearest by name`);
      continue;
    }
    const pan = union(byPan, o.gstins.map(panOfGstin));
    if (pan.length === 1) {
      pair(o, pan[0]!, "MATCHED", "Same PAN in another state — a branch");
      continue;
    }
    if (pan.length > 1) {
      const sameName = pan.filter((i) => looseName(zoho[i]!.name) === name);
      if (sameName.length === 1) pair(o, sameName[0]!, "MATCHED", "Same PAN and name — a branch");
      else pair(o, (nearest(o, pan) ?? { i: pan[0]! }).i, "SUGGESTED", `Same PAN as ${pan.length} Zoho records — the nearest by name`);
      continue;
    }
    const named = name ? (byName.get(name) ?? []) : [];
    if (named.length === 1) {
      pair(o, named[0]!, "MATCHED", "Same name");
      continue;
    }
    if (named.length > 1) {
      pair(o, named[0]!, "SUGGESTED", `Same name as ${named.length} Zoho records`);
      continue;
    }
    leftover.push(o);
  }
  const claimed = new Set(used);
  const open = (list: number[]) => list.filter((i) => !claimed.has(i));
  for (const o of leftover) {
    const name = looseName(o.name);
    const domain = open(union(byDomain, o.emails.map(domainOf)));
    const phone = open(union(byPhone, o.phones.map(phoneOf)));
    const contact = [...new Set([...domain, ...phone])];
    if (contact.length) {
      const best = contact.length === 1 ? { i: contact[0]! } : nearest(o, contact);
      if (best) {
        const why = domain.includes(best.i) ? `Same email domain (${o.emails.map(domainOf).find((d) => d && zoho[best.i]!.emails.map(domainOf).includes(d))})` : "Same phone number";
        pair(o, best.i, "SUGGESTED", why);
        continue;
      }
    }
    const first = name.split(" ")[0];
    const similar = first ? open(byFirstWord.get(first) ?? []).map((i) => ({ i, s: similarity(name, looseName(zoho[i]!.name)) })).filter((x) => x.s >= SIMILAR).sort((a, b) => b.s - a.s)[0] : undefined;
    if (similar) {
      pair(o, similar.i, "SUGGESTED", `Similar name (${Math.round(similar.s * 100)}%)`);
      continue;
    }
    pairs.push({ zohoId: null, oldId: o.id, zohoLabel: null, oldLabel: o.label, status: "OLD_ONLY", reason: "Not in Zoho" });
  }
  zoho.forEach((z, i) => {
    if (!used.has(i)) pairs.push({ zohoId: z.id, oldId: null, zohoLabel: z.label, oldLabel: null, status: "ZOHO_ONLY", reason: "Not in WroffyCRM" });
  });
  return pairs;
}

/** Products: the same SKU, else the same name; a similar name suggested. */
export function matchProducts(zoho: Party[], old: Party[]): Pair[] {
  const bySku = index(zoho, (z) => [z.sku ? z.sku.toLowerCase() : null]);
  const byName = index(zoho, (z) => [looseItem(z.name)]);
  const byFirstWord = index(zoho, (z) => [looseItem(z.name).split(" ")[0] ?? null]);
  const used = new Set<number>();
  const pairs: Pair[] = [];
  for (const o of old) {
    const sku = o.sku ? (bySku.get(o.sku.toLowerCase()) ?? []) : [];
    const name = looseItem(o.name);
    const named = byName.get(name) ?? [];
    const hit = sku.length === 1 ? { i: sku[0]!, status: "MATCHED" as const, reason: "Same SKU" } : named.length === 1 ? { i: named[0]!, status: "MATCHED" as const, reason: "Same name" } : named.length > 1 ? { i: named[0]!, status: "SUGGESTED" as const, reason: `Same name as ${named.length} Zoho items` } : null;
    const similar = hit
      ? null
      : (byFirstWord.get(name.split(" ")[0] ?? "") ?? [])
          .map((i) => ({ i, s: similarity(name, looseItem(zoho[i]!.name)) }))
          .filter((x) => x.s >= 0.9)
          .sort((a, b) => b.s - a.s)[0];
    const found = hit ?? (similar ? { i: similar.i, status: "SUGGESTED" as const, reason: `Similar name (${Math.round(similar.s * 100)}%)` } : null);
    if (!found) {
      pairs.push({ zohoId: null, oldId: o.id, zohoLabel: null, oldLabel: o.label, status: "OLD_ONLY", reason: "Not in Zoho" });
      continue;
    }
    used.add(found.i);
    pairs.push({ zohoId: zoho[found.i]!.id, oldId: o.id, zohoLabel: zoho[found.i]!.label, oldLabel: o.label, status: found.status, reason: found.reason });
  }
  zoho.forEach((z, i) => {
    if (!used.has(i)) pairs.push({ zohoId: z.id, oldId: null, zohoLabel: z.label, oldLabel: null, status: "ZOHO_ONLY", reason: "Not in WroffyCRM" });
  });
  return pairs;
}

/** One company's contacts: the same email, else mobile, else full name (flagged); the rest alone. */
export function matchContacts(zoho: Party[], old: Party[]): Pair[] {
  const byEmail = index(zoho, (z) => z.emails.map((e) => clean(e).toLowerCase() || null));
  const byPhone = index(zoho, (z) => z.phones.map(phoneOf));
  const byName = index(zoho, (z) => [looseItem(z.name) || null]);
  const used = new Set<number>();
  const pairs: Pair[] = [];
  const free = (list: number[]) => list.filter((i) => !used.has(i));
  for (const o of old) {
    const email = free(o.emails.flatMap((e) => byEmail.get(clean(e).toLowerCase()) ?? []));
    const phone = free(o.phones.flatMap((p) => byPhone.get(phoneOf(p) ?? "") ?? []));
    const name = free(byName.get(looseItem(o.name)) ?? []);
    const hit = email[0] !== undefined ? { i: email[0], reason: "Same email", flagged: false } : phone[0] !== undefined ? { i: phone[0], reason: "Same mobile", flagged: false } : name.length === 1 ? { i: name[0]!, reason: "Same name only — worth a look", flagged: true } : null;
    if (!hit) {
      pairs.push({ zohoId: null, oldId: o.id, zohoLabel: null, oldLabel: o.label, status: "OLD_ONLY", reason: "Not in Zoho" });
      continue;
    }
    used.add(hit.i);
    pairs.push({ zohoId: zoho[hit.i]!.id, oldId: o.id, zohoLabel: zoho[hit.i]!.label, oldLabel: o.label, status: "MATCHED", reason: hit.reason, flagged: hit.flagged });
  }
  zoho.forEach((z, i) => {
    if (!used.has(i)) pairs.push({ zohoId: z.id, oldId: null, zohoLabel: z.label, oldLabel: null, status: "ZOHO_ONLY", reason: "Not in WroffyCRM" });
  });
  return pairs;
}

// ─── From the files ──────────────────────────────────────────────────────────────────────────────

/** An id Excel has rounded ("8.80908E+17") — the file was opened and saved in a spreadsheet. */
export const roundedId = (id: string) => /^\d(\.\d+)?E\+\d+$/i.test(clean(id));

const live = (row: Record<string, string>) => !clean(row.deletedAt);
const nameOf = (...parts: (string | undefined)[]) => parts.map((p) => clean(p)).filter(Boolean).join(" ");

async function partiesOf(importId: string, kind: KindKey, read: (row: Record<string, string>) => Party | null): Promise<{ parties: Party[]; rounded: number }> {
  const parties: Party[] = [];
  let rounded = 0;
  for await (const { row } of rowsOf(importId, kind)) {
    const party = read(row);
    if (!party || !party.id) continue;
    if (roundedId(party.id)) rounded += 1;
    parties.push(party);
  }
  return { parties, rounded };
}

const companyLabel = (name: string, gstin: string | null) => (gstin ? `${name} · ${gstin}` : name);

/** Builds the four lists afresh from a draft's files; earlier decisions on the lists are replaced. */
export async function buildMasterLists(importId: string): Promise<{ counts: Record<string, Record<string, number>>; notes: string[] }> {
  const run = await db.legacyImport.findUnique({ where: { id: importId }, select: { status: true, files: { select: { kind: true } } } });
  if (!run || run.status !== "DRAFT") throw new ImportRefused("The master lists are built for an import that hasn't started.");
  const kinds = new Set(run.files.map((f) => f.kind));
  if (!kinds.has("zoho_contacts") && !kinds.has("zoho_vendors") && !kinds.has("zoho_items")) throw new ImportRefused("Upload Zoho Books' Contacts, Vendors or Item file first — the lists pair them with WroffyCRM's.");
  const notes: string[] = [];

  const zohoCustomers = await partiesOf(importId, "zoho_contacts", (r) => {
    const gstin = gstinOf(r["GST Identification Number (GSTIN)"] ?? "");
    const name = clean(r["Company Name"]) || clean(r["Display Name"]);
    return { id: clean(r["Contact ID"]), name, label: companyLabel(clean(r["Display Name"]) || name, gstin), gstins: gstin ? [gstin] : [], emails: [r.EmailID ?? ""], phones: [r.MobilePhone ?? "", r.Phone ?? ""] };
  });
  const zohoVendors = await partiesOf(importId, "zoho_vendors", (r) => {
    const gstin = gstinOf(r["GST Identification Number (GSTIN)"] ?? "");
    const name = clean(r["Company Name"]) || clean(r["Display Name"]);
    return { id: clean(r["Contact ID"]), name, label: companyLabel(clean(r["Display Name"]) || name, gstin), gstins: gstin ? [gstin] : [], emails: [r.EmailID ?? ""], phones: [r.MobilePhone ?? "", r.Phone ?? ""] };
  });
  const oldCustomers = await partiesOf(importId, "customers", (r) => {
    if (!live(r)) return null;
    const gstin = gstinOf(r.gst_no ?? "");
    return { id: clean(r.id), name: clean(r.company), label: companyLabel(clean(r.company), gstin), gstins: gstin ? [gstin] : [], emails: [r.official_email ?? ""], phones: [r.phone ?? ""] };
  });
  const oldVendors = await partiesOf(importId, "vendors", (r) => {
    if (!live(r)) return null;
    const gstin = gstinOf(r.gst_no ?? "");
    return { id: clean(r.id), name: clean(r.company), label: companyLabel(clean(r.company), gstin), gstins: gstin ? [gstin] : [], emails: [r.official_email ?? ""], phones: [r.official_phone ?? ""] };
  });
  const zohoItems = await partiesOf(importId, "zoho_items", (r) => ({ id: clean(r["Item ID"]), name: clean(r["Item Name"]), label: [clean(r["Item Name"]), clean(r.SKU)].filter(Boolean).join(" · "), sku: clean(r.SKU) || undefined, gstins: [], emails: [], phones: [] }));
  const oldProducts = await partiesOf(importId, "products", (r) => (live(r) ? { id: clean(r.id), name: clean(r.name), label: [clean(r.name), clean(r.sku)].filter(Boolean).join(" · "), sku: clean(r.sku) || undefined, gstins: [], emails: [], phones: [] } : null));

  for (const [label, read] of [["Contacts", zohoCustomers], ["Vendors", zohoVendors], ["Item", zohoItems]] as const) {
    if (read.rounded) notes.push(`Zoho's ${label} file has ${read.rounded} id(s) rounded like 8.80908E+17 — it was opened and saved in Excel, which breaks the links to its invoices. Upload the file as Zoho exported it.`);
  }

  const lists: [ListKey, Pair[]][] = [
    ["customers", kinds.has("zoho_contacts") ? matchCompanies(zohoCustomers.parties, oldCustomers.parties) : []],
    ["vendors", kinds.has("zoho_vendors") ? matchCompanies(zohoVendors.parties, oldVendors.parties) : []],
    ["products", kinds.has("zoho_items") ? matchProducts(zohoItems.parties, oldProducts.parties) : []],
  ];
  // A vendor that is also a customer becomes one company with both roles: said on its vendor row.
  const customerGstins = new Set(zohoCustomers.parties.flatMap((p) => p.gstins));
  for (const p of lists[1]![1]) {
    const z = zohoVendors.parties.find((v) => v.id === p.zohoId);
    if (z?.gstins.some((g) => customerGstins.has(g))) p.reason += " · also a Zoho customer: one company, both roles";
  }

  await db.legacyMatch.deleteMany({ where: { importId } });
  for (const [list, pairs] of lists) {
    for (let i = 0; i < pairs.length; i += 1000) {
      await db.legacyMatch.createMany({ data: pairs.slice(i, i + 1000).map((p) => ({ importId, list, zohoId: p.zohoId, oldId: p.oldId, zohoLabel: p.zohoLabel, oldLabel: p.oldLabel, status: p.status, reason: p.reason, flagged: !!p.flagged })) });
    }
  }
  await buildContacts(importId);
  return { counts: await masterCounts(importId), notes };
}

/** The contacts list, afresh: for every pair of companies taken as one, its people side by side. */
export async function buildContacts(importId: string) {
  await db.legacyMatch.deleteMany({ where: { importId, list: "contacts" } });
  const pairs = await db.legacyMatch.findMany({ where: { importId, list: { in: ["customers", "vendors"] }, status: { in: ["MATCHED", "CONFIRMED"] }, zohoId: { not: null }, oldId: { not: null } }, select: { id: true, list: true, zohoId: true, oldId: true } });
  if (pairs.length === 0) return;
  const zohoPeople = new Map<string, Party[]>();
  const add = (key: string, party: Party) => (zohoPeople.get(key) ?? zohoPeople.set(key, []).get(key)!).push(party);
  for await (const { row: r } of rowsOf(importId, "zoho_contact_persons")) {
    add(`customers:${clean(r["Customer ID"])}`, { id: clean(r["Contact Person ID"]), name: nameOf(r["First Name"], r["Last Name"]), label: [nameOf(r["First Name"], r["Last Name"]), clean(r.EmailID)].filter(Boolean).join(" · "), gstins: [], emails: [r.EmailID ?? ""], phones: [r.MobilePhone ?? "", r.Phone ?? ""] });
  }
  for await (const { row: r } of rowsOf(importId, "zoho_vendor_contact_persons")) {
    add(`vendors:${clean(r["Vendor ID"])}`, { id: clean(r["Contact Person ID"]), name: nameOf(r["First Name"], r["Last Name"]), label: [nameOf(r["First Name"], r["Last Name"]), clean(r.EmailID)].filter(Boolean).join(" · "), gstins: [], emails: [r.EmailID ?? ""], phones: [r.MobilePhone ?? "", r.Phone ?? ""] });
  }
  // A Zoho customer's own name, email and mobile are its primary contact.
  for await (const { row: r } of rowsOf(importId, "zoho_contacts")) {
    const person = nameOf(r["First Name"], r["Last Name"]);
    if (person || clean(r.EmailID)) add(`customers:${clean(r["Contact ID"])}`, { id: `${clean(r["Contact ID"])}:primary`, name: person, label: [person, clean(r.EmailID)].filter(Boolean).join(" · "), gstins: [], emails: [r.EmailID ?? ""], phones: [r.MobilePhone ?? "", r.Phone ?? ""] });
  }
  const oldPeople = new Map<string, Party[]>();
  for await (const { row: r } of rowsOf(importId, "employees")) {
    if (!live(r)) continue;
    const name = nameOf(r.first_name === "N/A" ? "" : r.first_name, r.last_name);
    if (!name && !clean(r.email) && !clean(r.phone)) continue;
    const key = `customers:${clean(r.customer_id)}`;
    (oldPeople.get(key) ?? oldPeople.set(key, []).get(key)!).push({ id: clean(r.id), name, label: [name, clean(r.email)].filter(Boolean).join(" · "), gstins: [], emails: [r.email ?? ""], phones: [r.phone ?? ""] });
  }
  const rows: Prisma.LegacyMatchCreateManyInput[] = [];
  for (const p of pairs) {
    const zoho = zohoPeople.get(`${p.list}:${p.zohoId}`) ?? [];
    const old = p.list === "customers" ? (oldPeople.get(`customers:${p.oldId}`) ?? []) : [];
    for (const m of matchContacts(zoho, old)) rows.push({ importId, list: "contacts", parentId: p.id, zohoId: m.zohoId, oldId: m.oldId, zohoLabel: m.zohoLabel, oldLabel: m.oldLabel, status: m.status, reason: m.reason, flagged: !!m.flagged });
  }
  for (let i = 0; i < rows.length; i += 1000) await db.legacyMatch.createMany({ data: rows.slice(i, i + 1000) });
}

/** Each list's rows by status — matched counts what was confirmed too. */
export async function masterCounts(importId: string): Promise<Record<string, Record<string, number>>> {
  const groups = await db.legacyMatch.groupBy({ by: ["list", "status"], where: { importId }, _count: { _all: true } });
  const out: Record<string, Record<string, number>> = {};
  for (const g of groups) (out[g.list] ??= {})[g.status] = g._count._all;
  const flagged = await db.legacyMatch.count({ where: { importId, list: "contacts", flagged: true, status: "MATCHED" } });
  if (flagged) (out.contacts ??= {}).FLAGGED = flagged;
  return out;
}


const STATUS_GROUPS: Record<string, string[]> = {
  matched: ["MATCHED", "CONFIRMED"],
  suggested: ["SUGGESTED"],
  zoho: ["ZOHO_ONLY"],
  old: ["OLD_ONLY", "REJECTED"],
};

/** A page of one list: matched (with the reason), suggested, only in Zoho, only in WroffyCRM — searchable by name. */
export async function listMatches(importId: string, list: string, group: string, query: string, page: number): Promise<{ rows: MatchRow[]; total: number }> {
  const statuses = STATUS_GROUPS[group] ?? STATUS_GROUPS.matched!;
  const q = clean(query);
  const where: Prisma.LegacyMatchWhereInput = {
    importId,
    list,
    status: { in: statuses },
    ...(group === "matched" && list === "contacts" && q === "flagged" ? { flagged: true } : q ? { OR: [{ zohoLabel: { contains: q, mode: "insensitive" } }, { oldLabel: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    db.legacyMatch.findMany({ where, orderBy: [{ flagged: "desc" }, { zohoLabel: "asc" }, { oldLabel: "asc" }], skip: Math.max(0, page) * 50, take: 50, select: { id: true, list: true, zohoId: true, oldId: true, zohoLabel: true, oldLabel: true, status: true, reason: true, flagged: true, parentId: true } }),
    db.legacyMatch.count({ where }),
  ]);
  const parents = new Map((await db.legacyMatch.findMany({ where: { id: { in: rows.map((r) => r.parentId).filter((x): x is string => !!x) } }, select: { id: true, zohoLabel: true } })).map((p) => [p.id, p.zohoLabel]));
  return { rows: rows.map((r) => ({ ...r, company: r.parentId ? (parents.get(r.parentId) ?? null) : null })), total };
}

/**
 * Settles a row: a suggestion confirmed or rejected, a match undone. Rejecting splits it into its two records, each
 * alone; a company pair's decision rebuilds the contacts list.
 */
export async function decideMatch(importId: string, matchId: string, decision: "confirm" | "reject") {
  const row = await db.legacyMatch.findFirst({ where: { id: matchId, importId }, select: { id: true, list: true, status: true, zohoId: true, oldId: true, zohoLabel: true, oldLabel: true, reason: true } });
  if (!row) throw new ImportRefused("That row isn't in the lists any more — build them again.");
  if (decision === "confirm") {
    if (row.status !== "SUGGESTED") throw new ImportRefused("Only a suggestion is confirmed.");
    await db.legacyMatch.update({ where: { id: row.id }, data: { status: "CONFIRMED", reason: `${row.reason} — confirmed` } });
  } else {
    if (!["SUGGESTED", "MATCHED", "CONFIRMED"].includes(row.status) || !row.zohoId || !row.oldId) throw new ImportRefused("Only a pair can be split.");
    await db.$transaction(async (tx) => {
      await tx.legacyMatch.update({ where: { id: row.id }, data: { status: "REJECTED", zohoId: null, zohoLabel: null, reason: `Not the same as ${row.zohoLabel} (${row.reason})` } });
      const stillPaired = await tx.legacyMatch.count({ where: { importId, list: row.list, zohoId: row.zohoId, status: { in: ["MATCHED", "CONFIRMED", "SUGGESTED"] } } });
      if (!stillPaired) await tx.legacyMatch.create({ data: { importId, list: row.list, zohoId: row.zohoId, zohoLabel: row.zohoLabel, status: "ZOHO_ONLY", reason: `Not the same as ${row.oldLabel}` } });
    });
  }
  if (row.list === "customers" || row.list === "vendors") await buildContacts(importId);
}

const csvCell = (v: string | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const LIST_HEADINGS = ["List", "Status", "Reason", "Zoho id", "Zoho record", "WroffyCRM id", "WroffyCRM record", "Decision"];

/** A list as CSV, to check many at once: write confirm, reject or pair in Decision and upload it back. */
export async function masterCsv(importId: string, list: string): Promise<string> {
  const rows = await db.legacyMatch.findMany({ where: { importId, list }, orderBy: [{ status: "asc" }, { zohoLabel: "asc" }], select: { list: true, status: true, reason: true, zohoId: true, zohoLabel: true, oldId: true, oldLabel: true } });
  return [LIST_HEADINGS.map(csvCell).join(","), ...rows.map((r) => [r.list, r.status, r.reason, r.zohoId, r.zohoLabel, r.oldId, r.oldLabel, ""].map(csvCell).join(","))].join("\n") + "\n";
}

/**
 * A list back from CSV: each row with a Decision — confirm (a suggestion), reject (a pair), or pair (a Zoho id and a
 * WroffyCRM id from the lists, taken as one). Rows without one are left as they are. Every id is checked first;
 * nothing changes unless all of them are good.
 */
export async function applyMasterCsv(importId: string, list: string, rows: Record<string, string>[]): Promise<{ confirmed: number; rejected: number; paired: number }> {
  const all = await db.legacyMatch.findMany({ where: { importId, list }, select: { id: true, status: true, zohoId: true, oldId: true, zohoLabel: true, oldLabel: true } });
  const zohoLabels = new Map(all.filter((r) => r.zohoId).map((r) => [r.zohoId!, r.zohoLabel]));
  const oldLabels = new Map(all.filter((r) => r.oldId).map((r) => [r.oldId!, r.oldLabel]));
  const plan: { kind: "confirm" | "reject"; id: string }[] = [];
  const pairs: { zohoId: string; oldId: string }[] = [];
  rows.forEach((r, i) => {
    const decision = clean(r.Decision).toLowerCase();
    if (!decision) return;
    const zohoId = clean(r["Zoho id"]);
    const oldId = clean(r["WroffyCRM id"]);
    const line = i + 2;
    if (decision === "pair") {
      if (!zohoLabels.has(zohoId) || !oldLabels.has(oldId)) throw new ImportRefused(`Line ${line}: ${!zohoLabels.has(zohoId) ? `Zoho id "${zohoId}"` : `WroffyCRM id "${oldId}"`} isn't in this list.`);
      pairs.push({ zohoId, oldId });
      return;
    }
    if (decision !== "confirm" && decision !== "reject") throw new ImportRefused(`Line ${line}: the decision is confirm, reject or pair — not "${r.Decision}".`);
    const row = all.find((x) => x.zohoId === (zohoId || null) && x.oldId === (oldId || null));
    if (!row) throw new ImportRefused(`Line ${line}: that pair isn't in the list any more — download it again.`);
    plan.push({ kind: decision, id: row.id });
  });
  let confirmed = 0;
  let rejected = 0;
  for (const p of plan) {
    await decideMatch(importId, p.id, p.kind).then(() => (p.kind === "confirm" ? confirmed++ : rejected++)).catch(() => undefined);
  }
  for (const p of pairs) {
    await db.$transaction(async (tx) => {
      // The WroffyCRM record's row becomes the pair; a Zoho record left alone loses its "only in Zoho" row.
      const own = await tx.legacyMatch.findFirst({ where: { importId, list, oldId: p.oldId }, select: { id: true } });
      const data = { zohoId: p.zohoId, zohoLabel: zohoLabels.get(p.zohoId) ?? null, oldLabel: oldLabels.get(p.oldId) ?? null, status: "CONFIRMED", reason: "Paired by hand" };
      if (own) await tx.legacyMatch.update({ where: { id: own.id }, data });
      else await tx.legacyMatch.create({ data: { importId, list, oldId: p.oldId, ...data } });
      await tx.legacyMatch.deleteMany({ where: { importId, list, zohoId: p.zohoId, status: "ZOHO_ONLY" } });
    });
  }
  if (pairs.length && (list === "customers" || list === "vendors")) await buildContacts(importId);
  return { confirmed, rejected, paired: pairs.length };
}
