import { EMIRATES, lineCategory, type Emirate, type TaxCategoryKey } from "@/lib/vat/rules";

/**
 * The UAE's VAT return (VAT 201) from the period's documents (owner, 31 Oct 2026 — src/lib/vat/rules.ts). Pure: the
 * documents are gathered by src/actions/vat-return.ts, already in the workspace's currency (AED).
 *
 *   · Box 1, by emirate: standard-rated sales and their VAT — invoices and debit notes up, credit notes down — under
 *     the emirate of the branch that raised them. A sale whose branch has no emirate is shown apart, to be fixed.
 *   · Box 3: reverse-charge purchases (imported services) — the VAT owed on them, recovered again in box 10.
 *   · Boxes 4 and 5: zero-rated and exempt sales, their value only. Out-of-scope lines are in no box.
 *   · Box 9: standard-rated purchases and their recoverable VAT — bills up, vendor credits down.
 *   · Boxes 12–14: VAT due, VAT recoverable, and what is payable (or, below 0, refundable).
 *
 *   · Box 6: goods bought from abroad on a reverse-charge bill — the VAT owed on import, recovered in box 10 with box 3's
 *     (owner, 14 Nov 2026). The portal fills it from Customs too; ours is the figure to check it against.
 *
 *   · Bad-debt relief (owner, 15 Nov 2026 — src/lib/receivables/write-off.ts): the VAT on invoices written off in the
 *     period, in Box 1's adjustment column of the emirate that raised them — taking boxes 8, 12 and 14 down by it.
 *
 * Left for the FTA's portal: tourist refunds (box 2), amendments to imports (box 7), and apportionment.
 */

export type VatReturnLine = { category: string | null; rate: number; taxable: number; vat: number; /** Goods, not services — from the line's item. */ goods?: boolean };

export type VatReturnDocument = {
  id: string;
  number: string;
  /** SALES or PURCHASE, and whether it adds to the period or takes away (a credit note, a vendor credit). */
  direction: "SALES" | "PURCHASE";
  sign: 1 | -1;
  reverseCharge: boolean;
  /** Purchases only: bought from a vendor outside the UAE — its goods came in through Customs. */
  fromAbroad?: boolean;
  /** Sales only: the emirate of the branch that raised it, or null. */
  emirate: Emirate | null;
  lines: VatReturnLine[];
};

export type Amounts = { amount: number; vat: number };

/** VAT claimed back on an invoice written off in the period, under the emirate that raised it. */
export type VatRelief = { emirate: Emirate | null; vat: number };

export type VatReturn = {
  /** `adjustment`: bad-debt relief, a negative VAT figure. */
  box1: { emirate: Emirate | "Not set"; amount: number; vat: number; adjustment: number }[];
  box3: Amounts;
  box4: number;
  box6: Amounts;
  box5: number;
  box8: Amounts;
  box9: Amounts;
  box10: Amounts;
  box11: Amounts;
  box12: number;
  box13: number;
  box14: number;
  /** The bad-debt relief in the period, as a positive figure — already taken off boxes 8, 12 and 14. */
  badDebtRelief: number;
  /** Sales counted with no emirate — their branch's address needs one. */
  withoutEmirate: { id: string; number: string }[];
  documents: number;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function buildVatReturn(documents: VatReturnDocument[], reliefs: VatRelief[] = []): VatReturn {
  const byEmirate = new Map<Emirate | "Not set", Amounts>(EMIRATES.map((e) => [e, { amount: 0, vat: 0 }]));
  const box3 = { amount: 0, vat: 0 };
  const box6 = { amount: 0, vat: 0 };
  const box9 = { amount: 0, vat: 0 };
  let box4 = 0;
  let box5 = 0;
  const withoutEmirate: VatReturn["withoutEmirate"] = [];

  for (const doc of documents) {
    for (const line of doc.lines) {
      const category: TaxCategoryKey = lineCategory(line.category, line.rate);
      const amount = doc.sign * line.taxable;
      const vat = doc.sign * line.vat;
      if (doc.direction === "SALES") {
        if (category === "STANDARD") {
          const key = doc.emirate ?? "Not set";
          const row = byEmirate.get(key) ?? { amount: 0, vat: 0 };
          row.amount += amount;
          row.vat += vat;
          byEmirate.set(key, row);
          if (!doc.emirate && !withoutEmirate.some((w) => w.id === doc.id)) withoutEmirate.push({ id: doc.id, number: doc.number });
        } else if (category === "ZERO_RATED") box4 += amount;
        else if (category === "EXEMPT") box5 += amount;
      } else if (category === "STANDARD") {
        // A reverse-charge purchase is owed (box 3 — or box 6, goods from abroad through Customs) and recovered (box 10);
        // any other is recovered in box 9.
        const into = doc.reverseCharge ? (doc.fromAbroad && line.goods ? box6 : box3) : box9;
        into.amount += amount;
        into.vat += vat;
      }
    }
  }

  const adjustments = new Map<Emirate | "Not set", number>();
  for (const relief of reliefs) {
    const key = relief.emirate ?? "Not set";
    adjustments.set(key, (adjustments.get(key) ?? 0) - Math.max(0, relief.vat));
  }
  const box1 = [...byEmirate.entries()]
    .filter(([emirate, row]) => emirate !== "Not set" || row.amount !== 0 || row.vat !== 0 || adjustments.has(emirate))
    .map(([emirate, row]) => ({ emirate, amount: round2(row.amount), vat: round2(row.vat), adjustment: round2(adjustments.get(emirate) ?? 0) }));
  const r = (a: Amounts): Amounts => ({ amount: round2(a.amount), vat: round2(a.vat) });
  const sum1 = box1.reduce((t, row) => ({ amount: t.amount + row.amount, vat: t.vat + row.vat + row.adjustment }), { amount: 0, vat: 0 });
  const badDebtRelief = round2(-box1.reduce((t, row) => t + row.adjustment, 0));
  const box8 = r({ amount: sum1.amount + box3.amount + box4 + box5 + box6.amount, vat: sum1.vat + box3.vat + box6.vat });
  const box10 = r({ amount: box3.amount + box6.amount, vat: box3.vat + box6.vat });
  const box11 = r({ amount: box9.amount + box10.amount, vat: box9.vat + box10.vat });
  return {
    box1,
    box3: r(box3),
    box4: round2(box4),
    box6: r(box6),
    box5: round2(box5),
    box8,
    box9: r(box9),
    box10,
    box11,
    box12: box8.vat,
    box13: box11.vat,
    box14: round2(box8.vat - box11.vat),
    badDebtRelief,
    withoutEmirate,
    documents: documents.length,
  };
}

/** The quarter (or month) a return covers, as calendar days: 2026-Q4 → 1 Oct – 31 Dec. */
export function vatPeriod(key: string): { from: string; to: string; label: string } | null {
  const q = /^(\d{4})-Q([1-4])$/.exec(key);
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = (y: number, month: number) => new Date(Date.UTC(y, month, 0)).getUTCDate();
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (q) {
    const y = Number(q[1]);
    const first = (Number(q[2]) - 1) * 3 + 1;
    return { from: `${y}-${pad(first)}-01`, to: `${y}-${pad(first + 2)}-${lastDay(y, first + 2)}`, label: `${MONTHS[first - 1]}–${MONTHS[first + 1]} ${y}` };
  }
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    const y = Number(m[1]);
    const month = Number(m[2]);
    return { from: `${y}-${pad(month)}-01`, to: `${y}-${pad(month)}-${lastDay(y, month)}`, label: `${MONTHS[month - 1]} ${y}` };
  }
  return null;
}

/** The return as the portal's boxes, one per row — for the CSV beside the page. */
export function vatReturnRows(ret: VatReturn): string[][] {
  const money = (n: number) => n.toFixed(2);
  const adjusted = ret.badDebtRelief > 0;
  return [
    // The adjustment column only where there is bad-debt relief in the period (src/lib/receivables/write-off.ts).
    ["Box", "Description", "Amount (AED)", "VAT (AED)", ...(adjusted ? ["Adjustment (AED)"] : [])],
    ...ret.box1.map((row, i) => [`1${String.fromCharCode(97 + i)}`, `Standard rated supplies in ${row.emirate}`, money(row.amount), money(row.vat), ...(adjusted ? [row.adjustment ? money(row.adjustment) : ""] : [])]),
    ["3", "Supplies subject to the reverse charge", money(ret.box3.amount), money(ret.box3.vat)],
    ["4", "Zero rated supplies", money(ret.box4), ""],
    ["5", "Exempt supplies", money(ret.box5), ""],
    ["6", "Goods imported into the UAE", money(ret.box6.amount), money(ret.box6.vat)],
    ["8", "Totals", money(ret.box8.amount), money(ret.box8.vat)],
    ["9", "Standard rated expenses", money(ret.box9.amount), money(ret.box9.vat)],
    ["10", "Supplies subject to the reverse charge", money(ret.box10.amount), money(ret.box10.vat)],
    ["11", "Totals", money(ret.box11.amount), money(ret.box11.vat)],
    ["12", "Total value of due tax for the period", "", money(ret.box12)],
    ["13", "Total value of recoverable tax for the period", "", money(ret.box13)],
    ["14", "Payable tax for the period", "", money(ret.box14)],
  ];
}
