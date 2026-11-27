import { MODULE_REGISTRY } from "@/lib/modules";
import { sectionPermission } from "@/lib/permissions";

/**
 * The menu's pages, each under the section switch of the module it belongs to — what a role's per-page ticks are
 * made of (owner, 2 Nov 2026: "per-page ticks"). Plain data, for the role screen, the menu and the door alike.
 */
export type MenuPage = { href: string; label: string; moduleKey: string; section: string; countries?: readonly string[] };

export const MENU_PAGES: readonly MenuPage[] = MODULE_REGISTRY.flatMap((m) =>
  m.navItems.map((i) => ({
    href: i.href,
    // Read when shown, as the menu's own is: "Delivery Notes" outside India.
    get label() {
      return i.label;
    },
    moduleKey: m.key,
    section: sectionPermission(m.key),
    ...(i.countries ? { countries: i.countries } : {}),
  })),
);

/**
 * Whether a page is one this workspace's country has — the rule the menu itself uses (src/lib/navigation.ts): e-way
 * bills, GST returns and TDS are India's, the VAT return and corporate tax the UAE's (owner, 16 Nov 2026: "eway
 * bills in uae?" — the role screen offered them as ticks to a UAE workspace).
 */
export const pageInCountry = (page: Pick<MenuPage, "countries">, country: string | null | undefined): boolean =>
  !page.countries || !country || page.countries.includes(country);

/** Longest first, so /items/brands is its own page and not part of /items. */
const HREFS = [...new Set(MENU_PAGES.map((p) => p.href))].sort((a, b) => b.length - a.length);

/**
 * The menu page an address belongs to: the page itself, or the deepest page it sits under — /sales/challans/new is
 * Delivery Challans', /items/123 is Items & Inventory's. Null for an address no menu page covers.
 */
export function pageOf(pathname: string): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return HREFS.find((h) => path === h || (h !== "/" && path.startsWith(`${h}/`))) ?? null;
}

/** The pages a section switch covers, in the menu's order — given a country, only the pages that country has. */
export function pagesOfSection(sectionKey: string, country?: string | null): MenuPage[] {
  return MENU_PAGES.filter((p) => p.section === sectionKey && pageInCountry(p, country));
}

export function isMenuPage(href: string): boolean {
  return MENU_PAGES.some((p) => p.href === href);
}
