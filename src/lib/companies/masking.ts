import { cache } from "react";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { fieldMasker, maskCustomValues, resolveFieldPolicies, type FieldMasker } from "@/lib/authz/fields";
import { businessDate, revealedFieldsAmong } from "@/lib/authz/unmask";
import { formatCompanyId } from "@/lib/order-id";
import { customFieldKey, isCustomFieldKey, visibility, type FieldContext, type FieldVisibility } from "@/lib/authz/field-policy";

/**
 * Field access applied to companies (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.1 and H.4.2): the company twin
 * of src/lib/contacts/masking.ts. What one person may see of a company's addresses, GSTINs, PAN, website and custom
 * fields, worked out on the server before a value is put in a response — so a masked value never reaches the browser,
 * a CSV, the API, the app or the copilot in the clear.
 *
 *   · "list" — the company lists and pickers, search, the API's and the app's lists, the copilot and exports.
 *   · "detail" — the company's own page and its edit forms, and the API's and the app's single company.
 *
 * Not the company name: it is the record's identity, the label every order, ticket, invoice and payment shows, and
 * masking it here would be a promise the rest of the app couldn't keep. Nor trade documents: an invoice's address is
 * the workspace's own legal document, printed as issued.
 *
 * One "address" rule covers a location's street, city, state and PIN code (its country stays — it says no more than
 * the currency does); "gstin" its GST number. "City only" leaves the city in the clear and masks the rest.
 *
 * "Show" on the company's page reveals it for the rest of the day (owner, 5 Nov 2026 — Phase 3 masking fixes, wave B,
 * audit H.4.5; src/actions/company-unmask.ts), and so does "Show" on one of its leads (audit H.5, src/actions/lead-unmask.ts
 * — its company comes with it at no unit of its own). A reveal covers the fields it revealed (audit C.3.6), and shows them
 * in the clear where this person meets that company and the masker knows which company it is:
 *
 *   · its own page — `getCompany` asks for "detail" and masks the company with `maskCompanyWith`, which finds the
 *     company's reveal by its id (a "detail" masker reads every company this person revealed today: a handful);
 *   · the company lists — `maskCompanyRows`, which reads the reveals of the rows it is given;
 *   · its leads' pages — src/actions/lead.ts `getLead`, through `forCompany`.
 *
 * Everywhere else a "list" masker is asked without ids, and its answers are the policy's as they stand: exports, the
 * copilot, reports, the API's lists. So is everything that asks a masker without naming the company (`present`,
 * `location`, …). A reveal is for reading: `hidden` and `flags` stay the policy's, so the forms still leave those fields
 * alone and the saves keep what is stored, as the saves in src/actions/company.ts ask without a reveal.
 *
 * The workspace's master switch is honoured where every policy is resolved (src/lib/authz/fields.ts,
 * src/lib/authz/masking-switch.ts): off, nothing here is masked, and there is nothing to reveal.
 */

/** The company's own fields that field access covers, besides its custom fields (`custom:<key>`). */
export const COMPANY_FIELDS = ["address", "gstin", "pan", "website"] as const;
export type CompanyField = (typeof COMPANY_FIELDS)[number];

/** Which of a company's fields are hidden from this person here — masked or restricted, so a form leaves them alone. */
export type CompanyMaskFlags = Record<CompanyField, boolean>;

/** A location as any read has it: whichever of its address parts and GSTIN were selected. */
export type LocationParts = { address?: string | null; city?: string | null; state?: string | null; pincode?: string | null; gstNumber?: string | null };

const ADDRESS_PARTS = ["address", "city", "state", "pincode"] as const;

export type CompanyMasker = {
  /** False when nothing about companies is masked or restricted for this person here — values go out as they are. */
  active: boolean;
  context: FieldContext;
  visibility(field: string): FieldVisibility;
  /** One of the company's own values as this person sees it here. */
  present(field: CompanyField, value: string | null | undefined): string | null;
  /** A location's address parts and GSTIN as this person sees them here — the parts it has, the rest as they are. */
  location<L extends LocationParts>(location: L): L;
  /** Custom field values, masked or left out as their policies say. */
  custom<V extends Record<string, unknown>>(values: V): V;
  /** One custom field's words, as a card or a list column shows them. */
  customText(key: string, text: string): string;
  /** The fields (`address`, …, `custom:<key>`) not shown in the clear here — kept as stored when this person saves. */
  hidden: string[];
  flags: CompanyMaskFlags;
  /**
   * The same for one company, with what this person revealed of it today in the clear (owner, 5 Nov 2026 — Phase 3
   * masking fixes, wave B): its values only — `hidden` and `flags` stay the policy's, so a form still leaves them alone.
   * A company the masker wasn't told about, or not revealed today, is masked as the policy says.
   */
  forCompany(companyId: string): CompanyMasker;
};

const NONE: CompanyMaskFlags = { address: false, gstin: false, pan: false, website: false };

function clearMasker(context: FieldContext): CompanyMasker {
  const masker: CompanyMasker = {
    active: false,
    context,
    visibility: () => "clear",
    present: (_f, v) => v ?? null,
    location: (l) => l,
    custom: (v) => v,
    customText: (_k, t) => t,
    hidden: [],
    flags: NONE,
    forCompany: () => masker,
  };
  return masker;
}

/**
 * Every company this person revealed today, by the fields each reveal covered — what a "detail" masker, asked without
 * ids, reads: the company's own page, through `getCompany`, which names no company until it masks one. A day's reveals
 * are few — the daily limit's worth, and the companies of the leads among them.
 */
const revealedCompaniesToday = cache(async (userId: string): Promise<Map<string, Set<string>>> => {
  try {
    const rows = await db.unmaskUsage.findMany({ where: { userId, businessDate: await businessDate(), entity: "companies" }, select: { recordId: true, fields: true } });
    return new Map(rows.map((r) => [r.recordId, new Set(r.fields)]));
  } catch (err) {
    if (notMigratedYet(err)) return new Map();
    throw err;
  }
});

/**
 * What one person may see of companies in one context. Read once per request (the resolver is cached).
 *
 * `ids`: the companies about to be shown, so today's reveals of them are read in one query (`forCompany` then shows
 * them in the clear). Without them, a "detail" masker reads every company revealed today, and a "list" masker none —
 * the policy's own answers, which exports, the copilot, reports and the API's lists keep to.
 */
export async function companyMasker(userId: string, context: FieldContext, ids?: string[]): Promise<CompanyMasker> {
  const base: FieldMasker = await fieldMasker(userId, "companies", context);
  if (!base.active) return clearMasker(context);
  const resolved = await resolveFieldPolicies(userId, "companies");
  const fields = [...resolved.fields.values()];
  const hidden = fields.filter((f) => visibility(f.policy, context) !== "clear").map((f) => f.field.key);
  const flags: CompanyMaskFlags = {
    address: base.visibility("address") !== "clear",
    gstin: base.visibility("gstin") !== "clear",
    pan: base.visibility("pan") !== "clear",
    website: base.visibility("website") !== "clear",
  };

  /** The masker's value side, for one way of seeing each field — the policy's, or the policy's with a reveal in the clear. */
  const valuesBy = (seen: (field: string) => FieldVisibility, present: (field: string, value: string | null | undefined) => string | null) => {
    const addressHidden = seen("address") !== "clear";
    const gstinHidden = seen("gstin") !== "clear";
    // "City only" (partial_address) on a location's own parts: the city as it is, every other part masked whole.
    const cityShown = seen("address") === "masked" && base.policy("address")?.format === "partial_address";
    return {
      visibility: seen,
      present,
      location: <L extends LocationParts>(l: L): L => {
        if (!addressHidden && !gstinHidden) return l;
        const out: LocationParts = { ...l };
        if (addressHidden) {
          for (const part of ADDRESS_PARTS) {
            if (!(part in l) || (part === "city" && cityShown)) continue;
            out[part] = present("address", l[part]);
          }
        }
        if (gstinHidden && "gstNumber" in l) out.gstNumber = present("gstin", l.gstNumber);
        return out as L;
      },
      custom: <V extends Record<string, unknown>>(values: V): V => maskCustomValues({ ...base, visibility: seen, present }, values),
      customText: (key: string, text: string) => (text === "" ? text : (present(customFieldKey(key), text) ?? "")),
    };
  };

  // Today's reveals (owner, 5 Nov 2026 — Phase 3 masking fixes, wave B): a field shows in the clear when it is masked
  // here, theirs to unmask, and today's reveal of that company covered it (audit C.3.6) — never one restricted here.
  const revealableKeys = new Set(fields.filter((f) => visibility(f.policy, context) === "masked" && f.policy.unmask).map((f) => f.field.key));
  const covered =
    revealableKeys.size === 0
      ? new Map<string, Set<string>>()
      : ids
        ? await revealedFieldsAmong(userId, "companies", ids)
        : context === "detail"
          ? await revealedCompaniesToday(userId)
          : new Map<string, Set<string>>();

  const policy: CompanyMasker = {
    active: true,
    context,
    ...valuesBy(base.visibility, base.present),
    hidden,
    flags,
    forCompany: (companyId) => {
      const clear = new Set([...(covered.get(companyId) ?? [])].filter((k) => revealableKeys.has(k)));
      if (clear.size === 0) return policy;
      const seen = (field: string): FieldVisibility => (clear.has(field) ? "clear" : base.visibility(field));
      const present = (field: string, value: string | null | undefined) => (clear.has(field) ? (value ?? null) : base.present(field, value));
      const revealed: CompanyMasker = { ...policy, ...valuesBy(seen, present), forCompany: (other) => (other === companyId ? revealed : policy.forCompany(other)) };
      return revealed;
    },
  };
  return policy;
}

/**
 * What "Show" on a company reveals for this person (owner, 5 Nov 2026 — Phase 3 masking fixes, wave B): `concealed`, its
 * fields not in the clear on its page or in a list; `revealable`, those masked there that they may unmask — the
 * contact's rule (src/actions/contact-unmask.ts), so one reveal shows the company in the clear wherever they meet it.
 * The same for every company: field access is per record type, not per record.
 */
export async function companyRevealFields(userId: string): Promise<{ concealed: string[]; revealable: string[] }> {
  const fields = [...(await resolveFieldPolicies(userId, "companies")).fields.values()];
  return {
    concealed: fields.filter((f) => visibility(f.policy, "list") !== "clear" || visibility(f.policy, "detail") !== "clear").map((f) => f.field.key),
    revealable: fields.filter((f) => f.policy.view && f.policy.unmask && (f.policy.maskInList || f.policy.maskInDetail)).map((f) => f.field.key),
  };
}

/** What "Show" on this company would reveal now: its revealable fields that today's reveal hasn't covered — none, no "Show". */
export async function pendingCompanyReveal(userId: string, companyId: string): Promise<string[]> {
  const { revealable } = await companyRevealFields(userId);
  if (revealable.length === 0) return [];
  const covered = (await revealedFieldsAmong(userId, "companies", [companyId])).get(companyId);
  return revealable.filter((k) => !covered?.has(k));
}

/** How the unmasking log names a company: its number and its name — never masked (see above). */
export function companyRevealRef(company: { name: string; companySeq: number }): string {
  return `${formatCompanyId(company.companySeq)} ${company.name}`.slice(0, 120);
}

/** The custom field keys (without `custom:`) among a masker's hidden fields — a save's `skip`, a form's `exclude`. */
export function hiddenCustomKeys(masker: Pick<CompanyMasker, "hidden">): string[] {
  return masker.hidden.filter(isCustomFieldKey).map((k) => k.slice("custom:".length));
}

type MaskableCompany = { id?: string; website?: string | null; panNumber?: string | null; locations?: LocationParts[]; customFields?: unknown };

/**
 * Companies as this person may see them here: the website and PAN, each location's address and GSTIN, and the custom
 * fields when the row carries them — with `masked` saying which of those are hidden, so a form can leave them alone.
 * Whatever else a row holds is passed through: the lists send every column of a company, and none of these must slip
 * past in a column the table never draws. A company revealed today shows what the reveal covered in the clear.
 */
export async function maskCompanyRows<T extends MaskableCompany>(userId: string, context: FieldContext, rows: T[]): Promise<(T & { masked: CompanyMaskFlags })[]> {
  const masker = await companyMasker(userId, context, rows.flatMap((r) => (typeof r.id === "string" ? [r.id] : [])));
  return rows.map((r) => maskCompanyWith(masker, r));
}

/**
 * One company, as `maskCompanyRows` — for a caller that already has the masker. A row with its id is masked as that
 * company (`forCompany`): in the clear where the masker read a reveal of it today. `masked` is the policy's either way.
 */
export function maskCompanyWith<T extends MaskableCompany>(masker: CompanyMasker, row: T): T & { masked: CompanyMaskFlags } {
  if (!masker.active) return { ...row, masked: NONE };
  const shown = typeof row.id === "string" ? masker.forCompany(row.id) : masker;
  return {
    ...row,
    ...("website" in row ? { website: shown.present("website", row.website) } : {}),
    ...("panNumber" in row ? { panNumber: shown.present("pan", row.panNumber) } : {}),
    ...(Array.isArray(row.locations) ? { locations: row.locations.map((l) => shown.location(l)) } : {}),
    ...(row.customFields && typeof row.customFields === "object" ? { customFields: shown.custom(row.customFields as Record<string, unknown>) } : {}),
    masked: masker.flags,
  };
}

/**
 * A location's form, sent back, made to keep what its person couldn't see (owner, 5 Nov 2026 — Phase 3 masking fixes,
 * audit H.4.2): the parts hidden from them on the company's page are replaced by what is stored — the form shows them
 * masked, or leaves them out, and saving that would write the stars over the real address or GSTIN. Anything not
 * hidden is as they sent it.
 */
export async function keepHiddenLocationParts<I extends Record<string, unknown>>(userId: string, input: I, stored: LocationParts): Promise<I> {
  // The policy's flags, not a reveal's: the location's form left these parts out, revealed today or not.
  const masker = await companyMasker(userId, "detail", []);
  if (!masker.flags.address && !masker.flags.gstin) return input;
  const out: Record<string, unknown> = { ...input };
  if (masker.flags.address) for (const part of ADDRESS_PARTS) out[part] = stored[part] ?? "";
  if (masker.flags.gstin) out.gstNumber = stored.gstNumber ?? "";
  return out as I;
}
