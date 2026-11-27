import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { maskContactRows, maskedInLists } from "@/lib/contacts/masking";

/**
 * Marketing › Subscribers (owner, 1 Nov 2026): everybody marketing can reach or has heard from — on a mailing list, or
 * with an email consent recorded — in one place inside Marketing. A workspace on Deskzo Campaigns alone has no
 * Companies or Contacts pages, so without this it couldn't see the people its own lists brought in.
 */

export const SUBSCRIBER_PAGE = 50;

/**
 * `hidden.email`: the person searching sees addresses masked in lists, so the search doesn't match on them (owner, 5 Nov
 * 2026 — Phase 3 masking fixes): which rows came back would say what the address holds, as the Contacts list's search
 * doesn't (src/actions/contact.ts).
 */
export function subscriberWhere(q?: string, hidden: { email: boolean; name?: boolean } = { email: false }): Prisma.ContactWhereInput {
  const search = q?.trim();
  return {
    AND: [
      { email: { not: null } },
      { OR: [{ marketingLists: { some: {} } }, { consents: { some: { channel: "EMAIL" } } }] },
      ...(search
        ? [
            {
              OR: [
                // Not a name masked in lists either (security audit round three, 14 Nov 2026 — R3-21).
                ...(hidden.name ? [] : [{ name: { contains: search, mode: "insensitive" as const } }]),
                ...(hidden.email ? [] : [{ email: { contains: search, mode: "insensitive" as const } }]),
                { company: { name: { contains: search, mode: "insensitive" as const } } },
              ],
            },
          ]
        : []),
    ],
  };
}

export type SubscriberRow = {
  id: string;
  name: string;
  email: string;
  company: string;
  emailStatus: string;
  subscribed: string[];
  unsubscribed: string[];
  lists: string[];
  suppressed: string | null;
  addedAt: Date;
};

/**
 * A page of subscribers, newest first, with each one's topics, lists and any suppression of their address.
 *
 * `viewerId`, who is looking: each subscriber's name and address as their contacts policy shows a contact in a list
 * (owner, 5 Nov 2026 — Phase 3 masking fixes; src/lib/contacts/masking.ts) — the page printed every address in full to
 * whoever runs marketing. Somebody with no masks sees them as before. The suppression is looked up on the real address,
 * here. Without a viewer, as stored: for a check, never for a screen.
 */
export async function subscribersPage(q: string | undefined, page: number, viewerId?: string): Promise<{ rows: SubscriberRow[]; total: number }> {
  const hidden = viewerId && q?.trim() ? await maskedInLists(viewerId) : { email: false };
  const where = subscriberWhere(q, hidden);
  const [rows, total] = await Promise.all([
    db.contact.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * SUBSCRIBER_PAGE,
      take: SUBSCRIBER_PAGE,
      select: {
        id: true,
        name: true,
        email: true,
        emailStatus: true,
        createdAt: true,
        company: { select: { name: true } },
        consents: { where: { channel: "EMAIL" }, select: { topic: true, status: true } },
        marketingLists: { select: { list: { select: { name: true } } }, orderBy: { addedAt: "desc" }, take: 5 },
      },
    }),
    db.contact.count({ where }),
  ]);
  const emails = rows.map((r) => r.email!.trim().toLowerCase());
  const suppressions = emails.length ? await db.suppression.findMany({ where: { scope: "EMAIL", value: { in: emails } }, select: { value: true, reason: true } }) : [];
  const suppressedBy = new Map(suppressions.map((s) => [s.value, s.reason]));
  const shown = viewerId ? new Map((await maskContactRows(viewerId, "list", rows.map((r) => ({ id: r.id, name: r.name, email: r.email, phone: null })))).map((r) => [r.id, r])) : null;
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      name: shown?.get(r.id)?.name ?? r.name,
      email: shown?.get(r.id)?.email ?? r.email!,
      company: r.company.name,
      emailStatus: r.emailStatus,
      subscribed: r.consents.filter((c) => c.status === "SUBSCRIBED").map((c) => c.topic),
      unsubscribed: r.consents.filter((c) => c.status === "UNSUBSCRIBED").map((c) => c.topic),
      lists: r.marketingLists.map((m) => m.list.name),
      suppressed: suppressedBy.get(r.email!.trim().toLowerCase()) ?? null,
      addedAt: r.createdAt,
    })),
  };
}
