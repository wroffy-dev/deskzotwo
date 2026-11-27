import type { AccessRecord } from "@/lib/authz/access";
import { DOC_ACTIONS, docKeyOf, type DOC_KINDS } from "@/lib/documents/permission-keys";
import { ACCESS_MODULES, RECORD_VIEW_KEY, actionRowsOf, docGridOf, sectionsOfModule } from "@/lib/staff/access-modules";

/**
 * The areas of Document Permissions: the modules that have document types with permissions of their
 * own (src/lib/documents/permission-keys.ts) — Sales and Purchases — each laid out as the design lays
 * out an area. A way of arranging the one model, like src/lib/staff/access-modules.ts it is read from:
 *
 *   · Records   — the module's record types, plus "Sales & purchase documents", whose level is how far
 *                 every document permission below it reaches;
 *   · Documents — one permission per document type and action (Create … Approve), allowed or not;
 *   · Other     — the permission that opens each record's pages, then the module's other permissions;
 *   · Module on — the module's menu sections, as "Module enabled" on the role screen.
 *
 * Dependency-free (the registry and types), so the page and the client screen read the same list.
 */

type DocKind = (typeof DOC_KINDS)[number];

export type DocArea = {
  key: string;
  label: string;
  description: string;
  records: AccessRecord[];
  kinds: DocKind[];
  /** The menu sections "Module on" shows or hides. */
  sections: string[];
  /** The permissions drawn as tick boxes. */
  other: string[];
};

/** The record every document type is a row of: its level decides which documents an allowed action reaches. */
export const DOCUMENT_RECORD: AccessRecord = "documents";

export const DOC_AREAS: readonly DocArea[] = ACCESS_MODULES.filter((m) => docGridOf(m.key).length > 0).map((m) => {
  const records: AccessRecord[] = m.records.includes(DOCUMENT_RECORD) ? [...m.records] : [...m.records, DOCUMENT_RECORD];
  const opens = records.flatMap((r) => (RECORD_VIEW_KEY[r] ? [RECORD_VIEW_KEY[r]!] : []));
  const own = actionRowsOf(m.key, [], { withoutDocs: true }).flatMap((row) => (row.kind === "key" ? [row.key] : []));
  return {
    key: m.key,
    label: m.label,
    description: m.description,
    records,
    kinds: docGridOf(m.key),
    sections: sectionsOfModule(m.key).map((d) => d.key),
    other: [...new Set([...opens, ...own])],
  };
});

/** Every document permission of an area, row by row. */
export function docKeysOfArea(area: DocArea): string[] {
  return area.kinds.flatMap((k) => DOC_ACTIONS.map((a) => docKeyOf(k.slug, a)));
}

/** Every permission key the screen reads or writes. */
export function docScreenKeys(): string[] {
  return [...new Set(DOC_AREAS.flatMap((a) => [...docKeysOfArea(a), ...a.sections, ...a.other]))];
}

/** Every record type the screen draws. */
export function docScreenRecords(): AccessRecord[] {
  return [...new Set(DOC_AREAS.flatMap((a) => a.records))];
}
