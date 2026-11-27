/**
 * Each person's own order for the sidebar (owner, 17 Nov 2026: "har user apni sidebar edit kar sake").
 *
 * Only the order changes, never what is in the menu or where a page lives: the sections can be put in another order
 * (each stays under its own heading — CRM, Finance… — since the heading is worked out from the section), and a
 * section's pages in another order inside it; a split section's parts (Finance → Accounts' Sales, Purchases…) too, and
 * a part's pages inside the part. A page never leaves its section, nor a part's page its part: the order is a
 * permutation of what `buildNavigation` gave, and nothing more.
 *
 * Stored on the person (User.sidebarOrder) as the names and addresses in the order they chose. What they never placed —
 * a module switched on since, a page added — keeps the app's order, after what they did place. Pure and client-safe:
 * the layout applies it on the server, and the sidebar applies a draft while it is being arranged.
 */

export type SidebarOrder = {
  /** The sections, by name, in the person's order. */
  groups?: string[];
  /** Each section's pages, by address, in the person's order. */
  items?: Record<string, string[]>;
  /** A split section's parts, by name, in the person's order. */
  parts?: Record<string, string[]>;
};

/** How much is kept — far more than any menu has, so a crafted request can't store a novel. */
const LIMITS = { groups: 60, keys: 60, perList: 200, text: 120 } as const;

const cleanList = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const s = x.trim();
    if (!s || s.length > LIMITS.text || out.includes(s)) continue;
    out.push(s);
    if (out.length >= LIMITS.perList) break;
  }
  return out;
};

const cleanMap = (v: unknown): Record<string, string[]> | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(v as Record<string, unknown>).slice(0, LIMITS.keys)) {
    const k = key.trim();
    if (!k || k.length > LIMITS.text) continue;
    const l = cleanList(list);
    if (l && l.length) out[k] = l;
  }
  return out;
};

/** The stored order, read tolerantly: anything malformed is left out, and the app's order stands for it. */
export function readSidebarOrder(raw: unknown): SidebarOrder {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: SidebarOrder = {};
  const groups = cleanList(r.groups)?.slice(0, LIMITS.groups);
  if (groups?.length) out.groups = groups;
  const items = cleanMap(r.items);
  if (items && Object.keys(items).length) out.items = items;
  const parts = cleanMap(r.parts);
  if (parts && Object.keys(parts).length) out.parts = parts;
  return out;
}

/** Whether the person has an order of their own at all. */
export const hasSidebarOrder = (order: SidebarOrder) => !!(order.groups?.length || Object.keys(order.items ?? {}).length || Object.keys(order.parts ?? {}).length);

/** A position in the person's list; what they never placed comes after, in the order it came in (the sort is stable). */
const rankIn = (list: string[] | undefined, key: string | null | undefined) => {
  const i = list && key ? list.indexOf(key) : -1;
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
};

/**
 * The menu in the person's order. Sections are reordered among themselves; each section's pages among themselves —
 * a split one's by part first, then within the part — so the parts stay whole and every page stays where it lives.
 */
export function applySidebarOrder<I extends { href: string; section?: string }, S extends { group: string; items: I[] }>(sections: readonly S[], order: SidebarOrder): S[] {
  if (!hasSidebarOrder(order)) return [...sections];
  const sortedSections = sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rankIn(order.groups, a.s.group) - rankIn(order.groups, b.s.group) || a.i - b.i)
    .map(({ s }) => s);
  return sortedSections.map((s) => {
    const itemOrder = order.items?.[s.group];
    const partOrder = order.parts?.[s.group];
    if (!itemOrder && !partOrder) return s;
    // The parts as they come, so a part the person never placed keeps its place among the others.
    const defaultParts: string[] = [];
    for (const i of s.items) if (i.section && !defaultParts.includes(i.section)) defaultParts.push(i.section);
    const partRank = (part: string | undefined) => {
      if (!part) return -1;
      const own = rankIn(partOrder, part);
      return own === Number.MAX_SAFE_INTEGER ? 10_000 + defaultParts.indexOf(part) : own;
    };
    const items = s.items
      .map((item, i) => ({ item, i }))
      .sort((a, b) => partRank(a.item.section) - partRank(b.item.section) || rankIn(itemOrder, a.item.href) - rankIn(itemOrder, b.item.href) || a.i - b.i)
      .map(({ item }) => item);
    return { ...s, items };
  });
}

/** The order a menu is in, as it would be stored — what the arranging sidebar saves. */
export function orderOf(sections: readonly { group: string; items: { href: string; section?: string }[] }[]): SidebarOrder {
  const items: Record<string, string[]> = {};
  const parts: Record<string, string[]> = {};
  for (const s of sections) {
    items[s.group] = s.items.map((i) => i.href);
    const p: string[] = [];
    for (const i of s.items) if (i.section && !p.includes(i.section)) p.push(i.section);
    if (p.length) parts[s.group] = p;
  }
  return { groups: sections.map((s) => s.group), items, ...(Object.keys(parts).length ? { parts } : {}) };
}

/** A list with one entry moved from one place to another — within the same list, which is all arranging allows. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}
