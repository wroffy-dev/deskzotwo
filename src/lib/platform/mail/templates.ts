import { DESKZO_BLUE } from "@/lib/branding";
import { controlConfigured } from "@/lib/platform/control-db";
import { getSetting, setSetting } from "@/lib/platform/settings";
import { fillTemplate, templateProblem } from "@/lib/console-shared/mail-template-engine";
import { MAIL_TEMPLATES, type MailTemplateDef, type MailTemplateKey } from "@/lib/console-shared/mail-templates";

/**
 * Deskzo's own emails, worded from the console (owner, 1 Nov 2026). Each email the platform writes has a
 * template (src/lib/console-shared/mail-templates.ts) with Deskzo's wording; an owner may change its subject
 * and text in Settings › Mail › Templates, kept as one setting (`mail.templates`). A saved wording that no
 * longer passes the checks — a field renamed in a later release — is passed over for Deskzo's, so an email
 * is never sent broken. Every email goes in the same plain branded layout.
 */

export type SavedWording = { subject: string; text: string; updatedAt: string; updatedBy: string };
type Saved = Partial<Record<MailTemplateKey, SavedWording>>;

let cached: { at: number; saved: Saved } | null = null;
let testSaved: Saved | null = null;

/** For check scripts: the saved wordings, without a control plane. Null: the real ones. */
export function setTestMailTemplates(saved: Saved | null): void {
  testSaved = saved;
  cached = null;
}

/** The wordings saved in the console — a minute old at most. A control plane out of reach: Deskzo's own. */
export async function savedWordings(): Promise<Saved> {
  if (testSaved) return testSaved;
  if (cached && Date.now() - cached.at < 60_000) return cached.saved;
  let saved: Saved = {};
  if (controlConfigured()) {
    try {
      const raw = await getSetting("mail.templates");
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      saved = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Saved) : {};
    } catch {
      saved = {};
    }
  }
  cached = { at: Date.now(), saved };
  return saved;
}

export function templateDef(key: MailTemplateKey): MailTemplateDef {
  const def = MAIL_TEMPLATES.find((t) => t.key === key);
  if (!def) throw new Error(`No such mail template: ${key}`);
  return def;
}

/** The wording an email goes with: the console's when it still passes the checks, otherwise Deskzo's. */
export function wordingOf(def: MailTemplateDef, saved: Saved): { subject: string; text: string; edited: boolean } {
  const own = saved[def.key];
  if (own && templateProblem(own, def.fields, def.required) === null) return { subject: own.subject, text: own.text, edited: true };
  return { subject: def.subject, text: def.text, edited: false };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The branded layout every one of Deskzo's emails goes in: the name in Deskzo blue, the text as written with
 * its links clickable, and a quiet footer. Inline styles and a table, as mail programs want; no images, so
 * nothing is blocked and nothing tracks.
 */
export function brandedHtml(text: string): string {
  const body = text
    .split(/\n{2,}/)
    .map((para) =>
      escapeHtml(para)
        .replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" style="color:${DESKZO_BLUE};word-break:break-all">${url}</a>`)
        .replace(/\n/g, "<br>"),
    )
    .map((para) => `<p style="margin:0 0 16px">${para}</p>`)
    .join("");
  return (
    `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6fb">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 12px"><tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e3e7ef">` +
    `<tr><td style="padding:22px 28px 0;font:700 20px/1 Arial,Helvetica,sans-serif;color:${DESKZO_BLUE};letter-spacing:-0.3px">Deskzo</td></tr>` +
    `<tr><td style="padding:18px 28px 8px;font:15px/1.6 Arial,Helvetica,sans-serif;color:#1f2533">${body}</td></tr>` +
    `</table>` +
    `<p style="max-width:560px;margin:14px auto 0;font:12px/1.5 Arial,Helvetica,sans-serif;color:#8a93a6">Sent by Deskzo · deskzo.com</p>` +
    `</td></tr></table></body></html>`
  );
}

export type RenderedMail = { subject: string; text: string; html: string };

/** One of Deskzo's emails, filled in: the console's wording or Deskzo's, and the branded layout. */
export async function renderPlatformMail(key: MailTemplateKey, values: Record<string, string | null | undefined>): Promise<RenderedMail> {
  const def = templateDef(key);
  const wording = wordingOf(def, await savedWordings());
  const text = fillTemplate(wording.text, values);
  return { subject: fillTemplate(wording.subject, values).replace(/\s+/g, " ").trim(), text, html: brandedHtml(text) };
}

/** Deskzo's own wording, filled in — what an email says with nothing changed in the console. Synchronous, for the mails' own builders. */
export function defaultPlatformMail(key: MailTemplateKey, values: Record<string, string | null | undefined>): { subject: string; text: string } {
  const def = templateDef(key);
  return { subject: fillTemplate(def.subject, values).replace(/\s+/g, " ").trim(), text: fillTemplate(def.text, values) };
}

/**
 * Saves a wording from the console, or `null` to go back to Deskzo's. Refused, with the reason, when it
 * doesn't pass the checks. Gives back the wordings as saved.
 */
export async function saveWording(key: MailTemplateKey, wording: { subject: string; text: string } | null, by: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const def = templateDef(key);
  const current = { ...(await savedWordings()) };
  cached = null;
  if (wording === null) {
    delete current[key];
  } else {
    const subject = wording.subject.trim();
    const text = wording.text.replace(/\r\n/g, "\n").trim();
    const problem = templateProblem({ subject, text }, def.fields, def.required);
    if (problem) return { ok: false, error: problem };
    current[key] = { subject, text, updatedAt: new Date().toISOString(), updatedBy: by };
  }
  if (testSaved) {
    testSaved = current;
  } else {
    await setSetting("mail.templates", Object.keys(current).length ? JSON.stringify(current) : null, by);
  }
  cached = null;
  return { ok: true };
}

/**
 * The parts of a PlatformMail an email's template gives (src/lib/platform/mailer.ts): its subject, text and
 * branded html, and — for an email about one workspace — "<Workspace> via Deskzo" as the From name (owner,
 * 1 Nov 2026). Spread into the mail: `sendPlatformMail({ type, to, ...(await templateMail(key, values, { workspace })) })`.
 */
export async function templateMail(
  key: MailTemplateKey,
  values: Record<string, string | null | undefined>,
  options: { workspace?: string | null } = {},
): Promise<RenderedMail & { fromName?: string }> {
  const mail = await renderPlatformMail(key, values);
  const workspace = options.workspace?.trim();
  return workspace && templateDef(key).fromWorkspace ? { ...mail, fromName: viaDeskzo(workspace) } : mail;
}

/** "Wroffy Technologies via Deskzo" — the From name of an email about one workspace. */
export function viaDeskzo(workspace: string): string {
  return `${workspace.replace(/["<>\r\n]/g, "").trim()} via Deskzo`;
}
