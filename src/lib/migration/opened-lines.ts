import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { computeDocument, type LineInput } from "@/lib/gst-engine";
import { zohoGet, ZohoBusy, type ZohoReply } from "@/lib/zoho/client";
import type { MigrationRow } from "./state";

/**
 * The earlier years' invoices and bills opened as owing (./opened.ts) carry one line, "Brought forward", because the
 * pull reads an earlier year's document from Zoho's list, which has no lines (owner, 21 Nov 2026: "why it can't show
 * real product name and description" — WT/25-26/3472, AutoCAD LT ×4, shown as "Brought forward"). This puts each
 * one's own lines on it:
 *
 *   · From the archive when Zoho's backup brought them; otherwise from Zoho, one call a document (GET /invoices/{id},
 *     /bills/{id}), and kept in the archive too, so the archive shows them and nothing is asked twice.
 *   · At their own pre-tax amounts — item, description, HSN, quantity, rate, discount — with no tax on them. GST,
 *     shipping and rounding as billed go on one line of their own, "Tax and charges as billed in Zoho". The total is
 *     what it was to the paisa, so its opening entry and what is owed stay as they are, and last year's GST is never
 *     counted in Deskzo's returns.
 *   · Only a document still on its one "Brought forward" line: one changed by hand since is left alone. One whose
 *     lines come to more than its total is left with why. Either is asked once (a MigrationRecord "lines-asked").
 *   · At Zoho's pace (zohoGet waits between calls), until the time budget; pressed again, it carries on.
 */

type J = Record<string, unknown>;
/** As the archive keeps a line (./archive.ts), with its HSN and unit when Zoho gave them. */
type ArchivedLine = { item: string | null; description: string | null; quantity: number; rate: number; discount: number; tax: number; amount: number; hsn?: string | null; unit?: string | null };
const ASKED = "lines-asked";
const BROUGHT_FORWARD = "Brought forward";
export const CHARGES_LINE = "Tax and charges as billed in Zoho";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const n = (v: unknown) => {
  const x = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(x) ? x : 0;
};
const money = (amount: number) => amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The opened documents still on their one "Brought forward" line, not asked about yet — newest first. */
async function waiting(migrationId: string) {
  const [opened, asked] = await Promise.all([
    db.migrationRecord.findMany({ where: { migrationId, kind: "document", key: { startsWith: "OPENED:" } }, select: { recordId: true } }),
    db.migrationRecord.findMany({ where: { migrationId, kind: ASKED }, select: { recordId: true } }),
  ]);
  const skip = new Set(asked.map((a) => a.recordId));
  const ids = opened.map((o) => o.recordId).filter((id) => !skip.has(id));
  const docs: { id: string; docType: string; docNumber: string | null; companyId: string; total: Prisma.Decimal; company: { name: string } | null; lines: { name: string }[] }[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    docs.push(
      ...(await db.tradeDocument.findMany({
        where: { id: { in: ids.slice(i, i + 1000) }, docType: { in: ["INVOICE", "BILL"] } },
        orderBy: [{ issueDate: "desc" }, { docNumber: "desc" }],
        select: { id: true, docType: true, docNumber: true, companyId: true, total: true, company: { select: { name: true } }, lines: { select: { name: true } } },
      })),
    );
  }
  return docs.filter((d) => d.lines.length === 1 && d.lines[0]!.name === BROUGHT_FORWARD);
}

/** How many opened invoices and bills are still on their "Brought forward" line. */
export async function openedWithoutLines(m: MigrationRow): Promise<number> {
  return (await waiting(m.id)).length;
}

/** Zoho's own document, as the archive keeps lines, with what its tax and charges were. */
async function fromZoho(kind: "INVOICE" | "BILL", zohoId: string): Promise<{ lines: ArchivedLine[]; charges: string }> {
  const reply = (await zohoGet(`/${kind === "INVOICE" ? "invoices" : "bills"}/${zohoId}`)) as ZohoReply;
  const d = (reply[kind === "INVOICE" ? "invoice" : "bill"] ?? {}) as J;
  const lines = ((d.line_items as J[] | undefined) ?? []).map((l) => {
    const quantity = n(l.quantity) || 1;
    const rate = n(l.rate);
    const amount = round2(n(l.item_total ?? l.amount));
    return {
      item: s(l.name ?? l.item_name) || null,
      description: s(l.description) || null,
      quantity,
      rate,
      discount: Math.max(0, round2(quantity * rate - amount)),
      tax: n(l.tax_percentage),
      amount,
      hsn: s(l.hsn_or_sac) || null,
      unit: s(l.unit) || null,
    };
  });
  const parts = ((d.taxes as J[] | undefined) ?? []).filter((t) => n(t.tax_amount)).map((t) => `${s(t.tax_name) || "Tax"} ${money(n(t.tax_amount))}`);
  if (n(d.shipping_charge)) parts.push(`Shipping ${money(n(d.shipping_charge))}`);
  if (n(d.adjustment)) parts.push(`${s(d.adjustment_description) || "Adjustment"} ${money(n(d.adjustment))}`);
  return { lines, charges: parts.join(" · ") };
}

export type OpenedLines = { brought: number; left: { number: string; party: string; why: string }[]; remaining: number; stopped: string | null };

/** Brings the real lines onto the opened documents, newest first, until the budget runs out. */
export async function bringOpenedLines(m: MigrationRow, input: { budgetMs: number; zoho: boolean }): Promise<OpenedLines> {
  const out: OpenedLines = { brought: 0, left: [], remaining: 0, stopped: null };
  const started = Date.now();
  const todo = await waiting(m.id);
  for (const doc of todo) {
    if (Date.now() - started > input.budgetMs) break;
    const kind = doc.docType as "INVOICE" | "BILL";
    const number = doc.docNumber ?? "";
    const leave = async (why: string) => {
      out.left.push({ number, party: doc.company?.name ?? "", why });
      await db.migrationRecord.create({ data: { migrationId: m.id, kind: ASKED, recordId: doc.id, key: `${ASKED}:${doc.id}` } });
    };
    const archived = await db.archivedDocument.findFirst({
      where: { migrationId: m.id, kind, number, ...(kind === "BILL" ? { companyId: doc.companyId } : {}) },
      select: { id: true, oldId: true, lines: true },
    });
    let lines = (Array.isArray(archived?.lines) ? archived.lines : []) as ArchivedLine[];
    let charges = "";
    if (lines.length === 0) {
      if (!archived?.oldId) {
        await leave("Zoho's id for it isn't kept in the archive, so Deskzo can't ask for it");
        continue;
      }
      // Without a connection, the ones the archive has lines for are all it can do: the rest wait for one.
      if (!input.zoho) {
        out.stopped = "The rest need Zoho: connect Deskzo to your Zoho Books organisation, then press it again.";
        continue;
      }
      try {
        const got = await fromZoho(kind, archived.oldId);
        lines = got.lines;
        charges = got.charges;
      } catch (err) {
        if (err instanceof ZohoBusy) {
          out.stopped = err.daily ? "Zoho's calls for today are used up — press it again after midnight." : "Zoho asked Deskzo to slow down — press it again in a minute.";
          break;
        }
        await leave(`Zoho didn't give it: ${err instanceof Error ? err.message.slice(0, 120) : "no answer"}`);
        continue;
      }
      if (lines.length) await db.archivedDocument.update({ where: { id: archived.id }, data: { lines: lines as Prisma.InputJsonValue } });
    }
    if (lines.length === 0) {
      await leave("Zoho has no lines for it");
      continue;
    }
    const total = round2(Number(doc.total));
    const inputs: (LineInput & { name: string; description: string | null; hsnCode: string | null; unit: string | null })[] = lines.map((l) => {
      const quantity = Math.round(l.quantity * 1000) / 1000 || 1;
      const rate = round2(l.rate);
      const gross = round2(quantity * rate);
      // A backup's line without its "Item Total": its rate times its quantity, less its discount.
      const amount = round2(l.amount) || Math.max(0, round2(gross - (l.discount || 0)));
      // Priced so its taxable value is what the old system's line was: its own rate, less its discount.
      const unitPrice = amount > gross + 0.005 ? round2(amount / quantity) : rate;
      const off = round2(round2(quantity * unitPrice) - amount);
      return {
        name: (l.item ?? "").slice(0, 300) || (l.description ?? "").split("\n")[0]!.slice(0, 300) || "Item",
        description: l.description ? l.description.slice(0, 4000) : null,
        hsnCode: l.hsn ? l.hsn.slice(0, 20) : null,
        unit: l.unit ? l.unit.slice(0, 30) : null,
        quantity,
        unitPrice,
        ...(off > 0.005 ? { discountMode: "AMOUNT" as const, discountValue: off } : {}),
        taxRatePercent: 0,
      };
    });
    const before = computeDocument(inputs, "INTRA_STATE", { roundOff: false });
    const rest = round2(total - before.total);
    if (rest < -0.005) {
      await leave(`Its lines come to ${money(before.total)}, more than its total of ${money(total)}`);
      continue;
    }
    if (rest > 0.005) {
      const rates = [...new Set(lines.map((l) => l.tax).filter((t) => t > 0))].map((t) => `${t}%`);
      inputs.push({
        name: CHARGES_LINE,
        description: charges || (rates.length ? `GST at ${rates.join(", ")} and any shipping or rounding, as on the original` : "Tax, shipping and rounding, as on the original"),
        hsnCode: null,
        unit: null,
        quantity: 1,
        unitPrice: rest,
        taxRatePercent: 0,
      });
    }
    const computed = computeDocument(inputs, "INTRA_STATE", { roundOff: false });
    if (Math.abs(computed.total - total) > 0.005) {
      await leave(`Its lines come to ${money(computed.total)}, not its total of ${money(total)}`);
      continue;
    }
    await db.$transaction(async (tx) => {
      // Still on its one line: not changed since it was read.
      const now = await tx.tradeDocumentLine.findMany({ where: { documentId: doc.id }, select: { name: true } });
      if (now.length !== 1 || now[0]!.name !== BROUGHT_FORWARD) return;
      await tx.tradeDocumentLine.deleteMany({ where: { documentId: doc.id } });
      await tx.tradeDocumentLine.createMany({
        data: inputs.map((l, sortOrder) => {
          const c = computed.lines[sortOrder]!;
          return {
            documentId: doc.id,
            name: l.name,
            description: l.description,
            hsnCode: l.hsnCode,
            unit: l.unit,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discountMode: l.discountMode ?? "PERCENT",
            discountValue: l.discountValue ?? 0,
            discountAmount: c.discountAmount,
            taxRatePercent: 0,
            taxableValue: c.taxableValue,
            cgstAmount: 0,
            sgstAmount: 0,
            igstAmount: 0,
            lineTotal: c.lineTotal,
            sortOrder,
          };
        }),
      });
      await tx.tradeDocument.update({
        where: { id: doc.id },
        data: { subtotal: computed.subtotal, discountTotal: computed.discountTotal, taxableValue: computed.taxableValue, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, shippingCharge: 0, adjustment: 0, roundOff: 0 },
      });
    });
    out.brought += 1;
  }
  out.remaining = (await waiting(m.id)).length;
  return out;
}
