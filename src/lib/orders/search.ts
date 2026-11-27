import type { Prisma } from "@prisma/client";
import { seqSearchTerm } from "@/lib/order-id";

/**
 * What a search box finds an order — or a renewal, which is an order — by (owner, 1 Nov 2026: neither list found one
 * by its number): its number, typed "ORD-044148", "044148" or "44148"; the customer's name; its end customer; its
 * product; the customer's PO. One list of terms, for an `OR` alongside whatever else a list searches.
 */
export function orderSearchTerms(search: string | null | undefined): Prisma.CompanyProductWhereInput[] {
  const typed = search?.trim() ?? "";
  if (!typed) return [];
  const has = { contains: typed, mode: "insensitive" as const };
  return [...seqSearchTerm(typed, "orderSeq"), { company: { name: has } }, { endCustomer: { name: has } }, { item: { name: has } }, { poNumber: has }];
}
