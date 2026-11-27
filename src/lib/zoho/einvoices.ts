import { db } from "@/lib/db";
import { zohoGet, type ZohoReply } from "@/lib/zoho/client";
import { einvoiceOf, type ZohoEInvoice } from "@/lib/zoho/rows";

/**
 * Invoices brought across from Zoho without their e-invoice (owner, 21 Nov 2026: "after 29 oct invoices not showing
 * irn"). Those up to the backup came from its files, which carry the IRN; those after came through the API pull, which
 * read the e-invoice under names guessed from Zoho's OpenAPI files — never seen in a real reply (memory: zoho pull,
 * "IRN and e-way fields from the API are guesses"). The pull now reads every name Zoho is known to use
 * (`einvoiceOf`, src/lib/zoho/rows.ts); this asks Zoho again for the invoices already in, without one.
 *
 *   · Only invoices brought across (origin IMPORTED), with no IRN yet, not drafts or cancelled.
 *   · Found in Zoho by their number; then the invoice's own e-invoice read (GET /invoices/{id}/einvoice), and if that
 *     says nothing, the invoice itself.
 *   · Each invoice is asked once (a MigrationRecord "irn-asked"), so the ones Zoho never e-invoiced — exports, B2C,
 *     below the threshold — aren't asked again on every press.
 *   · A reply with no IRN in it says which fields it did have, by name only — so the first run against real Zoho tells
 *     us the names if they differ again. No value of it is kept or shown.
 *   · Zoho's own calls only, at its pace (zohoGet waits between calls); a run stops at its time budget and carries on
 *     from where it was when pressed again.
 */

type J = Record<string, unknown>;
const ASKED = "irn-asked";
const IRN = /^[0-9a-f]{64}$/i;

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
/** Field names that look like the e-invoice's, for the message when a reply had none we read. Names only. */
function einvoiceKeys(d: J | undefined): string[] {
  const inner = (d?.einvoice_details ?? d?.e_invoice_details ?? d?.einvoice) as J | undefined;
  const top = Object.keys(d ?? {}).filter((k) => /einvoice|e_invoice|irn|ack|qr|inv_ref/i.test(k));
  return [...top, ...Object.keys(inner && typeof inner === "object" ? inner : {}).map((k) => `einvoice.${k}`)].slice(0, 20);
}

const missingWhere = { origin: "IMPORTED" as const, docType: "INVOICE" as const, irn: null, status: { notIn: ["DRAFT" as const, "CANCELLED" as const] } };

async function latestMigrationId(): Promise<string | null> {
  return (await db.migration.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } }))?.id ?? null;
}

/** How many invoices brought across have no IRN and haven't been asked about yet. */
export async function irnsToAsk(): Promise<number> {
  const migrationId = await latestMigrationId();
  if (!migrationId) return 0;
  const asked = await db.migrationRecord.findMany({ where: { migrationId, kind: ASKED }, select: { recordId: true } });
  return db.tradeDocument.count({ where: { ...missingWhere, id: { notIn: asked.map((a) => a.recordId) } } });
}

export type IrnFill = { filled: number; notEInvoiced: number; notFound: number; left: number; fieldsSeen: string[] };

/** Asks Zoho for the e-invoice of each invoice brought across without one, newest first, until the budget runs out. */
export async function fillIrnsFromZoho(input: { budgetMs: number; userId: string }): Promise<IrnFill> {
  const migrationId = await latestMigrationId();
  const out: IrnFill = { filled: 0, notEInvoiced: 0, notFound: 0, left: 0, fieldsSeen: [] };
  if (!migrationId) return out;
  const started = Date.now();
  const asked = new Set((await db.migrationRecord.findMany({ where: { migrationId, kind: ASKED }, select: { recordId: true } })).map((a) => a.recordId));
  const todo = (await db.tradeDocument.findMany({ where: missingWhere, orderBy: [{ issueDate: "desc" }, { docNumber: "desc" }], select: { id: true, docNumber: true } })).filter((d) => !asked.has(d.id));
  const seen = new Set<string>();
  let i = 0;
  for (; i < todo.length; i++) {
    if (Date.now() - started > input.budgetMs) break;
    const doc = todo[i]!;
    const list = ((await zohoGet("/invoices", { invoice_number: doc.docNumber })) as ZohoReply).invoices as J[] | undefined;
    const hit = (list ?? []).find((r) => s(r.invoice_number) === doc.docNumber);
    let info: ZohoEInvoice | null = null;
    if (hit) {
      const id = s(hit.invoice_id);
      const own = (await zohoGet(`/invoices/${id}/einvoice`).catch(() => null)) as ZohoReply | null;
      // The e-invoice's own reply: under "einvoice" or "einvoice_details", or its fields at the top.
      info = einvoiceOf(own ? ({ einvoice_details: own.einvoice ?? own.einvoice_details ?? own } as J) : undefined);
      if (!IRN.test(info.irn)) {
        const full = ((await zohoGet(`/invoices/${id}`)) as ZohoReply).invoice as J | undefined;
        const again = einvoiceOf(full);
        if (IRN.test(again.irn)) info = again;
        else for (const k of [...einvoiceKeys(own ?? undefined), ...einvoiceKeys(full)]) seen.add(k);
      }
    }
    if (!hit) out.notFound += 1;
    else if (info && IRN.test(info.irn) && !/cancel/i.test(info.status)) {
      const ackDate = info.ackDate ? new Date(info.ackDate.length <= 10 ? `${info.ackDate}T00:00:00+05:30` : info.ackDate.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(info.ackDate) ? "" : "+05:30")) : null;
      try {
        await db.tradeDocument.update({
          where: { id: doc.id },
          data: { irn: info.irn.toLowerCase(), ackNo: info.ackNo || null, ackDate: ackDate && !Number.isNaN(ackDate.getTime()) ? ackDate : null, signedQrCode: info.qr || null, einvoiceStatus: "GENERATED" },
        });
        out.filled += 1;
      } catch {
        out.notEInvoiced += 1; // the same IRN already on another document — left as it is
      }
    } else out.notEInvoiced += 1;
    await db.migrationRecord.create({ data: { migrationId, kind: ASKED, recordId: doc.id, key: `${ASKED}:${doc.id}` } });
  }
  out.left = todo.length - i;
  out.fieldsSeen = [...seen];
  return out;
}
