import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { companyScope } from "@/lib/authz/company-scope";
import { contactScope } from "@/lib/authz/contact-access";
import { leadAccess } from "@/lib/authz/access";
import { rightsFor } from "@/lib/smart-lists/access";
import { moduleAccessFor } from "@/lib/modules-access";
import { companyPath, leadPath } from "@/lib/record-links";
import { isLinkKind, linkTargetOf, type LinkKind, type PropertyKind } from "@/lib/smart-lists/values";

/**
 * Columns that link a Smart List's rows to records elsewhere (owner, 20 Nov 2026 — Smart Lists phase 2: "a backlink
 * linked to the article in the Content calendar, a site survey linked to its customer"): a company, a lead, a contact,
 * or a row of another list. The value is their ids. Each person sees — and may link — only what is theirs to see:
 * companies by `companyScope`, leads by `leadAccess` (with leads open to them), contacts by `contactScope`, another
 * list's rows only when they may open that list. A link they may not see shows as "Hidden", never by name. Server only.
 */

export type LinkLabel = { name: string; href: string | null; hidden?: boolean };

const LEADS_OPEN = async (userId: string) => (await moduleAccessFor(userId, "leads")) === "available" && (await can(userId, "leads.view"));

async function leadWhere(userId: string): Promise<Prisma.LeadWhereInput> {
  return (await LEADS_OPEN(userId)) ? leadAccess(userId, "view") : { id: { in: [] } };
}

/** Whether `userId` may open the list `listId` (its own rule — src/lib/smart-lists/open-list.ts). */
export async function mayOpenList(userId: string, listId: string): Promise<boolean> {
  const wb = await db.workbook.findUnique({ where: { id: listId }, select: { id: true, shared: true, ownerUserId: true } });
  if (!wb) return false;
  // The list's own rule, chosen people and departments too (Smart Lists phase 4 — src/lib/smart-lists/access.ts).
  return (await rightsFor(userId, wb)).view;
}

/** Records of `kind` whose name holds `query`, that `userId` may see — the picker's results. */
export async function searchLinkable(kind: LinkKind, query: string, userId: string, targetListId: string | null): Promise<{ id: string; name: string; sub: string | null }[]> {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 80);
  const take = 15;
  switch (kind) {
    case "COMPANY": {
      const rows = await db.company.findMany({
        where: { AND: [await companyScope(userId), q ? { name: { contains: q, mode: "insensitive" } } : {}] },
        orderBy: { name: "asc" },
        take,
        select: { id: true, name: true, locations: { where: { isPrimary: true }, take: 1, select: { city: true } } },
      });
      return rows.map((r) => ({ id: r.id, name: r.name, sub: r.locations[0]?.city ?? null }));
    }
    case "LEAD": {
      const rows = await db.lead.findMany({
        where: { AND: [await leadWhere(userId), q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { company: { name: { contains: q, mode: "insensitive" } } }] } : {}] },
        orderBy: { updatedAt: "desc" },
        take,
        select: { id: true, title: true, company: { select: { name: true } } },
      });
      return rows.map((r) => ({ id: r.id, name: r.title, sub: r.company?.name ?? null }));
    }
    case "CONTACT": {
      const rows = await db.contact.findMany({
        where: { AND: [await contactScope(userId), q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } : {}] },
        orderBy: { name: "asc" },
        take,
        select: { id: true, name: true, company: { select: { name: true } } },
      });
      return rows.map((r) => ({ id: r.id, name: r.name, sub: r.company?.name ?? null }));
    }
    case "ROW": {
      if (!targetListId || !(await mayOpenList(userId, targetListId))) return [];
      const rows = await db.workbookRow.findMany({
        where: { workbookId: targetListId, ...(q ? { title: { contains: q, mode: "insensitive" } } : {}) },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        take,
        select: { id: true, title: true },
      });
      return rows.map((r) => ({ id: r.id, name: r.title, sub: null }));
    }
  }
}

/** Of `ids`, the ones `userId` may link in a column of `kind` — what a save keeps. */
export async function linkableIds(kind: LinkKind, ids: string[], userId: string, targetListId: string | null): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const inIds = { id: { in: ids } };
  switch (kind) {
    case "COMPANY":
      return new Set((await db.company.findMany({ where: { AND: [await companyScope(userId), inIds] }, select: { id: true } })).map((r) => r.id));
    case "LEAD":
      return new Set((await db.lead.findMany({ where: { AND: [await leadWhere(userId), inIds] }, select: { id: true } })).map((r) => r.id));
    case "CONTACT":
      return new Set((await db.contact.findMany({ where: { AND: [await contactScope(userId), inIds] }, select: { id: true } })).map((r) => r.id));
    case "ROW":
      if (!targetListId || !(await mayOpenList(userId, targetListId))) return new Set();
      return new Set((await db.workbookRow.findMany({ where: { workbookId: targetListId, ...inIds }, select: { id: true } })).map((r) => r.id));
  }
}

/**
 * The names and addresses of every record and file the cells on screen link to — by id — as `userId` may see them.
 * A record they may not see reads "Hidden" with no address; one since deleted reads as nothing.
 */
export async function linkLabels(
  props: { id: string; kind: PropertyKind; options?: unknown; target?: string | null }[],
  values: Record<string, Record<string, unknown>>,
  userId: string,
): Promise<Record<string, LinkLabel>> {
  const want = new Map<string, Set<string>>();
  for (const p of props) {
    if (!["COMPANY", "LEAD", "CONTACT", "ROW", "FILE"].includes(p.kind)) continue;
    const key = p.kind === "ROW" ? `ROW:${p.target ?? linkTargetOf(p.options) ?? ""}` : p.kind;
    for (const row of Object.values(values)) {
      const v = row[p.id];
      if (Array.isArray(v)) for (const id of v) (want.get(key) ?? want.set(key, new Set()).get(key)!).add(String(id));
    }
  }
  const out: Record<string, LinkLabel> = {};
  const hide = (ids: Iterable<string>, seen: Set<string>) => {
    for (const id of ids) if (!seen.has(id) && !out[id]) out[id] = { name: "Hidden", href: null, hidden: true };
  };
  for (const [key, set] of want) {
    const ids = [...set];
    if (key === "COMPANY") {
      const all = await db.company.findMany({ where: { id: { in: ids } }, select: { id: true } });
      const seen = await db.company.findMany({ where: { AND: [await companyScope(userId), { id: { in: ids } }] }, select: { id: true, name: true, companySeq: true } });
      for (const c of seen) out[c.id] = { name: c.name, href: companyPath(c.companySeq) };
      hide(all.map((c) => c.id), new Set(seen.map((c) => c.id)));
    } else if (key === "LEAD") {
      const all = await db.lead.findMany({ where: { id: { in: ids } }, select: { id: true } });
      const seen = await db.lead.findMany({ where: { AND: [await leadWhere(userId), { id: { in: ids } }] }, select: { id: true, title: true, leadSeq: true } });
      for (const l of seen) out[l.id] = { name: l.title, href: leadPath(l.leadSeq) };
      hide(all.map((l) => l.id), new Set(seen.map((l) => l.id)));
    } else if (key === "CONTACT") {
      const all = await db.contact.findMany({ where: { id: { in: ids } }, select: { id: true } });
      const seen = await db.contact.findMany({ where: { AND: [await contactScope(userId), { id: { in: ids } }] }, select: { id: true, name: true, company: { select: { companySeq: true } } } });
      for (const c of seen) out[c.id] = { name: c.name, href: c.company ? `${companyPath(c.company.companySeq)}?tab=contacts` : null };
      hide(all.map((c) => c.id), new Set(seen.map((c) => c.id)));
    } else if (key === "FILE") {
      for (const f of await db.workbookFile.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) out[f.id] = { name: f.name, href: `/api/smart-lists/files/${f.id}` };
    } else if (key.startsWith("ROW:")) {
      const listId = key.slice(4);
      if (!listId) continue;
      const open = await mayOpenList(userId, listId);
      const rows = await db.workbookRow.findMany({ where: { workbookId: listId, id: { in: ids } }, select: { id: true, title: true } });
      for (const r of rows) out[r.id] = open ? { name: r.title, href: `/smart-lists/${listId}?q=${encodeURIComponent(r.title)}` } : { name: "Hidden", href: null, hidden: true };
    }
  }
  return out;
}

/**
 * The lists whose rows link to a record — for "In these lists" on a company's or a lead's page. Only lists the person
 * may open, and only the rows' titles.
 */
export async function listsLinking(kind: "COMPANY" | "LEAD" | "CONTACT", recordId: string, userId: string): Promise<{ listId: string; listName: string; rows: { id: string; title: string }[] }[]> {
  const props = await db.workbookProperty.findMany({ where: { kind }, select: { id: true, workbookId: true } });
  if (!props.length) return [];
  const hits = await db.workbookRowValue.findMany({
    where: { propertyId: { in: props.map((p) => p.id) }, value: { array_contains: [recordId] } },
    select: { rowId: true, workbookId: true, row: { select: { title: true } } },
    take: 200,
  });
  const byList = new Map<string, { id: string; title: string }[]>();
  for (const h of hits) (byList.get(h.workbookId) ?? byList.set(h.workbookId, []).get(h.workbookId)!).push({ id: h.rowId, title: h.row.title });
  const lists = await db.workbook.findMany({ where: { id: { in: [...byList.keys()] } }, select: { id: true, name: true } });
  const out: { listId: string; listName: string; rows: { id: string; title: string }[] }[] = [];
  for (const l of lists) if (await mayOpenList(userId, l.id)) out.push({ listId: l.id, listName: l.name, rows: byList.get(l.id)! });
  return out.sort((a, b) => a.listName.localeCompare(b.listName));
}

/**
 * What a link or file cell keeps, given what the person chose and what it held: a record they may link, or one already
 * there they can't see (left as it was — somebody else linked it); a file of this very cell.
 */
export async function checkedCellValue(kind: PropertyKind, propertyId: string, options: unknown, rowKey: string, chosen: string[], held: unknown, userId: string): Promise<string[] | { error: string }> {
  const before = new Set(Array.isArray(held) ? held.map(String) : []);
  if (kind === "FILE") {
    const files = new Set((await db.workbookFile.findMany({ where: { propertyId, rowKey, id: { in: chosen } }, select: { id: true } })).map((f) => f.id));
    return chosen.filter((id) => files.has(id));
  }
  if (!isLinkKind(kind)) return chosen;
  const linkable = await linkableIds(kind, chosen, userId, linkTargetOf(options));
  const kept = chosen.filter((id) => linkable.has(id) || before.has(id));
  if (kept.length < chosen.length) return { error: "One of those isn't yours to link." };
  return kept;
}

/**
 * Records a spreadsheet names, matched by name — a company's, a lead's title, a contact's name or email — whatever the
 * case, among those `userId` may see (Smart Lists phase 3: "matching link columns by name when importing"). A name two
 * of them share matches neither. Returns lower-case name → id.
 */
export async function matchLinkNames(kind: "COMPANY" | "LEAD" | "CONTACT", names: string[], userId: string): Promise<Map<string, string>> {
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 2000);
  const out = new Map<string, string>();
  if (!wanted.length) return out;
  const seen = new Map<string, Set<string>>();
  const add = (name: string | null | undefined, id: string) => {
    if (!name) return;
    const key = name.trim().toLowerCase();
    (seen.get(key) ?? seen.set(key, new Set()).get(key)!).add(id);
  };
  if (kind === "COMPANY") {
    for (const c of await db.company.findMany({ where: { AND: [await companyScope(userId), { name: { in: wanted, mode: "insensitive" } }] }, select: { id: true, name: true }, take: 5000 })) add(c.name, c.id);
  } else if (kind === "LEAD") {
    for (const l of await db.lead.findMany({ where: { AND: [await leadWhere(userId), { title: { in: wanted, mode: "insensitive" } }] }, select: { id: true, title: true }, take: 5000 })) add(l.title, l.id);
  } else {
    const people = await db.contact.findMany({
      where: { AND: [await contactScope(userId), { OR: [{ name: { in: wanted, mode: "insensitive" } }, { email: { in: wanted, mode: "insensitive" } }] }] },
      select: { id: true, name: true, email: true },
      take: 5000,
    });
    for (const c of people) {
      add(c.name, c.id);
      add(c.email, c.id);
    }
  }
  for (const [key, ids] of seen) if (ids.size === 1) out.set(key, [...ids][0]!);
  return out;
}
