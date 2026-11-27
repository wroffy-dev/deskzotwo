import { SLUG_PATTERN } from "@/lib/workspace-names";

/**
 * Demo booking on deskzo.com (owner, 18 Nov 2026 — "deskzo sales team would also need a crm"): one of the platform's own
 * workspaces — Deskzo's — and one of its booking pages. Every "Book a demo" link on the site, and anything marked
 * `data-deskzo-book` (the hero's email box), opens that page in a pop-up (src/lib/booking/embed.ts), so a demo lands in
 * Deskzo's own CRM as a booking, a meeting in a salesperson's calendar and a lead with the visitor's answers.
 *
 * The CMS keeps only the workspace's name and the page's address, as it does for the website chat
 * (src/lib/platform/site-chat.ts); the site makes the script's address itself. Pure and client-safe.
 */

export type SiteBooking = { workspace: string; page: string };

/** A booking page's address, as src/lib/booking/rules.ts allows them. */
export const BOOKING_PAGE_PATTERN = /^[a-z0-9][a-z0-9-]{2,40}$/;

/** The site's own links that open it, besides anything marked data-deskzo-book: its "Book a demo" links. */
export const SITE_BOOKING_LINKS = 'a[href^="/contact?topic=demo"], a[href="#book-demo"]';

export function bookingIsOn(booking: Partial<SiteBooking> | null | undefined): booking is SiteBooking {
  return !!booking && SLUG_PATTERN.test(booking.workspace ?? "") && BOOKING_PAGE_PATTERN.test(booking.page ?? "") && booking.page !== "manage";
}

/** What is wrong, field by field — nothing when both are empty (no pop-up: the links go to the contact page) or both are right. */
export function bookingProblems(booking: Partial<SiteBooking> | null | undefined): { workspace?: string; page?: string } {
  const workspace = (booking?.workspace ?? "").trim();
  const page = (booking?.page ?? "").trim();
  if (!workspace && !page) return {};
  return {
    ...(!workspace ? { workspace: "Which workspace's booking page? Its name, as in name.deskzo.com." } : !SLUG_PATTERN.test(workspace) ? { workspace: "A workspace's name: lower-case letters, digits and hyphens, as in its address." } : {}),
    ...(!page ? { page: "The booking page's address — demo for …/book/demo." } : !BOOKING_PAGE_PATTERN.test(page) || page === "manage" ? { page: "A booking page's address: lower-case letters, digits and hyphens, as after /book/." } : {}),
  };
}

/** The workspace and page from a booking page's address — https://deskzo.deskzo.com/book/demo. Null for anything else. */
export function bookingFromAddress(text: string): SiteBooking | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const page = /^\/book\/([a-z0-9][a-z0-9-]{2,40})\/?$/.exec(url.pathname)?.[1] ?? "";
  const workspace = url.hostname.split(".")[0] ?? "";
  const found = { workspace, page };
  return bookingIsOn(found) ? found : null;
}
