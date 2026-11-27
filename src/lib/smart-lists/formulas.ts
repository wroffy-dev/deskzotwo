/**
 * Formula columns (owner, 20 Nov 2026 — Smart Lists phase 4: "Qty × Rate", "Days until Expires on", "Cost ÷ Links",
 * "Overdue"). An expression over the row's other columns, worked out by Deskzo and kept like any value, so it filters,
 * sorts and adds up. Never typed in. Pure and client-safe: the column dialog checks an expression as it's typed, and the
 * server (src/lib/smart-lists/formula-server.ts) works it out with the same code. No eval — a small parser of its own.
 *
 *   {Qty} * {Rate}                       columns by name, in braces
 *   days_until({Expires on})             today(), days_until, days_since, days_between, add_days, year, month
 *   if({Status} = "Live", {Cost}, 0)     if, and, or, not, = != < <= > >=
 *   round({Cost} / {Links}, 2)           round, floor, ceil, abs, min, max, sum
 *   concat({City}, " — ", {Owner})       concat, upper, lower, len, empty
 */

export const FORMULA_FORMATS = ["number", "money", "days", "date", "checkbox", "text"] as const;
export type FormulaFormat = (typeof FORMULA_FORMATS)[number];
export const FORMAT_LABELS: Record<FormulaFormat, string> = { number: "A number", money: "Money", days: "Days", date: "A date", checkbox: "Yes or no (a tick)", text: "Text" };
export type Formula = { expr: string; format: FormulaFormat };
export const FORMULA_MAX = 500;

export function formulaOf(options: unknown): Formula | null {
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  const o = options as Partial<Formula>;
  if (typeof o.expr !== "string" || !o.expr.trim()) return null;
  return { expr: o.expr.slice(0, FORMULA_MAX), format: (FORMULA_FORMATS as readonly string[]).includes(String(o.format)) ? (o.format as FormulaFormat) : "number" };
}

/** Whether an expression changes with the day — worked out again each morning. */
export const usesToday = (expr: string) => /\b(today|days_until|days_since)\s*\(/i.test(expr);

// ─── Tokens ───────────────────────────────────────────────────────────────────

type Tok = { t: "num"; v: number } | { t: "str"; v: string } | { t: "col"; v: string } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+/.exec(src.slice(i));
      if (!m) throw new Error(`A number is written wrongly near "${src.slice(i, i + 8)}".`);
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error("Some words in quotes are never closed.");
      out.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === "{") {
      const end = src.indexOf("}", i + 1);
      if (end < 0) throw new Error("A column name in { } is never closed.");
      out.push({ t: "col", v: src.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }
    if (/[a-z_]/i.test(c)) {
      const m = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0].toLowerCase() });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if ([">=", "<=", "!=", "==", "<>", "&&", "||"].includes(two)) {
      out.push({ t: "op", v: two === "==" ? "=" : two === "<>" ? "!=" : two === "&&" ? "and" : two === "||" ? "or" : two });
      i += 2;
      continue;
    }
    if ("+-*/%()<>=,&".includes(c)) {
      out.push({ t: "op", v: c });
      i += 1;
      continue;
    }
    throw new Error(`"${c}" can't be used in a formula.`);
  }
  return out;
}

// ─── Parse ────────────────────────────────────────────────────────────────────

export type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "col"; id: string; name: string }
  | { k: "fn"; name: string; args: Node[] }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node };

const FUNCTIONS: Record<string, [number, number]> = {
  today: [0, 0],
  days_until: [1, 1],
  days_since: [1, 1],
  days_between: [2, 2],
  add_days: [2, 2],
  year: [1, 1],
  month: [1, 1],
  if: [2, 3],
  round: [1, 2],
  floor: [1, 1],
  ceil: [1, 1],
  abs: [1, 1],
  min: [1, 20],
  max: [1, 20],
  sum: [1, 20],
  concat: [1, 20],
  upper: [1, 1],
  lower: [1, 1],
  len: [1, 1],
  empty: [1, 1],
  not: [1, 1],
};
export const FUNCTION_NAMES = Object.keys(FUNCTIONS);

const PRECEDENCE: Record<string, number> = { or: 1, and: 2, "=": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "&": 5, "*": 6, "/": 6, "%": 6 };

/** An expression parsed against the list's columns (by name, whatever the case) — or why it can't be. */
export function compileFormula(expr: string, columns: { id: string; name: string }[], self?: string): { ok: true; node: Node; refs: string[] } | { ok: false; error: string } {
  if (!expr.trim()) return { ok: false, error: "Write the formula." };
  if (expr.length > FORMULA_MAX) return { ok: false, error: `A formula is ${FORMULA_MAX} characters at most.` };
  let toks: Tok[];
  try {
    toks = tokenize(expr);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  let pos = 0;
  const refs = new Set<string>();
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;
  const opOf = (tk: Tok | undefined): string | null => (tk?.t === "op" ? tk.v : tk?.t === "id" && (tk.v === "and" || tk.v === "or") ? tk.v : null);

  const primary = (): Node => {
    const tk = toks[pos++];
    if (!tk) throw new Error("The formula ends too soon.");
    if (tk.t === "num") return { k: "num", v: tk.v };
    if (tk.t === "str") return { k: "str", v: tk.v };
    if (tk.t === "col") {
      const col = columns.find((c) => c.name.toLowerCase() === tk.v.toLowerCase());
      if (!col) throw new Error(`There's no column called "${tk.v}".`);
      if (self && col.id === self) throw new Error("A formula can't use its own column.");
      refs.add(col.id);
      return { k: "col", id: col.id, name: col.name };
    }
    if (tk.t === "op" && tk.v === "(") {
      const n = expression(0);
      if (!isOp(")")) throw new Error("A ( is never closed.");
      pos += 1;
      return n;
    }
    if (tk.t === "op" && tk.v === "-") return { k: "un", op: "-", a: primary() };
    if (tk.t === "id") {
      if (tk.v === "true" || tk.v === "false") return { k: "bool", v: tk.v === "true" };
      if (tk.v === "not" && !isOp("(")) return { k: "un", op: "not", a: primary() };
      const arity = FUNCTIONS[tk.v];
      if (!arity) throw new Error(`"${tk.v}" isn't a formula word. Columns go in { } — {${tk.v}}.`);
      if (!isOp("(")) throw new Error(`${tk.v} needs ( ) after it.`);
      pos += 1;
      const args: Node[] = [];
      if (!isOp(")")) {
        for (;;) {
          args.push(expression(0));
          if (isOp(",")) {
            pos += 1;
            continue;
          }
          break;
        }
      }
      if (!isOp(")")) throw new Error(`${tk.v}( is never closed.`);
      pos += 1;
      if (args.length < arity[0] || args.length > arity[1]) throw new Error(`${tk.v} takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]} to ${arity[1]}`} value${arity[1] === 1 ? "" : "s"}.`);
      return { k: "fn", name: tk.v, args };
    }
    throw new Error(`Something's missing before "${tk.t === "op" ? tk.v : ""}".`);
  };

  const expression = (min: number): Node => {
    let left = primary();
    for (;;) {
      const op = opOf(peek());
      if (!op || op === ")" || op === ",") break;
      const p = PRECEDENCE[op];
      if (p === undefined || p <= min) break;
      pos += 1;
      left = { k: "bin", op, a: left, b: expression(p) };
    }
    return left;
  };

  try {
    const node = expression(0);
    if (pos < toks.length) throw new Error("Something is left over at the end — an operator missing?");
    return { ok: true, node, refs: [...refs] };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── Evaluate ─────────────────────────────────────────────────────────────────

export type Val = number | string | boolean | null;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const asDay = (v: Val): string | null => (typeof v === "string" && DAY.test(v) && !Number.isNaN(ms(v)) ? v : null);
const asNum = (v: Val): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const truthy = (v: Val) => v !== null && v !== false && v !== 0 && v !== "";
const text = (v: Val) => (v === null ? "" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));
const plusDays = (d: string, n: number) => new Date(ms(d) + Math.round(n) * 86_400_000).toISOString().slice(0, 10);

/** A parsed formula worked out for one row: `value` reads a column's value there, as words or numbers. */
export function evaluate(node: Node, value: (propertyId: string) => Val, today: string): Val {
  const ev = (n: Node): Val => evaluate(n, value, today);
  switch (n_k(node)) {
    case "num":
      return (node as { v: number }).v;
    case "str":
      return (node as { v: string }).v;
    case "bool":
      return (node as { v: boolean }).v;
    case "col":
      return value((node as { id: string }).id);
    case "un": {
      const u = node as { op: string; a: Node };
      const a = ev(u.a);
      if (u.op === "not") return !truthy(a);
      const n = asNum(a);
      return n === null ? null : -n;
    }
    case "bin": {
      const b = node as { op: string; a: Node; b: Node };
      if (b.op === "and") return truthy(ev(b.a)) && truthy(ev(b.b));
      if (b.op === "or") return truthy(ev(b.a)) || truthy(ev(b.b));
      const x = ev(b.a);
      const y = ev(b.b);
      if (b.op === "&") return text(x) + text(y);
      if (b.op === "=" || b.op === "!=") {
        const same = x === null || y === null ? x === y : typeof x === "string" && typeof y === "string" ? x.toLowerCase() === y.toLowerCase() : asNum(x) !== null && asNum(y) !== null ? asNum(x) === asNum(y) : x === y;
        return b.op === "=" ? same : !same;
      }
      if (["<", "<=", ">", ">="].includes(b.op)) {
        if (x === null || y === null) return false;
        const dx = asDay(x);
        const dy = asDay(y);
        const nx = dx && dy ? ms(dx) : asNum(x);
        const ny = dx && dy ? ms(dy) : asNum(y);
        if (nx === null || ny === null) return false;
        return b.op === "<" ? nx < ny : b.op === "<=" ? nx <= ny : b.op === ">" ? nx > ny : nx >= ny;
      }
      // A date and a number of days.
      if ((b.op === "+" || b.op === "-") && asDay(x) && asNum(y) !== null) return plusDays(asDay(x)!, b.op === "+" ? asNum(y)! : -asNum(y)!);
      if (b.op === "-" && asDay(x) && asDay(y)) return Math.round((ms(asDay(x)!) - ms(asDay(y)!)) / 86_400_000);
      const nx = asNum(x);
      const ny = asNum(y);
      if (nx === null || ny === null) return null;
      if (b.op === "+") return nx + ny;
      if (b.op === "-") return nx - ny;
      if (b.op === "*") return nx * ny;
      if (b.op === "/") return ny === 0 ? null : nx / ny;
      if (b.op === "%") return ny === 0 ? null : nx % ny;
      return null;
    }
    case "fn": {
      const f = node as { name: string; args: Node[] };
      const a = f.args.map(ev);
      const n0 = asNum(a[0] ?? null);
      switch (f.name) {
        case "today":
          return today;
        case "days_until": {
          const d = asDay(a[0]!);
          return d ? Math.round((ms(d) - ms(today)) / 86_400_000) : null;
        }
        case "days_since": {
          const d = asDay(a[0]!);
          return d ? Math.round((ms(today) - ms(d)) / 86_400_000) : null;
        }
        case "days_between": {
          const d1 = asDay(a[0]!);
          const d2 = asDay(a[1]!);
          return d1 && d2 ? Math.round((ms(d2) - ms(d1)) / 86_400_000) : null;
        }
        case "add_days": {
          const d = asDay(a[0]!);
          const n = asNum(a[1]!);
          return d && n !== null ? plusDays(d, n) : null;
        }
        case "year":
          return asDay(a[0]!) ? Number(asDay(a[0]!)!.slice(0, 4)) : null;
        case "month":
          return asDay(a[0]!) ? Number(asDay(a[0]!)!.slice(5, 7)) : null;
        case "if":
          return truthy(a[0]!) ? a[1]! : (a[2] ?? null);
        case "round": {
          const places = Math.max(0, Math.min(6, Math.round(asNum(a[1] ?? 0) ?? 0)));
          return n0 === null ? null : Math.round(n0 * 10 ** places) / 10 ** places;
        }
        case "floor":
          return n0 === null ? null : Math.floor(n0);
        case "ceil":
          return n0 === null ? null : Math.ceil(n0);
        case "abs":
          return n0 === null ? null : Math.abs(n0);
        case "min":
        case "max":
        case "sum": {
          const nums = a.map(asNum).filter((x): x is number => x !== null);
          if (!nums.length) return null;
          return f.name === "min" ? Math.min(...nums) : f.name === "max" ? Math.max(...nums) : nums.reduce((s, x) => s + x, 0);
        }
        case "concat":
          return a.map(text).join("");
        case "upper":
          return text(a[0]!).toUpperCase();
        case "lower":
          return text(a[0]!).toLowerCase();
        case "len":
          return text(a[0]!).length;
        case "empty":
          return a[0] === null || a[0] === "";
        case "not":
          return !truthy(a[0]!);
      }
      return null;
    }
  }
  return null;
}

const n_k = (n: Node) => n.k;

/** A result kept as its column's format says: a number, a day, a tick, words — or nothing. */
export function asFormat(v: Val, format: FormulaFormat): number | string | boolean | null {
  switch (format) {
    case "number":
    case "money":
    case "days": {
      const n = asNum(v);
      return n === null ? null : Math.round(n * 100) / 100;
    }
    case "date":
      return asDay(v);
    case "checkbox":
      return truthy(v) ? true : null;
    case "text": {
      const s = text(v).slice(0, 2000);
      return s ? s : null;
    }
  }
}
