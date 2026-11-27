import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { recordChanges } from "@/lib/smart-lists/history";
import { emitRowsAdded } from "@/lib/automate/emit-smart-lists";
import { OWN_ROWS, cleanTitle, titleNameOf } from "@/lib/smart-lists/own-rows";
import { optionsOf, parseValue, type PropertyKind, type SelectOption } from "@/lib/smart-lists/values";

/**
 * Forms that add a row to a list of its own (owner, 20 Nov 2026 — Smart Lists phase 3: "a short form for one list, for
 * teammates who never open the list, such as a site-survey request or an asset handover"). Internal: whoever is signed
 * in with Smart Lists open to them may fill one in — even for a list they can't open, which is the point — and sees
 * only the form, never the list. The row is theirs ("added by"), recorded in its history and handed to Deskzo Automate
 * like any row added by hand. A form's public link, for people outside the company, is src/lib/smart-lists/public-forms.ts
 * (phase 4). Server only.
 */

/** The kinds a form can ask: typed in or picked — not links to records, files or worked-out counts. */
export const FORM_KINDS: readonly PropertyKind[] = ["TEXT", "NUMBER", "MONEY", "DATE", "SELECT", "MULTI_SELECT", "CHECKBOX", "LINK", "PERSON", "RATING", "EMAIL", "PHONE"];
export const FORM_LIMITS = { fields: 30, name: 80, intro: 1000 } as const;

export type FormField = { propertyId: string; required: boolean };
export type FormQuestion = { propertyId: string; name: string; kind: PropertyKind; options: SelectOption[]; required: boolean };

/** A form's questions as kept: columns of this list a form may ask, once each, in order. */
export function cleanFormFields(raw: unknown, props: { id: string; kind: PropertyKind }[]): FormField[] {
  const seen = new Set<string>();
  const out: FormField[] = [];
  for (const f of Array.isArray(raw) ? raw : []) {
    const id = String((f as Partial<FormField>)?.propertyId ?? "");
    const p = props.find((x) => x.id === id);
    if (!p || !FORM_KINDS.includes(p.kind) || seen.has(id)) continue;
    seen.add(id);
    out.push({ propertyId: id, required: (f as Partial<FormField>).required === true });
    if (out.length >= FORM_LIMITS.fields) break;
  }
  return out;
}

/** A form as somebody filling it in sees it: its name, what it's for, the title's name and the questions. */
export async function formToFill(formId: string): Promise<{ id: string; name: string; intro: string | null; listName: string; titleName: string; questions: FormQuestion[]; people: { id: string; name: string }[] } | null> {
  const form = await db.workbookForm.findUnique({ where: { id: formId }, select: { id: true, name: true, intro: true, fields: true, active: true, workbookId: true, workbook: { select: { name: true, mode: true } } } }).catch(() => null);
  if (!form || !form.active || form.workbook.mode !== "ROWS") return null;
  const props = await db.workbookProperty.findMany({ where: { workbookId: form.workbookId }, select: { id: true, name: true, kind: true, options: true } });
  const fields = cleanFormFields(form.fields, props.map((p) => ({ id: p.id, kind: p.kind as PropertyKind })));
  const questions = fields.map((f) => {
    const p = props.find((x) => x.id === f.propertyId)!;
    return { propertyId: p.id, name: p.name, kind: p.kind as PropertyKind, options: optionsOf(p.options), required: f.required };
  });
  const people = questions.some((q) => q.kind === "PERSON") ? await db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [];
  return { id: form.id, name: form.name, intro: form.intro, listName: form.workbook.name, titleName: await titleNameOf(form.workbookId), questions, people };
}

/** An answer to a form: a new row of its list, added by whoever filled it in. */
export async function submitForm(input: { formId: string; title: string; answers: Record<string, unknown>; userId: string }): Promise<{ ok: true; rowId: string } | { ok: false; error: string }> {
  const form = await db.workbookForm.findUnique({ where: { id: input.formId }, select: { id: true, name: true, fields: true, active: true, workbookId: true, workbook: { select: { name: true, mode: true } } } }).catch(() => null);
  if (!form || !form.active || form.workbook.mode !== "ROWS") return { ok: false, error: "That form is closed." };
  const title = cleanTitle(input.title);
  if (!title) return { ok: false, error: `Fill in the ${(await titleNameOf(form.workbookId)).toLowerCase()}.` };
  const props = await db.workbookProperty.findMany({ where: { workbookId: form.workbookId }, select: { id: true, name: true, kind: true, options: true } });
  const fields = cleanFormFields(form.fields, props.map((p) => ({ id: p.id, kind: p.kind as PropertyKind })));
  const cells: { propertyId: string; value: Prisma.InputJsonValue }[] = [];
  for (const f of fields) {
    const p = props.find((x) => x.id === f.propertyId)!;
    const parsed = parseValue(p.kind as PropertyKind, (input.answers ?? {})[p.id], optionsOf(p.options));
    if (!parsed.ok) return { ok: false, error: `${p.name}: ${parsed.error}` };
    if (parsed.value === null) {
      if (f.required) return { ok: false, error: `Fill in ${p.name}.` };
      continue;
    }
    if (p.kind === "PERSON" && !(await db.user.findFirst({ where: { id: String(parsed.value), active: true }, select: { id: true } }))) return { ok: false, error: `${p.name}: pick somebody from the list.` };
    cells.push({ propertyId: p.id, value: parsed.value as Prisma.InputJsonValue });
  }
  if ((await db.workbookRow.count({ where: { workbookId: form.workbookId } })) >= OWN_ROWS.perList) return { ok: false, error: "This list is full — tell whoever keeps it." };
  const last = await db.workbookRow.aggregate({ where: { workbookId: form.workbookId }, _max: { sortOrder: true } });
  const row = await db.$transaction(async (tx) => {
    const made = await tx.workbookRow.create({
      data: { workbookId: form.workbookId, title, sortOrder: (last._max.sortOrder ?? 0) + 10, createdByUserId: input.userId, updatedByUserId: input.userId },
      select: { id: true, title: true },
    });
    if (cells.length) await tx.workbookRowValue.createMany({ data: cells.map((c) => ({ workbookId: form.workbookId, rowId: made.id, propertyId: c.propertyId, value: c.value, updatedByUserId: input.userId })) });
    await emitRowsAdded(tx, [{ workbookId: form.workbookId, listName: form.workbook.name, own: true, rowKey: made.id, title: made.title }], "form", input.userId);
    return made;
  });
  await recordChanges([{ workbookId: form.workbookId, rowKey: row.id, kind: "ADDED", after: `the form "${form.name}"`, byUserId: input.userId }]);
  await recordAudit({ userId: input.userId, action: "CREATE", entityType: "Workbook", entityId: form.workbookId, entityLabel: `${form.workbook.name}: a row from the form "${form.name}"` });
  return { ok: true, rowId: row.id };
}
