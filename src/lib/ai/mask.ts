import { createHash } from "node:crypto";
import type { Turn } from "@/lib/copilot/types";

/**
 * Customer data masked before it reaches an AI provider, and put back in what comes out (owner, 23 Nov 2026 — "we
 * will use the API, but the data goes masked"). Names, phone numbers, emails and Indian IDs are swapped for
 * placeholders — "Bisleri Pvt Ltd" becomes COMPANY_K7F3Q — the model works with those, and its answer and its tool
 * calls are given the real values back before anybody sees them or anything runs.
 *
 *   · Found by code, not by another model: the workspace's own companies, contacts and people (./mask-names.ts), the
 *     name and address fields of what a lookup returned, and patterns for emails, phones, GSTIN, PAN, Aadhaar, IFSC,
 *     cards, account numbers, street addresses and companies by their legal ending. Deterministic — no model guesses.
 *   · A saved person's first or last name alone is masked too, as itself: "Rahul" comes back as "Rahul", whichever
 *     Rahul was meant.
 *   · A value always gets the same placeholder in a workspace (a hash of it, salted with the workspace), so a
 *     conversation's earlier turns — Claude's thinking blocks among them, replayed exactly as they came back — and
 *     the provider's cache stay valid from turn to turn.
 *   · Left as they are, on purpose: amounts, dates, counts, record references (COM-000123) and products — the work
 *     needs them, and without a name they belong to nobody — and a city, state or PIN code in its own field.
 *   · Not caught: a name Deskzo doesn't hold, a misspelling, or an address written in a way the patterns don't know.
 *   · Images and PDFs can't be masked: the gateway refuses to send one to a masked account, and `maskHistory` drops it.
 *   · A saved turn not written from masked data is sent as its words alone, masked — never its provider's own form,
 *     whose thinking (signed, or encrypted) holds the real values and can't be changed.
 *
 * Pure — the names are handed in. Server only (node:crypto).
 */

export type MaskKind = "COMPANY" | "PERSON" | "ADDRESS" | "EMAIL" | "PHONE" | "GSTIN" | "PAN" | "AADHAAR" | "IFSC" | "ACCOUNT" | "CARD";
export type NamedEntry = { value: string; kind: "COMPANY" | "PERSON" };

const KINDS = "COMPANY|PERSON|ADDRESS|EMAIL|PHONE|GSTIN|PAN|AADHAAR|IFSC|ACCOUNT|CARD";
/** A placeholder: its kind, then five or more letters and digits from base32. */
const PLACEHOLDER = new RegExp(`\\b(?:${KINDS})_[A-Z2-7]{5,10}\\b`, "g");
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** In the order they are looked for: a card before an Aadhaar, an email before anything inside it. */
const PATTERNS: { kind: MaskKind; re: RegExp; key: (s: string) => string }[] = [
  { kind: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, key: (s) => s.toLowerCase() },
  { kind: "GSTIN", re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi, key: (s) => s.toUpperCase() },
  { kind: "PAN", re: /\b[A-Z]{5}\d{4}[A-Z]\b/gi, key: (s) => s.toUpperCase() },
  { kind: "IFSC", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi, key: (s) => s.toUpperCase() },
  { kind: "CARD", re: /\b(?:\d{4}[ -]){3}\d{4}\b/g, key: (s) => s.replace(/\D/g, "") },
  { kind: "AADHAAR", re: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/g, key: (s) => s.replace(/\D/g, "") },
  // An Indian mobile, with or without +91 / 0, spaced or not — never part of a longer number.
  { kind: "PHONE", re: /(?<![\w+])(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\w)/g, key: (s) => s.replace(/\D/g, "").slice(-10) },
  // A landline with its STD code — 022-27654321, (022) 2765 4321, +91 22 27654321 — and a number abroad, with its +.
  { kind: "PHONE", re: /(?<![\w+])(?:\+91[\s-]?\d{2,4}|\(0\d{2,4}\)|0\d{2,4})[\s-]\d{3,4}[\s-]?\d{3,4}(?!\w)/g, key: (s) => s.replace(/\D/g, "").replace(/^(?:91|0)/, "") },
  { kind: "PHONE", re: /(?<![\w+])\+[1-9]\d{0,2}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,5}){2,4}(?!\w)/g, key: (s) => s.replace(/\D/g, "") },
  // A bank account (or an unformatted card or Aadhaar): 11 to 18 digits standing alone, never after a currency sign.
  { kind: "ACCOUNT", re: /(?<![\w₹$.,])\d{11,18}(?![\w.,])/g, key: (s) => s },
];

/** Words that go before a street's name in a sentence, never in an address — "10 leads in Gandhi Nagar" is not one. */
const NOT_STREET =
  "in|on|at|near|the|from|for|of|by|to|and|with|is|are|was|leads?|orders?|customers?|compan(?:y|ies)|contacts?|visits?|tasks?|invoices?|quotes?|days?|weeks?|months?|years?|lakhs?|crores?|percent|units?|people|users?";
const ADDRESSES: RegExp[] = [
  // Its first part named, through to the PIN code: "Flat 4B, 12 MG Road, Pune 411001".
  /\b(?:flat|house|h\.?\s?no|plot|shop|office|unit|door|gala|survey|s\.?\s?no|bldg|building|block|wing|tower)\b\.?[ ]*(?:no\.?[ ]*)?[#:]?[ ]*[\w/-]{1,8}\b[^\n;|"{}]{3,160}?\b[1-9]\d{2} ?\d{3}\b/giu,
  // A number and a street: "12 MG Road", "45/2, Linking Rd".
  new RegExp(`(?<![\\w₹$.,-])#?\\d{1,5}[A-Za-z]?(?:[/-]\\d{1,4}[A-Za-z]?)?,? +(?:(?!(?:${NOT_STREET})\\b)[\\p{L}.]{1,20} +){1,3}(?:road|rd|street|marg|nagar|lane|colony|society|chowk|enclave|vihar|avenue|layout)\\b\\.?`, "giu"),
];

/** A company nobody has saved, by its legal ending: "Zenkraft Labs Pvt Ltd". Looked for after the names that are known. */
const LEGAL_NAME = /(?<![\p{L}\p{N}_])(?:\p{Lu}[\p{L}\p{N}&.'’-]* +(?:(?:&|and|of) +)?){1,6}(?:(?:Pvt\.?|Private|\(P\)) *(?:Ltd|Limited)|Ltd|Limited|LLP)(?![\p{L}\p{N}_])/gu;

/** A person's name that is really a desk, or a word the work needs — its parts are never masked alone. */
const NOT_A_PERSON = new Set(
  "purchase purchasing procurement dept department desk it helpdesk store stores project projects marketing operations operator reception director ceo cto cfo md gm incharge billing payment payments dispatch warehouse engineer technical customercare care service enquiry info contact person unknown na nil"
    .split(" "),
);
/** First and last names that are everyday words, places or products: masked only inside the whole name. */
const EVERYDAY = new Set(
  "will bill mark may grace hope joy rose art deep prince lucky april june august sunny rich frank pat page case price gold stone young long short king day green white black brown gray grey west east north south bank field park bell cross card cash file draft quote deal call mail note task item stock sale rate date time week month year today open close paid due high low top best good great first last next total amount invoice order lead company customer vendor india delhi mumbai pune goa chennai kolkata bengaluru hyderabad microsoft google adobe amazon oracle cisco dell apple zoho tally autodesk"
    .split(" "),
);
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "shri", "smt", "er", "ca", "adv", "prof", "sir", "md", "mohd"]);

/** Words a one-word name may not be — a company called "Sales" mustn't take the word out of every sentence. */
const STOP = new Set(
  "test demo india sales support admin account accounts office home team user users customer customers company lead leads order orders new main head none other default manager owner hr finance service services solutions technologies tech group global private limited ltd pvt llp inc corp the and for"
    .split(" "),
);

const WORD = /[\p{L}\p{N}_]+/gu;
/** What may sit between the words of one name: spaces, and the dots, ampersands and hyphens of "Pvt. Ltd." or "A & B". */
const GAP = /^[ \t.&'’-]{1,3}$/;

/** A name as it is looked up: lower case, words only, single spaces. */
export function nameKey(value: string): string {
  return (value.toLowerCase().match(WORD) ?? []).join(" ");
}

export class Masker {
  /** A name's key → the name, and the key its placeholder is made from (a company's own, for "Bisleri" alone). */
  private readonly names = new Map<string, NamedEntry & { canon: string }>();
  /** Street addresses learned from lookups. */
  private readonly addresses = new Set<string>();
  private maxWords = 1;
  /** placeholder → the value shown in its place; value key → placeholder. */
  private readonly back = new Map<string, string>();
  private readonly forward = new Map<string, string>();

  constructor(
    private readonly salt: string,
    names: Iterable<NamedEntry> = [],
  ) {
    for (const n of names) this.addName(n);
  }

  /** A name to mask from now on. Too short, or a common word alone, is left out. */
  addName(entry: NamedEntry): void {
    const key = nameKey(entry.value);
    if (!key || key.length < 3 || key.length > 120) return;
    const words = key.split(" ");
    if (words.length === 1 && (STOP.has(key) || /^\d+$/.test(key))) return;
    // A contact saved as "Purchase Team" is a desk, not somebody's name.
    if (entry.kind === "PERSON" && words.every((w) => STOP.has(w) || NOT_A_PERSON.has(w))) return;
    const known = this.names.get(key);
    if (known && known.canon === key) return;
    // A full name always wins over another's short form.
    this.names.set(key, { value: entry.value.trim(), kind: entry.kind, canon: key });
    this.maxWords = Math.max(this.maxWords, Math.min(words.length, 10));
    // A company as people type it: "Bisleri" for "Bisleri Pvt. Ltd.".
    if (entry.kind === "COMPANY") {
      const core = key.replace(SUFFIX, "").trim();
      if (core !== key && core.length >= 4 && !STOP.has(core)) {
        const other = this.names.get(core);
        if (!other) this.names.set(core, { value: entry.value.trim(), kind: "COMPANY", canon: key });
        // "Bisleri" of two Bisleri companies: masked as the short form itself, so it's never put back as the wrong one.
        else if (other.canon !== core && other.canon !== key) this.names.set(core, { value: shortOf(entry.value, core), kind: "COMPANY", canon: core });
      }
    } else if (words.length > 1 && words.length <= 5) this.addParts(entry.value, words);
  }

  /** "Rahul" and "Verma" of Rahul Verma, each as itself — unless it's a desk's name, a title or an everyday word. */
  private addParts(value: string, words: string[]): void {
    if (words.some((w) => STOP.has(w) || NOT_A_PERSON.has(w))) return;
    const written = value.match(WORD) ?? [];
    words.forEach((w, i) => {
      if (w.length < 3 || !/^\p{L}+$/u.test(w) || TITLES.has(w) || EVERYDAY.has(w) || this.names.has(w)) return;
      this.names.set(w, { value: written[i] ?? w, kind: "PERSON", canon: w });
    });
  }

  /** The names and addresses in what a lookup returned (JSON, whole or cut short), learned before anything is masked. */
  learnFromToolOutput(output: string): void {
    const t = output.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return;
    const { value, rest } = parseLoose(t);
    const found = (v: string, kind: "COMPANY" | "PERSON" | "ADDRESS") => (kind === "ADDRESS" ? this.addAddress(v) : this.addName({ value: v, kind }));
    if (value !== undefined) walk(value, null, found);
    // The record the cut went through: its fields one by one, the last perhaps half there.
    for (const m of rest.matchAll(/"(\w+)":\s*"((?:[^"\\…]|\\.)*)/g)) {
      const kind = ADDRESS_KEY.test(m[1]!) ? "ADDRESS" : PERSON_KEYS.has(m[1]!) ? "PERSON" : COMPANY_KEYS.has(m[1]!) || m[1] === "name" ? "COMPANY" : null;
      if (kind) found(m[2]!.replace(/\\n/g, "\n").replace(/\\(["\\/])/g, "$1"), kind);
    }
  }

  private addAddress(value: string): void {
    const v = value.trim();
    // A street, not a town on its own, an email address or a web one.
    if (v.length >= 8 && v.length <= 400 && /\s/.test(v) && /\d|,/.test(v) && !/@|:\/\//.test(v)) this.addresses.add(v);
  }

  /** Learned addresses, longest first, as they were returned — in JSON too, where a line break is written \n. */
  private maskAddresses(text: string): string {
    let out = text;
    for (const a of [...this.addresses].sort((x, y) => y.length - x.length)) {
      for (const form of new Set([JSON.stringify(a).slice(1, -1), a])) {
        if (out.includes(form)) out = out.split(form).join(this.placeholder("ADDRESS", nameKey(a), a));
      }
    }
    return out;
  }

  private placeholder(kind: MaskKind, key: string, shown: string): string {
    const known = this.forward.get(`${kind}|${key}`);
    if (known) return known;
    const digest = createHash("sha256").update(`${this.salt}|${kind}|${key}`).digest();
    for (let len = 5; len <= 10; len++) {
      let code = "";
      for (let i = 0; i < len; i++) code += B32[digest[i]! % 32];
      const token = `${kind}_${code}`;
      const taken = this.back.get(token);
      if (taken === undefined || taken === shown) {
        this.back.set(token, shown);
        this.forward.set(`${kind}|${key}`, token);
        return token;
      }
    }
    return shown; // Never reached in practice: ten characters of a hash collided too.
  }

  /** `text` with every name, number and ID it holds swapped for its placeholder. */
  mask(text: string): string {
    if (!text) return text;
    let out = this.maskAddresses(text);
    for (const p of PATTERNS) out = out.replace(p.re, (m) => this.placeholder(p.kind, p.key(m), m));
    for (const re of ADDRESSES) out = out.replace(re, (m) => this.placeholder("ADDRESS", nameKey(this.unmask(m)), this.unmask(m)));
    return this.maskNames(out).replace(LEGAL_NAME, (m) => this.placeholder("COMPANY", nameKey(m), m));
  }

  private maskNames(text: string): string {
    if (!this.names.size) return text;
    const words = [...text.matchAll(WORD)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, word: m[0].toLowerCase() }));
    let out = "";
    let at = 0;
    for (let i = 0; i < words.length; i++) {
      let found: { n: number; entry: NamedEntry & { canon: string } } | null = null;
      let key = "";
      for (let n = 1; n <= this.maxWords && i + n - 1 < words.length; n++) {
        const w = words[i + n - 1]!;
        if (n > 1 && !GAP.test(text.slice(words[i + n - 2]!.end, w.start))) break;
        key = n === 1 ? w.word : `${key} ${w.word}`;
        const entry = this.names.get(key);
        if (entry) found = { n, entry };
      }
      if (!found) continue;
      const first = words[i]!;
      const last = words[i + found.n - 1]!;
      out += text.slice(at, first.start) + this.placeholder(found.entry.kind, found.entry.canon, found.entry.value);
      at = last.end;
      // "Ltd." given back already ends in its dot: the one written after the name goes with it, never doubled.
      const trail = /[^\p{L}\p{N}]+$/u.exec(found.entry.value)?.[0];
      if (trail && text.startsWith(trail, at)) at += trail.length;
      i += found.n - 1;
    }
    return out + text.slice(at);
  }

  /** `text` with every placeholder this masker made given its value back; one it never made is left as written. */
  unmask(text: string): string {
    if (!text || !this.back.size) return text;
    return text.replace(PLACEHOLDER, (m) => this.back.get(m) ?? m);
  }

  /** Every string in `value` masked or unmasked — a tool call's input, a provider's own form of a turn. */
  deep(value: unknown, how: "mask" | "unmask"): unknown {
    if (typeof value === "string") return how === "mask" ? this.mask(value) : this.unmask(value);
    if (Array.isArray(value)) return value.map((v) => this.deep(v, how));
    if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      // Claude's thinking is signed: changed by a character, the provider refuses the turn. It was written about the
      // placeholders it was given, which stay the same from turn to turn.
      if (o.type === "thinking" || o.type === "redacted_thinking") return value;
      const keep = (k: string) => SKIP_KEYS.has(k) || (o.type === "tool_use" && k === "name");
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, keep(k) ? v : this.deep(v, how)]));
    }
    return value;
  }

  /**
   * A conversation as it is sent: names learned from every lookup first, then every turn's words, lookups and tool
   * inputs masked. Files (images, PDFs) are left out — they can't be masked, and the gateway refuses them before this.
   * A saved turn not written from masked data goes as its words alone, without its provider's own form.
   */
  maskHistory(history: readonly Turn[]): Turn[] {
    for (const t of history) if (t.role === "tool") for (const r of t.results) this.learnFromToolOutput(r.output);
    return history.map((t): Turn => {
      if (t.role === "user") return { role: "user", text: this.mask(t.text) };
      if (t.role === "note") return { ...t, text: this.mask(t.text) };
      if (t.role === "tool") return { ...t, results: t.results.map((r) => ({ ...r, output: this.mask(r.output) })) };
      const { native, ...rest } = t;
      return {
        ...rest,
        text: this.mask(t.text),
        toolCalls: t.toolCalls.map((c) => ({ ...c, input: this.deep(c.input, "mask") })),
        ...(native?.masked === true ? { native: { ...native, content: this.deep(native.content, "mask") } } : {}),
      };
    });
  }

  /**
   * The answer as it streams, its placeholders given back. A placeholder can arrive in two pieces, so a tail that
   * could be the start of one waits for the next piece.
   */
  streaming(emit: (delta: string) => void): { push: (delta: string) => void; end: () => void } {
    let pending = "";
    return {
      push: (delta) => {
        pending += delta;
        const tail = /[A-Z0-9_]{1,20}$/.exec(pending);
        const cut = tail ? tail.index : pending.length;
        if (cut > 0) {
          emit(this.unmask(pending.slice(0, cut)));
          pending = pending.slice(cut);
        }
      },
      end: () => {
        if (pending) emit(this.unmask(pending));
        pending = "";
      },
    };
  }
}

/** Ids, signatures and the like — never text about anybody. */
const SKIP_KEYS = new Set(["id", "tool_use_id", "signature", "thoughtSignature", "data", "media_type", "type"]);

/** The legal end of a company's name, left off for the short form people type. */
const SUFFIX = /(?:\s+(?:pvt|private|ltd|limited|llp|inc|corp|corporation|co|company|india|opc|plc|llc))+$/;

const COMPANY_KEYS = new Set(["company", "companyName", "customer", "customerName", "vendor", "vendorName", "client", "clientName", "party", "partyName", "organisation", "organization", "billTo", "shipTo"]);
const PERSON_KEYS = new Set([
  "contact", "contactName", "person", "personName", "owner", "ownerName", "manager", "managerName", "assignee", "assignedTo", "assigneeName", "employee", "employeeName",
  "user", "userName", "salesperson", "salesPerson", "createdBy", "updatedBy", "approver", "approvedBy", "requestedBy", "fullName", "reportsTo", "accountManager", "renewalManager",
]);

/** A field that holds a street address — never an email, web or IP one. */
const ADDRESS_KEY = /^(?:(?:billing|shipping|registered|office|site|delivery|home|permanent|current|full|street|postal|location)?_?address(?:_?line)?_?\d?|street\d?|line[12]|billTo|shipTo)$/i;

/** "BISLERI INTERNATIONAL Pvt Ltd" as its short form is written: as many words as `core` has. */
function shortOf(value: string, core: string): string {
  const last = [...value.matchAll(WORD)][core.split(" ").length - 1];
  return last ? value.slice(0, last.index! + last[0].length).trim() : core;
}

/** JSON as it is, or — cut short (src/lib/copilot/tools.ts `outputText`) — up to its last complete value, and what is left after it. */
function parseLoose(text: string): { value: unknown; rest: string } {
  try {
    return { value: JSON.parse(text), rest: "" };
  } catch {
    // Cut short: closed after its last complete value.
  }
  const open: string[] = [];
  let inString = false;
  let best: { at: number; close: string } | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") open.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      open.pop();
      best = { at: i + 1, close: [...open].reverse().join("") };
      if (!open.length) break;
    }
  }
  if (!best) return { value: undefined, rest: text };
  try {
    return { value: JSON.parse(text.slice(0, best.at) + best.close), rest: text.slice(best.at) };
  } catch {
    return { value: undefined, rest: text };
  }
}

/** The names and addresses in a lookup's JSON: a name field's value, a company or person field's value, and those inside. */
function walk(value: unknown, context: "COMPANY" | "PERSON" | null, found: (value: string, kind: "COMPANY" | "PERSON" | "ADDRESS") => void): void {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, context, found);
    return;
  }
  if (!value || typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  const looksLikeCompany = typeof o.ref === "string" ? /^COM-/i.test(o.ref) : "gstin" in o || "industry" in o || "website" in o;
  const looksLikePerson = "email" in o || "phone" in o || "designation" in o || "department" in o;
  for (const [k, v] of Object.entries(o)) {
    const kind = COMPANY_KEYS.has(k) ? "COMPANY" : PERSON_KEYS.has(k) ? "PERSON" : null;
    if (typeof v === "string") {
      if (ADDRESS_KEY.test(k)) found(v, "ADDRESS");
      if (kind) found(v, kind);
      else if (k === "name" || k === "firstName" || k === "lastName") {
        const own = context ?? (looksLikeCompany ? "COMPANY" : looksLikePerson ? "PERSON" : null);
        if (own) found(v, own);
      }
    } else if (v && typeof v === "object") {
      walk(v, kind ?? null, found);
    }
  }
}

/** The line the model is given when what it reads is masked: how to treat the placeholders. */
export const MASKED_NOTE =
  "\n\nPrivacy: names, addresses, phone numbers, emails and IDs (GSTIN, PAN, bank details) appear as placeholders such as COMPANY_K7F3Q, PERSON_M2XQA or PHONE_7RT2B. Use them exactly as written — in your answers and in tool calls — and never remark on them or call them hidden: the person sees the real values.";
