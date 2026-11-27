/**
 * Security audit round three, 14 Nov 2026 (R3-01): whether a pattern an admin typed could take for ever to check.
 *
 * JavaScript's regular expressions backtrack: a pattern such as `(a+)+b` tried against forty "a"s tries every way of
 * splitting them, which is billions of tries — and the one Node process every workspace shares does nothing else while
 * it does. This reads a pattern before it is saved and refuses the shapes that do that, in words an admin can act on:
 *
 *   · something repeated that repeats inside: (a+)+, (\d*)*, (a|b?)+ — "star height" above one;
 *   · a repeated choice whose options can start with the same character: (a|ab)+, (\d|[0-9])+;
 *   · a reference back to a group (\1, \k<name>) and a look ahead or behind ((?=…), (?<!…)).
 *
 * Conservative on purpose: a choice whose options start with a set, a dot or \d is treated as overlapping, because
 * proving it doesn't would need a real regex engine. It is the first of three layers — the value tested is short
 * (src/lib/field-rules/check.ts) and the match itself runs under a time limit (src/lib/field-rules/regex-guard.ts) —
 * so a shape this misses still can't hold the process. Pure, so the settings page refuses as the admin types.
 */

const BACK_REFERENCE = "A pattern can't refer back to an earlier part of itself (\\1 or \\k<name>) — those can take minutes to check, so it can't be saved.";
const LOOK_AROUND = "A pattern can't look ahead or behind ((?=…), (?!…), (?<=…) or (?<!…)). Describe the value from its start to its end instead.";
const NESTED =
  "This pattern repeats something that already repeats inside, like (a+)+ or (\\d*)*. Checked against a long value that can take minutes, so it can't be saved — repeat it once: (a+)+ is the same as a+.";
const OVERLAP =
  "This pattern repeats a choice whose options can start with the same character, like (a|ab)+ or (\\d|[0-9])+. Checked against a long value that can take minutes, so it can't be saved — put single characters in one set, such as [ab]+, or start each option with a different character.";

/** What can come first in a branch: one exact character, or "*" for a set, a dot or a class such as \d. */
type First = string;
const ANY: First = "*";

type Frame = {
  /** A repeat somewhere inside: a quantified character, set or group. */
  repeats: boolean;
  /** A choice inside whose options can start alike — its own, or a group's in it that isn't itself repeated. */
  overlaps: boolean;
  /** Each branch's first character so far; undefined while the branch is still empty. */
  firsts: (First | undefined)[];
};

/** A quantifier at `at`: how long it is, and whether it may repeat more than once — or null when there is none. */
function quantifierAt(s: string, at: number): { length: number; many: boolean; optional: boolean } | null {
  const c = s[at];
  let length = 0;
  let min = 1;
  let max = 1;
  if (c === "*" || c === "+" || c === "?") {
    length = 1;
    min = c === "+" ? 1 : 0;
    max = c === "?" ? 1 : Infinity;
  } else if (c === "{") {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(s.slice(at));
    if (!m) return null;
    length = m[0].length;
    min = Number(m[1]);
    max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
  } else {
    return null;
  }
  if (s[at + length] === "?") length += 1;
  return { length, many: max > 1, optional: min === 0 };
}

/** Whether a choice's options can start with the same character (an empty option counts, as it matches anything). */
function optionsOverlap(firsts: (First | undefined)[]): boolean {
  if (firsts.length < 2) return false;
  const seen = new Set<string>();
  for (const f of firsts) {
    if (f === undefined || f === ANY || seen.has(f)) return true;
    seen.add(f);
  }
  return false;
}

/**
 * Why this pattern could take too long to check, in words for the admin — or null when its shape is safe. Call it
 * only on a pattern that compiles (with the "u" flag), so the syntax can be trusted.
 */
export function patternDanger(source: string): string | null {
  const s = source;
  const stack: Frame[] = [{ repeats: false, overlaps: false, firsts: [undefined] }];
  const top = () => stack[stack.length - 1]!;
  let i = 0;

  /** An atom just read — a character, a set or a group — and the quantifier after it, if any. */
  const atom = (first: First, next: number, group: Frame | null): string | null => {
    const frame = top();
    const branch = frame.firsts.length - 1;
    const isFirst = frame.firsts[branch] === undefined;
    if (isFirst) frame.firsts[branch] = first;
    const q = quantifierAt(s, next);
    if (group) {
      if (q?.many && group.repeats) return NESTED;
      if (q?.many && group.overlaps) return OVERLAP;
      // A group that isn't repeated passes what is inside it on to the one around it.
      frame.repeats ||= group.repeats;
      frame.overlaps ||= group.overlaps;
    }
    if (q) {
      frame.repeats = true;
      // Something that may be left out isn't what the branch must start with.
      if (isFirst && q.optional) frame.firsts[branch] = ANY;
    }
    i = next + (q?.length ?? 0);
    return null;
  };

  while (i < s.length) {
    const c = s[i]!;
    let refused: string | null = null;
    if (c === "\\") {
      const e = s[i + 1] ?? "";
      if (/[1-9]/.test(e) || e === "k") return BACK_REFERENCE;
      let end = i + 2;
      let first: First = ANY;
      if ((e === "p" || e === "P" || e === "u") && s[i + 2] === "{") end = s.indexOf("}", i + 2) + 1 || s.length;
      else if (e === "u") end = i + 6;
      else if (e === "x") end = i + 4;
      else if (e === "c") end = i + 3;
      else if (!/[A-Za-z0-9]/.test(e)) first = e;
      refused = atom(first, end, null);
    } else if (c === "[") {
      let j = i + 1;
      if (s[j] === "^") j += 1;
      if (s[j] === "]") j += 1;
      while (j < s.length && s[j] !== "]") j += s[j] === "\\" ? 2 : 1;
      refused = atom(ANY, j + 1, null);
    } else if (c === "(") {
      if (s[i + 1] === "?") {
        const kind = s[i + 2];
        if (kind === "=" || kind === "!" || (kind === "<" && (s[i + 3] === "=" || s[i + 3] === "!"))) return LOOK_AROUND;
        // (?<name>…), (?:…), and a flags group such as (?i:…).
        i = kind === "<" ? s.indexOf(">", i) + 1 : s.indexOf(":", i) + 1;
      } else {
        i += 1;
      }
      stack.push({ repeats: false, overlaps: false, firsts: [undefined] });
    } else if (c === ")") {
      if (stack.length === 1) return null;
      const group = stack.pop()!;
      group.overlaps ||= optionsOverlap(group.firsts);
      const first = group.firsts.length === 1 && group.firsts[0] !== undefined ? group.firsts[0] : ANY;
      refused = atom(first, i + 1, group);
    } else if (c === "|") {
      top().firsts.push(undefined);
      i += 1;
    } else if (c === "^" || c === "$") {
      i += 1;
    } else {
      refused = atom(c === "." ? ANY : c, i + 1, null);
    }
    if (refused) return refused;
  }
  return null;
}
