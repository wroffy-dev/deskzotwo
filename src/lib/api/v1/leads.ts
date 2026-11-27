import { createLead, getLead, listLeadsPaged, logActivity, updateLeadDetails, updateLeadStatus } from "@/actions/lead";
import { ApiError, notFound, pageOf, paging, refusedBy, type ApiAnswer, type ApiCall } from "@/lib/api/handler";
import { customFieldsOut } from "@/lib/api/custom";
import { exportedCustom, mayReadContacts } from "@/lib/api/v1/companies";
import { leadCreateSchema, leadNoteSchema, leadPatchSchema, leadStageSchema } from "@/lib/api/v1/schemas";
import { needModule } from "@/lib/api/v1/shared";
import { amount, companyRef, contactRef, day, idOf, iso, leadRef, personId } from "@/lib/api/refs";
import { API_DEFAULT_PAGE_SIZE, API_MAX_PAGE_SIZE } from "@/lib/api/scopes";
import { exportAnswers, exportOverrides, fieldMasker, leadMasker } from "@/lib/authz/fields";
import { revealedFieldsToday } from "@/lib/authz/unmask";
import { db } from "@/lib/db";
import { leadRedactor, leadSecrets, listLeadMasker, maskLead, type FieldMasker } from "@/lib/leads/masking";
import { leadStatusValues } from "@/lib/validation/lead";

/**
 * Leads in the public API (src/lib/api): listed, read, added, changed, moved and noted — each through
 * the app's own lead actions as the key's person, so what reaches them, the field masking, the stage
 * rules and the assignment rules apply exactly as on the Leads screens.
 */

const STATUSES = leadStatusValues;
type Row = Record<string, unknown> & { id: string };
const str = (v: unknown) => (typeof v === "string" ? v : null);
const rec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

/** What the API says about leads beyond what the screens' rows carry: stage, pipeline and refs, read by name. */
async function extrasFor(ids: string[]) {
  const leads = await db.lead.findMany({
    where: { id: { in: ids } },
    select: { id: true, stage: { select: { id: true, key: true, label: true } }, pipeline: { select: { id: true, key: true, name: true } }, contact: { select: { contactSeq: true } } },
  });
  return new Map(leads.map((l) => [l.id, l]));
}

/** A lead as the API gives it, from a row the lead actions returned (masked for the key's person). */
function leadOut(row: Row, extra: Awaited<ReturnType<typeof extrasFor>> extends Map<string, infer V> ? V | undefined : never, custom: Record<string, unknown> | undefined) {
  const company = rec(row.company);
  const contact = rec(row.contact);
  const owner = rec(row.owner);
  return {
    id: row.id,
    ref: leadRef(row.leadSeq as number),
    title: row.title,
    description: str(row.description),
    status: row.status,
    stage: extra?.stage ? { id: extra.stage.id, key: extra.stage.key, name: extra.stage.label } : null,
    pipeline: extra?.pipeline ? { id: extra.pipeline.id, key: extra.pipeline.key, name: extra.pipeline.name } : null,
    value: amount(row.estimatedValue),
    expected_close_date: day(row.expectedCloseDate as Date | string | null),
    source: row.source ?? null,
    source_detail: str(row.sourceDetail),
    score: typeof row.score === "number" ? row.score : null,
    lost_reason: str(row.lostReason),
    company: company ? { id: company.id, ref: companyRef(company.companySeq as number), name: company.name } : null,
    contact: contact
      ? { id: contact.id, ref: contactRef(extra?.contact?.contactSeq ?? null), name: contact.name, ...("email" in contact ? { email: contact.email ?? null, phone: contact.phone ?? null } : {}) }
      : null,
    owner: owner ? { id: owner.id, name: owner.name } : null,
    custom_fields: custom ?? {},
    created_at: iso(row.createdAt as Date | string),
    updated_at: iso(row.updatedAt as Date | string),
  };
}

/**
 * `exported`: the API's own lists (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.4) — an API list is a file by
 * another name, so a custom field goes out only where the export answer shows it in the clear as well as the list's.
 * The app's screens (src/lib/app/sales.ts) and single reads are screens, not files, and leave it off.
 */
export async function leadsOut(userId: string, rows: Row[], options: { exported?: boolean; contactDetails?: boolean } = {}) {
  const ids = rows.map((r) => r.id);
  const [extras, custom, answers] = await Promise.all([extrasFor(ids), customFieldsOut("LEAD", userId, ids), options.exported ? exportAnswers(userId, "leads") : null]);
  // Security audit, 11 Nov 2026 (SEC-51): a key without `contacts:read` gets the lead's contact by name and reference
  // only — `leads:read` is no way to read people's email addresses and numbers.
  const shown = options.contactDetails === false ? rows.map(withoutContactDetails) : rows;
  return shown.map((r) => leadOut(r, extras.get(r.id), answers ? exportedCustom(custom.get(r.id), answers) : custom.get(r.id)));
}

function withoutContactDetails(row: Row): Row {
  const contact = rec(row.contact);
  if (!contact) return row;
  const { email: _email, phone: _phone, ...rest } = contact;
  void _email;
  void _phone;
  return { ...row, contact: rest };
}

/** A lead's own values as stored, for presenting again with other answers than the screens' read used. */
const STORED_LEAD = {
  id: true,
  title: true,
  description: true,
  source: true,
  sourceDetail: true,
  lostReason: true,
  company: { select: { name: true, locations: { select: { address: true, city: true, state: true, pincode: true, country: true, isPrimary: true } } } },
  contact: { select: { name: true, email: true, phone: true, linkedinUrl: true, emailCheckedValue: true, emailCheckDetail: true } },
} as const;

/**
 * A lead the screens' read returned, with its own fields presented again by `m` from what is stored: the title,
 * description, source, the free text that quotes them, the company's name and the contact's. `only` limits it to those
 * fields (and the free text, which quotes them); a contact's email or phone the read left out — `contacts.view`'s to give
 * (`getLead`) — stays out. Everything else on the row is the read's own.
 */
async function presentedAgain(m: FieldMasker, rows: Row[], only?: Set<string>): Promise<Row[]> {
  if (rows.length === 0) return rows;
  const stored = await db.lead.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: STORED_LEAD });
  const shown = new Map(stored.map((l) => [l.id, maskLead(m, l)]));
  const has = (field: string) => !only || only.has(field);
  return rows.map((row) => {
    const s = shown.get(row.id);
    if (!s) return row;
    const out: Row = { ...row };
    for (const key of ["description", "sourceDetail", "lostReason"] as const) if (key in out) out[key] = s[key];
    if (has("title") && "title" in out) out.title = s.title;
    if (has("source") && "source" in out) out.source = s.source;
    const company = rec(out.company);
    if (has("companyName") && company && "name" in company) out.company = { ...company, name: s.company.name };
    const contact = rec(out.contact);
    if (contact && s.contact) {
      const c = { ...contact };
      if (has("contactName") && "name" in c) c.name = s.contact.name;
      for (const key of ["email", "phone"] as const) if (has(key) && c[key] != null) c[key] = s.contact[key];
      // What would give a masked address away by another door goes with it, as `maskContact` sends it.
      if (has("email")) for (const key of ["linkedinUrl", "emailCheckedValue", "emailCheckDetail"] as const) if (c[key] != null) c[key] = s.contact[key];
      out.contact = c;
    }
    return out;
  });
}

/**
 * The API's leads list with each field's export answer (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.4): the
 * Leads list's own rows, and a field whose `export` is set — left out, masked though the list shows it, or in the clear
 * where the person sees it so somewhere — presented again from what is stored. Nobody with no export set pays a read.
 */
async function exportedLeads(userId: string, rows: Row[]): Promise<Row[]> {
  const set = await exportOverrides(userId, "leads");
  const out = set.size === 0 ? rows : await presentedAgain(await leadMasker(userId, "export"), rows, set);
  return contactsExported(userId, out);
}

/**
 * A lead's contact's email and phone in an API list by the contact's own export answers too, as the leads data export
 * carries them (src/lib/portability/exporters/leads.ts): they are the contact's values, and "left out" or "masked" for
 * contacts holds wherever they leave the building. Only where the row already carries them (`contacts.view`).
 */
async function contactsExported(userId: string, rows: Row[]): Promise<Row[]> {
  const set = [...(await exportOverrides(userId, "contacts"))].filter((k): k is "email" | "phone" => k === "email" || k === "phone");
  const ids = rows.map((r) => str(rec(r.contact)?.id)).filter((id): id is string => !!id);
  if (set.length === 0 || ids.length === 0) return rows;
  const [m, stored] = await Promise.all([fieldMasker(userId, "contacts", "export"), db.contact.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, phone: true } })]);
  const byId = new Map(stored.map((c) => [c.id, c]));
  return rows.map((r) => {
    const contact = rec(r.contact);
    const raw = contact ? byId.get(String(contact.id)) : undefined;
    if (!contact || !raw) return r;
    const c = { ...contact };
    for (const field of set) if (c[field] != null) c[field] = m.present(field, raw[field]);
    return { ...r, contact: c };
  });
}

/**
 * One lead as the API and the app give it (owner, 5 Nov 2026 — Phase 3 masking fixes, audit M-11 and H.5): the list
 * answers, not the lead page's. Its page shows "mask in list" fields in the clear where "mask in detail" is off, and the
 * API handed a script every lead that way — no "Show", no unit, no log. Its page's answers only once the person has
 * revealed the lead today (`revealedFieldsToday`), which was counted and logged as the page's "Show" is. The read is
 * the screens' own (`getLead`): who may open it, `contacts.view`, its shape.
 */
export async function leadAsListed(userId: string, lead: Row): Promise<Row> {
  if (await revealedFieldsToday(userId, "leads", lead.id)) return lead;
  const m = await listLeadMasker(userId);
  const [out] = await presentedAgain(m, [lead]);
  // Its activity, as the app lists it: what people wrote quotes the lead's fields — redacted by the list's answers too.
  if (Array.isArray(out!.activities) && out!.activities.length) {
    const ids = (out!.activities as Row[]).map((a) => a.id);
    const [notes, stored] = await Promise.all([
      db.activity.findMany({ where: { id: { in: ids } }, select: { id: true, notes: true } }),
      db.lead.findUnique({ where: { id: lead.id }, select: STORED_LEAD }),
    ]);
    const redact = leadRedactor(m, stored ? leadSecrets(stored) : []);
    const raw = new Map(notes.map((a) => [a.id, a.notes]));
    out!.activities = (out!.activities as Row[]).map((a) => (raw.has(a.id) ? { ...a, notes: redact(raw.get(a.id) ?? null) } : a));
  }
  return out!;
}

/** One lead, read again through the screens' own read — or not found — as the API gives one (`leadAsListed`). */
export async function readLead(userId: string, id: string, options: { contactDetails?: boolean } = {}) {
  const lead = (await getLead(id)) as Row | null;
  if (!lead) throw notFound("lead");
  return (await leadsOut(userId, [await leadAsListed(userId, lead)], options))[0]!;
}

/** What a key's call may see of a lead's contact (SEC-51). */
const detailsFor = (call: ApiCall) => ({ contactDetails: mayReadContacts(call.actor.scopes) });

export async function listLeadsApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("leads", call.actor.userId, "Leads");
  const q = call.url.searchParams;
  const { page, pageSize } = paging(call.url, API_MAX_PAGE_SIZE, API_DEFAULT_PAGE_SIZE);
  const status = q.get("status")?.toUpperCase();
  if (status && !(STATUSES as readonly string[]).includes(status)) throw new ApiError(400, "invalid_request", `status is one of ${STATUSES.join(", ")}.`, { status: "Unknown status." });
  const owner = q.get("owner");
  const ownerUserId = owner ? (owner === "unassigned" ? "unassigned" : ((await personId(owner)) ?? "zz-nobody")) : undefined;
  const { rows, total } = await listLeadsPaged({
    page,
    pageSize,
    search: q.get("search")?.slice(0, 100) || undefined,
    status: status as (typeof STATUSES)[number] | undefined,
    stage: q.get("stage")?.slice(0, 60) || undefined,
    pipeline: q.get("pipeline")?.slice(0, 60) || "all",
    ownerUserId,
  });
  return { data: await leadsOut(call.actor.userId, await exportedLeads(call.actor.userId, rows as unknown as Row[]), { exported: true, ...detailsFor(call) }), page: pageOf(page, pageSize, total) };
}

export async function getLeadApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("leads", call.actor.userId, "Leads");
  const id = await idOf("lead", call.params.ref);
  if (!id) throw notFound("lead");
  return { data: await readLead(call.actor.userId, id, detailsFor(call)) };
}

export async function createLeadApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("leads", call.actor.userId, "Leads");
  const input = leadCreateSchema.parse(await call.body());
  const companyId = await idOf("company", input.company);
  if (!companyId) throw new ApiError(422, "refused", "No company by that reference reaches this key.", { company: "Not found." });
  const contactId = input.contact ? await idOf("contact", input.contact) : null;
  if (input.contact && !contactId) throw new ApiError(422, "refused", "No contact by that reference.", { contact: "Not found." });
  const ownerUserId = input.owner ? await personId(input.owner) : null;
  if (input.owner && !ownerUserId) throw new ApiError(422, "refused", "No active person by that id or email.", { owner: "Not found." });
  /**
   * The caller's Idempotency-Key, kept on the lead itself (createLead): the same create sent twice is
   * one lead. The API's handler also replays a key's answer, but the app's routes keep no answers
   * (src/lib/app/handler.ts) — and a phone on a weak signal is the caller most likely to send again.
   */
  const requestId = call.req.headers.get("idempotency-key")?.trim() || undefined;
  if (requestId && (requestId.length < 8 || requestId.length > 100)) throw new ApiError(400, "invalid_idempotency_key", "An Idempotency-Key is 8 to 100 characters.");
  const made = await createLead({
    companyId,
    contactId: contactId ?? "",
    title: input.title,
    description: input.description ?? "",
    estimatedValue: input.value,
    expectedCloseDate: input.expected_close_date ?? "",
    ownerUserId: ownerUserId ?? "",
    source: input.source ?? "OTHER",
    sourceDetail: input.source_detail ?? "API",
    customFields: input.custom_fields,
    pipelineId: input.pipeline ?? "",
    requestId,
  });
  if (!made.ok) throw refusedBy(made);
  return { status: 201, data: await readLead(call.actor.userId, made.data.id, detailsFor(call)) };
}

export async function patchLeadApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("leads", call.actor.userId, "Leads");
  const id = await idOf("lead", call.params.ref);
  if (!id) throw notFound("lead");
  const input = leadPatchSchema.parse(await call.body());
  const current = (await getLead(id)) as Row | null;
  if (!current) throw notFound("lead");
  const contactId = input.contact === undefined ? (str(rec(current.contact)?.id) ?? "") : input.contact === "" ? "" : await idOf("contact", input.contact);
  if (contactId === null) throw new ApiError(422, "refused", "No contact by that reference.", { contact: "Not found." });
  /**
   * A value sent back exactly as the API showed it masked is no change (owner, 5 Nov 2026 — Phase 3 masking fixes,
   * "saving keeps the real values"): a lead is read with the list's answers now (`leadAsListed`), and the app's edit
   * sends its title back whole — "O********" for a title its page shows in the clear would otherwise be saved over it.
   */
  const shown = await leadAsListed(call.actor.userId, current);
  const unlessShown = <T,>(sent: T | undefined, field: "title" | "description"): T | undefined => (sent !== undefined && sent === shown[field] && shown[field] !== current[field] ? undefined : sent);
  // The screens' edit takes the whole set: what wasn't sent stays as it is.
  const value = input.value !== undefined ? input.value : amount(current.estimatedValue);
  const done = await updateLeadDetails({
    leadId: id,
    title: unlessShown(input.title, "title") ?? String(current.title),
    description: unlessShown(input.description, "description") ?? str(current.description) ?? "",
    estimatedValue: typeof value === "number" ? value : undefined,
    expectedCloseDate: input.expected_close_date !== undefined ? input.expected_close_date : (day(current.expectedCloseDate as Date | null) ?? ""),
    contactId,
  });
  if (!done.ok) throw refusedBy(done);
  return { data: await readLead(call.actor.userId, id, detailsFor(call)) };
}

export async function moveLeadApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("leads", call.actor.userId, "Leads");
  const id = await idOf("lead", call.params.ref);
  if (!id) throw notFound("lead");
  const input = leadStageSchema.parse(await call.body());
  let stageId: string | undefined;
  if (input.stage) {
    const lead = await db.lead.findUnique({ where: { id }, select: { pipelineId: true } });
    const stage = await db.leadStage.findFirst({
      where: { archivedAt: null, OR: [{ id: input.stage }, { key: input.stage, pipelineId: lead?.pipelineId ?? "lpip_sales" }] },
      select: { id: true },
    });
    if (!stage) throw new ApiError(422, "refused", "No stage by that id or key in the lead's pipeline.", { stage: "Not found." });
    stageId = stage.id;
  }
  const done = await updateLeadStatus({ leadId: id, ...(stageId ? { stageId } : { status: input.status }), lostReason: input.lost_reason ?? "" });
  if (!done.ok) throw refusedBy(done);
  return { data: await readLead(call.actor.userId, id, detailsFor(call)) };
}

export async function noteLeadApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("leads", call.actor.userId, "Leads");
  const id = await idOf("lead", call.params.ref);
  if (!id) throw notFound("lead");
  const input = leadNoteSchema.parse(await call.body());
  const done = await logActivity({ leadId: id, type: input.type, notes: input.notes });
  if (!done.ok) throw refusedBy(done);
  return { status: 201, data: { id: done.data.id, lead: (await readLead(call.actor.userId, id)).ref, type: input.type, notes: input.notes } };
}
