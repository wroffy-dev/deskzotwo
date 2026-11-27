/**
 * How much knowledge goes into one prompt (owner, 3 Nov 2026). The model behind Deskzo AI's copilot and inbox answers
 * is qwen2.5:7b, with 8k tokens of context for the whole request — instructions, conversation, tools and answer — so
 * no prompt is ever given more than 4,000 characters of knowledge at a time: AI Knowledge's chunks, and the website
 * passages an inbox channel reads, together. Pure — the copilot's tool, the inbox's brief and the checks all use it.
 */

/** The most knowledge one prompt holds, in characters: file names, headings and text, everything shown to the model. */
export const KNOWLEDGE_PROMPT_CHARS = 4000;

/** The copilot's search_knowledge gives this many chunks… */
export const COPILOT_KNOWLEDGE_CHUNKS = 5;
/** …and the inbox's bot is told this many, where a channel ticks "Use AI Knowledge". */
export const INBOX_KNOWLEDGE_CHUNKS = 3;

/** Less room than this left for a chunk, and it's left out rather than cut to a scrap. */
const SMALLEST_PART = 200;

/** A text cut to at most `max` characters, at the end of a word where there's one near, with "…" after it. */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - 1);
  const head = text.slice(0, room);
  const space = head.search(/\s\S*$/);
  // The last whole word, unless that would throw away more than half: one enormous "word" is cut through.
  const cut = space > room / 2 ? head.slice(0, space) : head;
  return `${cut.trimEnd()}…`;
}

/**
 * The items that fit in `budget` characters, best first, as `render` writes each and `separator` joins them — the
 * last one cut short at a word when there's still room worth giving it. The joined rendering of what comes back is
 * never longer than `budget`.
 */
export function fitKnowledge<T extends { text: string }>(items: readonly T[], render: (item: T) => string, budget: number = KNOWLEDGE_PROMPT_CHARS, separator = "\n\n"): T[] {
  const out: T[] = [];
  let used = 0;
  for (const item of items) {
    const join = out.length ? separator.length : 0;
    const full = render(item).length;
    if (used + join + full <= budget) {
      out.push(item);
      used += join + full;
      continue;
    }
    // Only part of it fits: its first words, when there's room enough for them to be worth reading.
    const frame = full - item.text.length;
    const room = budget - used - join - frame;
    if (room >= SMALLEST_PART) out.push({ ...item, text: cutAtWord(item.text, room) });
    break;
  }
  return out;
}

/** The characters `fitKnowledge`'s answer comes to, rendered and joined. */
export function renderedLength<T>(items: readonly T[], render: (item: T) => string, separator = "\n\n"): number {
  return items.reduce((sum, item, i) => sum + render(item).length + (i ? separator.length : 0), 0);
}

/** A chunk as the copilot's tool counts it: the file it came from, where in the file, and its words. */
export const copilotRender = (hit: { file: string; heading: string; text: string }) => `${hit.file}\n${hit.heading}\n${hit.text}`;

/** A chunk as the inbox's brief writes it: "[crm-leads.md › Leads › Q: …]" and its words below. */
export const inboxFileRender = (hit: { file: string; heading: string; text: string }) => `[${hit.heading ? `${hit.file} › ${hit.heading}` : hit.file}]\n${hit.text}`;

/** A website passage as the inbox's brief writes it (src/lib/inbox/knowledge.ts). */
export const inboxPageRender = (p: { url: string; title: string; text: string }) => `[${p.title || p.url}] ${p.url}\n${p.text}`;
