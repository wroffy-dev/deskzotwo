/**
 * The wording of Deskzo's own emails, as templates (owner, 1 Nov 2026: "templates should be editable from
 * platform Console"). Pure and client-safe: the console's editor previews with exactly what the server sends
 * with (src/lib/platform/mail/templates.ts).
 *
 * The rules a template follows, in the console's words:
 *   {name}          a field, filled in when the email is sent — the fields each email has are listed beside it
 *   [[ … ]]         an optional part: left out, brackets and all, when a field inside it is empty
 * Text outside braces is sent as written. An unknown {field} is refused when the template is saved, and the
 * fields an email can't work without (its link, its code) must stay in it.
 */

export type TemplateField = { name: string; about: string; sample: string };

/** The fields a piece of text uses, in order, without repeats. */
export function fieldsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((m) => m[1]!))];
}

function fillPlain(text: string, values: Record<string, string | null | undefined>): string {
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (whole, name: string) => (name in values ? (values[name] ?? "") : whole));
}

/**
 * The template with its fields filled in. An optional part goes when any field inside it is empty; a line left
 * empty by that goes too, so an optional sentence on a line of its own leaves no gap.
 */
export function fillTemplate(text: string, values: Record<string, string | null | undefined>): string {
  const DROPPED = "\u0000";
  // One pass over the template: a value goes in as it is, never read again for fields — a company called
  // "{link}" stays that — and a person's own blank lines are kept.
  const filled = text
    .split(/(\[\[[\s\S]*?\]\])/)
    .map((part) => {
      if (!part.startsWith("[[") || !part.endsWith("]]")) return fillPlain(part, values);
      const inner = part.slice(2, -2);
      const empty = fieldsIn(inner).some((name) => !(values[name] ?? "").toString().trim());
      return empty ? DROPPED : fillPlain(inner, values);
    })
    .join("");
  // A line that held only a part left out goes, and with it one of the blank lines around it, so an optional
  // paragraph leaves no gap.
  const lines = filled.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes(DROPPED) && line.replaceAll(DROPPED, "").trim() === "") {
      if ((kept.at(-1) ?? "").trim() === "" && (lines[i + 1] ?? "").trim() === "") i++;
      continue;
    }
    kept.push(line.replaceAll(DROPPED, ""));
  }
  return kept.join("\n").trim();
}

/** Why a template can't be saved, or null. `fields` are those the email has; `required` must each appear. */
export function templateProblem(input: { subject: string; text: string }, fields: readonly TemplateField[], required: readonly string[]): string | null {
  const subject = input.subject.trim();
  const text = input.text.trim();
  if (!subject) return "Give it a subject.";
  if (subject.length > 200) return "Keep the subject under 200 characters.";
  if (/[\r\n]/.test(subject)) return "The subject is one line.";
  if (!text) return "There's nothing in the email.";
  if (text.length > 10_000) return "Keep the email under 10,000 characters.";
  const known = new Set(fields.map((f) => f.name));
  const unknown = fieldsIn(`${subject}\n${text}`).filter((name) => !known.has(name));
  if (unknown.length) return `No such field: ${unknown.map((n) => `{${n}}`).join(", ")}. This email has ${fields.map((f) => `{${f.name}}`).join(", ") || "no fields"}.`;
  const opens = (text.match(/\[\[/g) ?? []).length;
  const closes = (text.match(/\]\]/g) ?? []).length;
  if (opens !== closes) return "An optional part [[ … ]] isn't closed.";
  const missing = required.filter((name) => !fieldsIn(text.replace(/\[\[[\s\S]*?\]\]/g, "")).includes(name));
  if (missing.length) return `The email can't work without ${missing.map((n) => `{${n}}`).join(" and ")} — keep it in the text, outside any optional part.`;
  return null;
}

/** The sample values, for a preview. */
export function sampleValues(fields: readonly TemplateField[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.name, f.sample]));
}
