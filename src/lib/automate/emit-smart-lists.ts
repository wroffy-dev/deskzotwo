import type { Prisma } from "@prisma/client";
import { emitEvents } from "@/lib/automate/events";
import { isLinkKind, optionsOf, valueText, type PropertyKind } from "@/lib/smart-lists/values";

/**
 * Smart Lists in Deskzo Automate (owner, 20 Nov 2026 — Smart Lists phase 3: "a row is added", "Status changes to…" —
 * "when a snag is marked Fixed, a Verify task goes to the site lead"). Recorded in the save's own transaction, behind
 * emitEvents' savepoint, so an event can never fail the save.
 *
 * The record is "smart-list-row" `<listId>:<rowKey>`; a workflow wakes only for an owner who may open the list — and,
 * in a list of companies, see the company (src/lib/automate/trigger-reach.ts). A value is handed on in words, as the
 * list shows it — a choice by its name, a person by theirs — so a condition reads `trigger.to = "Fixed"`.
 */

export type SmartListFacts = { workbookId: string; listName: string; own: boolean; rowKey: string; title: string };

const listPart = (f: SmartListFacts) => ({ id: f.workbookId, name: f.listName, kind: f.own ? "ROWS" : "COMPANIES" });
const rowPart = (f: SmartListFacts) => ({ id: f.rowKey, title: f.title });

/** A row added — by hand, from a spreadsheet, or from a form. */
export async function emitRowsAdded(tx: Prisma.TransactionClient, facts: SmartListFacts[], via: "hand" | "import" | "form" | "repeat", actorUserId: string | null): Promise<void> {
  if (!facts.length) return;
  await emitEvents(tx, "smartlist.row_added", async () =>
    facts.slice(0, 200).map((f) => ({
      type: "smartlist.row_added",
      recordType: "smart-list-row",
      recordId: `${f.workbookId}:${f.rowKey}`,
      payload: { list: listPart(f), row: rowPart(f), addedVia: via, addedBy: actorUserId },
      actorUserId,
    })),
  );
}

/** One column's value changed on some rows, from what each had to what it has now. */
export async function emitValuesChanged(
  tx: Prisma.TransactionClient,
  input: { rows: (SmartListFacts & { before: unknown })[]; column: { id: string; name: string; kind: PropertyKind; options: unknown }; after: unknown; actorUserId: string | null },
): Promise<void> {
  const changed = input.rows.filter((r) => JSON.stringify(r.before ?? null) !== JSON.stringify(input.after ?? null));
  if (!changed.length) return;
  await emitEvents(tx, "smartlist.value_changed", async () => {
    const { column } = input;
    const people = column.kind === "PERSON" ? [...new Set([input.after, ...changed.map((r) => r.before)].filter((x): x is string => typeof x === "string"))] : [];
    const names = new Map(people.length ? (await tx.user.findMany({ where: { id: { in: people } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]) : []);
    const words = (v: unknown) => {
      if (v === null || v === undefined) return "";
      if (isLinkKind(column.kind) || column.kind === "FILE") return Array.isArray(v) ? String(v.length) : "";
      return valueText(column.kind, v, optionsOf(column.options), names);
    };
    return changed.slice(0, 500).map((r) => ({
      type: "smartlist.value_changed",
      recordType: "smart-list-row",
      recordId: `${r.workbookId}:${r.rowKey}`,
      payload: { list: listPart(r), row: rowPart(r), column: { id: column.id, name: column.name, kind: column.kind }, from: words(r.before), to: words(input.after), changedBy: input.actorUserId },
      actorUserId: input.actorUserId,
    }));
  });
}
