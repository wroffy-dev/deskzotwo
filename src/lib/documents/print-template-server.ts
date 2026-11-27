import { cache } from "react";
import type { TradeDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { documentAccess } from "@/lib/authz/access";
import { notMigratedYet } from "@/lib/custom-fields/server";
import { docTypeIn, documentDirection, tradeDocumentLabels } from "@/lib/trade-documents";
import { BUILT_IN_TEMPLATE_NAME, DEFAULT_PRINT_OPTIONS, decodePrintDraft, templateOptions, type PrintOptions } from "@/lib/documents/print-template";

/**
 * Which print template a document prints with (src/lib/documents/print-template.ts), read on the server.
 *
 * Never throws, and never refuses to print: a workspace still waiting for the migration
 * (20261130090000_document_print_templates), or any read that fails, prints the built-in Standard — a template is
 * never worth an invoice that won't open, or an email that goes without its PDF.
 */

export type ResolvedPrintTemplate = { id: string | null; name: string; builtIn: boolean; options: PrintOptions };

const builtIn = (): ResolvedPrintTemplate => ({ id: null, name: BUILT_IN_TEMPLATE_NAME, builtIn: true, options: structuredClone(DEFAULT_PRINT_OPTIONS) });

const TEMPLATE_SELECT = { id: true, name: true, layout: true, options: true } as const;

/**
 * The template to print a document of this type with: the one asked for when it exists and is this type's, else the
 * type's default, else the built-in Standard. Once a request — the page and its print bar ask alike.
 */
export const printTemplateFor = cache(async (docType: TradeDocumentType, templateId?: string | null): Promise<ResolvedPrintTemplate> => {
  try {
    const asked = templateId ? await db.documentPrintTemplate.findFirst({ where: { id: templateId, docType }, select: TEMPLATE_SELECT }) : null;
    const row = asked ?? (await db.documentPrintTemplate.findFirst({ where: { docType, isDefault: true }, select: TEMPLATE_SELECT }));
    return row ? { id: row.id, name: row.name, builtIn: false, options: templateOptions(row) } : builtIn();
  } catch (err) {
    if (!notMigratedYet(err)) console.error("the print template could not be read", err);
    return builtIn();
  }
});

/**
 * The templates a document of this type can be printed with, for the print bar's picker: the type's own, with the
 * built-in Standard first when none of them is the default (it is what prints). Empty when they can't be read.
 */
export async function printTemplateChoices(docType: TradeDocumentType): Promise<{ id: string | null; name: string; isDefault: boolean }[]> {
  try {
    const rows = await db.documentPrintTemplate.findMany({ where: { docType }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { id: true, name: true, isDefault: true } });
    return rows.some((r) => r.isDefault) ? rows : [{ id: null, name: BUILT_IN_TEMPLATE_NAME, isDefault: true }, ...rows];
  } catch (err) {
    if (!notMigratedYet(err)) console.error("the print templates could not be listed", err);
    return [];
  }
}

/**
 * An unsaved template's options, from the print page's `?draft=` — for the settings editor's live preview, so only
 * for somebody who may change templates (`settings.manage`, asked here and now, never taken from the address).
 * Anybody else, a render pass with no session, or anything the schema refuses: null, and the page prints as it
 * would without it.
 */
export async function draftPrintOptions(raw: string | undefined): Promise<PrintOptions | null> {
  if (!raw) return null;
  const user = await currentUser().catch(() => null);
  if (!user || !(await can(user.id, "settings.manage"))) return null;
  return decodePrintDraft(raw);
}

/**
 * The document the editor previews a template on: the most recent of its type this person can see; failing that, the
 * most recent sales document they can see, with the template applied all the same. Null when they can't see any.
 */
export async function previewDocumentFor(userId: string, docType: TradeDocumentType): Promise<{ id: string; docNumber: string; label: string; sameType: boolean } | null> {
  if (!(await can(userId, "documents.view"))) return null;
  const scope = await documentAccess(userId, "view");
  const select = { id: true, docNumber: true, docType: true } as const;
  const own = await db.tradeDocument.findFirst({ where: { AND: [{ docType }, scope] }, orderBy: [{ createdAt: "desc" }], select });
  if (own) return { id: own.id, docNumber: own.docNumber, label: tradeDocumentLabels[own.docType], sameType: true };
  const sales = (Object.keys(documentDirection) as TradeDocumentType[]).filter((t) => documentDirection[t] === "SALES");
  const any = await db.tradeDocument.findFirst({ where: { AND: [{ docType: docTypeIn(sales) }, scope] }, orderBy: [{ createdAt: "desc" }], select });
  return any ? { id: any.id, docNumber: any.docNumber, label: tradeDocumentLabels[any.docType], sameType: false } : null;
}
