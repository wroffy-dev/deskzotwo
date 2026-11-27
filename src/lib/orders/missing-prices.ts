import type { Prisma } from "@prisma/client";

/**
 * Orders recorded without a price (owner, 3 Nov 2026) — most brought in from the old system with their
 * quantity and dates but no sale price — and filling it in once, so Renewals, the pro-rata calculator,
 * adding seats and renewal quotes all have a figure to work from.
 *
 * What "no price" means for each kind of order:
 *   an order of its own   no unit price (or 0) and no full-term price — its unit price is the one filled
 *   seats added later     no full-term price (or 0) — that is the renewal's basis; what they were charged
 *                         for part of a term stays as it was
 * Filling never changes a price an order has: the write is conditional on it still being missing.
 */

/** Orders still without a price, cancelled ones left out. */
export const MISSING_PRICE_WHERE = {
  orderStatus: { not: "CANCELLED" },
  OR: [
    { parentId: null, AND: [{ OR: [{ unitPrice: null }, { unitPrice: 0 }] }, { OR: [{ fullTermUnitPrice: null }, { fullTermUnitPrice: 0 }] }] },
    { parentId: { not: null }, OR: [{ fullTermUnitPrice: null }, { fullTermUnitPrice: 0 }] },
  ],
} satisfies Prisma.CompanyProductWhereInput;

/** The field a price is filled into, for an order or seats added to one. */
export function priceField(order: { parentId: string | null }): "unitPrice" | "fullTermUnitPrice" {
  return order.parentId ? "fullTermUnitPrice" : "unitPrice";
}

/** A typed or imported price: positive, at most two decimals, under a crore a seat. Null when it isn't one. */
export function readPrice(raw: unknown): number | null {
  const text = String(raw ?? "").replace(/[₹,\s]/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text);
  return n > 0 && n < 10_000_000 ? n : null;
}

/**
 * One CSV line's cells, split on commas, tabs or semicolons outside quotes — Excel quotes an amount written
 * "1,250", and splitting inside it would read the price as 1.
 */
function cellsOf(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (ch === "," || ch === "\t" || ch === ";")) {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Rows of "order number, price" from a pasted or uploaded CSV — a heading row, quotes and an "ORD-" prefix
 * allowed. Gives back each row's order number (as a number) and price, or why it was skipped.
 */
export function parsePriceCsv(text: string): { line: number; orderSeq: number | null; price: number | null; problem: string | null }[] {
  const out: { line: number; orderSeq: number | null; price: number | null; problem: string | null }[] = [];
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const cells = cellsOf(line);
      const ref = /^(?:ORD-?)?0*(\d{1,9})$/i.exec(cells[0] ?? "");
      // A heading row is passed over, not reported.
      if (!ref && i === 0) return;
      if (!ref) return out.push({ line: i + 1, orderSeq: null, price: null, problem: `"${cells[0] ?? ""}" isn't an order number` });
      const price = readPrice(cells[1]);
      if (price === null) return out.push({ line: i + 1, orderSeq: Number(ref[1]), price: null, problem: `"${cells[1] ?? ""}" isn't a price` });
      out.push({ line: i + 1, orderSeq: Number(ref[1]), price, problem: null });
    });
  return out;
}
