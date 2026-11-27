import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { tenantKey } from "@/lib/tenancy/cache";
import { optionsOf, type PropertyKind } from "@/lib/smart-lists/values";
import { asFormat, compileFormula, evaluate, formulaOf, usesToday, type Val } from "@/lib/smart-lists/formulas";

/**
 * Formula columns, worked out and kept (owner, 20 Nov 2026 — Smart Lists phase 4; the expressions are
 * src/lib/smart-lists/formulas.ts). Kept like any value — in `workbook_row_values` or `workbook_values` — so a formula
 * filters, sorts, adds up and reminds like the rest. Worked out again:
 *
 *   · for a row, whenever one of its cells changes (src/lib/smart-lists/history.ts calls this beside every change);
 *   · for the whole list, when a formula column is added or changed, or a column it uses goes;
 *   · each morning, for formulas that read today (days until a date…), from the heartbeat.
 *
 * A row's cells are read as words or numbers — a choice by its name, a person by theirs, a tick as true, linked records
 * and files as how many. Never throws to its caller. Server only.
 */

type Prop = { id: string; name: string; kind: string; options: unknown };

/** The formula columns of a list, parsed; none when it has none. */
async function formulasOf(workbookId: string): Promise<{ props: Prop[]; formulas: { id: string; node: ReturnType<typeof compileFormula> & { ok: true }; format: ReturnType<typeof formulaOf> & object }[] }> {
  const props = await db.workbookProperty.findMany({ where: { workbookId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, kind: true, options: true } });
  const formulas = [];
  for (const p of props) {
    if (p.kind !== "FORMULA") continue;
    const f = formulaOf(p.options);
    if (!f) continue;
    const c = compileFormula(f.expr, props, p.id);
    if (c.ok) formulas.push({ id: p.id, node: c, format: f });
  }
  return { props, formulas };
}

/** Works out a list's formulas for some rows (or every row), keeping what changed. Returns how many cells changed. */
export async function recomputeFormulas(workbookId: string, rowKeys?: string[]): Promise<number> {
  try {
    const { props, formulas } = await formulasOf(workbookId);
    if (!formulas.length) return 0;
    const wb = await db.workbook.findUnique({ where: { id: workbookId }, select: { mode: true } });
    if (!wb) return 0;
    const own = wb.mode === "ROWS";
    const keys = rowKeys
      ? [...new Set(rowKeys)]
      : own
        ? (await db.workbookRow.findMany({ where: { workbookId }, select: { id: true }, take: 5000 })).map((r) => r.id)
        : (await db.workbookValue.findMany({ where: { workbookId }, distinct: ["companyId"], select: { companyId: true }, take: 50_000 })).map((v) => v.companyId);
    if (!keys.length) return 0;
    const today = (await workspaceClock()).today();
    const byProp = new Map(props.map((p) => [p.id, p]));
    let changed = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      const cells = own
        ? (await db.workbookRowValue.findMany({ where: { rowId: { in: chunk } }, select: { rowId: true, propertyId: true, value: true } })).map((c) => ({ key: c.rowId, propertyId: c.propertyId, value: c.value as unknown }))
        : (await db.workbookValue.findMany({ where: { workbookId, companyId: { in: chunk } }, select: { companyId: true, propertyId: true, value: true } })).map((c) => ({ key: c.companyId, propertyId: c.propertyId, value: c.value as unknown }));
      const values = new Map<string, Map<string, unknown>>();
      for (const c of cells) (values.get(c.key) ?? values.set(c.key, new Map()).get(c.key)!).set(c.propertyId, c.value);
      const personIds = [...new Set(cells.filter((c) => byProp.get(c.propertyId)?.kind === "PERSON").map((c) => String(c.value)))];
      const names = new Map(personIds.length ? (await db.user.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]) : []);

      const upserts: { key: string; propertyId: string; value: Prisma.InputJsonValue }[] = [];
      const removals: { key: string; propertyId: string }[] = [];
      for (const key of chunk) {
        const row = values.get(key) ?? new Map<string, unknown>();
        // A cell as a formula reads it.
        const read = (propertyId: string): Val => {
          const p = byProp.get(propertyId);
          const v = row.get(propertyId);
          if (!p || v === undefined || v === null) return null;
          switch (p.kind as PropertyKind) {
            case "SELECT":
              return optionsOf(p.options).find((o) => o.id === v)?.name ?? null;
            case "MULTI_SELECT":
              return Array.isArray(v) ? v.map((id) => optionsOf(p.options).find((o) => o.id === id)?.name).filter(Boolean).join(", ") : null;
            case "PERSON":
              return names.get(String(v)) ?? null;
            case "COMPANY":
            case "LEAD":
            case "CONTACT":
            case "ROW":
            case "FILE":
              return Array.isArray(v) ? v.length : null;
            default:
              return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : null;
          }
        };
        // Formulas in column order: one may use another worked out before it.
        for (const f of formulas) {
          const out = asFormat(evaluate(f.node.node, read, today), f.format.format);
          const before = row.get(f.id) ?? null;
          row.set(f.id, out);
          if (JSON.stringify(before) === JSON.stringify(out)) continue;
          if (out === null) removals.push({ key, propertyId: f.id });
          else upserts.push({ key, propertyId: f.id, value: out as Prisma.InputJsonValue });
        }
      }
      if (!upserts.length && !removals.length) continue;
      await db.$transaction(async (tx) => {
        for (const r of removals) {
          if (own) await tx.workbookRowValue.deleteMany({ where: { propertyId: r.propertyId, rowId: r.key } });
          else await tx.workbookValue.deleteMany({ where: { propertyId: r.propertyId, companyId: r.key } });
        }
        for (const u of upserts) {
          if (own)
            await tx.workbookRowValue.upsert({
              where: { propertyId_rowId: { propertyId: u.propertyId, rowId: u.key } },
              create: { workbookId, propertyId: u.propertyId, rowId: u.key, value: u.value, updatedByUserId: null },
              update: { value: u.value },
              select: { id: true },
            });
          else
            await tx.workbookValue.upsert({
              where: { propertyId_companyId: { propertyId: u.propertyId, companyId: u.key } },
              create: { workbookId, propertyId: u.propertyId, companyId: u.key, value: u.value, updatedByUserId: null },
              update: { value: u.value },
              select: { id: true },
            });
        }
      }, { timeout: 120_000 });
      changed += upserts.length + removals.length;
    }
    return changed;
  } catch (err) {
    if (!notMigratedYet(err)) console.error("[smart-lists] formulas not worked out", err instanceof Error ? err.message : err);
    return 0;
  }
}

const ranOn = new Map<string, string>();

/** Each morning: lists whose formulas read today, worked out again — once a day a workspace. From the heartbeat; never throws. */
export async function runFormulaDay(): Promise<number> {
  try {
    const key = await tenantKey().catch(() => "default");
    const today = (await workspaceClock()).today();
    if (ranOn.get(key) === today) return 0;
    ranOn.set(key, today);
    // Read by kind in code, not in the query: a workspace not yet migrated has no FORMULA to ask for.
    const props = (await db.workbookProperty.findMany({ where: { NOT: { options: { equals: Prisma.DbNull } } }, select: { workbookId: true, kind: true, options: true } })).filter((p) => p.kind === "FORMULA");
    const lists = [...new Set(props.filter((p) => usesToday(formulaOf(p.options)?.expr ?? "")).map((p) => p.workbookId))];
    let changed = 0;
    for (const id of lists) changed += await recomputeFormulas(id);
    return changed;
  } catch (err) {
    if (!notMigratedYet(err)) console.error("[smart-lists] the morning's formulas failed", err instanceof Error ? err.message : err);
    return 0;
  }
}
