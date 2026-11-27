import {
  KINDS_FOR,
  OPS_FOR,
  PATTERN_LABELS,
  opNeedsValue,
  type FieldRule,
  type RuleCondition,
  type RuleField,
  type RuleRecord,
} from "@/lib/field-rules/catalogue";
import { patternDanger } from "@/lib/field-rules/pattern-safety";

/**
 * Checking a record against the workspace's field rules (owner, 12 Nov 2026): pure — the record and the rules in,
 * what is wrong out — so every rule can be proved in a test, and the server only adds the one thing that needs the
 * database, whether a value is already taken (UNIQUE).
 *
 * A save is checked on what it changes: a new record against every rule; an edit only against the rules on fields it
 * sends, so changing a contact's phone isn't stopped by a rule on the company's industry. "Only when" conditions
 * read the whole record as it will be after the save.
 */

/** Nothing there: null, blank text, an empty list, an unticked box. */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "boolean") return !value;
  return false;
}

const asText = (value: unknown): string => (Array.isArray(value) ? value.join(", ") : value === null || value === undefined ? "" : String(value).trim());
const asNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(/[,\s₹]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Whether an "only when" condition holds for the record. */
export function conditionHolds(condition: RuleCondition, record: RuleRecord): boolean {
  const value = record[condition.field];
  switch (condition.op) {
    case "FILLED":
      return !isEmpty(value);
    case "EMPTY":
      return isEmpty(value);
    case "EQUALS":
      return asText(value).toLowerCase() === String(condition.value ?? "").trim().toLowerCase();
    case "NOT_EQUALS":
      return asText(value).toLowerCase() !== String(condition.value ?? "").trim().toLowerCase();
    case "GREATER":
    case "LESS": {
      const n = asNumber(value);
      const bound = asNumber(condition.value);
      if (n === null || bound === null) return false;
      return condition.op === "GREATER" ? n > bound : n < bound;
    }
  }
}

/**
 * A custom pattern, compiled — or why it can't be. Long ones are refused, so a pattern can't stall a save.
 *
 * Security audit round three, 14 Nov 2026 (R3-01): `safety` (on when a rule is saved) also refuses the shapes that can
 * backtrack for minutes — (a+)+, (a|ab)+, \1, lookarounds — in words (src/lib/field-rules/pattern-safety.ts). A rule
 * saved before that check is still compiled without it when a record is checked: the time limit there catches it.
 */
export function compilePattern(source: string, options: { safety?: boolean } = { safety: true }): RegExp | string {
  if (source.length > 200) return "Keep the pattern under 200 characters.";
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${source})$`, "u");
  } catch {
    return "That pattern isn't a valid regular expression.";
  }
  if (options.safety !== false) {
    const danger = patternDanger(source);
    if (danger) return danger;
  }
  return re;
}

/**
 * Security audit round three, 14 Nov 2026 (R3-01): the longest value a custom pattern is tried on. A value over it
 * fails the rule ("too long to check") rather than being cut short, which would pass a value whose end is wrong.
 */
export const PATTERN_TEXT_MAX = 200;

/**
 * How a custom pattern is run: `re.test`, unless the caller gives a guarded runner. The server always does
 * (src/lib/field-rules/regex-guard.ts `guardedTest`, under a time limit); "timeout" means it ran too long.
 */
export type PatternRunner = (re: RegExp, text: string) => boolean | "timeout";
const plainRunner: PatternRunner = (re, text) => re.test(text);

/** How a text fares against a rule's format: it fits, it doesn't, or it couldn't be checked (too long, too slow). */
export type PatternVerdict = "match" | "no" | "too-long" | "timeout";

export function patternVerdict(rule: Pick<FieldRule, "pattern" | "patternValue">, text: string, run: PatternRunner = plainRunner): PatternVerdict {
  const v = String(rule.patternValue ?? "");
  const yes = (b: boolean): PatternVerdict => (b ? "match" : "no");
  switch (rule.pattern) {
    case "DIGITS":
      return yes(/^\d+$/.test(text));
    case "LETTERS":
      return yes(/^[\p{L}\s.'-]+$/u.test(text));
    case "LETTERS_DIGITS":
      return yes(/^[\p{L}\p{N}]+$/u.test(text));
    case "UPPERCASE":
      return yes(text === text.toUpperCase());
    case "STARTS_WITH":
      return yes(text.toLowerCase().startsWith(v.toLowerCase()));
    case "ENDS_WITH":
      return yes(text.toLowerCase().endsWith(v.toLowerCase()));
    case "CUSTOM": {
      const re = compilePattern(v, { safety: false });
      if (typeof re === "string") return "match";
      if (text.length > PATTERN_TEXT_MAX) return "too-long";
      const out = run(re, text);
      return out === "timeout" ? "timeout" : yes(out);
    }
    default:
      return "match";
  }
}

/** Whether a text matches a rule's format. Too long or too slow to check is not a match. */
export function matchesPattern(rule: Pick<FieldRule, "pattern" | "patternValue">, text: string, run: PatternRunner = plainRunner): boolean {
  return patternVerdict(rule, text, run) === "match";
}

/** The words a rule says when it isn't met, unless the admin wrote their own. */
export function ruleWords(rule: FieldRule, label: string): string {
  if (rule.message?.trim()) return rule.message.trim();
  switch (rule.kind) {
    case "REQUIRED":
      return `${label} is required.`;
    case "LENGTH":
      return rule.min != null && rule.max != null
        ? rule.min === rule.max
          ? `${label} must be exactly ${rule.min} characters.`
          : `${label} must be ${rule.min} to ${rule.max} characters.`
        : rule.min != null
          ? `${label} must be at least ${rule.min} characters.`
          : `${label} can be ${rule.max} characters at most.`;
    case "PATTERN":
      return rule.pattern === "STARTS_WITH"
        ? `${label} must start with "${rule.patternValue}".`
        : rule.pattern === "ENDS_WITH"
          ? `${label} must end with "${rule.patternValue}".`
          : rule.pattern === "CUSTOM"
            ? `${label} isn't in the format it needs to be.`
            : `${label}: ${PATTERN_LABELS[rule.pattern ?? "DIGITS"].toLowerCase()}.`;
    case "RANGE":
      return rule.min != null && rule.max != null ? `${label} must be between ${rule.min} and ${rule.max}.` : rule.min != null ? `${label} must be at least ${rule.min}.` : `${label} can be ${rule.max} at most.`;
    case "UNIQUE":
      return `${label} is already used on another record — it has to be different.`;
  }
}

export type RuleProblem = { field: string; label: string; message: string; rule: FieldRule };

/**
 * What is wrong with a record, rule by rule — UNIQUE aside, which the server asks the database (it is returned as
 * `toCheckUnique` when the value is there to check). `touched` is the fields this save sends; null means every one,
 * as for a new record.
 */
export function checkRecord(params: {
  rules: FieldRule[];
  fields: RuleField[];
  record: RuleRecord;
  isNew: boolean;
  touched: Set<string> | null;
  /** How custom patterns are run — the server passes its time-limited runner (R3-01). */
  run?: PatternRunner;
}): { problems: RuleProblem[]; toCheckUnique: { rule: FieldRule; value: string; label: string }[] } {
  const byKey = new Map(params.fields.map((f) => [f.key, f]));
  const problems: RuleProblem[] = [];
  const toCheckUnique: { rule: FieldRule; value: string; label: string }[] = [];
  for (const rule of params.rules) {
    if (!rule.active) continue;
    if (rule.newOnly && !params.isNew) continue;
    if (params.touched && !params.touched.has(rule.field)) continue;
    const field = byKey.get(rule.field);
    // A rule about a field the workspace has since removed asks nothing.
    if (!field) continue;
    if (rule.when && !conditionHolds(rule.when, params.record)) continue;
    const value = params.record[rule.field];
    const fail = () => problems.push({ field: rule.field, label: field.label, message: ruleWords(rule, field.label), rule });
    if (rule.kind === "REQUIRED") {
      if (isEmpty(value)) fail();
      continue;
    }
    // The other rules are about a value that is there; an empty one is REQUIRED's business.
    if (isEmpty(value)) continue;
    if (rule.kind === "LENGTH") {
      const n = [...asText(value)].length;
      if ((rule.min != null && n < rule.min) || (rule.max != null && n > rule.max)) fail();
    } else if (rule.kind === "PATTERN") {
      const verdict = patternVerdict(rule, asText(value), params.run);
      if (verdict === "no") fail();
      // R3-01: a value the pattern couldn't be checked against is refused, and says why — never let through unchecked.
      else if (verdict === "too-long") problems.push({ field: rule.field, label: field.label, message: `${field.label} is too long to check against its format — ${PATTERN_TEXT_MAX} characters at most.`, rule });
      else if (verdict === "timeout") problems.push({ field: rule.field, label: field.label, message: `${field.label} couldn't be checked against its format in time. Ask an admin to simplify the rule's pattern.`, rule });
    } else if (rule.kind === "RANGE") {
      const n = asNumber(value);
      if (n === null || (rule.min != null && n < rule.min) || (rule.max != null && n > rule.max)) fail();
    } else if (rule.kind === "UNIQUE") {
      toCheckUnique.push({ rule, value: asText(value), label: field.label });
    }
  }
  return { problems, toCheckUnique };
}

/** What stops a rule being saved, in words; null when it is fine. */
export function ruleRefusal(rule: Omit<FieldRule, "id" | "active"> & { active?: boolean }, fields: RuleField[]): string | null {
  const field = fields.find((f) => f.key === rule.field);
  if (!field) return "Pick a field.";
  if (field.conditionOnly) return `${field.label} always has a value, so it can only be used in "only when".`;
  if (!KINDS_FOR[field.kind].includes(rule.kind)) return `${field.label} can't take that kind of rule.`;
  if (rule.kind === "LENGTH" || rule.kind === "RANGE") {
    if (rule.min == null && rule.max == null) return "Give a smallest or a largest value, or both.";
    if (rule.min != null && rule.max != null && rule.min > rule.max) return "The smallest is more than the largest.";
    if (rule.kind === "LENGTH" && ((rule.min != null && (rule.min < 0 || !Number.isInteger(rule.min))) || (rule.max != null && (rule.max < 1 || !Number.isInteger(rule.max))))) {
      return "A length is a whole number of characters.";
    }
  }
  if (rule.kind === "PATTERN") {
    if (!rule.pattern) return "Pick a format.";
    if ((rule.pattern === "STARTS_WITH" || rule.pattern === "ENDS_WITH" || rule.pattern === "CUSTOM") && !String(rule.patternValue ?? "").trim()) return "Say what it should start with, end with, or match.";
    if (rule.pattern === "CUSTOM") {
      const re = compilePattern(String(rule.patternValue));
      if (typeof re === "string") return re;
    }
  }
  if (rule.when) {
    const on = fields.find((f) => f.key === rule.when!.field);
    if (!on) return 'Pick the field "only when" asks about.';
    if (on.key === rule.field) return 'A rule can\'t depend on its own field — use "must be filled in" instead.';
    if (!OPS_FOR[on.kind].includes(rule.when.op)) return `"${on.label}" can't be asked that.`;
    if (opNeedsValue(rule.when.op) && !String(rule.when.value ?? "").trim()) return `Say what "${on.label}" should be.`;
  }
  if (rule.message && rule.message.length > 300) return "Keep the message under 300 characters.";
  return null;
}
