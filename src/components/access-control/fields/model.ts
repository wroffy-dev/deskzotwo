import type { FieldAccessRow } from "@/actions/field-access";
import {
  exportVisibility,
  FIELD_ENTITIES,
  normalisePolicy,
  openPolicy,
  withinPolicy,
  type ExportMode,
  type FieldEntity,
  type FieldKind,
  type FieldPolicy,
  type MaskFormat,
} from "@/lib/authz/field-policy";

/**
 * What the Field-Level Permission Manager is drawn from, and the few rules it keeps before the server
 * does (src/actions/field-access.ts is the authority on every one of them):
 *
 *   · a field that can't be read has nothing to mask, unmask or export — `normalisePolicy`;
 *   · an answer equal to what the subject would get anyway is not stored: the row goes instead;
 *   · nobody gives a field more open than they have it themselves — `withinPolicy`, flagged per row.
 */

/** A subject's own answer for one field: a policy, or null where nothing is set on them. */
export type Choice = FieldPolicy | null;
/** Staged, unsaved answers: record type → field key → the answer that would be saved. */
export type Draft = Record<FieldEntity, Record<string, Choice>>;

export const emptyDraft = (): Draft => ({ leads: {}, contacts: {}, companies: {} });

export type FieldSubject =
  | { type: "role"; id: string; name: string; system: boolean; active: boolean; holders: { id: string; name: string }[] }
  | {
      type: "user";
      id: string;
      name: string;
      roleKey: string;
      roleName: string;
      /** Outside field access altogether: a super admin sees every field, whatever is stored. */
      superAdmin: boolean;
      /** Their account or role is switched off: nothing is readable until it is back on; the rules are kept. */
      inactive: boolean;
    };

export type SubjectOption = { id: string; name: string; hint: string | null };

export type EntityAccess = { entity: FieldEntity; rows: FieldAccessRow[]; warnings: string[] };

/** The subject's daily unmask limit, as stored — the wording is the old screens' (see `limitWords`). */
export type LimitSummary =
  | { kind: "role"; dailyLimit: number | null; limitStored: boolean; workspaceDefault: number | null }
  | { kind: "user"; effective: number | null; why: string; used: number; limit: number | null; remaining: number | null; zone: string };

/** One entry of the permission history about a field (`field:<entity>:<key>`). */
export type FieldChange = { id: string; entity: FieldEntity; field: string; detail: string; actor: string | null; at: string };

/** The viewer's own answers per field — the ceiling on what they may give. Null: a super admin, no ceiling. */
export type OwnCaps = Record<FieldEntity, Record<string, FieldPolicy>> | null;

export type MaskingBanner = { enabled: boolean; changedAtText: string | null; changedBy: string | null };

export function samePolicy(a: Choice, b: Choice): boolean {
  if (a === null || b === null) return a === b;
  return a.view === b.view && a.maskInList === b.maskInList && a.maskInDetail === b.maskInDetail && a.unmask === b.unmask && a.format === b.format && a.export === b.export;
}

/** One field as the matrix, the preview and the summary all read it. */
export type RowModel = {
  row: FieldAccessRow;
  /** What applies with the staged answer. */
  policy: FieldPolicy;
  /** What applies as saved. */
  saved: FieldPolicy;
  /** The subject's own answer after staging, null where it follows the default. */
  choice: Choice;
  /** The subject has a row of their own here (after staging) — drawn solid; without one, dashed. */
  own: boolean;
  staged: boolean;
  /** Staged, and more open than the viewer's own answer: the server will refuse it. */
  exceeds: boolean;
  pii: boolean;
  /** A custom field marked restricted — it also needs "See restricted fields". */
  restrictedCustom: boolean;
};

export function buildRows(access: EntityAccess, draft: Record<string, Choice>, caps: OwnCaps, fixed: boolean): RowModel[] {
  return access.rows.map((row) => {
    // Somebody outside field access is shown what applies to them, and nothing is staged for them.
    const has = !fixed && Object.prototype.hasOwnProperty.call(draft, row.key);
    const choice = has ? draft[row.key]! : row.stored;
    const staged = has && !samePolicy(choice, row.stored);
    const policy = fixed ? row.effective : (choice ?? row.inherited);
    const saved = fixed ? row.effective : (row.stored ?? row.inherited);
    const cap = caps ? (caps[access.entity][row.key] ?? openPolicy(row.kind)) : null;
    return {
      row,
      policy,
      saved,
      choice,
      own: !fixed && choice !== null,
      staged,
      exceeds: staged && cap !== null && !withinPolicy(policy, cap),
      pii: row.kind === "email" || row.kind === "phone",
      restrictedCustom: row.custom && row.description.includes("restricted custom field"),
    };
  });
}

/**
 * The answer to store after a change: made consistent, and dropped (null) where it is exactly what the
 * subject would get without a row — a role's "nothing set", a person's "as their role".
 */
export function nextChoice(row: FieldAccessRow, current: FieldPolicy, patch: Partial<FieldPolicy>): Choice {
  let wanted = { ...current, ...patch };
  // Switching View back on: what they would get anyway, where that can be read; else readable but masked,
  // the cautious step from "Restricted".
  if (patch.view === true && !current.view) {
    wanted = row.inherited.view ? row.inherited : { ...openPolicy(row.kind), maskInList: true, maskInDetail: true, format: current.format };
  }
  const next = normalisePolicy(row.kind, wanted);
  return samePolicy(next, row.inherited) ? null : next;
}

export const KIND_LABEL: Record<FieldKind, string> = { text: "Text", email: "Email", phone: "Phone", address: "Address", choice: "Choice" };

export const FORMAT_SHORT: Record<MaskFormat, string> = {
  first: "First letter",
  stars: "Fully hidden",
  email: "Email",
  phone_last4: "Last four",
  phone_code: "Code only",
  partial_address: "City only",
};

/** What an export does with a field, in the words of the old editors (`exportVisibility`): "as the list" spelled out. */
export function exportWords(p: FieldPolicy): string {
  const seen = exportVisibility(p);
  if (seen === "restricted") return "Restricted";
  if (p.export === "clear" && seen === "masked") return "Masked — it is masked everywhere";
  const said = seen === "none" ? "Left out" : seen === "masked" ? "Masked" : "In the clear";
  return p.export === null ? `As the list · ${said.toLowerCase()}` : said;
}

export const EXPORT_HELP: Record<ExportMode, string> = {
  none: "Left out: the cell goes out blank.",
  masked: "Masked in files and API lists, even where the screens show it in the clear.",
  clear: "In the clear — only where they may see it in the clear in a list or on the record; otherwise it stays masked.",
};

/** A field's standing in one word, with the tone the old screens gave it. */
export function standing(p: FieldPolicy): { text: string; tone: "green" | "amber" | "red" | "blue" } {
  if (!p.view) return { text: "Restricted", tone: "red" };
  if (!p.maskInList && !p.maskInDetail) return { text: "Visible", tone: "green" };
  return p.unmask ? { text: "Masked · may unmask", tone: "blue" } : { text: "Masked", tone: "amber" };
}

/**
 * A role's daily unmask limit in words (the Roles screen's `roleLimitWords`): nothing set on the role is
 * the workspace's default, not "no limit" — that has to be chosen.
 */
export function limitWords(limit: LimitSummary): { short: string; full: string } {
  if (limit.kind === "user") {
    const short = limit.limit === null ? `${limit.used} unmasked today · no limit` : `${limit.used} / ${limit.limit} unmasked today`;
    return { short, full: `${limit.why} Resets at 12:00 AM (${limit.zone}).` };
  }
  if (limit.limitStored) {
    return limit.dailyLimit === null
      ? { short: "No daily unmask limit", full: "No limit, chosen for this role: people in it may unmask as many leads, contacts and companies as their field access allows." }
      : { short: `${limit.dailyLimit} unmasks a day`, full: `${limit.dailyLimit} leads, contacts and companies a day for each person in this role.` };
  }
  return limit.workspaceDefault === null
    ? { short: "Workspace default · no limit", full: "Nothing set on this role, so the workspace default applies — and the default is no limit." }
    : {
        short: `${limit.workspaceDefault} a day · workspace default`,
        full: `Nothing set on this role, so the workspace default applies: ${limit.workspaceDefault} a day for each person in it who may unmask anything.`,
      };
}

// ─── Sample records ───────────────────────────────────────────────────────────────────────────────

/**
 * Made-up records the preview is drawn on — never a real lead, contact or company. The values are masked
 * with the real `maskValue` / `presentValue`, so what the admin sees is what the server would send.
 */
const SAMPLES: Record<FieldEntity, Record<string, string>[]> = {
  leads: [
    {
      title: "Sample enquiry — CNC lathe",
      companyName: "Example Industries Pvt Ltd",
      contactName: "Priya Sharma",
      email: "priya.sharma@example.com",
      phone: "+91 98765 43210",
      address: "14 MG Road, Pune",
      source: "Website",
      description: "Sample message: please share a quote for two units.",
    },
    {
      title: "Sample enquiry — packaging line",
      companyName: "Sample Traders LLP",
      contactName: "Arjun Mehta",
      email: "arjun.mehta@example.org",
      phone: "+91 90000 12345",
      address: "221 Sample Street, Jaipur",
      source: "Referral",
      description: "Sample message: would like a demo next week.",
    },
    {
      title: "Sample enquiry — spare parts",
      companyName: "Demo Exports Ltd",
      contactName: "Neha Iyer",
      email: "neha.iyer@example.net",
      phone: "+91 91234 56780",
      address: "7 Test Lane, Kochi",
      source: "Trade fair",
      description: "Sample message: checking prices before ordering.",
    },
  ],
  contacts: [
    { name: "Priya Sharma", email: "priya.sharma@example.com", phone: "+91 98765 43210" },
    { name: "Arjun Mehta", email: "arjun.mehta@example.org", phone: "+91 90000 12345" },
    { name: "Neha Iyer", email: "neha.iyer@example.net", phone: "+91 91234 56780" },
  ],
  companies: [
    { address: "14 MG Road, Pune", gstin: "27AAAAA0000A1Z5", pan: "AAAAA0000A", website: "www.example.com" },
    { address: "221 Sample Street, Jaipur", gstin: "08BBBBB1111B1Z4", pan: "BBBBB1111B", website: "www.example.org" },
    { address: "7 Test Lane, Kochi", gstin: "32CCCCC2222C1Z3", pan: "CCCCC2222C", website: "www.example.net" },
  ],
};

/** For a custom field, by what it holds. */
const KIND_SAMPLES: Record<FieldKind, string[]> = {
  text: ["Sample value", "Another sample", "Third sample"],
  email: ["priya.sharma@example.com", "arjun.mehta@example.org", "neha.iyer@example.net"],
  phone: ["+91 98765 43210", "+91 90000 12345", "+91 91234 56780"],
  address: ["14 MG Road, Pune", "221 Sample Street, Jaipur", "7 Test Lane, Kochi"],
  choice: ["Option A", "Option B", "Option C"],
};

export const SAMPLE_COUNT = 3;

export function sampleValue(entity: FieldEntity, row: FieldAccessRow, record: number): string {
  const i = ((record % SAMPLE_COUNT) + SAMPLE_COUNT) % SAMPLE_COUNT;
  return SAMPLES[entity][i]![row.key] ?? KIND_SAMPLES[row.kind][i]!;
}

export { FIELD_ENTITIES };
