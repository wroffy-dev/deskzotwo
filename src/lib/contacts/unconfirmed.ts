import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Contacts a visitor added (security audit round two, 13 Nov 2026 — R2-14).
 *
 * A website form, the booking page or a digital card that names a company we already have adds the
 * person typing as that company's contact. Nothing proves they work there: anybody can type a
 * customer's name. So such a contact is marked with where it came from (`Contact.unconfirmedFrom`),
 * shown as "Unconfirmed — came from the website" with a Confirm button, and never picked as an
 * automatic recipient — a pay link's payer, a payment or renewal reminder, a document's "anyone with an
 * email" fallback — until somebody on the staff confirms them. A person chosen by hand is still sent to.
 *
 * A new company made by the same form isn't marked: there is nobody there to be mistaken for.
 *
 * The column is in NOT_YET_EVERYWHERE (src/lib/tenancy/clients.ts): every read names it, and a workspace
 * that hasn't got it yet counts everyone as confirmed, as before.
 */

export const UNCONFIRMED_SOURCES = ["WEB_FORM", "BOOKING", "CARD"] as const;
export type UnconfirmedSource = (typeof UNCONFIRMED_SOURCES)[number];

/** What the badge says. */
export const UNCONFIRMED_LABEL = "Unconfirmed — came from the website";

export function unconfirmedFromLabel(from: string | null | undefined): string | null {
  if (!from) return null;
  if (from === "BOOKING") return "Unconfirmed — booked a meeting on the website";
  if (from === "CARD") return "Unconfirmed — came from a digital card";
  return UNCONFIRMED_LABEL;
}

/** The `where` that leaves unconfirmed contacts out — add it to any query that picks a recipient by itself. */
export const CONFIRMED_ONLY = { unconfirmedFrom: null } satisfies Prisma.ContactWhereInput;

/**
 * Runs a query with `CONFIRMED_ONLY` in its `where`; in a workspace without the column yet, again
 * without it (everyone there is confirmed).
 */
export async function withConfirmed<T>(run: (confirmed: Prisma.ContactWhereInput) => Promise<T>): Promise<T> {
  try {
    return await run(CONFIRMED_ONLY);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return run({});
  }
}

/**
 * Whether this workspace has the column — asked before a transaction that creates a contact, so the
 * mark goes in with the row itself (a failed statement would end the whole transaction).
 */
export async function unconfirmedColumnHere(): Promise<boolean> {
  try {
    await db.contact.findFirst({ select: { unconfirmedFrom: true } });
    return true;
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return false;
  }
}

/** The mark to spread into a contact's create `data`: only when the company already existed, and the workspace has the column. */
export function unconfirmedData(from: UnconfirmedSource, companyExisted: boolean, columnHere: boolean): { unconfirmedFrom?: string } {
  return companyExisted && columnHere ? { unconfirmedFrom: from } : {};
}

/** Marks a contact a visitor just made on an existing company. Quietly nothing before the migration. */
export async function markUnconfirmed(contactId: string, from: UnconfirmedSource): Promise<void> {
  try {
    await db.contact.updateMany({ where: { id: contactId }, data: { unconfirmedFrom: from } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
}

/** Which of these contacts are unconfirmed, and where each came from. Empty before the migration. */
export async function unconfirmedAmong(contactIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(contactIds.filter(Boolean))];
  if (!ids.length) return new Map();
  try {
    const rows = await db.contact.findMany({ where: { id: { in: ids }, unconfirmedFrom: { not: null } }, select: { id: true, unconfirmedFrom: true } });
    return new Map(rows.map((r) => [r.id, r.unconfirmedFrom!]));
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return new Map();
  }
}

/** Whether one contact is unconfirmed. */
export async function isUnconfirmed(contactId: string | null | undefined): Promise<boolean> {
  if (!contactId) return false;
  return (await unconfirmedAmong([contactId])).has(contactId);
}

/** Staff confirm them: from now on they are a contact like any other. */
export async function confirmContact(contactId: string): Promise<boolean> {
  try {
    const done = await db.contact.updateMany({ where: { id: contactId, unconfirmedFrom: { not: null } }, data: { unconfirmedFrom: null } });
    return done.count > 0;
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return false;
  }
}
