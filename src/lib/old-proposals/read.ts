/**
 * The proposals made in Excel before Zoho (owner, 25 Nov 2026: "before zoho we used to make proposals in xls … now if i
 * want to feed this data in deskzo"), read from their sheets. Pure: no database, no file system — the folder is walked by
 * scripts/old-proposals-prepare.ts, and what it makes is matched against the workspace by ./preview.ts.
 *
 * Two sources, joined here:
 *   · the **status sheet**, a tab a year and a row a proposal — who it was for, the product, who made it, how it ended;
 *   · the **quotations**, a workbook each on one layout — the reference, the customer, the date, the lines and the total.
 * A reference was typed by hand, and is sometimes wrong or another's, so it never joins the two on its own: the company
 * has to agree as well.
 */

export type SheetRow = { row: number; cells: Record<string, string> };
export type OldStatus = "WON" | "LOST" | "PENDING" | "OTHER" | "UNKNOWN";
export type OldLine = { item: string; quantity: number | null; rate: number | null; amount: number | null };
export type Quotation = {
  file: string;
  ref: string;
  company: string;
  folder: string;
  contact: string;
  email: string;
  date: string | null;
  madeBy: string;
  lines: OldLine[];
  total: number | null;
  /** When Excel last saved it, to the second — which of two versions is the later when both carry one date. */
  saved: string | null;
};
export type StatusRow = {
  tab: string;
  row: number;
  ref: string;
  date: string | null;
  company: string;
  product: string;
  madeBy: string;
  status: OldStatus;
  statusText: string;
  contact: string;
  phone: string;
  email: string;
  address: string;
  remarks: string;
  left: boolean;
};
export type OldProposal = {
  key: string;
  ref: string;
  year: string;
  date: string | null;
  company: string;
  /** Other names for it — the folder's, the sheet's when they differ. */
  alsoNamed: string[];
  contact: string;
  phone: string;
  email: string;
  address: string;
  madeBy: string;
  product: string;
  status: OldStatus;
  remarks: string;
  left: boolean;
  lines: OldLine[];
  total: number | null;
  /** The latest version first. */
  files: string[];
  /** What else was in its folder — a purchase order, a licence order form: kept beside it, not read. */
  attachments: string[];
  /** How its file met its row: by reference and company, by company and date, or only one of the two is there. */
  joined: "REFERENCE" | "DATE" | "SHEET_ONLY" | "FILE_ONLY";
  issues: string[];
};
export type Prepared = { version: 1; made: string; proposals: OldProposal[]; unread: { file: string; why: string }[]; otherFiles: number };

// ─── Cells ───────────────────────────────────────────────────────────────────────────────────────

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, e: string) => {
      if (e[0] !== "#") return ENTITY[e] ?? whole;
      const code = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/_x000D_/g, " ");
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]!)).join("");

export const sharedStrings = (xml: string): string[] => [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g)].map((m) => textOf((m[1] ?? "").replace(/<rPh[\s\S]*?<\/rPh>/g, "")));

/** A worksheet's XML as its rows that hold something. */
export function rowsOf(xml: string, strings: readonly string[]): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const m of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (!m[2]) continue;
    const cells: Record<string, string> = {};
    for (const c of m[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      if (!c[2]) continue;
      const column = /\br="([A-Z]+)\d+"/.exec(c[1]!)?.[1];
      if (!column) continue;
      const type = /\bt="(\w+)"/.exec(c[1]!)?.[1];
      const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(c[2])?.[1];
      const value = type === "s" ? (raw === undefined ? "" : (strings[Number(raw)] ?? "")) : type === "inlineStr" ? textOf(c[2]) : type === "e" ? "" : decode(raw ?? "");
      if (value.trim()) cells[column] = value.trim();
    }
    if (Object.keys(cells).length) rows.push({ row: Number(/\br="(\d+)"/.exec(m[1]!)?.[1] ?? rows.length + 1), cells });
  }
  return rows;
}

/** A Word document's tables as rows of cells, and each paragraph outside them a row of one — so a proposal in Word reads as a sheet does. */
export function wordRows(xml: string): SheetRow[] {
  const plain = (x: string) => decode(x.replace(/<w:(?:tab|br)\b[^>]*\/>/g, " ").replace(/<\/w:p>/g, " ").replace(/<[^>]*>/g, "")).replace(/​/g, "").replace(/\s+/g, " ").trim();
  const rows: SheetRow[] = [];
  for (const m of xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>|<w:p\b(?:[^>]*\/>|[\s\S]*?<\/w:p>)/g)) {
    const cells: Record<string, string> = {};
    if (m[0].startsWith("<w:tr")) [...m[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].slice(0, 26).forEach((c, i) => {
      const text = plain(c[0]);
      if (text) cells[String.fromCharCode(65 + i)] = text;
    });
    else if (plain(m[0])) cells.A = plain(m[0]);
    if (Object.keys(cells).length) rows.push({ row: rows.length + 1, cells });
  }
  return rows;
}

const columns = (cells: Record<string, string>) => Object.keys(cells).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
const flat = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

export function numberOf(text: string | undefined): number | null {
  // Two figures in one cell are neither.
  if (/\d\s+\d/.test((text ?? "").trim())) return null;
  const t = (text ?? "").replace(/(?:₹|rs\.?|inr|usd|\$)/gi, "").replace(/[,\s]/g, "").replace(/\/-?$/, "");
  return t && /^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(t) ? Math.round(Number(t) * 100) / 100 : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const day = (y: number, m: number, d: number): string | null => {
  const at = new Date(Date.UTC(y, m - 1, d));
  return y >= 2015 && y <= 2022 && at.getUTCMonth() === m - 1 && at.getUTCDate() === d ? at.toISOString().slice(0, 10) : null;
};

/** A date as Excel keeps it (a serial) or as somebody typed it, day first. Outside 2015–2022 it was mistyped: none. */
export function dateOf(text: string | undefined): string | null {
  const t = flat(text);
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const at = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86_400_000);
    return day(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
  }
  const m = /(\d{1,2})(?:st|nd|rd|th)?[-/.,\s]+(\d{1,2}|[a-z]{3,9})[-/.,\s]+(\d{4}|\d{2})\b/i.exec(t);
  if (!m) return null;
  const month = /^\d/.test(m[2]!) ? Number(m[2]) : MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1;
  return day(m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), month, Number(m[1]));
}

// ─── Names and references ────────────────────────────────────────────────────────────────────────

const FORM = new Set(["pvt", "private", "ltd", "limited", "limites", "lmtd", "llp", "p", "m", "s", "the", "co", "company", "inc", "india"]);
/** A name's own words: no legal form, no punctuation. */
export const nameWords = (name: string): string[] => name.toLowerCase().replace(/&/g, " and ").replace(/\./g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w && !FORM.has(w));
/** Words many companies start with, which alone say nothing. */
const COMMON = new Set(["shri", "shree", "sri", "new", "indian", "national", "global", "international", "om", "jai", "sai", "royal", "super", "great", "first", "red", "blue", "green", "star", "tech", "smart", "a", "i", "govt", "government", "dr", "mr", "and", "of"]);

function within(a: string, b: string, most: number): boolean {
  if (Math.abs(a.length - b.length) > most) return false;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]! <= most;
}

/** Whether two names written by hand are one company: the same words, one the start of the other, or a slip of the pen. */
export function sameCompany(a: string, b: string): boolean {
  const x = nameWords(a);
  const y = nameWords(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const jx = x.join("");
  const jy = y.join("");
  if (jx === jy) return true;
  if (short.every((w, i) => w === long[i]) && (short.length > 1 || (short[0]!.length >= 4 && !COMMON.has(short[0]!)))) return true;
  return Math.min(jx.length, jy.length) >= 7 && within(jx, jy, Math.min(jx.length, jy.length) >= 12 ? 2 : 1);
}

/** "WT/19-2-0/Ref/005" → 2019's 5th. Null when it isn't one. */
export function refOf(text: string): { year: string; number: number } | null {
  const m = /(\d{2})\s*-\s*\d[\d-]*\s*\/?\s*ref\s*[/.:-]?\s*0*(\d+)/i.exec(text);
  return m ? { year: `20${m[1]}`, number: Number(m[2]) } : null;
}
export const refKey = (text: string): string | null => {
  const r = refOf(text);
  return r ? `${r.year}:${r.number}` : null;
};
/** The Indian financial year a day is in, by the year it began. */
export const yearOfDay = (d: string): string => String(Number(d.slice(5, 7)) >= 4 ? Number(d.slice(0, 4)) : Number(d.slice(0, 4)) - 1);
export const yearLabel = (began: string): string => (/^\d{4}$/.test(began) ? `${began}-${String((Number(began) + 1) % 100).padStart(2, "0")}` : "");

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const emailIn = (s: string, own: RegExp): string => (s.match(EMAIL) ?? []).map((e) => e.toLowerCase().replace(/\.+$/, "")).find((e) => !own.test(e)) ?? "";
const phoneIn = (s: string): string => /(?:^|\D)([6-9]\d{9})(?!\d)/.exec(s.replace(/(\d)[\s-](?=\d)/g, "$1"))?.[1] ?? "";

/** A reference in running text. */
const refIn = (text: string): string => flat(/\bw[t1]\s*\/\s*\d{2}\s*-\s*\d[\d-]*\s*\/\s*(?:ref|qt)\s*\/\s*\d+/i.exec(text)?.[0]);

/**
 * A proposal from its PDF's text, which has lost its table: who, when, the reference and the total, and a line wherever a
 * name is followed by a quantity, a rate and their product — which is how it is known to be one. Null without who and when.
 */
export function pdfQuotation(text: string, at: { file: string; folder: string }, own: RegExp): Quotation | null {
  const t = text.replace(/\s+/g, " ").trim();
  const until = "address|date|contact|proposal title|prepared by|quote id|gst no";
  const company =
    flat(new RegExp(String.raw`(?:customer name|name of the customer\s*/\s*domain)\s*:?\s*(.{2,120}?)\s+(?:${until})\b`, "i").exec(t)?.[1]) ||
    flat(/customer details.{0,20}?quote id\s*\S+\s+(.{2,100}?)\s+(?:contact\s*:|gst no)/i.exec(t)?.[1]) ||
    flat(/\bcompany(?: name)?\s*:?\s+(.{2,100}?)\s+(?:gst no|contact|email)/i.exec(t)?.[1]);
  const ref = refIn(t);
  const date = dateOf(/\bdate\s*:?\s*(\d{1,2}[-/. ](?:\d{1,2}|[a-z]{3,9})[-/., ]+\d{2,4})/i.exec(t)?.[1]);
  if (!(company || ref) || !/propos|quot|proforma|performa/i.test(`${t.slice(0, 4000)} ${at.file}`) || !(date || ref)) return null;
  const lines: OldLine[] = [];
  const from = t.search(/\bitem\b.{0,20}?\bqty\b/i);
  let total: number | null = null;
  if (from >= 0) {
    const table = t.slice(from, from + 4000);
    const stop = table.search(/terms\s*(?:and|&)\s*cond|validity|taxes as applicable/i);
    const body = (stop > 0 ? table.slice(0, stop) : table).replace(/^.*?total\s*(?:\(inr\))?\s*(?:annual|price)?\s*(?:\(inr\))?/i, "");
    let last = 0;
    for (const m of body.matchAll(/(?<![\d,.])(\d{1,6})\s+(?:₹|rs\.?\s*)?([\d,]+(?:\.\d{1,2})?)\s+(?:₹|rs\.?\s*)?([\d,]+(?:\.\d{1,2})?)(?![\d,.])/gi)) {
      const [q, r, a] = [numberOf(m[1]), numberOf(m[2]), numberOf(m[3])];
      if (q === null || r === null || a === null || !a || Math.abs(q * r - a) > Math.max(2, a * 0.002)) continue;
      const item = flat(body.slice(last, m.index)).replace(/^.*\btotal\b[^a-z]*/i, "").replace(/^[\d.,]+[a-z]?\s+/, "").slice(-200);
      if (item) lines.push({ item, quantity: q, rate: r, amount: a });
      last = m.index + m[0].length;
    }
    for (const m of body.matchAll(/\b(?:grand\s*)?total(?:\s*amount)?\s*:?\s*(?:₹|rs\.?\s*)?([\d,]+(?:\.\d{1,2})?)/gi)) total = numberOf(m[1]) ?? total;
  }
  const emails = (t.match(EMAIL) ?? []).map((e) => e.toLowerCase().replace(/\.+$/, ""));
  return {
    file: at.file,
    folder: at.folder,
    saved: null,
    ref,
    company: company && !/^wroffy\b/i.test(company) ? company : at.folder,
    contact: flat(/contact (?:person|details)\s*:?\s*((?:(?:mr|ms|mrs|dr)\.?\s*)?[a-z][a-z. ]{2,40}?)\s*[/:|0-9]/i.exec(t)?.[1] ?? /\bto,?\s*((?:mr|ms|mrs|dr)\.?\s*[a-z. ]{2,30}?)\s{0,2}(?:sub|[A-Z]{2})/.exec(t)?.[1]).slice(0, 120),
    email: emails.find((e) => !own.test(e)) ?? "",
    date,
    madeBy: emails.find((e) => own.test(e) && !/^info@/.test(e)) ?? "",
    lines,
    total: total || null,
  };
}

// ─── A quotation ─────────────────────────────────────────────────────────────────────────────────

/** The cell after a label on its row. */
function beside(rows: readonly SheetRow[], label: RegExp): string {
  for (const { cells } of rows) {
    const ks = columns(cells);
    for (let i = 0; i < ks.length; i++) if (label.test(flat(cells[ks[i]!]))) return ks[i + 1] ? (cells[ks[i + 1]!] ?? "") : "";
  }
  return "";
}

/** A quotation on the usual layout, or null for a sheet that isn't one. `own` tells the sender's own addresses. */
export function quotationOf(rows: readonly SheetRow[], at: { file: string; folder: string; saved: string | null; word?: boolean }, own: RegExp): Quotation | null {
  const label = /^(company( name)?|customer name|(name of the\s*)?customer\s*\/\s*domain)\s*:?$/i;
  const labelled = rows.some(({ cells }) => Object.values(cells).some((v) => label.test(flat(v))));
  // The first layout (2017) had no label: the company is the line under "Customer Details".
  const under = rows.findIndex(({ cells }) => Object.values(cells).some((v) => /^customer details\s*:?$/i.test(flat(v))));
  if (!labelled && (under < 0 || !rows[under + 1])) return null;
  // Left blank, the cell after it is the next label ("GST No."): the folder says who.
  const written = labelled ? flat(beside(rows, label)) : flat(rows[under + 1]!.cells.B ?? rows[under + 1]!.cells.A);
  const company = !written || /^(gst|contact|e-?mail|address|date|quote|customer|wroffy)\b/i.test(written) ? at.folder : written;
  if (!company) return null;
  const head = rows.findIndex(({ cells }) => Object.values(cells).some((v) => /^(item|description|product)s?\b/i.test(v)) && Object.values(cells).some((v) => /^(qty|quantity)/i.test(v)));
  const lines: OldLine[] = [];
  let total: number | null = null;
  if (head >= 0) {
    const of = (re: RegExp) => columns(rows[head]!.cells).find((k) => re.test(flat(rows[head]!.cells[k])));
    const item = of(/^(item|description|product)/i)!;
    let ended = false;
    const qty = of(/^(qty|quantity)/i)!;
    const rate = of(/(unit|price|rate)/i);
    const amount = of(/total|amount/i);
    let heading = "";
    let over = false;
    for (const { cells } of rows.slice(head + 1)) {
      for (const k of columns(cells)) {
        // Outside the item column: "Total", "Grand Total" — a later one is the larger, with the tax.
        if (k === item || !/^(grand\s*)?total\b/i.test(flat(cells[k]))) continue;
        const after = columns(cells).filter((c) => columns(cells).indexOf(c) > columns(cells).indexOf(k)).map((c) => numberOf(cells[c])).find((v) => v !== null);
        if (after !== undefined && after !== null) total = after;
      }
      // Word has no "Terms" beside the totals: what follows the last of them isn't a line.
      if (Object.entries(cells).some(([k, v]) => k !== item && /^(grand\s*)?total\b/i.test(flat(v)))) ended = true;
      if (over || (at.word && (ended || (Object.keys(cells).length === 1 && cells.A !== undefined && lines.length > 0))) || Object.values(cells).some((v) => /^terms\s*(and|&)\s*cond/i.test(v))) {
        over = true;
        continue;
      }
      if (Object.entries(cells).some(([k, v]) => k !== item && /^(sub\s*-?total|gst|igst|cgst|sgst|grand|total)/i.test(v))) continue;
      const text = flat(cells[item]);
      const q = numberOf(cells[qty]);
      const r = rate ? numberOf(cells[rate]) : null;
      const a = amount ? numberOf(cells[amount]) : null;
      if (text && (q !== null || r !== null || a !== null)) {
        lines.push({ item: flat(heading ? `${heading} — ${text}` : text).slice(0, 500), quantity: q, rate: r, amount: a });
        heading = "";
      } else if (text) {
        // A name above its line, or more about the line before.
        const last = lines[lines.length - 1];
        if (last && Object.keys(cells).length === 1 && /part code|support|validity|warranty|\*/i.test(text)) last.item = `${last.item} · ${text}`.slice(0, 500);
        else if (!/^option/i.test(text)) heading = text.slice(0, 120);
      }
    }
  }
  const all = rows.flatMap((r) => Object.values(r.cells)).join(" \n ");
  // "Contact :" alone is our own person, across from theirs on the layouts that say "Contact Person" or "Details".
  const contact = flat(beside(rows, /^contact\s*(details?|person)\s*:?$/i)) || (/contact person\s*:\s*([^\n]+)/i.exec(all)?.[1] ?? "") || (/\bto,?\s*((?:mr|ms|mrs|dr)\.?\s*[^\n|,]+)/i.exec(all)?.[1] ?? "");
  const who = flat(contact.replace(/contact person\s*:?/i, "").split(/[/|]/)[0]).replace(/[\d+()-]{8,}/g, "").replace(/\s*(?:mob|m|ph|phone|mobile)\.?\s*[-:]*\s*$/i, "").replace(/\s*contact (details|no).*$/i, "").replace(/[\s;,:-]+$/, "").trim();
  return {
    file: at.file,
    folder: at.folder,
    saved: at.saved,
    ref: flat(beside(rows, /^(?:quot(?:e|ation)\s*(?:id|no|number)|ref(?:erence)?\s*(?:id|no)?)\.?\s*:?$/i)) || refIn(all),
    company,
    contact: who.slice(0, 120),
    email: emailIn(flat(beside(rows, /^e-?mail\s*id\s*:?$/i)) || all, own),
    date: dateOf(beside(rows, /^date\s*:?$/i)),
    madeBy: (all.match(EMAIL) ?? []).map((e) => e.toLowerCase()).find((e) => own.test(e)) ?? "",
    lines,
    // A formula never worked out, or left at nothing under a choice of options ("OR"): not a total.
    total: total === 0 ? null : total,
  };
}

// ─── The status sheet ────────────────────────────────────────────────────────────────────────────

export function statusOf(text: string): OldStatus {
  const t = text.trim().toLowerCase();
  if (!t) return "UNKNOWN";
  if (/^won|^close[d]? won/.test(t)) return "WON";
  if (/lost|^loss/.test(t)) return "LOST";
  if (/^p(e|r)n?n?ding|^prnding|^pend/.test(t)) return "PENDING";
  return "OTHER";
}

/** A tab of the status sheet: its headings where they are, and a row for each that has a reference and a company. */
export function statusRows(tab: string, rows: readonly SheetRow[], own: RegExp): StatusRow[] {
  const headings = rows[0]?.cells ?? {};
  const of = (re: RegExp) => columns(headings).find((k) => re.test(flat(headings[k])));
  const at = { ref: of(/^ref code/i), date: of(/^date$|^\.$/i), company: of(/^account name/i), product: of(/^product/i), by: of(/^prepared by/i), status: of(/^status/i), name: of(/^name$/i), phone: of(/^contact( no\.?)?$/i), email: of(/^email/i), city: of(/^city/i), place: of(/^location/i), remarks: of(/^remarks/i) };
  if (!at.ref || !at.company) return [];
  const out: StatusRow[] = [];
  for (const { row, cells } of rows.slice(1)) {
    const get = (k: string | undefined) => (k ? flat(cells[k]) : "");
    const ref = get(at.ref);
    const company = get(at.company);
    if (!company || !/ref/i.test(ref)) continue;
    const statusText = get(at.status);
    const remarks = (at.remarks ? (cells[at.remarks] ?? "") : "").replace(/[ \t]+/g, " ").trim();
    const everything = Object.values(cells).join(" \n ");
    out.push({
      tab,
      row,
      ref,
      company,
      date: at.date ? dateOf(cells[at.date]) : null,
      product: get(at.product),
      madeBy: get(at.by),
      status: statusOf(statusText),
      statusText,
      contact: get(at.name),
      phone: phoneIn(get(at.phone)),
      email: emailIn(get(at.email) || everything, own),
      address: get(at.place) || get(at.city),
      remarks: remarks.slice(0, 2000),
      left: /left the (job|comp|org)|not working there|he (has )?left|she (has )?left/i.test(remarks),
    });
  }
  return out;
}

// ─── The two joined ──────────────────────────────────────────────────────────────────────────────

const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
/** What a file is for, by its name: without "Proposal for", "Revised", a copy's number. */
const topic = (file: string) =>
  flat(
    (file.split("/").pop() ?? "")
      .replace(/\.\w+$/, "")
      .replace(/[_()\-&+,.]/g, " ")
      .replace(/\b(re-?revised|revised|revise|revision|final|fresh|new|latest|copy|proposals?|quotation|quote|for|of|updated|pi|om)\b/gi, " ")
      .replace(/(?<![a-z])\d+(?![a-z0-9])/gi, " "),
  ).toLowerCase();
/** The makers and kinds a proposal is told by — "MS Licenses", "O365" and "Microsoft" are one. */
const FAMILIES: [string, RegExp][] = [
  ["Microsoft", /microsoft|\bms\b|o\s?365|m\s?365|office|windows|win ?pro|azure|sql|exchange|power ?bi|visio|skype/],
  ["Google", /g\s?-?suite|google|gsuit/],
  ["Corel", /corel|coral/],
  ["Adobe", /adobe|photoshop|acrobat|creative cloud/],
  ["Autodesk", /auto\s?cad|autodesk|3ds|maya|revit/],
  ["Security", /firewall|sophos|cyberoam|fortig?|sonic|anti\s?-?virus|\bav\b|quick\s?heal|seqrite|kasper|symantec|mca?f+ee|bitdefender|trend/],
  ["Hardware", /laptop|desktop|server|dell|lenovo|\bhp\b|printer|ups|cctv|mac ?book|hard ?(disk|drive)|switch|cisco/],
  ["Tally", /tally/],
];
const families = (text: string) => FAMILIES.filter(([, re]) => re.test(text)).map(([name]) => name);
/** A proforma is for what was agreed, not the proposal itself: after its proposals. */
const isProforma = (file: string) => /(^|[\s_-])pi([\s_.-]|$)|perfo?rma|proforma/i.test(file.split("/").pop() ?? "");
const isVersion = (file: string) => (/final/i.test(file) ? 2 : /revis|updated/i.test(file) ? 1 : 0);

/** The later of two versions first: by its date, then by when it was saved, then by being called revised or final. */
const later = (a: Quotation, b: Quotation) => Number(isProforma(a.file)) - Number(isProforma(b.file)) || (b.date ?? "").localeCompare(a.date ?? "") || Number(b.lines.length > 0) - Number(a.lines.length > 0) || (b.saved ?? "").localeCompare(a.saved ?? "") || isVersion(b.file) - isVersion(a.file) || a.file.localeCompare(b.file);

export function joinProposals(status: readonly StatusRow[], quotations: readonly Quotation[]): OldProposal[] {
  // Versions together: the same reference for the same company. Without a reference that reads, each file is on its own.
  const groups: Quotation[][] = [];
  const byRef = new Map<string, Quotation[][]>();
  for (const q of quotations) {
    const key = refKey(q.ref);
    const near = key ? (byRef.get(key) ?? []) : [];
    // Without one: the same day, for the same company, for the same or with no total — Word and its PDF.
    const found = key ? near.find((g) => sameCompany(g[0]!.company, q.company)) : groups.find((g) => q.date !== null && g.some((x) => x.date === q.date && (x.total === q.total || x.total === null || q.total === null)) && sameCompany(g[0]!.company, q.company));
    if (found) found.push(q);
    else {
      const made = [q];
      groups.push(made);
      if (key) byRef.set(key, [...near, made]);
    }
  }
  const rowsByRef = new Map<string, StatusRow[]>();
  for (const r of status) {
    const key = refKey(r.ref);
    if (key) rowsByRef.set(key, [...(rowsByRef.get(key) ?? []), r]);
  }
  const taken = new Map<StatusRow, { group: Quotation[]; how: "REFERENCE" | "DATE" }>();
  const agrees = (r: StatusRow, g: Quotation[]) => g.some((q) => sameCompany(r.company, q.company) || (q.folder && sameCompany(r.company, q.folder)));
  const left: Quotation[][] = [];
  for (const g of groups) {
    const key = refKey(g[0]!.ref);
    const row = (key ? (rowsByRef.get(key) ?? []) : []).find((r) => !taken.has(r) && agrees(r, g));
    if (row) taken.set(row, { group: g, how: "REFERENCE" });
    else left.push(g);
  }
  // A reference that names no row of its company: its company's one row within a fortnight, nobody else's.
  const only: Quotation[][] = [];
  for (const g of left) {
    const date = [...g].sort(later)[0]!.date;
    const near = date ? status.filter((r) => !taken.has(r) && r.date && daysApart(r.date, date) <= 14 && agrees(r, g)) : [];
    if (near.length === 1) taken.set(near[0]!, { group: g, how: "DATE" });
    else only.push(g);
  }
  const make = (row: StatusRow | null, group: Quotation[], joined: OldProposal["joined"], at: number): OldProposal => {
    const versions = [...group].sort(later);
    const q = versions[0];
    // The latest may be a PDF or a Word file whose figures couldn't be read: those of the latest that has them.
    const figures = versions.find((v) => v.lines.length > 0 && v.total !== null) ?? versions.find((v) => v.lines.length > 0 || v.total !== null);
    const own = q && (q.lines.length > 0 || q.total !== null) && /\.xlsx$/i.test(q.file) ? q : q && q.lines.length > 0 && q.total !== null ? q : (figures ?? q);
    const ref = row?.ref || q?.ref || "";
    const date = q?.date ?? row?.date ?? null;
    const issues: string[] = [];
    if (joined === "DATE") issues.push(`The file's reference is ${q?.ref || "blank"}, the sheet's ${row?.ref}: joined by company and date`);
    if (joined === "FILE_ONLY") issues.push("Not in the status sheet");
    if (!date) issues.push("No date that reads");
    if (q && own && own !== q) issues.push(`Its figures are an earlier version's: ${own.file.split("/").pop()}`);
    if (q && (own?.total ?? null) === null) issues.push("No total found on the sheet");
    if (q && !own?.lines.length) issues.push("No item lines found on the sheet");
    const told = versions.map((v) => families(topic(v.file))).filter((x) => x.length);
    if (told.some((x) => !x.some((name) => told[0]!.includes(name)))) issues.push(`Files under one reference look like different proposals: ${[...new Set(told.flat())].join(", ")}`);
    const company = row?.company || q?.company || "";
    const alsoNamed = [...new Set([q?.company ?? "", q?.folder ?? ""].filter((n) => n && n.toLowerCase() !== company.toLowerCase()))];
    const year = refOf(ref)?.year ?? (date ? yearOfDay(date) : (/(20\d\d)/.exec(q?.file ?? "")?.[1] ?? ""));
    return {
      key: row ? `S:${row.tab}:${row.row}` : `F:${q?.file ?? at}`,
      ref,
      year,
      date,
      company,
      alsoNamed,
      contact: row?.contact || q?.contact || "",
      phone: row?.phone ?? "",
      email: row?.email || q?.email || "",
      address: row?.address ?? "",
      madeBy: row?.madeBy || q?.madeBy || "",
      product: row?.product || (q ? topic(q.file) : ""),
      status: row?.status ?? "UNKNOWN",
      remarks: row?.remarks ?? "",
      left: row?.left ?? false,
      lines: own?.lines ?? [],
      total: own?.total ?? null,
      files: versions.map((v) => v.file),
      attachments: [],
      joined,
      issues,
    };
  };
  return [
    ...status.map((r, i) => {
      const t = taken.get(r);
      return make(r, t?.group ?? [], t ? t.how : "SHEET_ONLY", i);
    }),
    ...only.map((g, i) => make(null, g, "FILE_ONLY", i)),
  ];
}

/** A licence order form, a purchase order or an invoice, by its name: somebody ordered. */
const ORDERED = /\b(eu[fl]|end user|order form|licen[cs]e form|purchase order|po|invoice|so)\b|\.xls$/i;

/**
 * The papers nobody reads — order forms, agreements, spec sheets — each put beside a proposal of its company: the latest
 * one filed in the same folder, else the nearest of that name. A folder with none is a proposal of papers only, so nothing
 * in it is lost. One said to be unknown with an order form beside it was probably won, and says so.
 */
export function attachPapers(proposals: OldProposal[], papers: readonly string[]): { proposals: OldProposal[]; loose: string[] } {
  const folderOf = (f: string) => f.split("/").slice(0, 2).join("/");
  const inFolder = new Map<string, OldProposal[]>();
  for (const p of proposals) for (const f of new Set(p.files.map(folderOf))) inFolder.set(f, [...(inFolder.get(f) ?? []), p]);
  const newest = (list: OldProposal[]) => [...list].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))[0];
  const out = [...proposals];
  const loose: string[] = [];
  const byFolder = new Map<string, OldProposal | null>();
  for (const file of papers) {
    const parts = file.split("/");
    if (parts.length < 3) {
      loose.push(file);
      continue;
    }
    const folder = folderOf(file);
    if (!byFolder.has(folder)) {
      const name = parts[1]!;
      const year = parts[0]!;
      const named = newest(inFolder.get(folder) ?? []) ?? newest(proposals.filter((p) => p.year === year && [p.company, ...p.alsoNamed].some((n) => sameCompany(n, name)))) ?? newest(proposals.filter((p) => [p.company, ...p.alsoNamed].some((n) => sameCompany(n, name))));
      if (named) byFolder.set(folder, named);
      else {
        const made: OldProposal = { key: `P:${folder}`, ref: "", year, date: null, company: name, alsoNamed: [], contact: "", phone: "", email: "", address: "", madeBy: "", product: "Papers only", status: "UNKNOWN", remarks: "", left: false, lines: [], total: null, files: [], attachments: [], joined: "FILE_ONLY", issues: ["Only papers in its folder: no proposal was read"] };
        out.push(made);
        byFolder.set(folder, made);
      }
    }
    byFolder.get(folder)!.attachments.push(file);
  }
  for (const p of out) if (p.status === "UNKNOWN" && p.attachments.some((f) => ORDERED.test((f.split("/").pop() ?? "").replace(/[_-]/g, " ")))) p.issues.push("An order form or a purchase order is in its folder: probably won");
  return { proposals: out, loose };
}
