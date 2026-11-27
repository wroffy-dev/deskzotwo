import type { ToolCall, ToolSpec } from "@/lib/copilot/types";

/**
 * Tool calls a small model wrote out as text instead of making them.
 *
 * Owner, 20 Nov 2026, with screenshots: on Deskzo's own Ollama (qwen2.5 7B) Deskzo AI answered "how many employees"
 * with a block of JSON — the report it meant to run — then asked "Would you like me to run this report now?", and
 * on "yes" wrote the JSON again and a count it had made up. A 7B model often writes a call as a ```json block, a
 * <tool_call> tag or a bare object rather than as the API's tool call; nothing ran, and the person saw code.
 *
 *   · `textToolCalls` turns such a block back into the call it was: by its own `name` when it gives one, otherwise
 *     the one offered tool whose parameters it fits (a tool named in the text wins a tie). The call is then checked
 *     against the tool's schema like any other, so a wrong guess is refused, not run.
 *   · `jsonHider` keeps those blocks off the screen as the answer streams, wherever they sit in it. A code block
 *     that isn't a JSON object still shows, once it is complete.
 */

const FENCE = "```";
const TAG_OPEN = "<tool_call>";
const TAG_CLOSE = "</tool_call>";

function jsonObject(raw: string): Record<string, unknown> | null {
  const s = raw.trim().replace(/^json\b/i, "").trim();
  if (!s.startsWith("{")) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Where the object opening at `text[from]` closes (just past its "}"), minding strings — or -1 while it's open. */
function objectEnd(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The JSON objects written in `text` — fenced, tagged, or loose in the text — with where each sits. Owner, 23 Nov
 * 2026, with a screenshot: "Let me try searching for it." and then a bare {"name": "search_companies", …} in the
 * middle of the answer; a loose object was only caught when it was the whole answer.
 */
function blocksIn(text: string): { start: number; end: number; value: Record<string, unknown> }[] {
  const out: { start: number; end: number; value: Record<string, unknown> }[] = [];
  const covered: [number, number][] = [];
  const patterns = [/```[a-zA-Z]*\s*\n?([\s\S]*?)```/g, /<tool_call>([\s\S]*?)<\/tool_call>/g];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      covered.push([start, end]);
      const value = jsonObject(m[1] ?? "");
      if (value) out.push({ start, end, value });
    }
  }
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) {
    const inside = covered.find(([a, b]) => i >= a && i < b);
    if (inside) {
      i = inside[1] - 1;
      continue;
    }
    const end = objectEnd(text, i);
    if (end < 0) continue;
    const value = jsonObject(text.slice(i, end));
    if (!value) continue;
    out.push({ start: i, end, value });
    i = end - 1;
  }
  return out.sort((a, b) => a.start - b.start);
}

function propertiesOf(spec: ToolSpec): { keys: Set<string>; required: string[] } {
  const p = spec.parameters as { properties?: Record<string, unknown>; required?: string[] };
  return { keys: new Set(Object.keys(p.properties ?? {})), required: p.required ?? [] };
}

/** Which offered tool `value` is a call to, and its input — or null when it isn't clearly one. */
function callOf(value: Record<string, unknown>, tools: ToolSpec[], text: string): { name: string; input: unknown } | null {
  const named = typeof value.name === "string" ? tools.find((t) => t.name === value.name) : undefined;
  if (named) {
    const args = value.arguments ?? value.parameters ?? value.input ?? {};
    const input = typeof args === "string" ? (jsonObject(args) ?? {}) : args;
    return { name: named.name, input };
  }
  const keys = Object.keys(value);
  if (!keys.length) return null;
  const fits = tools.filter((t) => {
    const { keys: known } = propertiesOf(t);
    return keys.every((k) => known.has(k));
  });
  if (!fits.length) return null;
  const mentioned = fits.filter((t) => text.includes(t.name));
  const pool = mentioned.length ? mentioned : fits;
  // The one whose required parameters are most covered, then the one with the fewest parameters it didn't give.
  const ranked = pool
    .map((t) => {
      const { keys: known, required } = propertiesOf(t);
      return { t, missing: required.filter((r) => !keys.includes(r)).length, spare: known.size - keys.length };
    })
    .sort((a, b) => a.missing - b.missing || a.spare - b.spare);
  const best = ranked[0]!;
  const runnerUp = ranked[1];
  if (runnerUp && runnerUp.missing === best.missing && runnerUp.spare === best.spare) return null;
  return { name: best.t.name, input: value };
}

/** The calls written into `text`, and the text without them. */
export function textToolCalls(text: string, tools: ToolSpec[]): { calls: ToolCall[]; text: string } {
  if (!text.includes("{") || !tools.length) return { calls: [], text };
  const calls: ToolCall[] = [];
  let kept = "";
  let at = 0;
  for (const b of blocksIn(text)) {
    const call = callOf(b.value, tools, text);
    if (!call) continue;
    calls.push({ id: `call_text_${Date.now().toString(36)}_${calls.length}`, name: call.name, input: call.input });
    kept += text.slice(at, b.start);
    at = b.end;
  }
  if (!calls.length) return { calls, text };
  return { calls, text: (kept + text.slice(at)).replace(/\n{3,}/g, "\n\n").trim() };
}

/**
 * A filter on the streamed answer: JSON objects — fenced, tagged, or loose anywhere in the text — are held back and
 * dropped; everything else goes straight through. A loose object starts at a "{" followed by a quote, so "{" in
 * ordinary prose isn't held. `end()` lets out whatever was still held that isn't JSON.
 */
export function jsonHider(emit: (delta: string) => void): { push: (delta: string) => void; end: () => void } {
  let pending = "";
  let mode: "text" | "fence" | "tag" | "object" = "text";
  const markers = [FENCE, TAG_OPEN];
  const OBJECT = /\{\s*"/;

  const drain = () => {
    for (;;) {
      if (mode === "text") {
        const hits = markers.map((m) => pending.indexOf(m)).filter((i) => i >= 0);
        const obj = pending.search(OBJECT);
        if (obj >= 0) hits.push(obj);
        if (hits.length) {
          const i = Math.min(...hits);
          if (i > 0) emit(pending.slice(0, i));
          pending = pending.slice(i);
          mode = pending.startsWith(FENCE) ? "fence" : pending.startsWith(TAG_OPEN) ? "tag" : "object";
          continue;
        }
        // Hold back a tail that could be the start of a marker split across two pieces — or a "{" not yet followed.
        let keep = 0;
        for (const m of markers) for (let n = Math.min(m.length - 1, pending.length); n > keep; n--) if (m.startsWith(pending.slice(-n))) keep = n;
        const brace = /\{\s*$/.exec(pending);
        if (brace) keep = Math.max(keep, pending.length - brace.index);
        if (pending.length > keep) emit(pending.slice(0, pending.length - keep));
        pending = pending.slice(pending.length - keep);
        return;
      }
      if (mode === "object") {
        const end = objectEnd(pending, 0);
        if (end < 0) return;
        const block = pending.slice(0, end);
        if (!jsonObject(block)) emit(block);
        pending = pending.slice(end);
        mode = "text";
        continue;
      }
      const close = mode === "fence" ? FENCE : TAG_CLOSE;
      const j = pending.indexOf(close, mode === "fence" ? FENCE.length : TAG_OPEN.length);
      if (j < 0) return;
      const block = pending.slice(0, j + close.length);
      const inner = block.slice(mode === "fence" ? FENCE.length : TAG_OPEN.length, j);
      if (mode === "fence" && !jsonObject(inner)) emit(block);
      pending = pending.slice(j + close.length);
      mode = "text";
    }
  };

  return {
    push(delta) {
      pending += delta;
      drain();
    },
    end() {
      if (!pending) return;
      const inner = mode === "fence" ? pending.slice(FENCE.length).replace(/```\s*$/, "") : pending;
      // An unclosed tool-call tag, or a block that is JSON once its last brace is counted, stays off the screen.
      if (mode === "tag" || ((mode === "fence" || mode === "object") && jsonObject(inner))) {
        pending = "";
        return;
      }
      emit(pending);
      pending = "";
    },
  };
}
