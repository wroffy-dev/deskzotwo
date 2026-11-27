/**
 * The Customer inbox's team tools, the rules alone (owner, 24 Oct 2026: saved replies, private notes,
 * tags, the customer's rating, "usually replies in…"). Pure and client-safe: the screens, the server and
 * the checks share them.
 */

import type { DetailField, FieldRule } from "@/lib/inbox/settings";

export const TEAM_LIMITS = {
  tags: 10,
  tag: 24,
  shortcut: 30,
  replyTitle: 60,
  replyBody: 2000,
  replies: 200,
  note: 2000,
  blockReason: 200,
  ratingComment: 500,
  file: 5 * 1024 * 1024,
} as const;

/** "Complaint ", "follow up" → "complaint", "follow-up": lower case, words joined by hyphens, ten at most, each once. */
export function normaliseTags(input: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const tag = raw
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, TEAM_LIMITS.tag);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length === TEAM_LIMITS.tags) break;
  }
  return out;
}

/** A saved reply's shortcut as typed after "/": lower case letters, digits and hyphens. Null for anything else. */
export function cleanShortcut(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/^\//, "").toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,29}$/.test(v) ? v : null;
}

/**
 * A saved reply ready to send: {name} the customer's first name — or left out, comma and all, when it
 * isn't known — and {agent} the sender's first name.
 */
export function fillReply(body: string, people: { customer: string | null; agent: string | null }): string {
  const first = (name: string | null) => name?.trim().split(/\s+/)[0] || null;
  const customer = first(people.customer);
  const agent = first(people.agent);
  return body.replace(customer ? /\{name\}/g : /,?\s*\{name\}/g, customer ?? "").replace(/\{agent\}/g, agent ?? "");
}

/** The saved replies a "/word" in the reply box asks for: shortcuts first, then titles, eight at most. */
export function matchReplies<T extends { shortcut: string; title: string }>(replies: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return replies.slice(0, 8);
  const starts = replies.filter((r) => r.shortcut.startsWith(q));
  const rest = replies.filter((r) => !r.shortcut.startsWith(q) && (r.shortcut.includes(q) || r.title.toLowerCase().includes(q)));
  return [...starts, ...rest].slice(0, 8);
}

/** A customer's answer to "How did we do?": 👍, 1, "good"… or 👎, 2, "bad"… — the whole message, nothing more. */
export function ratingOf(text: string): "GOOD" | "BAD" | null {
  const t = text.trim().toLowerCase().replace(/[.!\s]+$/u, "");
  if (/^(👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿|1|good|great|excellent|yes|helpful|😊|🙂|❤️)$/u.test(t)) return "GOOD";
  if (/^(👎|👎🏻|👎🏼|👎🏽|👎🏾|👎🏿|2|bad|poor|no|not good|not helpful|😞|🙁)$/u.test(t)) return "BAD";
  return null;
}

/** What the bubble says about how soon the team replies, from the median first response — or nothing without enough to go on. */
export function replyInText(medianMs: number | null, answered: number): string | null {
  if (medianMs === null || answered < 3) return null;
  const min = medianMs / 60_000;
  if (min < 5) return "Usually replies within a few minutes";
  if (min < 20) return "Usually replies within 15 minutes";
  if (min < 60) return "Usually replies within an hour";
  if (min < 240) return "Usually replies within a few hours";
  return "Usually replies within a day";
}

/** A file a customer or the team may send: pictures, PDFs and office documents — never a program or a web page. */
export const SENDABLE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

export type Prechat = { name: string | null; company: string | null; email: string | null; phone: string | null };

/**
 * The details a website asks for before its chat starts (Settings › Customer inbox, "Ask before the chat"):
 * each field as the channel sets it — required, optional, or not asked (and dropped if sent anyway).
 * What's given must look right even where it's optional.
 */
export function checkPrechat(input: { name?: unknown; company?: unknown; email?: unknown; phone?: unknown }, fields: Record<DetailField, FieldRule>): { ok: true; details: Prechat } | { ok: false; error: string } {
  const name = fields.name !== "off" && typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  const company = fields.company !== "off" && typeof input.company === "string" ? input.company.replace(/\s+/g, " ").trim().slice(0, 160) : "";
  const email = fields.email !== "off" && typeof input.email === "string" ? input.email.trim().toLowerCase().slice(0, 200) : "";
  const phone = fields.phone !== "off" && typeof input.phone === "string" ? input.phone.trim().slice(0, 20) : "";
  if (fields.name === "required" && name.length < 2) return { ok: false, error: "Please tell us your name." };
  if (name && name.length < 2) return { ok: false, error: "That name looks too short." };
  if (fields.company === "required" && company.length < 2) return { ok: false, error: "Please tell us your company's name." };
  if (fields.email === "required" && !email) return { ok: false, error: "Please give an email address we can reply to." };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: "That email address doesn't look right." };
  if (fields.phone === "required" && !phone) return { ok: false, error: "Please give a phone number." };
  const digits = phone.replace(/\D/g, "");
  if (phone && (digits.length < 7 || digits.length > 15 || !/^\+?[\d\s()-]+$/.test(phone))) return { ok: false, error: "That phone number doesn't look right." };
  return { ok: true, details: { name: name || null, company: company || null, email: email || null, phone: phone || null } };
}

/** How a file reads in the conversation, as WhatsApp's own do: "[Photo] the caption", "[Document: quote.pdf]". */
export function fileText(mime: string, name: string | null, caption?: string | null): string {
  const said = caption?.replace(/\s+/g, " ").trim();
  const what = mime.startsWith("image/") ? "[Photo]" : `[Document${name ? `: ${name}` : ""}]`;
  return said ? `${what} ${said}` : what;
}

/** The type a file is sent as, from what the browser said and its name; null for one that isn't sendable. */
export function sendableType(mime: string, name: string): string | null {
  const m = mime.split(";")[0]!.trim().toLowerCase();
  if (SENDABLE_TYPES[m]) return m;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return Object.entries(SENDABLE_TYPES).find(([, e]) => e === ext)?.[0] ?? null;
}
