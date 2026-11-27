import { z } from "zod";
import { FREE_MAIL, companyByEmailDomain } from "@/lib/lead-capture/domain-match";
import { newLeadStage } from "@/lib/pipeline/server";
import { emitLeadCreated } from "@/lib/automate/emit-leads";
import type { EventCause } from "@/lib/automate/action-types";
import { Prisma, type ContactDesignation, type LeadSource } from "@prisma/client";
import { db } from "@/lib/db";
import { raisedByForKey } from "@/lib/lead-capture/credit";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { normalizeCompanyName } from "@/lib/company-name";
import { isResellerManaged } from "@/lib/reseller";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { formatLeadId } from "@/lib/order-id";
import { companyPath, leadPath } from "@/lib/record-links";
import { whoCouldOpen, type AssignmentSignals } from "@/lib/leads/assign";
import { leadCapacityError, markLeadWrite } from "@/lib/leads/limits";
import { intakeOwner, notifyOverflow, overflowReason, type IntakeOwner, type IntakeOwnerPlan } from "@/lib/leads/intake-owner";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { postalCodeIssue } from "@/lib/geo/postal";
import { isIndia } from "@/lib/geo/countries";
import { describeValues, stillToFillLines, type SkippedValue } from "@/lib/custom-fields/outside";
import { customFieldsFromOutside, type OutsideFields } from "@/lib/custom-fields/outside-server";
import { MAX_OWN_FIELDS, type OwnFieldGroupName } from "@/lib/lead-capture/spec";
import { unconfirmedColumnHere, unconfirmedData, type UnconfirmedSource } from "@/lib/contacts/unconfirmed";

/**
 * A website enquiry, turned into a company, a contact and a lead.
 *
 * The API route authenticates and rate-limits; everything about *what the request means* is here,
 * so it can be exercised without HTTP.
 *
 * ## The rules it keeps
 *
 *   · **No duplicate companies.** Matched by `normalizedName`, the same global rule every other path
 *     follows. A website cannot be the one thing that gets round it.
 *   · **No duplicate people.** An existing contact at that company is matched by email, then phone.
 *   · **No duplicate leads on retry.** `external_id` plus the key is unique; a second request with the
 *     same pair returns the first lead.
 *   · **Resellers' customers are not ours to approach.** A company managed by a reseller gets no
 *     contact and no lead — the enquiry is passed to whoever manages the reseller, to route.
 *   · **No marketing consent.** An API call proves nothing about who owns the address it carries, so
 *     unlike a signed-up form it records no consent at all.
 *   · **The workspace's own fields, only into what it creates.** `custom_fields` go on the new lead;
 *     `company_fields` and `contact_fields` only on a company or contact this enquiry creates — a
 *     website never changes a customer already on file (src/lib/custom-fields/outside.ts). A value
 *     that can't be used is set aside, listed in the answer and noted on the lead; it never costs the
 *     lead itself. Required fields are not required here: the lead says what is still to fill in.
 *   · **A lead only where the plan has leads** (owner, 14 Oct 2026). A workspace without them — a
 *     Cards or Campaigns one, or one that has stopped paying for its CRM — still gets the company and
 *     contact, made or found by the same rules, and no lead, score or automation. The lead's own
 *     fields are set aside, and whoever is told about the enquiry is told what it said.
 *   · **Lead limits** (owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6.5; src/lib/leads/intake-owner.ts). The
 *     owner is chosen, and their room taken, inside the transaction that writes the lead. Whoever it was for being
 *     full — the person named, or everybody the rules would choose — never loses the enquiry: the lead is made with
 *     nobody, says why, and the managers are told. A REFUSE rule refuses it (`LeadRuleRefused`), and the plan's cap
 *     refuses it (`LeadCapacityFull`, `scope: "workspace"`): both are thrown, and nothing is made.
 */

const text = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

/**
 * The workspace's own fields, by key. Only the shape is checked here: each value is checked on its
 * own in `intakeLead`, where one that can't be used is set aside instead of refusing the whole lead.
 */
const ownFields = (name: OwnFieldGroupName) =>
  z
    .record(z.string(), z.unknown(), { error: `${name} should be an object of field keys and values` })
    .refine((v) => Object.keys(v).length <= MAX_OWN_FIELDS, `${name} can name at most ${MAX_OWN_FIELDS} fields`)
    .optional();

export const leadPayloadSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(120),
    email: z.string().trim().toLowerCase().email("email is not a valid address").max(200).optional().or(z.literal("")),
    phone: text(20),
    company: text(160),
    designation: text(80),
    city: text(80),
    state: text(80),
    pincode: text(12),
    country: text(60),
    message: text(5000),
    product_interest: text(200),
    products: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    quantity: z.coerce.number().int().positive().max(100_000).optional(),
    budget: z.coerce.number().nonnegative().max(1_000_000_000).optional(),
    source: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(z.enum(LEAD_SOURCE_VALUES))
      .optional(),
    page_url: z.string().trim().url("page_url is not a URL").max(500).optional().or(z.literal("")),
    utm_source: text(100),
    utm_medium: text(100),
    utm_campaign: text(100),
    external_id: text(100),
    // The id the chat bubble's script gives this browser (DeskzoChat.visitorId()), so the visits it made join the contact.
    visitor_id: text(64),
    custom_fields: ownFields("custom_fields"),
    company_fields: ownFields("company_fields"),
    contact_fields: ownFields("contact_fields"),
  })
  .superRefine((v, ctx) => {
    if (!v.email && !v.phone) ctx.addIssue({ code: "custom", path: ["email"], message: "email or phone is required" });
    const postal = postalCodeIssue(v.country, v.pincode);
    if (postal) ctx.addIssue({ code: "custom", path: ["pincode"], message: postal });
  });

export type LeadPayload = z.infer<typeof leadPayloadSchema>;

/** Every field the validator accepts — `check:leads` compares this with the documentation. */
export const ACCEPTED_FIELDS = Object.keys(leadPayloadSchema.shape);

const OWN_FIELD_NAME = /^(custom_fields|company_fields|contact_fields)\[([^[\]]+)\](\[\])?$/;

/**
 * A plain HTML form's body, read into the shape a JSON body has. A form cannot send an array or an
 * object, so `products` comes as "SKU1,SKU2" and the workspace's own fields as `custom_fields[tower]`;
 * a field named twice, or as `custom_fields[regions][]`, is a list. Later values of any other name
 * replace earlier ones, as they always did.
 */
export function readFormBody(raw: string): Record<string, unknown> {
  const plain: [string, string][] = [];
  const own = new Map<string, Map<string, { values: string[]; list: boolean }>>();
  for (const [name, value] of new URLSearchParams(raw)) {
    const match = OWN_FIELD_NAME.exec(name);
    if (!match) {
      plain.push([name, value]);
      continue;
    }
    const [, group = "", key = "", brackets] = match;
    const fields = own.get(group) ?? new Map<string, { values: string[]; list: boolean }>();
    own.set(group, fields);
    const field = fields.get(key) ?? { values: [], list: false };
    fields.set(key, { values: [...field.values, value], list: field.list || brackets === "[]" || field.values.length > 0 });
  }
  // Built with fromEntries, so a key like `__proto__` is just a key — reported as one no field has.
  const body: Record<string, unknown> = Object.fromEntries(plain);
  for (const [group, fields] of own) {
    body[group] = Object.fromEntries([...fields].map(([key, f]) => [key, f.list ? f.values : f.values[0]]));
  }
  if (typeof body.products === "string") body.products = body.products.split(",").map((s) => s.trim()).filter(Boolean);
  return body;
}

/**
 * A job title, as people type it, read into the CRM's designations.
 *
 * Order matters: "IT head" is checked before "head", and "chief information officer" before
 * "chief", so the more specific reading wins.
 */
export function designationFromTitle(title: string | undefined): ContactDesignation {
  const t = ` ${(title ?? "").toLowerCase()} `;
  if (/\b(cio|cto|chief (information|technology|digital))/.test(t)) return "CIO";
  if (/\b(ceo|chief executive|managing director|founder|co-founder|proprietor|owner)\b|\bmd\b/.test(t)) return "CEO";
  if (/\b(it|technology|infra\w*|systems?)\s*head\b|\bhead\b.*\b(it|technology|infra\w*|systems?)\b/.test(t)) return "IT_HEAD";
  if (/\b(director|vp|vice president|head)\b/.test(t)) return "DIRECTOR";
  if (/\b(it|system|systems|network)\s*(manager|admin\w*|executive|engineer|officer)\b|\bsysadmin\b/.test(t)) return "IT_MANAGER";
  if (/\b(purchase|procurement|buyer|buying|sourcing)\b/.test(t)) return "PURCHASE_MANAGER";
  if (/\bhr\b|human resource/.test(t)) return "HR";
  return "OTHER";
}


export function companyNameFor(p: Pick<LeadPayload, "company" | "email" | "name">): string {
  if (p.company) return p.company;
  const domain = p.email?.split("@")[1]?.toLowerCase();
  if (domain && !FREE_MAIL.has(domain)) return domain;
  return `${p.name} (individual)`;
}

/** One of the workspace's own fields' values that was set aside: `custom_fields.floor`, and why. */
export type NotSaved = { field: string; reason: string };

export type IntakeResult =
  /** `overflow`: kept with nobody because whoever it was for is at their lead limit — the managers were told. */
  | { status: "created"; leadId: string; reference: string; assigned: boolean; notSaved: NotSaved[]; overflow?: true }
  | { status: "duplicate"; leadId: string; reference: string }
  | { status: "reseller" }
  /** No leads in the workspace's plan: the company and contact, made or found, and nothing more. */
  | { status: "contact"; companyId: string; companySeq: number; contactId: string; notSaved: NotSaved[] };

/** Why a lead's own field is set aside where there is no lead to put it on. */
export const NO_LEADS = "Leads aren't in this workspace's plan, so there is no lead to save it on.";

type SetAside = { group: OwnFieldGroupName; skipped: SkippedValue };

const RECORD_OF: Record<OwnFieldGroupName, string> = { custom_fields: "lead", company_fields: "company", contact_fields: "contact" };

/** The values set aside, as the lead's description notes them for whoever picks it up. */
function setAsideNote(items: SetAside[]): string | null {
  if (items.length === 0) return null;
  const lines = items.map(({ group, skipped: s }) => {
    if (!s.label) return `· ${group}.${s.key} isn't one of the fields a website can fill.`;
    const whose = group === "custom_fields" ? "" : `For the ${RECORD_OF[group]}: `;
    const sent = s.value && !s.reason.includes(`“${s.value}”`) ? ` It was “${s.value}”.` : "";
    return `· ${whose}${s.reason}${sent}`;
  });
  return ["Not saved from the website:", ...lines].join("\n");
}

/** What was sent for a company or contact already on file — not written to it, but not lost either. */
function onFileNote(record: string, own: OutsideFields): string | null {
  const given = describeValues(own.defs, own.values);
  return given.length ? `Sent for the ${record}, which was already on file, so not saved to it: ${given.join(" · ")}` : null;
}

/**
 * What an enquiry came through: a website's capture key — or, with no key (`id: null`), somebody's
 * digital card (src/lib/cards), whose holder is `createdById`.
 */
export type IntakeSource = { id: string | null; name: string; sourceLabel: string | null; createdById: string | null };

export type IntakeOptions = {
  /** The company a reviewer chose for a held website enquiry (src/lib/lead-capture/review.ts). */
  companyId?: string;
  /** Or the name they gave a new one — or "<name> (individual)". Either way the email isn't asked. */
  companyName?: string;
  /**
   * The lead goes to this person rather than through the assignment rules: a card's holder, who met
   * them. The rules would hand a contact somebody made in person to whoever covers the region.
   */
  ownerUserId?: string;
  /** In place of "<product> — <company>". */
  leadTitle?: string;
  /** What the owner is told, in place of "A website lead was assigned to you". */
  notifyTitle?: string;
  /** False when the owner made it themselves — a card they scanned — and needs no telling. */
  notify?: boolean;
  /** The team pipeline it starts in (src/lib/pipeline) — a booking page's; the main one when not given. */
  pipelineId?: string | null;
  /**
   * For a workflow's step (src/lib/automate/actions/lead-create.ts): written in the same transaction as
   * what it made, so the step's record and the lead stand or fall together — a retry finds the record
   * instead of making a second lead. A workflow's lead has no key, so `external_id` can't do this.
   */
  inTransaction?: (tx: Prisma.TransactionClient, made: { leadId: string | null; companyId: string; contactId: string }) => Promise<void>;
  /** The run whose step made it, for the `lead.created` event. */
  cause?: EventCause | null;
  /**
   * Who raised and sourced it, or null for nobody (owner, 9 Nov 2026 — "this came from our website, but why is my
   * name in Raised by?"). When not given: what a website's key is set to (nobody unless the admin chose), the person behind the source otherwise — a
   * card's holder, the agent who turned a chat into a lead. Raised by is what "Leads raised" pays incentives on.
   */
  raisedBy?: string | null;
  /**
   * Security audit round two, 13 Nov 2026 (R2-14): what a contact made here on a company already on file is
   * marked as — unconfirmed until staff say otherwise (src/lib/contacts/unconfirmed.ts). Not given: "WEB_FORM",
   * since everything else that calls this takes what a visitor typed. Null for one a person here made
   * themselves — a workflow's step, a card they scanned.
   */
  unconfirmedFrom?: UnconfirmedSource | null;
  /** Which way in, for the lead limits' warning rows (`markLeadWrite`): "capture", "booking", "inbox", "automate"… */
  path?: string;
};

export async function intakeLead(key: IntakeSource, p: LeadPayload, options: IntakeOptions = {}): Promise<IntakeResult> {
  const leadsHere = await moduleAvailableForTenant("leads");
  // A retry of something already received. Only a key makes a retry recognisable, and only a lead records it.
  if (p.external_id && key.id && leadsHere) {
    const existing = await db.lead.findUnique({
      where: { captureKeyId_externalId: { captureKeyId: key.id, externalId: p.external_id } },
      select: { id: true, leadSeq: true },
    });
    if (existing) return { status: "duplicate", leadId: existing.id, reference: formatLeadId(existing.leadSeq) };
  }

  // Somebody to credit for anything created — the person who issued the key, or failing that the
  // super admin. A company must have a creator, and "the website" is not a user.
  const actorId =
    key.createdById ?? (await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } }))?.id;
  if (!actorId) throw new Error("No user to attribute website leads to.");
  // A website's key credits whom its settings say (src/lib/lead-capture/credit.ts): nobody unless the admin chose.
  const raisedBy = options.raisedBy !== undefined ? options.raisedBy : key.id ? await raisedByForKey(key.id, key.createdById) : actorId;

  /**
   * Which company (owner, 9 Nov 2026): the one a reviewer chose, if one did; else the one named, when that name is on
   * file; else the one the sender's work email points at — somebody at @acme.co.in typing "Twentytwelve" is Acme;
   * else a new one by the name typed, as before.
   */
  const COMPANY_SELECT = { id: true, companySeq: true, name: true, ownerUserId: true, managedByResellerId: true, managedByReseller: { select: { name: true, ownerUserId: true } } } as const;
  const chosen = options.companyId ? await db.company.findUnique({ where: { id: options.companyId }, select: COMPANY_SELECT }) : null;
  const typedName = options.companyName ?? companyNameFor(p);
  const named = chosen ? null : await db.company.findUnique({ where: { normalizedName: normalizeCompanyName(typedName) }, select: COMPANY_SELECT });
  // A colleague's address counts only when no company was typed: the company's own website, always.
  const byDomain = !chosen && !named && !options.companyName ? await companyByEmailDomain(p.email, { viaContacts: !p.company?.trim() }).catch(() => null) : null;
  const domainCompany = byDomain ? await db.company.findUnique({ where: { id: byDomain.id }, select: COMPANY_SELECT }) : null;
  const existingCompany = chosen ?? named ?? domainCompany;
  const companyName = existingCompany?.name ?? typedName;
  const normalizedName = normalizeCompanyName(companyName);

  if (existingCompany && isResellerManaged(existingCompany)) {
    const routeTo = existingCompany.managedByReseller?.ownerUserId ?? actorId;
    await notifyUser({
      userId: routeTo,
      type: "LEAD_ASSIGNED",
      title: `A website enquiry for ${existingCompany.name} — a customer of ${existingCompany.managedByReseller?.name ?? "a reseller"}`,
      message: [p.name, p.email, p.phone, p.message].filter(Boolean).join(" · ").slice(0, 500),
      link: companyPath(existingCompany.companySeq),
    });
    return { status: "reseller" };
  }

  // The workspace's own fields, each value checked on its own. Read now; written only into the
  // records the transaction below creates.
  const [leadOwn, companyOwn, contactOwn] = await Promise.all([
    customFieldsFromOutside("LEAD", leadsHere ? p.custom_fields : undefined),
    customFieldsFromOutside("COMPANY", p.company_fields),
    customFieldsFromOutside("CONTACT", p.contact_fields),
  ]);
  const leadSkipped: SkippedValue[] = leadsHere ? leadOwn.skipped : Object.keys(p.custom_fields ?? {}).map((key) => ({ key, reason: NO_LEADS }));
  const setAside: SetAside[] = [
    ...leadSkipped.map((skipped) => ({ group: "custom_fields" as const, skipped })),
    ...companyOwn.skipped.map((skipped) => ({ group: "company_fields" as const, skipped })),
    ...contactOwn.skipped.map((skipped) => ({ group: "contact_fields" as const, skipped })),
  ];

  // What the assignment rules look at.
  const items = p.products?.length
    ? await db.item.findMany({ where: { sku: { in: p.products, mode: "insensitive" } }, select: { id: true, sku: true, brandId: true, type: true } })
    : [];
  const unknownSkus = (p.products ?? []).filter((sku) => !items.some((i) => i.sku.toLowerCase() === sku.toLowerCase()));
  const designation = designationFromTitle(p.designation);
  const source: LeadSource = p.source ?? "WEBSITE";
  /**
   * The assignment rules are part of leads; without them a new company is owned only by somebody named. Who the lead
   * goes to is decided inside the transaction below (lead limits, owner 12 Nov 2026); here only what that reads
   * through the global client — who could open it (M-15).
   */
  const namedOwner = options.ownerUserId ? { userId: options.ownerUserId, note: `Shared back from ${key.name}.` } : null;
  let plan: IntakeOwnerPlan | null = null;
  if (namedOwner) plan = { kind: "named", ...namedOwner };
  else if (leadsHere) {
    const signals: AssignmentSignals = {
      brandIds: [...new Set(items.map((i) => i.brandId).filter((b): b is string => !!b))],
      itemTypes: [...new Set(items.map((i) => i.type))],
      designation,
      source,
      state: p.state || null,
      companyOwnerId: existingCompany?.ownerUserId ?? null,
      // Where they said they are, and what they asked for; a company already here adds its category.
      itemIds: items.map((i) => i.id),
      country: p.country || null,
      city: p.city || null,
      pincode: p.pincode || null,
      companyId: existingCompany?.id ?? null,
    };
    plan = { kind: "rules", signals, mayOpen: await whoCouldOpen(signals) };
  }

  const sourceDetail = [
    key.sourceLabel || key.name,
    p.page_url,
    [p.utm_source, p.utm_medium, p.utm_campaign].some(Boolean) ? `utm ${[p.utm_source, p.utm_medium, p.utm_campaign].filter(Boolean).join(" / ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 300);

  // Which of the company and contact are new is known only inside the transaction, and the
  // description says different things for each.
  const describe = (made: { company: boolean; contact: boolean }) =>
    [
      p.message,
      p.designation ? `Designation given: ${p.designation}` : null,
      unknownSkus.length ? `Products asked for that are not in the catalogue: ${unknownSkus.join(", ")}` : null,
      setAsideNote(setAside),
      made.company ? null : onFileNote("company", companyOwn),
      made.contact ? null : onFileNote("contact", contactOwn),
      ...stillToFillLines({
        LEAD: leadOwn.missing,
        COMPANY: made.company ? companyOwn.missing : [],
        CONTACT: made.contact ? contactOwn.missing : [],
      }),
    ]
      .filter(Boolean)
      .join("\n\n");

  // Where the lead starts (src/lib/pipeline) — read before the transaction, which holds a connection.
  const entry = leadsHere ? await newLeadStage(undefined, options.pipelineId) : null;
  // R2-14: asked before the transaction, so the mark goes in with the contact itself.
  const unconfirmedFrom = options.unconfirmedFrom === undefined ? "WEB_FORM" : options.unconfirmedFrom;
  const markable = unconfirmedFrom && existingCompany ? await unconfirmedColumnHere() : false;
  let made: { lead: { id: string; leadSeq: number } | null; company: { id: string; companySeq: number }; contactId: string; owner: IntakeOwner | null };
  try {
    made = await db.$transaction(async (tx) => {
      // Who it goes to, and their room taken, first — the workspace's lead queue, then the rule, then the person.
      let owner: IntakeOwner | null = namedOwner ? { ...namedOwner, overflow: null } : null;
      if (entry && plan) {
        await markLeadWrite(tx, options.path ?? (key.id ? "capture" : "intake"));
        owner = await intakeOwner(tx, plan);
      }
      const company =
        existingCompany ??
        (await tx.company.create({
          data: {
            name: companyName,
            normalizedName,
            source: "INBOUND",
            stage: "LEAD",
            createdById: actorId,
            ownerUserId: owner?.userId ?? null,
            locations: {
              create: {
                label: "Head Office",
                city: p.city || null,
                state: p.state || null,
                pincode: p.pincode || null,
                country: p.country || null,
                gstTreatment: isIndia(p.country) ? "UNREGISTERED" : "OVERSEAS",
                isPrimary: true,
                isBilling: true,
                isShipping: true,
              },
            },
            ...companyOwn.data,
          },
          select: { id: true, companySeq: true },
        }));

      const matched =
        (p.email ? await tx.contact.findFirst({ where: { companyId: company.id, email: p.email }, select: { id: true } }) : null) ??
        (p.phone ? await tx.contact.findFirst({ where: { companyId: company.id, phone: p.phone }, select: { id: true } }) : null);
      const contact =
        matched ??
        (await tx.contact.create({
          data: {
            companyId: company.id,
            name: p.name,
            email: p.email || null,
            phone: p.phone || null,
            designation,
            createdByUserId: actorId,
            ...contactOwn.data,
            // R2-14: a visitor naming a company we already have — by name or by their email's domain — isn't
            // proof they work there: never picked by itself as a recipient until staff confirm them.
            ...(unconfirmedFrom ? unconfirmedData(unconfirmedFrom, !!existingCompany, markable) : {}),
          },
          select: { id: true },
        }));

      if (!entry) {
        await options.inTransaction?.(tx, { leadId: null, companyId: company.id, contactId: contact.id });
        return { lead: null, company, contactId: contact.id, owner };
      }
      const description = describe({ company: !existingCompany, contact: !matched });
      const lead = await tx.lead.create({
        data: {
          companyId: company.id,
          contactId: contact.id,
          title: (options.leadTitle ?? `${p.product_interest || "Website enquiry"} — ${companyName}`).slice(0, 200),
          description: description || null,
          ...entry,
          estimatedValue: p.budget ?? null,
          source,
          sourceDetail: sourceDetail || null,
          ownerUserId: owner?.userId ?? null,
          assignmentNote: owner?.note ?? null,
          // Not the key's maker for a website's lead: nobody raised it, and a person credited would be paid for it.
          sourcedByUserId: raisedBy,
          createdByUserId: raisedBy,
          captureKeyId: key.id,
          externalId: key.id ? p.external_id || null : null,
          requirements: { create: items.map((i) => ({ itemId: i.id, quantity: p.quantity ?? 1 })) },
          ...leadOwn.data,
        },
        select: { id: true, leadSeq: true },
      });
      // How it came in — the API key, a booking page, a card — is the source's name.
      await emitLeadCreated(tx, lead.id, actorId, key.name, options.cause ?? null);
      await options.inTransaction?.(tx, { leadId: lead.id, companyId: company.id, contactId: contact.id });
      return { lead, company, contactId: contact.id, owner };
    }, { maxWait: 10_000, timeout: 20_000 });
  } catch (error) {
    // Two copies of one request racing: the unique index let exactly one through. Answer the other
    // with the lead that won, as a duplicate — which is what it is.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && p.external_id && key.id) {
      const winner = await db.lead.findUnique({
        where: { captureKeyId_externalId: { captureKeyId: key.id, externalId: p.external_id } },
        select: { id: true, leadSeq: true },
      });
      if (winner) return { status: "duplicate", leadId: winner.id, reference: formatLeadId(winner.leadSeq) };
    }
    // The database's backstop refusing in "enforce" mode reads as the limit it is, for the caller to answer.
    throw leadCapacityError(error) ?? error;
  }
  const owner = made.owner;

  const notSaved = setAside.map(({ group, skipped }) => ({ field: `${group}.${skipped.key}`, reason: skipped.reason }));
  const created = made.lead;
  if (!created) {
    // No lead to hold what they said, so whoever hears of it is told — the company's owner, else whoever issued the key.
    if (options.notify !== false) {
      await notifyUser({
        userId: owner?.userId ?? existingCompany?.ownerUserId ?? actorId,
        type: "FORM_RESPONSE",
        title: options.notifyTitle ?? `A website enquiry from ${p.name}${companyName === p.name ? "" : `, ${companyName}`}`,
        message: [[p.email, p.phone].filter(Boolean).join(" · "), p.product_interest, p.message].filter(Boolean).join("\n").slice(0, 500),
        link: companyPath(made.company.companySeq),
      });
    }
    await recordAudit({
      userId: actorId,
      action: "CREATE",
      entityType: "Contact",
      entityId: made.contactId,
      entityLabel: key.id ? `Website enquiry via “${key.name}” (no leads in the plan)` : `Contact from ${key.name}`,
    });
    return { status: "contact", companyId: made.company.id, companySeq: made.company.companySeq, contactId: made.contactId, notSaved };
  }

  await refreshLeadScore(created.id);
  if (owner?.overflow) {
    // Nobody free to take it: the managers are told, and the person it was meant for — who met them, or whose it
    // would have been — hears of it, and why it isn't theirs.
    const title = options.leadTitle ?? `${p.product_interest || "Website enquiry"} — ${companyName}`;
    await notifyOverflow([created.id], overflowReason(title, owner.overflow));
    if (owner.overflow.full && options.notify !== false) {
      await notifyUser({
        userId: owner.overflow.full,
        type: "LEAD_ASSIGNED",
        title: "A lead came in for you while you're at your lead limit",
        message: `${title} — left with nobody: you're at your lead limit, so it's for your managers to give out.`,
        link: leadPath(created.leadSeq),
      });
    }
  }
  if (owner?.userId && options.notify !== false) {
    await notifyUser({
      userId: owner.userId,
      type: "LEAD_ASSIGNED",
      title: options.notifyTitle ?? "A website lead was assigned to you",
      message: options.leadTitle ?? `${p.product_interest || "Website enquiry"} — ${companyName}`,
      link: leadPath(created.leadSeq),
    });
  }
  await recordAudit({
    userId: actorId,
    action: "CREATE",
    entityType: "Lead",
    entityId: created.id,
    entityLabel: key.id ? `Website lead via “${key.name}”` : `Lead from ${key.name}`,
  });

  return { status: "created", leadId: created.id, reference: formatLeadId(created.leadSeq), assigned: Boolean(owner?.userId), notSaved, ...(owner?.overflow ? { overflow: true as const } : {}) };
}
