import vm from "node:vm";

/**
 * Security audit round three, 14 Nov 2026 (R3-01): a regular expression from a workspace's own settings, run with a
 * time limit. Server only.
 *
 * Node runs every workspace in one process, and a backtracking pattern — `(a+)+b` against forty "a"s — keeps it busy
 * for minutes: every request of every workspace waits. RE2 would make that impossible, but nothing new may be
 * installed, so the match runs inside `node:vm` with a `timeout`: V8 stops a script that runs past it, regex
 * backtracking included (TerminateExecution reaches the regex engine), and the caller hears "timeout" instead of a
 * result. scripts/check-audit-round3-platform.ts proves it with a pattern that would otherwise run for minutes.
 *
 * The pattern is compiled by the caller, outside; only the match runs inside, with the pattern and the text handed in
 * through one reused context, so a match costs a fraction of a millisecond more.
 */

/** How long one field-rule match may take. A sane pattern on 200 characters takes microseconds. */
export const FIELD_RULE_MATCH_MS = 50;

const sandbox: { re: RegExp | null; text: string } = { re: null, text: "" };
const context = vm.createContext(sandbox);
const testScript = new vm.Script("re.test(text)");
const matchAllScript = new vm.Script("Array.from(text.matchAll(re), (m) => [m.index, m[0]])");

const timedOut = (err: unknown) => (err as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";

function run<T>(script: vm.Script, re: RegExp, text: string, timeoutMs: number): T | "timeout" {
  // Compiled first, outside the limit: V8 compiles a pattern on its first runs (interpreted, then native code), and a
  // big one — the word filter's 500 entries in one — takes longer to compile than the limit allows. Compiling depends
  // on the pattern alone, never on the text, and V8 keeps it for the same source, so this costs nothing after the
  // first time; against an empty string nothing can backtrack.
  re.lastIndex = 0;
  re.test("");
  re.lastIndex = 0;
  re.test("");
  re.lastIndex = 0;
  sandbox.re = re;
  sandbox.text = text;
  try {
    return script.runInContext(context, { timeout: Math.max(1, Math.floor(timeoutMs)) }) as T;
  } catch (err) {
    if (timedOut(err)) return "timeout";
    throw err;
  } finally {
    sandbox.re = null;
    sandbox.text = "";
    re.lastIndex = 0;
  }
}

/** Whether `re` matches `text` — or "timeout" when it ran past the limit, which callers treat as no match. */
export function guardedTest(re: RegExp, text: string, timeoutMs = FIELD_RULE_MATCH_MS): boolean | "timeout" {
  const out = run<unknown>(testScript, re, text, timeoutMs);
  return out === "timeout" ? out : out === true;
}

/** Every match of a global `re` in `text`, as [index, matched text] — or "timeout". */
export function guardedMatchAll(re: RegExp, text: string, timeoutMs: number): [number, string][] | "timeout" {
  const out = run<unknown>(matchAllScript, re, text, timeoutMs);
  if (out === "timeout") return out;
  return (out as [number, string][]).map(([index, matched]) => [Number(index), String(matched)]);
}
