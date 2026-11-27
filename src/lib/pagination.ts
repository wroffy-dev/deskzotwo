/**
 * Page-size choices for list screens. Lives here rather than beside the query action because a
 * `"use server"` module can only export async functions — a plain constant there fails the build.
 */
export const PAGE_SIZES = [25, 50, 100, 200] as const;

export const DEFAULT_PAGE_SIZE = 50;

export function resolvePageSize(value?: string) {
  const size = Number(value);
  return PAGE_SIZES.includes(size as (typeof PAGE_SIZES)[number]) ? size : DEFAULT_PAGE_SIZE;
}

export function resolvePage(value?: string) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

/** What every paginated list query returns: the page's rows plus the unpaginated total. */
export type Paged<T> = { rows: T[]; total: number };

/**
 * The most rows one page may hold, whatever the caller asks for. The list screens offer up to 200 (PAGE_SIZES) and
 * one screen reads 500 invitations at once; a server action is a public endpoint, and before this ceiling a
 * hand-made call with `pageSize: 1000000` returned every lead or company in scope in one go, past the export
 * permission (security audit, 11 Nov 2026 — SEC-29).
 */
export const MAX_PAGE_SIZE = 500;

/**
 * The most rows a list reader without pages (`listCompanies`, `listOrders`, …) returns. Security audit, 13 Nov 2026
 * (SEC-29): those readers answered every row in scope to one call. No screen draws them unpaged — the screens use the
 * `…Paged` siblings — so this only bounds what a hand-made call, a picker or a check suite can pull at once.
 */
export const UNPAGED_LIST_CEILING = 5_000;

/** A page number and size made safe: whole numbers, page 1 or later, 1 to MAX_PAGE_SIZE rows. */
export function clampPage(page: number, pageSize: number) {
  const p = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const size = Number.isFinite(pageSize) && pageSize >= 1 ? Math.min(MAX_PAGE_SIZE, Math.floor(pageSize)) : DEFAULT_PAGE_SIZE;
  return { page: p, pageSize: size };
}

/** Prisma's `skip`/`take` for a page, clamped, so no list query has to do the arithmetic or the bounds itself. */
export function pageSlice(page: number, pageSize: number) {
  const c = clampPage(page, pageSize);
  return { skip: (c.page - 1) * c.pageSize, take: c.pageSize };
}

export function totalPages(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Slices an already-fetched array. Used where the rows can't be paginated in SQL — a list whose
 * ordering or filtering is computed in JS after the query (renewal status, payment balances) has to
 * see every row before it can pick a page.
 */
export function pageOf<T>(rows: T[], page: number, pageSize: number): Paged<T> {
  const { skip, take } = pageSlice(page, pageSize);
  return { rows: rows.slice(skip, skip + take), total: rows.length };
}
