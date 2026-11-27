"use server";

import { revalidatePath } from "next/cache";
import { tooLong } from "@/lib/validation/text";
import { z } from "zod";
import type { Prisma, TradeDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import {
  DEFAULT_PRINT_OPTIONS,
  PRINT_LAYOUTS,
  printLayoutInfo,
  printOptionsSchema,
  templateOptions,
  type PrintLayout,
  type PrintOptions,
} from "@/lib/documents/print-template";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Document templates (owner, 30 Oct 2026): how each kind of document looks on paper — several templates a
 * type, one the default (src/lib/documents/print-template.ts).
 *
 * Every action asks for `settings.manage`, the key Letterhead, Document numbering and Document emails ask for: what
 * goes out on a tax invoice is the organisation's, not one person's. Asked here on every call, never trusted from
 * the screen. Each change is in the audit log, as the neighbouring document settings' are.
 */

const PAGE = "/settings/document-templates";
const REFUSED = "Only somebody who can change organisation settings can change document templates.";
const TYPES = Object.keys(tradeDocumentLabels) as TradeDocumentType[];

/** The person, when they may change templates; null otherwise. */
async function templateEditor() {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  return (await can(user.id, "settings.manage")) ? user : null;
}

export type PrintTemplateRow = {
  id: string;
  docType: TradeDocumentType;
  name: string;
  layout: PrintLayout;
  isDefault: boolean;
  updatedAt: string;
};

const ROW_SELECT = { id: true, docType: true, name: true, layout: true, isDefault: true, updatedAt: true } as const;

function toRow(r: { id: string; docType: TradeDocumentType; name: string; layout: string; isDefault: boolean; updatedAt: Date }): PrintTemplateRow {
  return { ...r, layout: (PRINT_LAYOUTS as readonly string[]).includes(r.layout) ? (r.layout as PrintLayout) : "standard", updatedAt: r.updatedAt.toISOString() };
}

/** Every template, or one type's — the default first, then by name. Null for somebody who may not change them. */
export async function listPrintTemplates(docType?: TradeDocumentType): Promise<PrintTemplateRow[] | null> {
  if (!(await templateEditor())) return null;
  if (docType !== undefined && !TYPES.includes(docType)) return [];
  const rows = await db.documentPrintTemplate.findMany({
    where: docType ? { docType } : undefined,
    orderBy: [{ docType: "asc" }, { isDefault: "desc" }, { name: "asc" }],
    select: ROW_SELECT,
  });
  return rows.map(toRow);
}

/** One template with its options, for the editor. Null when it isn't there or may not be changed. */
export async function getPrintTemplate(id: string): Promise<(PrintTemplateRow & { options: PrintOptions }) | null> {
  if (typeof id !== "string" || !(await templateEditor())) return null;
  const row = await db.documentPrintTemplate.findUnique({ where: { id }, select: { ...ROW_SELECT, options: true } });
  return row ? { ...toRow(row), options: templateOptions(row) } : null;
}

const nameSchema = z.string().trim().min(1, "Give the template a name.").max(60, "Keep the name to 60 characters.");
const docTypeSchema = z.enum(TYPES as [TradeDocumentType, ...TradeDocumentType[]]);

/** The layout column and the rest, as stored: everything but the layout is `options`. */
function stored(options: PrintOptions): { layout: string; options: Prisma.InputJsonValue } {
  const { layout, ...rest } = options;
  return { layout, options: rest as unknown as Prisma.InputJsonValue };
}

/** A name not yet used by another of this type's templates: "Name", else "Name (2)", "Name (3)"… */
async function freeName(docType: TradeDocumentType, wanted: string, exceptId?: string): Promise<string> {
  const taken = new Set(
    (await db.documentPrintTemplate.findMany({ where: { docType, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { name: true } })).map((r) => r.name.toLowerCase()),
  );
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; ; n += 1) {
    const candidate = `${wanted.slice(0, 54)} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

const createSchema = z.object({
  name: nameSchema,
  docType: docTypeSchema,
  /** Start from a built-in layout… */
  layout: z.enum(PRINT_LAYOUTS).optional(),
  /** …or as a copy of an existing template, of any type. */
  copyOf: z.string().max(100, tooLong(100)).min(1).optional(),
  /** "Customise" makes the copy of the built-in the default straight away: until it is changed it prints the same page. */
  makeDefault: z.boolean().optional(),
});

/** A new template for a type: from Standard, Modern or Compact, or a copy of one already made. */
export async function createPrintTemplate(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await templateEditor();
  if (!user) return { ok: false, error: REFUSED };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That template isn't complete." };
  const { docType, copyOf, makeDefault } = parsed.data;

  let options: PrintOptions = { ...structuredClone(DEFAULT_PRINT_OPTIONS), layout: parsed.data.layout ?? "standard" };
  if (copyOf) {
    const source = await db.documentPrintTemplate.findUnique({ where: { id: copyOf }, select: { layout: true, options: true } });
    if (!source) return { ok: false, error: "The template to copy is no longer there." };
    options = templateOptions(source);
  }
  const name = await freeName(docType, parsed.data.name);

  const created = await db.$transaction(async (tx) => {
    if (makeDefault) await tx.documentPrintTemplate.updateMany({ where: { docType, isDefault: true }, data: { isDefault: false } });
    return tx.documentPrintTemplate.create({
      data: { docType, name, isDefault: Boolean(makeDefault), ...stored(options), createdById: user.id, updatedById: user.id },
      select: { id: true },
    });
  });
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "DocumentPrintTemplate",
    entityId: created.id,
    entityLabel: `${tradeDocumentLabels[docType]} print template “${name}” (${copyOf ? "a copy" : printLayoutInfo[options.layout].label})${makeDefault ? ", the default" : ""}`,
  });
  revalidatePath(PAGE);
  return { ok: true, data: { id: created.id } };
}

const updateSchema = z.object({ id: z.string().max(100, tooLong(100)).min(1), name: nameSchema, options: printOptionsSchema });

/** A template's name and options, every value checked by the schema the print page reads them with. */
export async function updatePrintTemplate(input: unknown): Promise<ActionResult<{ name: string }>> {
  const user = await templateEditor();
  if (!user) return { ok: false, error: REFUSED };
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue ? `${issue.path.length ? `${issue.path.join(" › ")}: ` : ""}${issue.message}` : "Those options aren't valid." };
  }
  const current = await db.documentPrintTemplate.findUnique({ where: { id: parsed.data.id }, select: { docType: true, name: true } });
  if (!current) return { ok: false, error: "That template is no longer there." };
  const name = await freeName(current.docType, parsed.data.name, parsed.data.id);
  await db.documentPrintTemplate.update({ where: { id: parsed.data.id }, data: { name, ...stored(parsed.data.options), updatedById: user.id } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "DocumentPrintTemplate",
    entityId: parsed.data.id,
    entityLabel: `${tradeDocumentLabels[current.docType]} print template “${name}” changed${name !== current.name ? ` (was “${current.name}”)` : ""}`,
  });
  revalidatePath(PAGE);
  revalidatePath(`${PAGE}/${parsed.data.id}`);
  return { ok: true, data: { name } };
}

/**
 * The template a type prints with unless another is picked — one a type, so the old default is cleared in the same
 * transaction (and the partial unique index document_print_templates_one_default refuses a second). `id: null` puts
 * the type back on the built-in Standard.
 */
export async function setDefaultPrintTemplate(input: { docType: TradeDocumentType; id: string | null }): Promise<ActionResult<null>> {
  const user = await templateEditor();
  if (!user) return { ok: false, error: REFUSED };
  const docType = docTypeSchema.safeParse(input?.docType);
  if (!docType.success) return { ok: false, error: "That isn't a kind of document." };
  const id = typeof input.id === "string" && input.id ? input.id : null;
  const target = id ? await db.documentPrintTemplate.findFirst({ where: { id, docType: docType.data }, select: { id: true, name: true } }) : null;
  if (id && !target) return { ok: false, error: "That template is no longer there." };

  await db.$transaction(async (tx) => {
    await tx.documentPrintTemplate.updateMany({ where: { docType: docType.data, isDefault: true }, data: { isDefault: false } });
    if (target) await tx.documentPrintTemplate.update({ where: { id: target.id }, data: { isDefault: true, updatedById: user.id } });
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "DocumentPrintTemplate",
    entityId: target?.id ?? docType.data,
    entityLabel: `${tradeDocumentLabels[docType.data]}s print with ${target ? `“${target.name}”` : "the built-in Standard template"} by default`,
  });
  revalidatePath(PAGE);
  return { ok: true, data: null };
}

/** A copy of a template, beside it and not the default. */
export async function duplicatePrintTemplate(id: string): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await templateEditor();
  if (!user) return { ok: false, error: REFUSED };
  const source = typeof id === "string" ? await db.documentPrintTemplate.findUnique({ where: { id }, select: { docType: true, name: true, layout: true, options: true } }) : null;
  if (!source) return { ok: false, error: "That template is no longer there." };
  const name = await freeName(source.docType, `${source.name.slice(0, 53)} (copy)`);
  const created = await db.documentPrintTemplate.create({
    data: { docType: source.docType, name, isDefault: false, ...stored(templateOptions(source)), createdById: user.id, updatedById: user.id },
    select: { id: true },
  });
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "DocumentPrintTemplate",
    entityId: created.id,
    entityLabel: `${tradeDocumentLabels[source.docType]} print template “${name}”, a copy of “${source.name}”`,
  });
  revalidatePath(PAGE);
  return { ok: true, data: { id: created.id, name } };
}

/**
 * Deletes a template. Deleting a type's default puts the type back on the built-in Standard until another is made the
 * default — said in the confirmation, and in what this returns. Documents keep nothing of a template: each prints
 * with whatever is chosen when it prints.
 */
export async function deletePrintTemplate(id: string): Promise<ActionResult<{ wasDefault: boolean }>> {
  const user = await templateEditor();
  if (!user) return { ok: false, error: REFUSED };
  const row = typeof id === "string" ? await db.documentPrintTemplate.findUnique({ where: { id }, select: { id: true, docType: true, name: true, isDefault: true } }) : null;
  if (!row) return { ok: false, error: "That template is no longer there." };
  await db.documentPrintTemplate.delete({ where: { id: row.id } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "DocumentPrintTemplate",
    entityId: row.id,
    entityLabel: `${tradeDocumentLabels[row.docType]} print template “${row.name}” deleted${row.isDefault ? " — the built-in Standard is the default again" : ""}`,
  });
  revalidatePath(PAGE);
  return { ok: true, data: { wasDefault: row.isDefault } };
}
