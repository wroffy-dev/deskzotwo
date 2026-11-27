import { escapeHtml } from "@/lib/marketing/html";

/**
 * Countdown timers and polls inside an email (owner, 1 Nov 2026 — the gaps against Mailchimp, Brevo, Zoho Campaigns).
 * Written in a template as
 *
 *   {{countdown 2026-11-15 18:00}}                 a picture of the time left, drawn fresh each time it's opened
 *   {{countdown 2026-11-15 18:00 | Offer ends in}}  with a line above the numbers
 *   {{poll How did we do? | Great | Okay | Poor}}  a question with a button for each answer
 *
 * Expanded once the fields are filled, before links are tagged and tracked. A countdown's time is the workspace's
 * clock (src/app/api/marketing/countdown/route.tsx reads it there). A poll's button opens a page where the answer is
 * pressed once more to count — mail scanners follow every link by themselves (src/app/(public)/preferences/poll/[token]).
 * A text email gets the same in words: the closing time, and each answer's address.
 */

const COUNTDOWN = /\{\{\s*countdown\s+(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?\s*(?:\|([^}]*))?\}\}/gi;
const POLL = /\{\{\s*poll\s+([^|}]+?)\s*((?:\|[^|}]+)+)\}\}/gi;

export const POLL_LIMITS = { answers: 6, text: 120 } as const;

/** `2026-11-15` and `18:00` as the one value the countdown address carries, or null if it isn't a real date. */
export function countdownTarget(day: string, time?: string | null): string | null {
  const [h, m] = (time ?? "23:59").split(":").map(Number);
  if (h! > 23 || m! > 59) return null;
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return null;
  return `${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function pollLink(origin: string, token: string, question: string, answer: string): string {
  return `${origin}/preferences/poll/${encodeURIComponent(token)}?q=${encodeURIComponent(question)}&a=${encodeURIComponent(answer)}`;
}

/** The polls a template asks, for its report. */
export function pollsIn(body: string): { question: string; answers: string[] }[] {
  return [...body.matchAll(POLL)].map((m) => ({
    question: m[1]!.trim().slice(0, POLL_LIMITS.text),
    answers: m[2]!.split("|").map((a) => a.trim().slice(0, POLL_LIMITS.text)).filter(Boolean).slice(0, POLL_LIMITS.answers),
  }));
}

export function expandWidgets(body: string, format: "HTML" | "TEXT", ctx: { origin: string; token: string }): string {
  const html = format === "HTML";
  let out = body.replace(COUNTDOWN, (whole: string, day: string, time: string | undefined, label: string | undefined) => {
    const target = countdownTarget(day, time);
    if (!target) return whole;
    const when = `${day} ${target.slice(11)}`;
    const caption = label?.trim();
    if (!html) return `${caption ? `${caption}: ` : "Ends "}${when}`;
    const src = `${ctx.origin}/api/marketing/countdown?to=${encodeURIComponent(target)}${caption ? `&l=${encodeURIComponent(caption.slice(0, 60))}` : ""}`;
    return `<img src="${escapeHtml(src)}" width="480" height="${caption ? 140 : 110}" alt="${escapeHtml(`${caption ? `${caption} — ` : ""}ends ${when}`)}" style="display:block;max-width:100%;height:auto;border:0;margin:12px auto">`;
  });
  out = out.replace(POLL, (whole: string, q: string, rest: string) => {
    const question = q.trim().slice(0, POLL_LIMITS.text);
    const answers = rest.split("|").map((a) => a.trim().slice(0, POLL_LIMITS.text)).filter(Boolean).slice(0, POLL_LIMITS.answers);
    if (!question || answers.length < 2) return whole;
    if (!html) return `${question}\n${answers.map((a) => `· ${a}: ${pollLink(ctx.origin, ctx.token, question, a)}`).join("\n")}`;
    const buttons = answers
      .map(
        (a) =>
          `<a href="${escapeHtml(pollLink(ctx.origin, ctx.token, question, a))}" style="display:inline-block;margin:4px;padding:8px 16px;border:1px solid #cbd5e1;border-radius:6px;color:#0f172a;text-decoration:none;font:14px Arial,sans-serif">${escapeHtml(a)}</a>`,
      )
      .join("");
    return `<div style="margin:16px 0;text-align:center"><p style="margin:0 0 8px;font:600 15px Arial,sans-serif;color:#0f172a">${escapeHtml(question)}</p>${buttons}</div>`;
  });
  return out;
}
