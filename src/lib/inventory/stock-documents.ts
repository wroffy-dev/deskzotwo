import type { Prisma, StockDocumentType } from "@prisma/client";
import { fromMilli, toMilli } from "@/lib/accounts/money";
import type { AccountsSettings } from "@/lib/accounts/settings";
import type { db } from "@/lib/db";
import { lockStockPairs, moveStock, reverseMovement, StockError, type MovementWritten } from "@/lib/inventory/engine";
import { pair, postInventoryEntry, reverseInventoryEntry, type InventoryLine } from "@/lib/inventory/posting";

type Tx = Prisma.TransactionClient;

/**
 * Posting inventory's own vouchers (owner, 22 Oct 2026). Each runs inside one transaction with its stock
 * movements and — under perpetual inventory — its journal entry, keyed by the voucher and its lines so posting
 * twice moves nothing more.
 *
 *   · **Goods receipt (GRN)** — the accepted quantity in, at its price; Dr Stock in Hand, Cr Goods Received Not
 *     Invoiced (or Purchases, where the bill came first).
 *   · **Transfer** — out of one warehouse when dispatched, into the other when received, at the same cost;
 *     in transit between the two. No entry: the stock is still the company's.
 *   · **Adjustment** — each line's signed quantity, with its reason; Dr/Cr Stock Adjustments.
 *   · **Physical count** — the difference between what was counted and what the books say when it posts.
 *   · **Purchase return** — out, back to the vendor; Dr Purchases, Cr Stock in Hand.
 *
 * Cancelling a posted one reverses its movements and its entry; a draft is simply cancelled.
 */

export const stockDocumentLabels: Record<StockDocumentType, string> = {
  GRN: "Goods receipt",
  TRANSFER: "Stock transfer",
  ADJUSTMENT: "Stock adjustment",
  PHYSICAL_COUNT: "Physical stock count",
  PURCHASE_RETURN: "Purchase return",
};

/**
 * The documents that wait for a second person when Accounts settings ask for one.
 *
 * Security audit round three, 14 Nov 2026 (R3-16): a purchase return takes stock out as surely as a write-off, and
 * posted straight away — so it waits for approval too.
 */
export function needsApproval(type: StockDocumentType, settings: Pick<AccountsSettings, "adjustmentApprovalRequired">) {
  return settings.adjustmentApprovalRequired && (type === "ADJUSTMENT" || type === "PHYSICAL_COUNT" || type === "PURCHASE_RETURN");
}

/** A goods receipt's line as checked against its purchase order. */
export type ReceiptLineCheck = { poLineId: string | null; itemId: string; quantity: number; unitCost: number | null };

/**
 * Security audit round three, 14 Nov 2026 (R3-16): a goods receipt against a purchase order took any line, any
 * quantity and any price — stock and its value (and, under perpetual inventory, Goods Received Not Invoiced) for
 * goods never ordered. Every line must be one of that order's lines, for its item; what has been accepted on posted
 * receipts, with this one, stays within what was ordered (exactly — there is no over-receipt tolerance setting);
 * and a cost left empty is the order's price, while a different one needs `mayChangeCost` ("Adjust stock").
 *
 * Returns the refusal, or the lines with their costs filled in. Run when the draft is saved and again, under a lock
 * on the order, when it posts — two receipts posted at once can't both take the last of an order.
 */
export async function checkReceiptAgainstOrder(
  tx: Tx | typeof db,
  input: { purchaseOrderId: string; excludeDocumentId?: string | null; lines: ReceiptLineCheck[]; mayChangeCost: boolean; costsChecked?: boolean },
): Promise<{ error: string } | { lines: ReceiptLineCheck[] }> {
  const po = await tx.tradeDocument.findUnique({
    where: { id: input.purchaseOrderId },
    select: { docType: true, lines: { select: { id: true, itemId: true, name: true, quantity: true, taxableValue: true } } },
  });
  if (!po || po.docType !== "PURCHASE_ORDER") return { error: "That isn't a purchase order." };
  const earlier = await tx.stockDocumentLine.groupBy({
    by: ["poLineId"],
    where: {
      stockDocument: { purchaseOrderId: input.purchaseOrderId, type: "GRN", status: "POSTED", ...(input.excludeDocumentId ? { id: { not: input.excludeDocumentId } } : {}) },
      poLineId: { not: null },
    },
    _sum: { quantity: true },
  });
  const taking = new Map<string, number>();
  const out: ReceiptLineCheck[] = [];
  for (const [i, l] of input.lines.entries()) {
    const n = `Line ${i + 1}`;
    const poLine = l.poLineId ? po.lines.find((p) => p.id === l.poLineId) : undefined;
    if (!poLine) return { error: `${n}: a receipt against a purchase order takes only that order's lines.` };
    if (poLine.itemId !== l.itemId) return { error: `${n}: that isn't the item ordered on this line (${poLine.name}).` };
    taking.set(poLine.id, (taking.get(poLine.id) ?? 0) + l.quantity);
    const ordered = Number(poLine.quantity);
    const price = Math.round((Number(poLine.taxableValue) / (ordered || 1)) * 10000) / 10000;
    let unitCost = l.unitCost;
    if (unitCost == null) unitCost = price;
    else if (!input.costsChecked && Math.abs(unitCost - price) > 0.005 && !input.mayChangeCost) {
      return { error: `${n}: the order's price is ${price} — a different cost needs “Adjust stock”.` };
    }
    out.push({ ...l, unitCost });
  }
  for (const [poLineId, qty] of taking) {
    const poLine = po.lines.find((p) => p.id === poLineId)!;
    const ordered = Number(poLine.quantity);
    const before = Number(earlier.find((e) => e.poLineId === poLineId)?._sum.quantity ?? 0);
    if (toMilli(before + qty) > toMilli(ordered)) {
      const left = Math.max(0, fromMilli(toMilli(ordered) - toMilli(before)));
      return { error: `${poLine.name}: ${ordered} ordered and ${before} received already — at most ${left} more can be accepted against this order.` };
    }
  }
  return { lines: out };
}

async function load(tx: Tx, id: string) {
  return tx.stockDocument.findUnique({
    where: { id },
    select: {
      id: true, type: true, number: true, date: true, status: true, warehouseId: true, toWarehouseId: true,
      companyId: true, billId: true, reason: true, purchaseOrderId: true,
      warehouse: { select: { branchId: true } },
      lines: {
        orderBy: { sortOrder: "asc" },
        select: {
          id: true, itemId: true, quantity: true, unitCost: true, batchId: true, batchNo: true, mfgDate: true, expiryDate: true,
          serialNumbers: true, countedQty: true, receivedQty: true, rejectedQty: true, poLineId: true,
          item: { select: { name: true, trackBatches: true } },
        },
      },
    },
  });
}

type Doc = NonNullable<Awaited<ReturnType<typeof load>>>;

const batchOf = (line: Doc["lines"][number]) =>
  line.batchNo ? { batchNo: line.batchNo, mfgDate: line.mfgDate, expiryDate: line.expiryDate } : null;

/** Posts a draft (or approved) voucher — everything but a transfer's arrival. Returns the movements written. */
export async function postStockDocument(tx: Tx, id: string, userId: string, settings: AccountsSettings): Promise<MovementWritten[]> {
  const doc = await load(tx, id);
  if (!doc) throw new StockError("That stock voucher no longer exists.");
  if (doc.lines.length === 0) throw new StockError("Add at least one line before posting.");
  if (doc.status !== "DRAFT" && doc.status !== "PENDING_APPROVAL") throw new StockError(`It is already ${doc.status.toLowerCase().replace("_", " ")}.`);
  if (doc.status === "PENDING_APPROVAL" || (needsApproval(doc.type, settings) && doc.status === "DRAFT")) {
    // Approval moves it on itself (approveStockDocument); a draft that needs one is sent for it first.
    throw new StockError("This needs approving before it posts.");
  }
  return postApproved(tx, doc, userId, settings);
}

/** Posts a voucher whose approval, where it needed one, has been given. */
export async function postApprovedStockDocument(tx: Tx, id: string, userId: string, settings: AccountsSettings) {
  const doc = await load(tx, id);
  if (!doc) throw new StockError("That stock voucher no longer exists.");
  // Security audit, 11 Nov 2026 (SEC-13): only a voucher still waiting for approval. One sent back to
  // draft while the approver looked at it is being changed again, and posting it would approve edits
  // nobody has seen; the claim in postApproved is conditional on this same status.
  if (doc.status === "DRAFT") throw new StockError("It was sent back to draft — it has to be sent for approval again.");
  if (doc.status !== "PENDING_APPROVAL") throw new StockError(`It is already ${doc.status.toLowerCase().replace("_", " ")}.`);
  return postApproved(tx, doc, userId, settings);
}

async function postApproved(tx: Tx, doc: Doc, userId: string, settings: AccountsSettings): Promise<MovementWritten[]> {
  // The status first, conditionally: whoever posts it second finds it moved on and stops.
  const target = doc.type === "TRANSFER" ? "IN_TRANSIT" : "POSTED";
  const claimed = await tx.stockDocument.updateMany({
    where: { id: doc.id, status: doc.status },
    data: { status: target, postedById: userId, postedAt: new Date(), ...(doc.type === "TRANSFER" ? { dispatchedAt: new Date() } : {}) },
  });
  if (claimed.count === 0) throw new StockError("Somebody else has just posted this.");

  await lockStockPairs(tx, doc.lines.map((l) => ({ itemId: l.itemId, warehouseId: doc.warehouseId })));
  const written: MovementWritten[] = [];
  const base = { warehouseId: doc.warehouseId, stockDocumentId: doc.id, sourceId: doc.id, date: doc.date, userId, settings };

  if (doc.type === "GRN") {
    // R3-16: against a purchase order, checked again under the order's lock — two receipts posted at once can't
    // both take the last of it. Costs were checked (and filled in) when the draft was saved.
    if (doc.purchaseOrderId) {
      const key = `deskzo:grn:po:${doc.purchaseOrderId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const checked = await checkReceiptAgainstOrder(tx, {
        purchaseOrderId: doc.purchaseOrderId,
        excludeDocumentId: doc.id,
        lines: doc.lines.map((l) => ({ poLineId: l.poLineId, itemId: l.itemId, quantity: Number(l.quantity), unitCost: l.unitCost == null ? null : Number(l.unitCost) })),
        mayChangeCost: false,
        costsChecked: true,
      });
      if ("error" in checked) throw new StockError(checked.error);
    }
    for (const line of doc.lines) {
      const qty = Number(line.quantity);
      if (qty <= 0) continue;
      written.push(
        ...(await moveStock(tx, {
          ...base, itemId: line.itemId, quantity: qty, type: "RECEIVED", sourceType: "GRN", sourceLineId: line.id,
          reason: `Received on ${doc.number}`, idempotencyKey: `stockdoc:${doc.id}:line:${line.id}`,
          unitCost: line.unitCost == null ? null : Number(line.unitCost), batch: batchOf(line), serials: line.serialNumbers,
        })),
      );
    }
    const value = written.reduce((t, m) => t + m.valuePaise, 0);
    await perpetual(tx, doc, userId, settings, `Goods received on ${doc.number}`, pair("INVENTORY", doc.billId ? "PURCHASES" : "GRNI", value));
  } else if (doc.type === "TRANSFER") {
    if (!doc.toWarehouseId || doc.toWarehouseId === doc.warehouseId) throw new StockError("A transfer goes to a different warehouse.");
    for (const line of doc.lines) {
      written.push(
        ...(await moveStock(tx, {
          ...base, itemId: line.itemId, quantity: -Number(line.quantity), type: "TRANSFER_OUT", sourceType: "TRANSFER", sourceLineId: line.id,
          reason: `Sent on ${doc.number}`, idempotencyKey: `stockdoc:${doc.id}:out:${line.id}`,
          batchId: line.batchId, batch: line.batchId ? null : batchOf(line), serials: line.serialNumbers, serialOutStatus: "ISSUED",
        })),
      );
    }
  } else if (doc.type === "ADJUSTMENT" || doc.type === "PHYSICAL_COUNT") {
    let gains = 0;
    let losses = 0;
    for (const line of doc.lines) {
      let qty = Number(line.quantity);
      if (doc.type === "PHYSICAL_COUNT") {
        // What the books say now, at posting — not when the count sheet was written.
        const onHand = await tx.stockBalance.aggregate({
          where: { itemId: line.itemId, warehouseId: doc.warehouseId, ...(line.item.trackBatches ? { batchId: line.batchId ?? "__none__" } : {}) },
          _sum: { quantity: true },
        });
        const system = Number(onHand._sum.quantity ?? 0);
        qty = fromMilli(toMilli(Number(line.countedQty ?? 0)) - toMilli(system));
        await tx.stockDocumentLine.update({ where: { id: line.id }, data: { systemQty: system, quantity: qty } });
        if (qty === 0) continue;
      }
      if (qty === 0) continue;
      const moved = await moveStock(tx, {
        ...base, itemId: line.itemId, quantity: qty, type: qty < 0 && /damag|expir|broken|lost/i.test(doc.reason ?? "") ? "DAMAGED" : "ADJUSTMENT",
        sourceType: doc.type === "PHYSICAL_COUNT" ? "PHYSICAL_COUNT" : "ADJUSTMENT", sourceLineId: line.id,
        reason: doc.reason ?? stockDocumentLabels[doc.type], idempotencyKey: `stockdoc:${doc.id}:line:${line.id}`,
        unitCost: qty > 0 && line.unitCost != null ? Number(line.unitCost) : null,
        batchId: line.batchId, batch: line.batchId ? null : batchOf(line), serials: line.serialNumbers, serialOutStatus: "SCRAPPED",
      });
      written.push(...moved);
      for (const m of moved) {
        if (m.quantity > 0) gains += m.valuePaise;
        else losses += m.valuePaise;
      }
    }
    await perpetual(tx, doc, userId, settings, `${stockDocumentLabels[doc.type]} ${doc.number}`, [
      ...pair("INVENTORY", "STOCK_ADJUSTMENT", gains),
      ...pair("STOCK_ADJUSTMENT", "INVENTORY", losses),
    ]);
  } else if (doc.type === "PURCHASE_RETURN") {
    for (const line of doc.lines) {
      written.push(
        ...(await moveStock(tx, {
          ...base, itemId: line.itemId, quantity: -Number(line.quantity), type: "PURCHASE_RETURN", sourceType: "PURCHASE_RETURN", sourceLineId: line.id,
          reason: doc.reason ?? `Returned on ${doc.number}`, idempotencyKey: `stockdoc:${doc.id}:line:${line.id}`,
          batchId: line.batchId, batch: line.batchId ? null : batchOf(line), serials: line.serialNumbers, serialOutStatus: "RETURNED_TO_VENDOR",
        })),
      );
    }
    const value = written.reduce((t, m) => t + m.valuePaise, 0);
    await perpetual(tx, doc, userId, settings, `Goods returned on ${doc.number}`, pair("PURCHASES", "INVENTORY", value));
  }
  return written;
}

async function perpetual(tx: Tx, doc: Doc, userId: string, settings: AccountsSettings, narration: string, lines: InventoryLine[]) {
  if (settings.inventoryAccounting !== "PERPETUAL") return;
  await postInventoryEntry(tx, {
    postingKey: `stockdoc:${doc.id}`,
    date: doc.date,
    narration,
    userId,
    lines,
    stockDocumentId: doc.id,
    companyId: doc.companyId,
    branchId: doc.warehouse.branchId,
  });
}

/** A transfer reaching its destination: in at what it cost when it left, batch for batch, serial for serial. */
export async function receiveTransfer(tx: Tx, id: string, userId: string, settings: AccountsSettings, date: Date): Promise<MovementWritten[]> {
  const doc = await load(tx, id);
  if (!doc || doc.type !== "TRANSFER") throw new StockError("That transfer no longer exists.");
  if (doc.status !== "IN_TRANSIT") throw new StockError(doc.status === "POSTED" ? "It has already been received." : "Send it before receiving it.");
  const claimed = await tx.stockDocument.updateMany({ where: { id, status: "IN_TRANSIT" }, data: { status: "POSTED", receivedAt: new Date() } });
  if (claimed.count === 0) throw new StockError("Somebody else has just received this.");
  const out = await tx.stockMovement.findMany({
    where: { stockDocumentId: id, type: "TRANSFER_OUT", reversesId: null, reversedBy: { is: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, itemId: true, quantityChange: true, value: true, batchId: true, serialNumbers: true, sourceLineId: true },
  });
  await lockStockPairs(tx, out.map((m) => ({ itemId: m.itemId, warehouseId: doc.toWarehouseId! })));
  const written: MovementWritten[] = [];
  for (const m of out) {
    written.push(
      ...(await moveStock(tx, {
        itemId: m.itemId, warehouseId: doc.toWarehouseId!, quantity: -Number(m.quantityChange), type: "TRANSFER_IN", sourceType: "TRANSFER",
        sourceId: id, sourceLineId: m.sourceLineId, stockDocumentId: id, date, userId, settings,
        reason: `Received on ${doc.number}`, idempotencyKey: `stockdoc:${id}:in:${m.id}`,
        valuePaise: Math.abs(Math.round(Number(m.value ?? 0) * 100)), batchId: m.batchId, serials: m.serialNumbers,
      })),
    );
  }
  return written;
}

/**
 * Cancels a voucher. A draft or one waiting for approval just stops; a posted one — or a transfer in transit —
 * has every movement reversed at its own value, and its entry with it.
 */
export async function cancelStockDocument(tx: Tx, id: string, userId: string, reason: string, settings: AccountsSettings) {
  const doc = await tx.stockDocument.findUnique({ where: { id }, select: { id: true, number: true, status: true } });
  if (!doc) throw new StockError("That stock voucher no longer exists.");
  if (doc.status === "CANCELLED") return;
  const claimed = await tx.stockDocument.updateMany({
    where: { id, status: doc.status },
    data: { status: "CANCELLED", cancelledById: userId, cancelledAt: new Date(), cancelReason: reason },
  });
  if (claimed.count === 0) throw new StockError("Somebody else has just changed this.");
  if (doc.status === "DRAFT" || doc.status === "PENDING_APPROVAL") return;
  const live = await tx.stockMovement.findMany({
    where: { stockDocumentId: id, reversesId: null, reversedBy: { is: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, itemId: true, warehouseId: true },
  });
  await lockStockPairs(tx, live.filter((m) => m.warehouseId).map((m) => ({ itemId: m.itemId, warehouseId: m.warehouseId! })));
  // Newest first: a transfer's arrival comes off the destination before its departure goes back to the source.
  for (const m of live) await reverseMovement(tx, m.id, { userId, reason: `${doc.number} cancelled: ${reason}`, settings });
  await reverseInventoryEntry(tx, `stockdoc:${id}`, { userId, narration: `${doc.number} cancelled` });
}
