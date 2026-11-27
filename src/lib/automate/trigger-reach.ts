import { mayAccess, type AccessRecord } from "@/lib/authz/access";
import { companyMasker } from "@/lib/companies/masking";
import { contactMasker } from "@/lib/contacts/masking";
import { detailLeadMasker, maskLeadTitle } from "@/lib/leads/masking";
import { mayOpenList } from "@/lib/smart-lists/links";

/**
 * What a workflow learns from an event, as its owner may see it (Deskzo Automate, Phase 8). A workflow
 * is its owner acting, so it starts — or a waiting run wakes — only on a record its owner may view, and
 * reads the event's data with the owner's field masking: a workflow can't hand on, to Slack or anywhere,
 * a lead its owner couldn't open, nor a contact's name they see masked. Without this, any event started
 * the workflow with the record's data in the clear.
 *
 * Done before the trigger's own conditions are read, so whether a workflow runs can't give away what a
 * masked field holds either. Events about no record a person reaches by level — a webhook's call, a
 * person joining, a booking — are as they came.
 */

const RECORDS: Partial<Record<string, AccessRecord>> = {
  lead: "leads",
  company: "companies",
  contact: "contacts",
  document: "documents",
  order: "orders",
  payment: "payments",
  ticket: "tickets",
  task: "tasks",
};

/** The record an event is about: `lead_1@pipe` (arrived), `ticket_9>CLOSED` (status), `doc_2@2026-10-18` (a date check) name it first. */
export const eventRecordId = (recordId: string): string => recordId.split(/[@>]/)[0]!;

type EventFacts = { recordType: string | null; recordId: string | null; payload: unknown };

/** Remembers answers within one matching pass: the same owner and record are asked once. */
export type ReachCache = Map<string, boolean>;

/** The event's data as `ownerId` may see it, or null when they may not see what it is about. */
export async function eventAsOwner(ownerId: string, event: EventFacts, cache: ReachCache = new Map()): Promise<Record<string, unknown> | null> {
  const payload = (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? { ...(event.payload as Record<string, unknown>) } : {}) as Record<string, unknown>;
  // A Smart List row (owner, 20 Nov 2026 — src/lib/automate/emit-smart-lists.ts): for an owner who may open the list, and —
  // in a list of companies — see the company.
  if (event.recordType === "smart-list-row" && event.recordId) {
    const [listId, rowKey] = event.recordId.split(":");
    const key = `${ownerId}:smart-list:${event.recordId}`;
    let may = cache.get(key);
    if (may === undefined) {
      const kind = (payload.list as { kind?: string } | undefined)?.kind;
      may = !!listId && (await mayOpenList(ownerId, listId)) && (kind !== "COMPANIES" || (!!rowKey && (await mayAccess(ownerId, "companies", "view", rowKey))));
      cache.set(key, may);
    }
    return may ? payload : null;
  }
  const record = event.recordType ? RECORDS[event.recordType] : undefined;
  if (!record || !event.recordId) return payload;
  const id = eventRecordId(event.recordId);
  const key = `${ownerId}:${record}:${id}`;
  let may = cache.get(key);
  if (may === undefined) {
    may = await mayAccess(ownerId, record, "view", id);
    cache.set(key, may);
  }
  if (!may) return null;
  if (event.recordType === "lead") await maskLead(ownerId, id, payload);
  if (!(await customDateVisible(ownerId, event.recordType!, id, payload))) return null;
  return payload;
}

/**
 * A custom date event (src/lib/automate/custom-dates.ts) only for an owner who sees that field in the clear on that company or
 * contact, whose field policies can hide it; a contact's name as they see it. Whether a workflow ran would otherwise tell them
 * the date.
 */
async function customDateVisible(ownerId: string, recordType: string, id: string, payload: Record<string, unknown>): Promise<boolean> {
  const field = payload.field as { key?: unknown } | undefined;
  if (!field || typeof field.key !== "string" || typeof payload.date !== "string") return true;
  const asStored = { [field.key]: payload.date };
  if (recordType === "company") {
    const masker = await companyMasker(ownerId, "detail", [id]);
    return !masker.active || masker.forCompany(id).custom(asStored)[field.key] === payload.date;
  }
  if (recordType === "contact") {
    const masker = await contactMasker(ownerId, "detail", [id]);
    if (!masker.active) return true;
    if (masker.custom(id, asStored)[field.key] !== payload.date) return false;
    const contact = payload.contact as { name?: unknown } | null | undefined;
    if (contact && typeof contact.name === "string") payload.contact = { ...contact, name: masker.present(id, "name", contact.name) ?? "" };
  }
  return true;
}

/** A lead event's title, source, company and contact names as the owner sees them on the lead (record-get.ts does the same). */
async function maskLead(ownerId: string, leadId: string, payload: Record<string, unknown>) {
  const masker = await detailLeadMasker(ownerId, leadId);
  if (!masker.active) return;
  const lead = payload.lead as Record<string, unknown> | undefined;
  if (lead && typeof lead === "object") {
    payload.lead = {
      ...lead,
      title: typeof lead.title === "string" ? maskLeadTitle(masker, lead.title) : lead.title,
      source: typeof lead.source === "string" ? (masker.present("source", lead.source) ?? "") : lead.source,
    };
  }
  const company = payload.company as Record<string, unknown> | undefined;
  if (company && typeof company === "object" && typeof company.name === "string") payload.company = { ...company, name: masker.present("companyName", company.name) ?? "" };
  const contact = payload.contact as Record<string, unknown> | null | undefined;
  if (contact && typeof contact === "object" && typeof contact.name === "string") payload.contact = { ...contact, name: masker.present("contactName", contact.name) ?? "" };
}
