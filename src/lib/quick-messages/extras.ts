import { db } from "@/lib/db";
import { buildMarketingEmail, marketingSettings, soonestSubscriptions, usesSubscriptionFields, type Recipient } from "@/lib/marketing/pipeline";
import { previewValues } from "@/lib/marketing/merge";
import { sanitizeEmailHtml } from "@/lib/marketing/html";
import { OWN_FILES } from "@/lib/quick-messages/own-files";

/**
 * Two things the quick-message email gained (owner, 16 Nov 2026: "template selection? no attachment option?" — "both"):
 *
 *   - **Files of the sender's own**, attached to that one email: a quote, a brochure. PDFs only
 *     (owner, 16 Nov 2026: "only pdf"), each checked to be one, and 3 MB at most in all (Microsoft 365 takes an
 *     attachment inline up to about that).
 *   - **Marketing › Templates' designed emails**, beside the message templates: filled in for each person as a campaign
 *     fills them, with their own footer and unsubscribe link, sent one to one from the same mailbox. Their words are the
 *     template's — the subject may be changed, the body is changed in Marketing.
 */


export type OwnFile = { name: string; mime: string; bytes: Buffer };

/** PDFs only (owner, 16 Nov 2026: "only pdf"): what a customer opens safely, and what a quote or brochure is. */
const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";

/** A name safe to hand a mail server: no path, no control characters, no quotes, not too long. */
function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "").trim().slice(-120);
  return clean || "attachment";
}

/** The sender's own files, checked: PDFs only, each really one, within the limits. */
export function checkedOwnFiles(files: { name: string; bytes: Buffer }[]): { ok: true; files: OwnFile[] } | { ok: false; error: string } {
  if (files.length > OWN_FILES.maxFiles) return { ok: false, error: `Attach ${OWN_FILES.maxFiles} files at most.` };
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  if (total > OWN_FILES.maxBytes) return { ok: false, error: "The files come to more than 3 MB together — the mail server may refuse that. Send a smaller copy, or a link." };
  const out: OwnFile[] = [];
  for (const f of files) {
    const name = cleanName(f.name);
    if (f.bytes.length === 0) return { ok: false, error: `${name} is empty.` };
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    if (ext !== "pdf") return { ok: false, error: `${name} can't be attached — only PDFs can.` };
    if (!isPdf(f.bytes)) return { ok: false, error: `${name} isn't a PDF inside. Save it as a PDF again and attach that.` };
    out.push({ name, mime: "application/pdf", bytes: f.bytes });
  }
  return { ok: true, files: out };
}

export type QuickMarketingEmail = { id: string; name: string; subject: string; html: string };

/** The designed emails a quick message may use: Marketing's live email templates, each as it would look. */
export async function marketingEmailsForQuick(origin: string): Promise<QuickMarketingEmail[]> {
  const [templates, settings] = await Promise.all([
    db.marketingTemplate.findMany({ where: { active: true, channel: "EMAIL" }, orderBy: { updatedAt: "desc" }, take: 60, select: { id: true, name: true, subject: true, preheader: true, body: true, format: true } }),
    marketingSettings(),
  ]);
  const sample = previewValues();
  const recipient: Recipient = { contactId: "", companyId: "", companyName: String(sample.companyName ?? ""), name: String(sample.fullName ?? sample.firstName ?? ""), email: null, phone: null, ownerName: String(sample.ownerName ?? ""), ownerEmail: null, state: {} as Recipient["state"] };
  return templates.flatMap((t) => {
    const built = buildMarketingEmail({ template: { ...t, body: t.format === "HTML" ? sanitizeEmailHtml(t.body) : t.body }, recipient, settings, token: "preview", origin, trackingKey: null, extras: sample });
    return built.ok ? [{ id: t.id, name: t.name, subject: t.subject ?? "", html: built.html }] : [{ id: t.id, name: t.name, subject: t.subject ?? "", html: "" }];
  });
}

export type MarketingForPerson = (person: { contactId: string; name: string; email: string }, token: string) => { ok: true; subject: string; html: string; text: string } | { ok: false; error: string };

/**
 * A designed email, ready to fill in for each person at one company — or why it can't go. A renewal email takes the
 * company's soonest live subscription, as a mass mail does, and refuses when there is none.
 */
export async function marketingEmailFor(templateId: string, companyId: string, subjectOverride: string, origin: string): Promise<{ ok: true; build: MarketingForPerson } | { ok: false; error: string }> {
  const template = await db.marketingTemplate.findUnique({ where: { id: templateId }, select: { active: true, channel: true, subject: true, preheader: true, body: true, format: true } });
  if (!template?.active || template.channel !== "EMAIL") return { ok: false, error: "That marketing email isn't in use any more." };
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { name: true, relationshipType: true, owner: { select: { name: true, email: true } }, locations: { orderBy: { isPrimary: "desc" }, take: 1, select: { city: true, state: true } } },
  });
  if (!company) return { ok: false, error: "That customer no longer exists." };
  const settings = await marketingSettings();
  let extras = {};
  if (usesSubscriptionFields(template)) {
    const subs = await soonestSubscriptions([companyId], settings.rules.clock.calendarDate(new Date()));
    const found = subs.get(companyId);
    if (!found) return { ok: false, error: `This is a renewal email, and ${company.name} has no live subscription to fill its details from.` };
    extras = found;
  }
  const subject = subjectOverride.trim() ? subjectOverride.trim().slice(0, 300) : template.subject;
  const body = template.format === "HTML" ? sanitizeEmailHtml(template.body) : template.body;
  const build: MarketingForPerson = (person, token) => {
    const recipient: Recipient = {
      contactId: person.contactId,
      companyId,
      companyName: company.name,
      name: person.name,
      email: person.email,
      phone: null,
      ownerName: company.owner?.name ?? null,
      ownerEmail: company.owner?.email ?? null,
      state: {} as Recipient["state"],
      isCustomer: company.relationshipType === "CLIENT",
      city: company.locations[0]?.city ?? null,
      region: company.locations[0]?.state ?? null,
    };
    const built = buildMarketingEmail({ template: { ...template, subject, body }, recipient, settings, token, origin, trackingKey: null, extras });
    if (!built.ok) return { ok: false, error: `It has no value for ${built.missing.map((k) => `{{${k}}}`).join(", ")} for ${person.name}.` };
    return { ok: true, subject: built.subject, html: built.html, text: built.text };
  };
  return { ok: true, build };
}
