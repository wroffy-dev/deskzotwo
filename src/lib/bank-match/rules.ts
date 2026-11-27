import { z } from "zod";
import type { ToolSpec } from "@/lib/copilot/types";

/**
 * Arjun reading the bank's money-in lines that nothing in the books matches yet (owner, 20 Nov 2026 — "yes build it,
 * money in first"), without a database: whose money it is, which of their open invoices it pays, and in words why.
 * Pure, so the server (./server.ts), the Banking screen and check:bank-match read the same answers.
 *
 *   · **Rules first, free.** An open invoice's number in the narration; a customer's name in it (the words that tell
 *     one company from another, not "Pvt Ltd"); then what the amount fits among that customer's open invoices — one
 *     exactly, several adding up to it, one less TDS, part of the one the narration names — or, failing those, their
 *     account. With no name to go on, an amount only one open invoice in the workspace has.
 *   · **Deskzo AI for what's left**, when somebody asks (./server.ts): a narration the rules couldn't read.
 *   · **Never twice.** A receipt of the same amount already in the books, unmatched, is offered to be matched — never
 *     recorded again. And nothing is recorded until a person confirms it.
 */

export type MoneyInLine = { id: string; date: Date; narration: string; reference: string | null; amount: number };
export type OpenInvoice = { id: string; number: string; companyId: string; companyName: string; balance: number; total: number; taxable: number; issueDate: Date };
export type Customer = { id: string; name: string };
/** A receipt already in the books on this account that no statement line is matched to. */
export type UnmatchedReceipt = { id: string; date: Date; amount: number; narration: string };

export type ProposalKind = "EXACT" | "SEVERAL" | "TDS" | "PART" | "ON_ACCOUNT" | "IN_BOOKS";
export type Proposal = {
  statementLineId: string;
  kind: ProposalKind;
  companyId: string | null;
  companyName: string | null;
  /** What goes onto which invoice; the rest of the line, if any, stays on the customer's account. */
  allocations: { invoiceId: string; number: string; amount: number }[];
  /** For IN_BOOKS: the receipt already recorded. */
  bookLineId: string | null;
  how: "INVOICE" | "NAME" | "AMOUNT" | "AI";
  confidence: "HIGH" | "MEDIUM";
  why: string;
  /** The UTR or reference the narration carries, for the payment. */
  reference: string | null;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number, by = 0.5) => Math.abs(a - b) <= by;
const rupees = (n: number) => `₹${r2(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const DAY = 86_400_000;

// ─── Reading a narration ──────────────────────────────────────────────────────────────────────────────────────────

/** Words in company names that don't tell one company from another. */
const COMMON = new Set(
  "pvt private ltd limited llp llc inc corp corporation co company india indian the and of m s ms technologies technology tech solutions solution services service enterprises enterprise industries industry international group systems system global infotech infosystems consultancy consultants consulting trading traders agencies agency associates".split(
    " ",
  ),
);
/** Words a bank puts in narrations that aren't anybody's name. */
const BANKING = new Set(
  "neft rtgs imps upi cr dr inb ib mb by to from transfer trf tfr credit debit cheque chq clg clearing payment pay ref utr txn tran a c ac acct account bank fund funds received rcvd inward ach nach ecs cms int".split(" "),
);

export const squash = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** A name's telling words: lower case, at least three letters, not "Pvt", "Ltd", "Solutions" and the like. */
export function nameWords(name: string): string[] {
  return [...new Set(words(name).filter((w) => w.length >= 3 && !COMMON.has(w) && !/^\d+$/.test(w)))];
}

/**
 * How well a narration names a customer, 0 to 1: the share of the name's telling words in it — as words, or run
 * together (banks drop spaces: "ACMESOLUTIONS") for a word of four letters or more. Nothing without one such word.
 */
export function nameScore(narration: string, name: string): number {
  // A bank's own words (NEFT, UPI, Transfer) never name anybody, even in a company called "Neft Traders".
  const telling = nameWords(name).filter((w) => !BANKING.has(w));
  if (!telling.length) return 0;
  const said = new Set(words(narration).filter((w) => !BANKING.has(w)));
  const run = squash(narration);
  let found = 0;
  let strong = false;
  for (const w of telling) {
    const hit = said.has(w) || (w.length >= 4 && run.includes(w));
    if (hit) {
      found += 1;
      if (w.length >= 4) strong = true;
    }
  }
  return strong ? found / telling.length : 0;
}

/** The UTR or reference a narration carries: the statement's own, else a long run of letters and digits in it. */
export function referenceOf(line: Pick<MoneyInLine, "narration" | "reference">): string | null {
  if (line.reference?.trim()) return line.reference.trim().slice(0, 60);
  const runs = line.narration.toUpperCase().match(/\b(?=[A-Z0-9]*\d)[A-Z0-9]{12,22}\b/g);
  return runs?.[0] ?? null;
}

/** Open invoices the narration names by number — a number with letters in it, so a UTR's digits can't pass for one. */
export function invoicesNamed(narration: string, invoices: OpenInvoice[]): OpenInvoice[] {
  const run = squash(narration);
  return invoices.filter((i) => {
    const n = squash(i.number);
    return n.length >= 4 && /[a-z]/.test(n) && /\d/.test(n) && run.includes(n);
  });
}

// ─── What an amount fits ──────────────────────────────────────────────────────────────────────────────────────────

/** TDS a customer may deduct before paying: on the value before GST, or on the whole. */
const TDS_RATES = [0.1, 0.02, 0.01, 0.05];

export type Fit = { kind: Exclude<ProposalKind, "IN_BOOKS">; allocations: { invoiceId: string; number: string; amount: number }[]; why: string };

/** Sets of up to four of `pool` adding up to `amount` — at most two found, so one can be told from none or many. */
function subsets(pool: OpenInvoice[], amount: number): OpenInvoice[][] {
  const out: OpenInvoice[][] = [];
  const n = Math.min(pool.length, 14);
  const walk = (start: number, chosen: OpenInvoice[], sum: number) => {
    if (out.length >= 2) return;
    if (chosen.length >= 2 && near(sum, amount)) {
      out.push([...chosen]);
      return;
    }
    if (chosen.length === 4 || sum > amount + 0.5) return;
    for (let i = start; i < n; i++) walk(i + 1, [...chosen, pool[i]!], sum + pool[i]!.balance);
  };
  walk(0, [], 0);
  return out;
}

/**
 * What `amount` pays among one customer's open invoices (oldest first), preferring those the narration names: one
 * exactly; several adding up to it, when only one set does; one less TDS; part of the one named; else their account.
 */
export function fitAmount(amount: number, invoices: OpenInvoice[], named: OpenInvoice[] = [], opts: { india?: boolean } = {}): Fit {
  const pool = [...invoices].sort((a, b) => a.issueDate.getTime() - b.issueDate.getTime());
  const one = (i: OpenInvoice, amt: number) => ({ invoiceId: i.id, number: i.number, amount: r2(amt) });
  const exact = (named.length ? named : pool).filter((i) => near(i.balance, amount));
  const exactAny = exact.length ? exact : pool.filter((i) => near(i.balance, amount));
  if (exactAny.length === 1) return { kind: "EXACT", allocations: [one(exactAny[0]!, amount)], why: `exactly what's open on ${exactAny[0]!.number}` };
  if (exactAny.length > 1) {
    // Two of the same amount: the oldest — the one most likely paid first — said as such.
    return { kind: "EXACT", allocations: [one(exactAny[0]!, amount)], why: `what's open on ${exactAny[0]!.number}, the oldest of ${exactAny.length} invoices of that amount` };
  }
  const sets = subsets(named.length >= 2 ? named : pool, amount);
  if (sets.length === 1) {
    const set = sets[0]!;
    return { kind: "SEVERAL", allocations: set.map((i) => one(i, i.balance)), why: `${set.map((i) => i.number).join(" + ")} add up to it exactly` };
  }
  // A customer deducting TDS before paying is India's (src/lib/country-pack.ts); elsewhere it isn't looked for.
  for (const i of opts.india === false ? [] : named.length ? named : pool) {
    if (!near(i.balance, i.total)) continue; // TDS is taken off an invoice paid in one go
    for (const rate of TDS_RATES) {
      for (const base of [i.taxable, i.total]) {
        const short = r2(base * rate);
        if (short > 0 && near(i.total - short, amount, 1)) {
          return { kind: "TDS", allocations: [one(i, amount)], why: `${i.number} less ${rate * 100}% TDS (${rupees(short)}) — the TDS stays open until their certificate comes` };
        }
      }
    }
  }
  if (named.length === 1 && amount < named[0]!.balance) {
    return { kind: "PART", allocations: [one(named[0]!, amount)], why: `part of ${named[0]!.number}, which the narration names — ${rupees(named[0]!.balance - amount)} would stay open` };
  }
  return { kind: "ON_ACCOUNT", allocations: [], why: "nothing open adds up to it — kept on their account, to apply later" };
}

// ─── A proposal for each line ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What Arjun proposes for each money-in line the books don't match, or nothing where he can't tell. `guesses` are Deskzo
 * AI's for lines the rules couldn't place (./server.ts), applied the same way.
 */
export function proposeMoneyIn(
  lines: MoneyInLine[],
  ctx: { invoices: OpenInvoice[]; customers: Customer[]; unmatched: UnmatchedReceipt[]; guesses?: Map<string, { companyId: string | null; documentIds: string[]; why: string }>; india?: boolean },
): Proposal[] {
  const out: Proposal[] = [];
  const byCompany = new Map<string, OpenInvoice[]>();
  for (const i of ctx.invoices) byCompany.set(i.companyId, [...(byCompany.get(i.companyId) ?? []), i]);
  const nameOf = new Map(ctx.customers.map((c) => [c.id, c.name]));
  const takenReceipts = new Set<string>();

  for (const line of lines) {
    if (line.amount <= 0) continue;
    const reference = referenceOf(line);
    const base = { statementLineId: line.id, reference, bookLineId: null as string | null };

    // Already in the books, unmatched: match it — never record it twice.
    const same = ctx.unmatched.filter((u) => !takenReceipts.has(u.id) && near(u.amount, line.amount, 0.005) && Math.abs(u.date.getTime() - line.date.getTime()) <= 30 * DAY);
    if (same.length) {
      const u = same.sort((a, b) => Math.abs(a.date.getTime() - line.date.getTime()) - Math.abs(b.date.getTime() - line.date.getTime()))[0]!;
      takenReceipts.add(u.id);
      out.push({ ...base, kind: "IN_BOOKS", companyId: null, companyName: null, allocations: [], bookLineId: u.id, how: "AMOUNT", confidence: same.length === 1 ? "HIGH" : "MEDIUM", why: `${same.length === 1 ? "A receipt" : `${same.length} receipts`} of this amount ${same.length === 1 ? "is" : "are"} already in the books — "${u.narration.slice(0, 60)}". Match it rather than record it again.` });
      continue;
    }

    // Who: an invoice named in it, else a name in it, else the AI's guess.
    let companyId: string | null = null;
    let how: Proposal["how"] = "NAME";
    let confidence: Proposal["confidence"] = "HIGH";
    let because = "";
    const named = invoicesNamed(line.narration, ctx.invoices);
    const namedCompanies = [...new Set(named.map((i) => i.companyId))];
    if (namedCompanies.length === 1) {
      companyId = namedCompanies[0]!;
      how = "INVOICE";
      because = `the narration names ${named.map((i) => i.number).join(", ")}`;
    } else {
      const scored = ctx.customers.map((c) => ({ c, s: nameScore(line.narration, c.name) })).filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s);
      const top = scored[0];
      // A bank cuts long names short: "GAMMA FOODS" may be Gamma Foods or Gamma Foods Retail — another customer whose name
      // holds all of the top one's telling words makes it a guess, left to Deskzo AI or a person.
      const rival = top ? scored.slice(1).find((x) => x.s >= top.s - 0.001 || nameWords(top.c.name).every((w) => nameWords(x.c.name).includes(w))) : undefined;
      if (top && !rival) {
        companyId = top.c.id;
        confidence = top.s >= 0.99 ? "HIGH" : "MEDIUM";
        because = `the narration names ${top.c.name}`;
      }
    }
    const guess = ctx.guesses?.get(line.id);
    if (!companyId && guess?.companyId && nameOf.has(guess.companyId)) {
      companyId = guess.companyId;
      how = "AI";
      confidence = "MEDIUM";
      because = guess.why;
    }

    if (companyId) {
      const open = byCompany.get(companyId) ?? [];
      const prefer = how === "AI" ? open.filter((i) => guess!.documentIds.includes(i.id)) : named.filter((i) => i.companyId === companyId);
      const fit = fitAmount(line.amount, open, prefer, { india: ctx.india });
      out.push({ ...base, kind: fit.kind, companyId, companyName: nameOf.get(companyId) ?? null, allocations: fit.allocations, how, confidence: fit.kind === "ON_ACCOUNT" ? "MEDIUM" : confidence, why: `${capital(because)}; ${fit.why}.` });
      continue;
    }

    // No name to go on: an amount only one open invoice has, raised in the last six months.
    const recent = ctx.invoices.filter((i) => near(i.balance, line.amount) && line.date.getTime() - i.issueDate.getTime() <= 183 * DAY && i.issueDate.getTime() <= line.date.getTime() + DAY);
    if (recent.length === 1) {
      const i = recent[0]!;
      out.push({ ...base, kind: "EXACT", companyId: i.companyId, companyName: i.companyName, allocations: [{ invoiceId: i.id, number: i.number, amount: line.amount }], how: "AMOUNT", confidence: "MEDIUM", why: `Only ${i.number} (${i.companyName}) has exactly this open — check the narration is theirs.` });
    }
  }
  return out;
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

// ─── Deskzo AI, for what's left ───────────────────────────────────────────────────────────────────────────────────

export const MATCH_SYSTEM = [
  "You read Indian bank statement lines — money received — and say which of our customers each is from, and which of their open invoices it pays.",
  "Use only the lines and the customers given. A narration often holds the payer's name, shortened, run together or cut off, with bank words around it (NEFT, IMPS, UPI, RTGS, a UTR, the payer's bank).",
  "Pick a customer only when the narration names them; never on the amount alone. invoices: those of that customer's listed invoices the money pays, if you can tell.",
  "why: a few words on what in the narration told you — \"ACMESOLN is Acme Solutions\". For a line you can't place, customer null.",
  "Call propose_matches exactly once, with one entry per line.",
].join(" ");

export const PROPOSE_MATCHES: ToolSpec = {
  name: "propose_matches",
  description: "Hand back who each line is from. Call it once.",
  parameters: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            line: { type: "number", description: "The line's number as listed." },
            customer: { type: ["number", "null"], description: "The customer's number as listed, or null." },
            invoices: { type: "array", items: { type: "string" }, description: "Invoice numbers of that customer's, if you can tell." },
            why: { type: "string" },
          },
          required: ["line", "customer", "why"],
        },
      },
    },
    required: ["matches"],
  },
};

export const matchesSchema = z.object({
  matches: z
    .array(
      z.object({
        line: z.coerce.number().int(),
        customer: z.coerce.number().int().nullable().catch(null),
        invoices: z.array(z.string()).optional().catch(undefined),
        why: z.string().trim().catch("").transform((s) => s.replace(/\s+/g, " ").slice(0, 200)),
      }),
    )
    .catch([]),
});

/** What the model reads: the lines, numbered, and the customers it may pick from, numbered, with their open invoices. */
export function matchPrompt(lines: MoneyInLine[], customers: (Customer & { invoices: OpenInvoice[] })[]): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return [
    "Money received, not yet placed:",
    ...lines.map((l, i) => `${i + 1}. ${day(l.date)} · ${rupees(l.amount)} · ${l.narration}${l.reference ? ` · ref ${l.reference}` : ""}`),
    "",
    "Our customers with money open:",
    ...customers.map((c, i) => `${i + 1}. ${c.name}${c.invoices.length ? ` — ${c.invoices.slice(0, 6).map((v) => `${v.number} ${rupees(v.balance)}`).join("; ")}` : ""}`),
  ].join("\n");
}
