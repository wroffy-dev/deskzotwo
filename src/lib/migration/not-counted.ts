import { db } from "@/lib/db";
import { zohoGet, type ZohoReply } from "@/lib/zoho/client";
import { leftBehind, refreshSettledStatus } from "@/lib/migration/documents";
import { takeBack, MigrationRefused, type MigrationRow } from "@/lib/migration/state";

/**
 * This year's invoices and credit notes brought across though Zoho doesn't count them (owner, 17 Nov 2026 — "why
 * different in numbers of zoho and deskzo?"): rejected, waiting for approval, approved but not sent, void or a draft
 * there. Before 17 Nov the import left only void and drafts behind, so a rejected invoice in April and a rejected
 * credit note in July came across as a sale and a return, and November's invoices awaiting approval as sales.
 *
 * Zoho is asked for the year's documents (a call a page, 200 to a page) — never the page's own list — and those this
 * migration brought across whose status there is one that stays behind are listed, then taken back on a press with
 * their ledger entries, as Undo takes them back. An invoice something is set against — a payment, a credit note kept,
 * another document made from it — is held for a person.
 */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const PAGES = 40;

export type NotCountedRow = { kind: "INVOICE" | "CREDIT_NOTE"; number: string; party: string; date: string; total: number; zohoStatus: string; why: string; held: string | null };
export type NotCounted = { rows: NotCountedRow[]; toTakeBack: number; total: number; held: number };
type Found = NotCountedRow & { documentId: string; recordIds: string[] };

/** Every invoice or credit note number Zoho has in the window whose status stays behind, with that status. */
async function zohoLeftBehind(m: MigrationRow): Promise<Map<string, string>> {
  const to = new Date(`${m.switchDate}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() - 1);
  const window = { date_start: m.yearStart, date_end: to.toISOString().slice(0, 10) };
  const out = new Map<string, string>();
  for (const [path, list, field, kind] of [
    ["/invoices", "invoices", "invoice_number", "INVOICE"],
    ["/creditnotes", "creditnotes", "creditnote_number", "CREDIT_NOTE"],
  ] as const) {
    for (let page = 1; page <= PAGES; page++) {
      const reply = (await zohoGet(path, { ...window, page, per_page: 200 })) as ZohoReply;
      if (typeof reply.code === "number" && reply.code !== 0) throw new MigrationRefused(`Zoho didn't answer: ${reply.message ?? "unknown"}`);
      for (const r of (reply[list] as Record<string, unknown>[] | undefined) ?? []) {
        const number = String(r[field] ?? "").trim();
        const status = String(r.status ?? "");
        if (number && leftBehind(status)) out.set(`${kind}:${number}`, status);
      }
      if (!reply.page_context?.has_more_page) break;
    }
  }
  return out;
}

async function find(m: MigrationRow): Promise<Found[]> {
  const behind = await zohoLeftBehind(m);
  if (behind.size === 0) return [];
  const records = await db.migrationRecord.findMany({ where: { migrationId: m.id, kind: { in: ["document", "journal"] }, key: { in: [...behind.keys()].flatMap((k) => [k, `${k}:entry`]) } }, select: { id: true, kind: true, key: true, recordId: true } });
  const docRecords = records.filter((r) => r.kind === "document");
  if (docRecords.length === 0) return [];
  const ids = docRecords.map((r) => r.recordId);
  const [docs, paid, creditedBy, children] = await Promise.all([
    db.tradeDocument.findMany({ where: { id: { in: ids } }, select: { id: true, docType: true, docNumber: true, issueDate: true, total: true, exchangeRate: true, company: { select: { name: true } } } }),
    db.paymentAllocation.findMany({ where: { documentId: { in: ids } }, select: { documentId: true } }),
    db.creditNoteApplication.findMany({ where: { invoiceId: { in: ids } }, select: { invoiceId: true, creditNoteId: true } }),
    db.tradeDocument.findMany({ where: { OR: [{ sourceDocumentId: { in: ids } }, { againstDocumentId: { in: ids } }] }, select: { id: true, sourceDocumentId: true, againstDocumentId: true } }),
  ]);
  const going = new Set(ids);
  const found: Found[] = [];
  for (const d of docs) {
    const rec = docRecords.find((r) => r.recordId === d.id)!;
    const key = rec.key;
    // A credit note kept, or another document made from it, that isn't going too, holds an invoice back.
    const keptCredit = creditedBy.some((c) => c.invoiceId === d.id && !going.has(c.creditNoteId));
    const keptChild = children.some((c) => (c.sourceDocumentId === d.id || c.againstDocumentId === d.id) && !going.has(c.id));
    const held = paid.some((p) => p.documentId === d.id) ? "A payment is set against it" : keptCredit ? "A credit note is set against it" : keptChild ? "Another document was made from it" : null;
    const zohoStatus = behind.get(key) ?? "";
    found.push({
      documentId: d.id,
      recordIds: [rec.id, ...records.filter((r) => r.kind === "journal" && r.key === `${key}:entry`).map((r) => r.id)],
      kind: d.docType === "CREDIT_NOTE" ? "CREDIT_NOTE" : "INVOICE",
      number: d.docNumber ?? "",
      party: d.company?.name ?? "",
      date: d.issueDate.toISOString().slice(0, 10),
      total: round2(Number(d.total) * (Number(d.exchangeRate) || 1)),
      zohoStatus: zohoStatus.replace(/_/g, " "),
      why: leftBehind(zohoStatus) ?? "",
      held,
    });
  }
  return found.sort((a, b) => a.date.localeCompare(b.date));
}

/** The list a person checks before anything goes. Asks Zoho; changes nothing. */
export async function notCounted(m: MigrationRow): Promise<NotCounted> {
  const found = await find(m);
  const free = found.filter((f) => !f.held);
  return {
    rows: found.map((f) => ({ kind: f.kind, number: f.number, party: f.party, date: f.date, total: f.total, zohoStatus: f.zohoStatus, why: f.why, held: f.held })),
    toTakeBack: free.length,
    total: round2(free.reduce((n, f) => n + (f.kind === "CREDIT_NOTE" ? -f.total : f.total), 0)),
    held: found.length - free.length,
  };
}

/** Takes the free ones back with their entries, as Undo would — found again here, never from what the page sent. */
export async function takeBackNotCounted(m: MigrationRow): Promise<{ takenBack: number; total: number }> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const free = (await find(m)).filter((f) => !f.held);
  if (free.length === 0) return { takenBack: 0, total: 0 };
  // The invoices a going credit note was set against: what they owe changes, so their paid state is worked out again.
  const touched = (await db.creditNoteApplication.findMany({ where: { creditNoteId: { in: free.filter((f) => f.kind === "CREDIT_NOTE").map((f) => f.documentId) } }, select: { invoiceId: true } })).map((a) => a.invoiceId);
  const taken = await takeBack(m.id, new Set(free.flatMap((f) => f.recordIds)));
  const staying = [...new Set(touched)].filter((id) => !free.some((f) => f.documentId === id));
  for (const id of staying) await db.$transaction((tx) => refreshSettledStatus(tx, id));
  return { takenBack: taken.documents, total: round2(free.reduce((n, f) => n + (f.kind === "CREDIT_NOTE" ? -f.total : f.total), 0)) };
}
