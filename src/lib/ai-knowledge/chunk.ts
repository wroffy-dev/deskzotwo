/**
 * Cutting an AI Knowledge file into chunks (owner, 3 Nov 2026: "headings ke hisaab se ~800 characters").
 * Pure — no database: the store (./store.ts) saves what this returns, and check:ai-knowledge tests it as is.
 *
 *   · A Markdown file is read as sections, one per heading (`#` to `######`; a `#` inside a ``` fence is code,
 *     not a heading). Each chunk knows the headings above it — "Leads › Q: How do I add a lead?" — which is
 *     searched with more weight than the text, and shown with it to the AI.
 *   · A section of up to about 800 characters is one chunk. Small sections that follow each other are put
 *     together, each with its own heading line, while they stay under that: a page of short questions and
 *     answers isn't a hundred scraps. A new `#` topic always starts a chunk of its own.
 *   · A longer section is cut at its paragraphs, then its lines, then its sentences, then its words — never in
 *     the middle of a word — into pieces of up to 800 characters; a small last piece stays with the one before.
 *   · A .txt file has no headings: it is cut the same way, at its paragraphs.
 */

export const AI_KNOWLEDGE_LIMITS = {
  /** About this many characters of text in a chunk. */
  chunkChars: 800,
  /** A short last piece of a section is kept with the one before it while together they are under this. */
  chunkMaxChars: 960,
  /** A piece shorter than this is "short", for the rule above. */
  shortPiece: 160,
  /** The headings above a chunk, as kept. */
  headingChars: 300,
  /** A file's text. A long handbook is about 100,000. */
  fileChars: 500_000,
  /** A file's name, its folders inside a .zip included. */
  nameChars: 200,
  /** Files in a workspace. */
  files: 1_000,
} as const;

export type KnowledgeChunk = { heading: string; text: string };

type Section = {
  /** The titles of the headings above it and its own, outermost first. */
  path: string[];
  /** Its heading's level, 1 to 6; 0 before the first heading. */
  level: number;
  /** Its heading line as written ("## Q: How do I add a lead?"); null before the first heading. */
  headingLine: string | null;
  body: string;
};

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})[ \t]+(.*?)[ \t]*(?:[ \t]#+[ \t]*)?$/;

/** A heading's words, without the Markdown around them: "**Pricing** (`INR`)" → "Pricing (INR)". */
export function headingTitle(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text with "\n" line endings, without a byte-order mark, trailing spaces or YAML front matter. */
export function normaliseText(text: string): string {
  let out = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const front = out.match(/^---\n[\s\S]*?\n---\n/);
  if (front && front[0].length < 4000) out = out.slice(front[0].length);
  return out
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A file's sections, one per heading. Headings inside a fenced code block are code. */
function sectionsOf(text: string): Section[] {
  const out: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: Section = { path: [], level: 0, headingLine: null, body: "" };
  let lines: string[] = [];
  let fence: { char: string; length: number } | null = null;
  const close = () => {
    current.body = lines.join("\n").trim();
    if (current.headingLine || current.body) out.push(current);
  };
  for (const line of text.split("\n")) {
    const f = line.match(FENCE);
    if (f) {
      const mark = f[1]!;
      if (!fence) fence = { char: mark[0]!, length: mark.length };
      else if (mark[0] === fence.char && mark.length >= fence.length && line.trim() === mark) fence = null;
      lines.push(line);
      continue;
    }
    const h = fence ? null : line.match(HEADING);
    if (!h) {
      lines.push(line);
      continue;
    }
    close();
    const level = h[1]!.length;
    const title = headingTitle(h[2]!);
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    if (title) stack.push({ level, title });
    current = { path: stack.map((s) => s.title), level, headingLine: line.trim(), body: "" };
    lines = [];
  }
  close();
  return out;
}

/** The headings above a chunk as one line: "Leads › Q: How do I add a lead?". */
const breadcrumb = (path: string[]) => {
  const text = path.join(" › ");
  return text.length > AI_KNOWLEDGE_LIMITS.headingChars ? `${text.slice(0, AI_KNOWLEDGE_LIMITS.headingChars - 1).trimEnd()}…` : text;
};

/** Where a text may be cut, from the best place to the last resort: paragraphs, lines, sentences, words. */
const CUTS: { at: RegExp; join: string }[] = [
  { at: /\n{2,}/, join: "\n\n" },
  { at: /\n/, join: "\n" },
  { at: /(?<=[.!?।])\s+/, join: " " },
  { at: /\s+/, join: " " },
];

/**
 * A text in pieces of at most `size` characters, cut at the best place there is: whole paragraphs packed together while
 * they fit, a paragraph too long for one piece cut at its lines, and so on down to its words. A word longer than a
 * piece — a pasted key, a long link — is the only thing ever cut through.
 */
export function splitText(text: string, size: number = AI_KNOWLEDGE_LIMITS.chunkChars, level = 0): string[] {
  const whole = text.trim();
  if (!whole) return [];
  if (whole.length <= size) return [whole];
  if (level >= CUTS.length) {
    const out: string[] = [];
    for (let i = 0; i < whole.length; i += size) out.push(whole.slice(i, i + size));
    return out;
  }
  const { at, join } = CUTS[level]!;
  const out: string[] = [];
  let current = "";
  for (const unit of whole.split(at).map((u) => u.trim()).filter(Boolean)) {
    if (unit.length > size) {
      // Too long for a piece of its own: cut finer, and its pieces stand by themselves.
      if (current) out.push(current);
      current = "";
      out.push(...splitText(unit, size, level + 1));
      continue;
    }
    if (!current) current = unit;
    else if (current.length + join.length + unit.length <= size) current = `${current}${join}${unit}`;
    else {
      out.push(current);
      current = unit;
    }
  }
  if (current) out.push(current);
  return out;
}

/** A section's text in pieces; a short last piece kept with the one before while together they're still small enough. */
function piecesOf(text: string, size: number): string[] {
  const pieces = splitText(text, size);
  if (pieces.length >= 2) {
    const last = pieces[pieces.length - 1]!;
    const before = pieces[pieces.length - 2]!;
    const max = Math.round((size * AI_KNOWLEDGE_LIMITS.chunkMaxChars) / AI_KNOWLEDGE_LIMITS.chunkChars);
    if (last.length < AI_KNOWLEDGE_LIMITS.shortPiece && before.length + 2 + last.length <= max) pieces.splice(-2, 2, `${before}\n\n${last}`);
  }
  return pieces;
}

/** The headings two paths share, from the outside in. */
function sharedPath(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) out.push(a[i]!);
  return out;
}

/**
 * A file's chunks, in order. `markdown`: read its headings (a .md file); otherwise it is plain text (a .txt file).
 * `size` is for the checks; the app always cuts at AI_KNOWLEDGE_LIMITS.chunkChars.
 */
export function chunkFile(content: string, options: { markdown: boolean; size?: number } = { markdown: true }): KnowledgeChunk[] {
  const size = options.size ?? AI_KNOWLEDGE_LIMITS.chunkChars;
  const text = normaliseText(content);
  if (!text) return [];
  const sections = options.markdown ? sectionsOf(text) : [{ path: [], level: 0, headingLine: null, body: text } satisfies Section];
  const chunks: KnowledgeChunk[] = [];

  // Small sections in a row, waiting to be put together into one chunk.
  let group: Section[] = [];
  let groupSize = 0;
  const flush = () => {
    if (!group.length) return;
    if (group.length === 1) {
      // One section: its headings are the chunk's; its own heading line isn't repeated in the text.
      const only = group[0]!;
      if (only.body) chunks.push({ heading: breadcrumb(only.path), text: only.body });
    } else {
      // Several: the headings they share are the chunk's, and each keeps its own heading line in the text.
      const shared = group.slice(1).reduce((path, s) => sharedPath(path, s.path), group[0]!.path);
      const parts = group.map((s) => [s.path.length > shared.length && s.headingLine ? s.headingLine : "", s.body].filter(Boolean).join("\n")).filter(Boolean);
      chunks.push({ heading: breadcrumb(shared), text: parts.join("\n\n") });
    }
    group = [];
    groupSize = 0;
  };

  for (const section of sections) {
    const own = (section.headingLine?.length ?? 0) + 1 + section.body.length;
    if (section.body.length > size) {
      // Too long to share: cut into pieces of its own, each under its headings.
      flush();
      for (const piece of piecesOf(section.body, size)) chunks.push({ heading: breadcrumb(section.path), text: piece });
      continue;
    }
    // A new top-level topic, or no room left in the group: what's waiting is a chunk now.
    if (group.length && (section.level === 1 || groupSize + 2 + own > size)) flush();
    group.push(section);
    groupSize += (group.length > 1 ? 2 : 0) + own;
  }
  flush();
  return chunks;
}

/** A file's title for the list: its first heading's words, or nothing when it has no heading. */
export function fileTitle(content: string, markdown: boolean): string {
  if (!markdown) return "";
  let fence = false;
  for (const line of normaliseText(content).split("\n")) {
    if (FENCE.test(line)) fence = !fence;
    const h = fence ? null : line.match(HEADING);
    if (h) return headingTitle(h[2]!).slice(0, 200);
  }
  return "";
}

/** Whether a file is read for its headings: a .md or .markdown file. */
export const isMarkdownName = (name: string) => /\.(md|markdown)$/i.test(name);
