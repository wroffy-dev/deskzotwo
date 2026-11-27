import { db } from "@/lib/db";
import { parseRecordRef } from "@/lib/record-url";

/**
 * The customer a notification is about, for `{customer}` in its email (owner, 18 Nov 2026: "customer variable").
 * A notification keeps no customer of its own, only the link the bell opens, so it is read from where that link
 * points: a company's page is that company; an order, ticket, lead or document is the company it is with. Anything
 * else — a task, a person, a settings page — has no customer, and `{customer}` is left empty (and a [[ … ]] around it
 * left out). Never throws: an email is never held up for its customer's name.
 */

type Finder = (ref: ReturnType<typeof parseRecordRef>) => Promise<string | null | undefined>;

const FINDERS: Record<string, Finder> = {
  companies: async (ref) =>
    (await db.company.findUnique({ where: ref.kind === "seq" ? { companySeq: ref.seq } : { id: ref.id }, select: { name: true } }))?.name,
  orders: async (ref) =>
    (await db.companyProduct.findUnique({ where: ref.kind === "seq" ? { orderSeq: ref.seq } : { id: ref.id }, select: { company: { select: { name: true } } } }))?.company.name,
  tickets: async (ref) =>
    (await db.ticket.findUnique({ where: ref.kind === "seq" ? { ticketSeq: ref.seq } : { id: ref.id }, select: { company: { select: { name: true } } } }))?.company.name,
  leads: async (ref) =>
    (await db.lead.findUnique({ where: ref.kind === "seq" ? { leadSeq: ref.seq } : { id: ref.id }, select: { company: { select: { name: true } } } }))?.company.name,
  documents: async (ref) =>
    ref.kind === "id" ? (await db.tradeDocument.findUnique({ where: { id: ref.id }, select: { company: { select: { name: true } } } }))?.company?.name : null,
};

/** "/companies/COM-000123?tab=renewals" → its section and record; null for a link to no one record. */
export function recordOfLink(link: string | null | undefined): { section: string; segment: string } | null {
  if (!link) return null;
  const path = link.split(/[?#]/)[0]!;
  const match = path.match(/^\/([a-z-]+)\/([^/]+)\/?$/);
  if (!match || !FINDERS[match[1]!]) return null;
  return { section: match[1]!, segment: match[2]! };
}

export async function customerOfLink(link: string | null | undefined): Promise<string> {
  const record = recordOfLink(link);
  if (!record) return "";
  try {
    return ((await FINDERS[record.section]!(parseRecordRef(record.segment))) ?? "").trim();
  } catch {
    return "";
  }
}
