"use server";

import type { CompanyRelationshipType, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { companyScope } from "@/lib/authz/company-scope";
import { CATEGORY_SELECT } from "@/lib/customers/categories";
import { companyNameMatches, nameSearchText } from "@/lib/company-name";
import { customerSide, vendorSide, type CompanySide } from "@/lib/companies/roles";
import { STILL_THERE } from "@/lib/contacts/left";
import { contactScope } from "@/lib/authz/contact-access";
import { contactMasker } from "@/lib/contacts/masking";

/**
 * Company pickers that search rather than send the whole book (owner, 30 Oct 2026: the Pro-rata panel "is very slow" —
 * it, and the expense, lead, payment, ticket and visit forms, sent every company with every contact before anything
 * could be typed). A form sends the first few hundred and, past that, searches as the person types
 * (`searchCompanyOptions`), then asks for the picked company's people (`companyContactOptions`).
 *
 * The same accounts `listCompanyOptions` (src/actions/company.ts) offers: this person's scope, nothing disqualified, no
 * reseller's end customer, and the kinds or side asked for.
 */

export type CompanyPickerFilter = { relationshipTypes?: CompanyRelationshipType[]; side?: CompanySide };

const SEARCH_LIMIT = 20;

async function optionsWhere(userId: string, filter?: CompanyPickerFilter): Promise<Prisma.CompanyWhereInput> {
  const sideWhere = filter?.side === "customer" ? await customerSide() : filter?.side === "vendor" ? await vendorSide() : null;
  return {
    AND: [await companyScope(userId), ...(sideWhere ? [sideWhere] : [])],
    stage: { not: "DISQUALIFIED" },
    managedByResellerId: null,
    ...(filter?.relationshipTypes?.length ? { relationshipType: { in: [...filter.relationshipTypes] } } : {}),
  };
}

const OPTION_SELECT = { id: true, name: true, relationshipType: true, customerCategory: { select: CATEGORY_SELECT } } as const;

/** Companies whose name holds what was typed — two characters at least, the first twenty by name, no contacts. */
export async function searchCompanyOptions(query: string, filter?: CompanyPickerFilter) {
  const user = await requireUser();
  const typed = String(query ?? "").trim().slice(0, 120);
  if (typed.length < 2) return [];
  const rows = await db.company.findMany({
    where: { ...(await optionsWhere(user.id, filter)), name: { contains: nameSearchText(typed), mode: "insensitive" } },
    orderBy: { name: "asc" },
    take: SEARCH_LIMIT,
    select: OPTION_SELECT,
  });
  return rows.filter((c) => companyNameMatches(c.name, typed));
}

/** A company's people still there, primary first — only for a company this person may see. */
export async function companyContactOptions(companyId: string) {
  const user = await requireUser();
  if (typeof companyId !== "string" || !companyId) return [];
  // Only one in the picker's own scope: an id from anywhere else answers nobody.
  const seen = await db.company.findFirst({ where: { id: companyId, AND: [await companyScope(user.id)] }, select: { id: true } });
  if (!seen) return [];
  // Security audit round three, 14 Nov 2026 (R3-21): every contact of the company, names in full. Now only those the
  // person's contact rule reaches (`contactScope`), each name as the contacts policy shows it in a list.
  const rows = await db.contact.findMany({
    where: { AND: [{ companyId, ...STILL_THERE }, await contactScope(user.id)] },
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
    select: { id: true, name: true, designation: true },
  });
  const people = await contactMasker(user.id, "list", rows.map((r) => r.id));
  if (!people.active) return rows;
  return rows.map((r) => ({ ...r, name: people.present(r.id, "name", r.name) ?? "" }));
}
