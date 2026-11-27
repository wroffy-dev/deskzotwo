import { indiaClock } from "@/lib/time/zone";
import { buildGstr1, countsForReturn, type Gstr3b, type HsnRow, type ReturnDocument } from "./gst-returns";

/**
 * GSTR-1 and GSTR-3B as the GST portal takes them (owner, 29 Oct 2026): the JSON its offline tool makes and its
 * "Upload JSON" reads, built from the same documents as the returns on the screen (./gst-returns.ts), so nobody types
 * the figures in again. Pure, so check:gstn-json reads the same file.
 *
 * GSTR-1's tables, by whom a supply went to:
 *   · b2b — a registered buyer: invoice by invoice, each one's tax by rate. Its type is R, or SEZ (with tax paid or
 *     not), or a deemed export, by the document's GST treatment;
 *   · b2cl — an unregistered buyer in another state, an invoice over ₹1,00,000: invoice by invoice;
 *   · b2cs — every other unregistered supply: by place of supply and rate, credit notes netted in, as on the screen;
 *   · exp — exports, with tax paid or not;
 *   · cdnr / cdnur — credit and debit notes to registered buyers, and to unregistered ones of a B2CL size or abroad;
 *   · hsn — the HSN summary in its two tabs, B2B and B2C (Phase III);
 *   · doc_issue — Table 13: the documents issued in each series, the cancelled ones counted.
 *
 * What a file can't carry from Deskzo yet is left to the person filing: an export's shipping bill and port, cess (Deskzo
 * charges none), amendments to an earlier month's figures, and GSTR-3B's interest, late fee and reversed credit.
 */

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** 7 October 2026 → "07-10-2026", the portal's way of writing a day — India's day, as the return's month is India's. */
const portalDay = (d: Date) => indiaClock.dateKey(d).split("-").reverse().join("-");
const pos = (code: string | null, fallback: string) => (code ?? fallback).padStart(2, "0");

/** The return period the portal names: October 2026 is "102026". */
export const returnPeriod = (month: number, year: number) => `${String(month).padStart(2, "0")}${year}`;

/** B2CL's line: an unregistered buyer in another state, an invoice over this. */
export const B2CL_LIMIT = 100_000;

type ItemTax = { txval: number; rt: number; iamt: number; camt: number; samt: number; csamt: number };

/**
 * A document's tax by rate — the portal's items, one a rate; `num` its own serial, rate × 100 + 1, as the tool numbers them.
 * Freight is among the lines, at its own rate (security audit round three, 14 Nov 2026, R3-05: `freightLine` in
 * ./gst-returns.ts) — it was left out, so an invoice's items added up to less than its value.
 */
function itemsOf(doc: ReturnDocument): { num: number; itm_det: ItemTax }[] {
  const byRate = new Map<number, ItemTax>();
  for (const l of doc.lines) {
    const t = byRate.get(l.taxRatePercent) ?? { txval: 0, rt: l.taxRatePercent, iamt: 0, camt: 0, samt: 0, csamt: 0 };
    t.txval = r2(t.txval + l.taxableValue);
    t.iamt = r2(t.iamt + l.igstAmount);
    t.camt = r2(t.camt + l.cgstAmount);
    t.samt = r2(t.samt + l.sgstAmount);
    byRate.set(l.taxRatePercent, t);
  }
  return [...byRate.values()].sort((a, b) => a.rt - b.rt).map((t) => ({ num: Math.round(t.rt * 100) + 1, itm_det: t }));
}

/** R, SEWP / SEWOP (SEZ, with tax paid or not) or DE (a deemed export), by the document's GST treatment. */
function invoiceType(doc: ReturnDocument): string {
  if (doc.gstTreatment === "SEZ") return doc.igstAmount > 0 ? "SEWP" : "SEWOP";
  if (doc.gstTreatment === "DEEMED_EXPORT") return "DE";
  return "R";
}

const abroad = (doc: ReturnDocument) => doc.gstTreatment === "OVERSEAS";
const interState = (doc: ReturnDocument, ours: string) => doc.igstAmount > 0 || (!!doc.placeOfSupplyCode && doc.placeOfSupplyCode !== ours);

const hsnEntry = (row: HsnRow, i: number) => ({
  num: i + 1,
  hsn_sc: row.hsnCode,
  desc: row.description.slice(0, 30),
  uqc: row.uqc,
  qty: row.quantity,
  rt: row.taxRatePercent,
  txval: row.taxableValue,
  iamt: row.igstAmount,
  camt: row.cgstAmount,
  samt: row.sgstAmount,
  csamt: 0,
});

/** A series' prefix — everything before its running number: "INV/26-27/0007" is of "INV/26-27/". */
const seriesOf = (n: string) => n.replace(/\d+$/, "");
const numberOf = (n: string) => Number(/(\d+)$/.exec(n)?.[1] ?? NaN);

/** Table 13's document types: invoices for outward supply, debit notes, credit notes. */
const DOC_TYPE: Record<string, number> = { INVOICE: 1, DEBIT_NOTE: 4, CREDIT_NOTE: 5 };

export type Gstr1File = Record<string, unknown> & { gstin: string; fp: string };

/**
 * GSTR-1's JSON for one registration's month. `docs` are the month's sales documents, cancelled ones too — Table 13
 * counts them; the tables leave them out, as the screen does (`countsForReturn`).
 */
export function gstr1Json(docs: ReturnDocument[], registration: { gstin: string; stateCode: string }, month: number, year: number, hsn = buildGstr1(docs).hsn): Gstr1File {
  const ours = registration.stateCode.padStart(2, "0");
  const sales = docs.filter((d) => (d.docType === "INVOICE" || d.docType === "CREDIT_NOTE" || d.docType === "DEBIT_NOTE") && countsForReturn(d));
  const invoices = sales.filter((d) => d.docType === "INVOICE");
  const notes = sales.filter((d) => d.docType !== "INVOICE");

  const b2b = new Map<string, unknown[]>();
  const b2cl = new Map<string, unknown[]>();
  const b2cs = new Map<string, { sply_ty: string; pos: string; typ: string; rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>();
  const exp = new Map<string, unknown[]>();
  const cdnr = new Map<string, unknown[]>();
  const cdnur: unknown[] = [];

  /** An unregistered supply's lines into B2CS, a credit note's taken off. */
  const intoB2cs = (doc: ReturnDocument) => {
    const sign = doc.docType === "CREDIT_NOTE" ? -1 : 1;
    const inter = interState(doc, ours);
    const place = pos(doc.placeOfSupplyCode, ours);
    for (const l of doc.lines) {
      const key = `${inter}|${place}|${l.taxRatePercent}`;
      const row = b2cs.get(key) ?? { sply_ty: inter ? "INTER" : "INTRA", pos: place, typ: "OE", rt: l.taxRatePercent, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      row.txval = r2(row.txval + sign * l.taxableValue);
      row.iamt = r2(row.iamt + sign * l.igstAmount);
      row.camt = r2(row.camt + sign * l.cgstAmount);
      row.samt = r2(row.samt + sign * l.sgstAmount);
      b2cs.set(key, row);
    }
  };

  for (const d of invoices) {
    const head = { inum: d.docNumber, idt: portalDay(d.issueDate), val: r2(d.total) };
    if (d.partyGstin) {
      const list = b2b.get(d.partyGstin) ?? [];
      list.push({ ...head, pos: pos(d.placeOfSupplyCode, ours), rchrg: d.reverseCharge ? "Y" : "N", inv_typ: invoiceType(d), itms: itemsOf(d) });
      b2b.set(d.partyGstin, list);
    } else if (abroad(d)) {
      const typ = d.igstAmount > 0 ? "WPAY" : "WOPAY";
      const list = exp.get(typ) ?? [];
      list.push({ ...head, itms: itemsOf(d).map((i) => ({ txval: i.itm_det.txval, rt: i.itm_det.rt, iamt: i.itm_det.iamt, csamt: 0 })) });
      exp.set(typ, list);
    } else if (interState(d, ours) && d.total > B2CL_LIMIT) {
      const place = pos(d.placeOfSupplyCode, ours);
      const list = b2cl.get(place) ?? [];
      list.push({ ...head, itms: itemsOf(d).map((i) => ({ num: i.num, itm_det: { txval: i.itm_det.txval, rt: i.itm_det.rt, iamt: i.itm_det.iamt, csamt: 0 } })) });
      b2cl.set(place, list);
    } else intoB2cs(d);
  }

  for (const d of notes) {
    const note = { ntty: d.docType === "CREDIT_NOTE" ? "C" : "D", nt_num: d.docNumber, nt_dt: portalDay(d.issueDate), val: r2(d.total), pos: pos(d.placeOfSupplyCode, ours) };
    if (d.partyGstin) {
      const list = cdnr.get(d.partyGstin) ?? [];
      list.push({ ...note, rchrg: d.reverseCharge ? "Y" : "N", inv_typ: invoiceType(d), itms: itemsOf(d) });
      cdnr.set(d.partyGstin, list);
    } else if (abroad(d)) {
      cdnur.push({ ...note, typ: d.igstAmount > 0 ? "EXPWP" : "EXPWOP", itms: itemsOf(d) });
    } else if (interState(d, ours) && d.total > B2CL_LIMIT) {
      cdnur.push({ ...note, typ: "B2CL", itms: itemsOf(d) });
    } else intoB2cs(d);
  }

  // Table 13: each series' first and last number, how many, how many cancelled.
  const issued = docs.filter((d) => DOC_TYPE[d.docType] && d.status !== "DRAFT");
  const docDet = Object.entries(DOC_TYPE)
    .map(([type, num]) => {
      const series = new Map<string, ReturnDocument[]>();
      for (const d of issued.filter((x) => x.docType === type)) series.set(seriesOf(d.docNumber), [...(series.get(seriesOf(d.docNumber)) ?? []), d]);
      const docs = [...series.values()].map((list, i) => {
        const sorted = [...list].sort((a, b) => numberOf(a.docNumber) - numberOf(b.docNumber) || a.docNumber.localeCompare(b.docNumber));
        const cancel = list.filter((d) => d.status === "CANCELLED").length;
        return { num: i + 1, from: sorted[0]!.docNumber, to: sorted[sorted.length - 1]!.docNumber, totnum: list.length, cancel, net_issue: list.length - cancel };
      });
      return docs.length ? { doc_num: num, docs } : null;
    })
    .filter(Boolean);

  const b2csRows = [...b2cs.values()].filter((r) => r.txval !== 0 || r.iamt !== 0 || r.camt !== 0 || r.samt !== 0);
  const file: Gstr1File = { gstin: registration.gstin, fp: returnPeriod(month, year), version: "GST3.2.1", hash: "hash" };
  if (b2b.size) file.b2b = [...b2b].map(([ctin, inv]) => ({ ctin, inv }));
  if (b2cl.size) file.b2cl = [...b2cl].map(([place, inv]) => ({ pos: place, inv }));
  if (b2csRows.length) file.b2cs = b2csRows.sort((a, b) => a.pos.localeCompare(b.pos) || a.rt - b.rt);
  if (exp.size) file.exp = [...exp].map(([exp_typ, inv]) => ({ exp_typ, inv }));
  if (cdnr.size) file.cdnr = [...cdnr].map(([ctin, nt]) => ({ ctin, nt }));
  if (cdnur.length) file.cdnur = cdnur;
  if (hsn.b2b.length || hsn.b2c.length) file.hsn = { hsn_b2b: hsn.b2b.map(hsnEntry), hsn_b2c: hsn.b2c.map(hsnEntry) };
  if (docDet.length) file.doc_issue = { doc_det: docDet };
  return file;
}

const tax = (h: { igst: number; cgst: number; sgst: number }) => ({ iamt: r2(h.igst), camt: r2(h.cgst), samt: r2(h.sgst), csamt: 0 });
const none = { iamt: 0, camt: 0, samt: 0, csamt: 0 };

/**
 * GSTR-3B's JSON for one registration's month, from the return on the screen (`buildGstr3b`) and the month's documents
 * for what it splits out: zero-rated supplies (exports, SEZ), nil-rated ones, inward supplies on reverse charge, and
 * inter-state supplies to unregistered buyers by state (Table 3.2). Eligible credit goes in as "all other ITC".
 */
export function gstr3bJson(g: Gstr3b, outward: ReturnDocument[], inward: ReturnDocument[], registration: { gstin: string; stateCode: string }, month: number, year: number) {
  const ours = registration.stateCode.padStart(2, "0");
  const counted = outward.filter((d) => (d.docType === "INVOICE" || d.docType === "CREDIT_NOTE" || d.docType === "DEBIT_NOTE") && countsForReturn(d));
  const sign = (d: ReturnDocument) => (d.docType === "CREDIT_NOTE" ? -1 : 1);
  const sumOf = (docs: ReturnDocument[], pick: (l: ReturnDocument["lines"][number]) => boolean = () => true) =>
    docs.reduce(
      (t, d) =>
        d.lines.filter(pick).reduce(
          (u, l) => ({ txval: r2(u.txval + sign(d) * l.taxableValue), iamt: r2(u.iamt + sign(d) * l.igstAmount), camt: r2(u.camt + sign(d) * l.cgstAmount), samt: r2(u.samt + sign(d) * l.sgstAmount) }),
          t,
        ),
      { txval: 0, iamt: 0, camt: 0, samt: 0 },
    );
  const zeroRated = counted.filter((d) => abroad(d) || d.gstTreatment === "SEZ");
  const domestic = counted.filter((d) => !zeroRated.includes(d));
  const taxed = sumOf(domestic, (l) => l.taxRatePercent > 0);
  const nil = sumOf(domestic, (l) => l.taxRatePercent === 0);
  const zero = sumOf(zeroRated);
  const reverse = sumOf(inward.filter((d) => countsForReturn(d) && d.reverseCharge));

  // Table 3.2: inter-state supplies to unregistered buyers, by the state they went to.
  const unreg = new Map<string, { pos: string; txval: number; iamt: number }>();
  for (const d of domestic.filter((x) => !x.partyGstin && interState(x, ours))) {
    const place = pos(d.placeOfSupplyCode, ours);
    const row = unreg.get(place) ?? { pos: place, txval: 0, iamt: 0 };
    row.txval = r2(row.txval + sign(d) * d.taxableValue);
    row.iamt = r2(row.iamt + sign(d) * d.igstAmount);
    unreg.set(place, row);
  }

  const itc = tax(g.inward);
  /**
   * Security audit round three, 14 Nov 2026 (R3-10): credit on inward supplies under reverse charge is its own row,
   * ISRC (table 4A(3)), not "all other ITC" — and its tax is a liability in 3.1(d) (`isup_rev`, below), paid before the
   * credit is taken. Standard treatment — confirm with your CA.
   */
  const rcm = tax({ igst: Math.min(g.reverseCharge.igst, g.inward.igst), cgst: Math.min(g.reverseCharge.cgst, g.inward.cgst), sgst: Math.min(g.reverseCharge.sgst, g.inward.sgst) });
  const other = { iamt: r2(itc.iamt - rcm.iamt), camt: r2(itc.camt - rcm.camt), samt: r2(itc.samt - rcm.samt), csamt: 0 };
  return {
    gstin: registration.gstin,
    ret_period: returnPeriod(month, year),
    sup_details: {
      osup_det: { txval: taxed.txval, iamt: taxed.iamt, camt: taxed.camt, samt: taxed.samt, csamt: 0 },
      osup_zero: { txval: zero.txval, iamt: zero.iamt, csamt: 0 },
      osup_nil_exmp: { txval: nil.txval },
      isup_rev: { txval: reverse.txval, iamt: reverse.iamt, camt: reverse.camt, samt: reverse.samt, csamt: 0 },
      osup_nongst: { txval: 0 },
    },
    inter_sup: { unreg_details: [...unreg.values()].filter((r) => r.txval !== 0), comp_details: [], uin_details: [] },
    itc_elg: {
      itc_avl: [
        { ty: "IMPG", ...none },
        { ty: "IMPS", ...none },
        { ty: "ISRC", ...rcm },
        { ty: "ISD", ...none },
        { ty: "OTH", ...other },
      ],
      itc_rev: [
        { ty: "RUL", ...none },
        { ty: "OTH", ...none },
      ],
      itc_net: itc,
      itc_inelg: [
        { ty: "RUL", ...none },
        { ty: "OTH", ...none },
      ],
    },
    inward_sup: {
      isup_details: [
        { ty: "GST", inter: 0, intra: 0 },
        { ty: "NONGST", inter: 0, intra: 0 },
      ],
    },
    intr_ltfee: { intr_details: { ...none } },
  };
}
