import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { optionsOf, type PropertyKind } from "@/lib/smart-lists/values";
import type { ListTemplate, TemplateColumn, TemplateView } from "@/lib/smart-lists/templates";

/**
 * A company's own Smart List templates (owner, 20 Nov 2026 — Smart Lists phase 3: "save this list as a template for your
 * own company"): a list's columns, choices and views — never its rows — offered on New list beside Deskzo's own
 * (src/lib/smart-lists/templates.ts). A column that only makes sense for that one list — a link to another list's rows,
 * a count through one — is left out. Server only.
 */

export const CUSTOM_PREFIX = "custom:";
type Shape = { columns: TemplateColumn[]; views: TemplateView[] };

/** The list's shape as a template: its columns (bar the ones tied to other lists), its views on columns kept. */
export async function shapeOf(workbookId: string): Promise<{ titleName: string; shape: Shape }> {
  const [settings, props, views] = await Promise.all([
    db.workbookRowSettings.findUnique({ where: { workbookId }, select: { titleName: true } }),
    db.workbookProperty.findMany({ where: { workbookId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, kind: true, options: true } }),
    db.workbookView.findMany({ where: { workbookId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { name: true, kind: true, propertyId: true } }),
  ]);
  const kept = props.filter((p) => p.kind !== "ROW" && p.kind !== "ROLLUP");
  const columns: TemplateColumn[] = kept.map((p) => ({
    name: p.name,
    kind: p.kind as TemplateColumn["kind"],
    ...(p.kind === "SELECT" || p.kind === "MULTI_SELECT" ? { options: optionsOf(p.options).map((o) => o.name) } : {}),
  }));
  const viewsOut: TemplateView[] = [];
  // A board or a calendar, on a column kept; a table is every list's anyway.
  for (const v of views) {
    if (v.kind !== "BOARD" && v.kind !== "CALENDAR") continue;
    const by = kept.find((p) => p.id === v.propertyId);
    if (by) viewsOut.push({ name: v.name, kind: v.kind, by: by.name });
  }
  return { titleName: settings?.titleName || "Name", shape: { columns, views: viewsOut } };
}

export async function saveCompanyTemplate(input: { workbookId: string; name: string; description: string | null; userId: string }): Promise<string> {
  const { titleName, shape } = await shapeOf(input.workbookId);
  const made = await db.workbookTemplate.create({ data: { name: input.name, description: input.description, titleName, shape: shape as unknown as Prisma.InputJsonValue, createdByUserId: input.userId }, select: { id: true } });
  return made.id;
}

const KINDS: readonly string[] = ["TEXT", "NUMBER", "MONEY", "DATE", "SELECT", "MULTI_SELECT", "CHECKBOX", "LINK", "PERSON", "RATING", "EMAIL", "PHONE", "COMPANY", "LEAD", "CONTACT", "FILE"];

/** A stored template as New list offers it — its key "custom:<id>". Columns of a kind not known are left out. */
function asTemplate(row: { id: string; name: string; description: string | null; titleName: string; shape: unknown }): ListTemplate {
  const shape = (row.shape ?? {}) as Partial<Shape>;
  const columns = (Array.isArray(shape.columns) ? shape.columns : []).filter((c) => c && typeof c.name === "string" && KINDS.includes(c.kind as PropertyKind)).slice(0, 40);
  const names = new Set(columns.map((c) => c.name));
  const views = (Array.isArray(shape.views) ? shape.views : []).filter((v) => v && (v.kind === "BOARD" || v.kind === "CALENDAR") && typeof v.by === "string" && names.has(v.by)).slice(0, 12);
  return { key: `${CUSTOM_PREFIX}${row.id}`, name: row.name, description: row.description ?? "", group: "operations", titleName: row.titleName, columns, views, industries: [] };
}

/** The company's templates, newest first, each saying who may delete it. */
export async function companyTemplates(userId: string, mayManageAll: boolean): Promise<(ListTemplate & { canDelete: boolean; by: string | null })[]> {
  try {
    const rows = await db.workbookTemplate.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true, name: true, description: true, titleName: true, shape: true, createdByUserId: true } });
    const names = new Map((await db.user.findMany({ where: { id: { in: rows.map((r) => r.createdByUserId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return rows.map((r) => ({ ...asTemplate(r), canDelete: mayManageAll || r.createdByUserId === userId, by: r.createdByUserId ? (names.get(r.createdByUserId) ?? null) : null }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** One of the company's templates by its key, or null. */
export async function companyTemplateByKey(key: unknown): Promise<ListTemplate | null> {
  if (typeof key !== "string" || !key.startsWith(CUSTOM_PREFIX)) return null;
  const row = await db.workbookTemplate.findUnique({ where: { id: key.slice(CUSTOM_PREFIX.length) }, select: { id: true, name: true, description: true, titleName: true, shape: true } }).catch(() => null);
  return row ? asTemplate(row) : null;
}
