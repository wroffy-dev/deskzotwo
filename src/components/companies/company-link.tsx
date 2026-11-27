"use client";

import Link from "next/link";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";

/**
 * A company's name where it is a link — for somebody who may open it. For somebody whose role has no Companies &
 * Contacts, the same words without the link (owner, 25 Nov 2026: "if company view permission is not there than
 * hyperlink should not be there for that person" — Support, opening a ticket's customer, landed on a page refused).
 *
 * Whether they may is the menu's own answer (`accessContextFor`), handed down once by the dashboard layout; the page
 * asks again whatever is drawn here. Outside that layout — the portal, a check script — it is a link, as before.
 *
 * For one company a person can't open though they have the section, the caller says so: `shut`.
 *
 * Use this, not next/link, for anything that may lead to /companies/…; an address that doesn't is an ordinary link.
 */
const OpensCompanies = createContext(true);

export function CompanyLinksProvider({ open, children }: { open: boolean; children: ReactNode }) {
  return <OpensCompanies.Provider value={open}>{children}</OpensCompanies.Provider>;
}

/** Whether this person may open companies at all. */
export function useOpensCompanies(): boolean {
  return useContext(OpensCompanies);
}

/** /companies itself and all beneath it — never /companies-something else. */
export const leadsToCompanies = (href: unknown): boolean => typeof href === "string" && /^\/companies(?=$|[/?#])/.test(href);

/** The link's classes without what makes it look like one. */
export function plainClasses(className: string | undefined): string | undefined {
  const kept = (className ?? "").split(/\s+/).filter((c) => c && !/^(hover:|focus-visible:|underline$|underline-offset-|text-brand$)/.test(c));
  return kept.length ? kept.join(" ") : undefined;
}

type Props = ComponentProps<typeof Link> & {
  /** This one company is out of their reach. */
  shut?: boolean;
  /** For a button or "Open …", whose words mean nothing without the link: drawn not at all. */
  hideWhenShut?: boolean;
};

export function CompanyLink({ shut = false, hideWhenShut = false, ...link }: Props) {
  const opens = useOpensCompanies();
  if (leadsToCompanies(link.href) && (shut || !opens)) {
    if (hideWhenShut) return null;
    return (
      <span className={plainClasses(link.className)} title={link.title}>
        {link.children}
      </span>
    );
  }
  return <Link {...link} />;
}
