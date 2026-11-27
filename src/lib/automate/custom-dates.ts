import type { CustomFieldEntity, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { STILL_THERE } from "@/lib/contacts/left";
import { notMigratedYet } from "@/lib/not-migrated";
import { formatCompanyId, formatLeadId, formatOrderId } from "@/lib/order-id";
import { vendorRelationshipTypeValues } from "@/lib/validation/company";

/**
 * "A custom date is coming up" (owner, 7 Nov 2026): the date check that makes a workspace's own date fields useful — a visa or
 * trade licence expiring, a certificate's surveillance audit due — by any date field, on any record that has one.
 *
 * Once a day (src/lib/automate/dates.ts) each date in the window gets one event, carrying `daysLeft`, negative once it has
 * passed. A workflow picks the field and its days with conditions, as it does for a renewal: "Field is visa_expiry", "Days
 * left is in 60, 30, 7".
 *
 *   · Not a restricted field: a workflow's email or Slack message would carry it to people who can't see it. Nor a retired one.
 *   · Not a record that's over: a contact who has left, a cancelled order, a closed lead.
 *   · The workflow's owner must be able to see the record and the field, as for any event (src/lib/automate/trigger-reach.ts).
 */

export const CUSTOM_DATE_TRIGGER = "custom_date.coming";
/** The key a workflow's rule compares for a verifiable document's expiry. */
export const VERIFIABLE_EXPIRY_KEY = "verifiable_expiry";
/** How far ahead an event is made, and how long after: enough for "60 days before" and "a week overdue". */
export const CUSTOM_DATE_AHEAD_DAYS = 120;
export const CUSTOM_DATE_BEHIND_DAYS = 30;
/** For each field, soonest first. */
const CAP_PER_FIELD = 1_000;
const DAY_MS = 86_400_000;

export type CustomDateRow = { type: string; recordType: string; recordId: string; payload: Prisma.InputJsonValue };

type Found = {
  id: string;
  date: unknown;
  recordType: string;
  name: string;
  ref: string | null;
  company: { id: string; name: string; ownerUserId: string | null } | null;
  contact: { id: string; name: string } | null;
};

const dayOf = (value: unknown): Date | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const at = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? null : at;
};

const companySelect = { id: true, name: true, ownerUserId: true } as const;

async function recordsWith(entity: CustomFieldEntity, key: string, from: string, to: string): Promise<Found[]> {
  // One date field between two days: the same comparison a list's filter uses (src/lib/custom-fields/filters.ts).
  const within = { AND: [{ customFields: { path: [key], gte: from } }, { customFields: { path: [key], lte: to } }] };
  const dateIn = (fields: unknown) => (fields as Record<string, unknown> | null)?.[key];
  const take = CAP_PER_FIELD;
  switch (entity) {
    case "COMPANY":
    case "VENDOR": {
      const kinds = { in: [...vendorRelationshipTypeValues] };
      const rows = await db.company.findMany({
        where: { ...within, relationshipType: entity === "VENDOR" ? kinds : { notIn: kinds.in } },
        select: { ...companySelect, companySeq: true, customFields: true },
        take,
      });
      return rows.map((c) => ({ id: c.id, date: dateIn(c.customFields), recordType: "company", name: c.name, ref: formatCompanyId(c.companySeq), company: { id: c.id, name: c.name, ownerUserId: c.ownerUserId }, contact: null }));
    }
    case "CONTACT": {
      const rows = await db.contact.findMany({ where: { ...within, ...STILL_THERE }, select: { id: true, name: true, customFields: true, company: { select: companySelect } }, take });
      return rows.map((c) => ({ id: c.id, date: dateIn(c.customFields), recordType: "contact", name: c.name, ref: null, company: c.company, contact: { id: c.id, name: c.name } }));
    }
    case "LEAD": {
      const rows = await db.lead.findMany({
        where: { ...within, status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } },
        select: { id: true, leadSeq: true, title: true, customFields: true, company: { select: companySelect }, contact: { select: { id: true, name: true } } },
        take,
      });
      return rows.map((l) => ({ id: l.id, date: dateIn(l.customFields), recordType: "lead", name: l.title, ref: formatLeadId(l.leadSeq), company: l.company, contact: l.contact }));
    }
    case "ORDER": {
      const rows = await db.companyProduct.findMany({
        where: { ...within, orderStatus: { notIn: ["CANCELLED", "REJECTED"] } },
        select: { id: true, orderSeq: true, customFields: true, item: { select: { name: true } }, company: { select: companySelect } },
        take,
      });
      return rows.map((o) => ({ id: o.id, date: dateIn(o.customFields), recordType: "order", name: o.item.name, ref: formatOrderId(o.orderSeq), company: o.company, contact: null }));
    }
    case "VERIFIABLE": {
      const rows = await db.verifiableDocument.findMany({
        where: { ...within, withdrawnAt: null },
        select: { id: true, number: true, title: true, holderName: true, customFields: true, company: { select: companySelect } },
        take,
      });
      // Reached as its customer is, when it has one (src/lib/automate/trigger-reach.ts).
      return rows.map((d) => ({ id: d.company?.id ?? d.id, date: dateIn(d.customFields), recordType: d.company ? "company" : "verifiable", name: `${d.holderName}: ${d.title}`, ref: d.number, company: d.company, contact: null }));
    }
    case "ITEM": {
      const rows = await db.item.findMany({ where: within, select: { id: true, name: true, customFields: true }, take });
      return rows.map((i) => ({ id: i.id, date: dateIn(i.customFields), recordType: "item", name: i.name, ref: null, company: null, contact: null }));
    }
  }
}

/** Today's events for every date field. `day`: today at UTC midnight, as a typed day is held. */
export async function customDateRows(day: Date): Promise<CustomDateRow[]> {
  let fields: { entity: CustomFieldEntity; key: string; label: string }[];
  try {
    fields = await db.customFieldDefinition.findMany({ where: { type: "DATE", archivedAt: null, restricted: false }, select: { entity: true, key: true, label: true } });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
  const iso = (at: Date) => at.toISOString().slice(0, 10);
  const from = iso(new Date(day.getTime() - CUSTOM_DATE_BEHIND_DAYS * DAY_MS));
  const to = iso(new Date(day.getTime() + CUSTOM_DATE_AHEAD_DAYS * DAY_MS));
  const stamp = iso(day);
  const rows: CustomDateRow[] = [];
  for (const field of fields) {
    let found: Found[];
    try {
      found = await recordsWith(field.entity, field.key, from, to);
    } catch (err) {
      // A record type this workspace hasn't its column for yet: the others still go.
      if (notMigratedYet(err)) continue;
      throw err;
    }
    for (const record of found) {
      const date = dayOf(record.date);
      if (!date) continue;
      rows.push({
        type: CUSTOM_DATE_TRIGGER,
        recordType: record.recordType,
        // The record first (trigger-reach.ts reads it so), then what makes today's event its own.
        recordId: `${record.id}@${field.key}:${stamp}`,
        payload: {
          field: { key: field.key, label: field.label, entity: field.entity },
          date: iso(date),
          daysLeft: Math.round((date.getTime() - day.getTime()) / DAY_MS),
          record: { id: record.id, type: record.recordType, name: record.name, ref: record.ref },
          company: record.company,
          contact: record.contact,
        },
      });
    }
  }
  rows.push(...(await verifiableRows(day, from, to, stamp)));
  return rows;
}

/** A verifiable document's expiry, as if it were a date field (src/actions/verifiable.ts). Not one withdrawn. */
async function verifiableRows(day: Date, from: string, to: string, stamp: string): Promise<CustomDateRow[]> {
  let docs;
  try {
    docs = await db.verifiableDocument.findMany({
      where: { withdrawnAt: null, expiresOn: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
      orderBy: { expiresOn: "asc" },
      take: CAP_PER_FIELD,
      select: { id: true, docType: true, number: true, title: true, holderName: true, expiresOn: true, company: { select: companySelect } },
    });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
  return docs.map((d) => ({
    type: CUSTOM_DATE_TRIGGER,
    // Reached as its customer is, when it has one (src/lib/automate/trigger-reach.ts).
    recordType: d.company ? "company" : "verifiable",
    recordId: `${d.company?.id ?? d.id}@${VERIFIABLE_EXPIRY_KEY}:${d.id}:${stamp}`,
    payload: {
      field: { key: VERIFIABLE_EXPIRY_KEY, label: `${d.docType} expiry`, entity: "VERIFIABLE" },
      date: d.expiresOn!.toISOString().slice(0, 10),
      daysLeft: Math.round((d.expiresOn!.getTime() - day.getTime()) / DAY_MS),
      record: { id: d.id, type: "verifiable", name: `${d.holderName}: ${d.title}`, ref: d.number },
      company: d.company,
      contact: null,
    },
  }));
}
