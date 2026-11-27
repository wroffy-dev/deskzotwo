import { graphBase } from "@/lib/mail/microsoft";
import { gmailBase } from "@/lib/mail/google";
import { zohoMailBase } from "@/lib/mail/zoho";
import type { Connection } from "@/lib/mail/mailbox";
import { addressOf } from "@/lib/mail-reading/agents";

/**
 * Reading a person's own mailbox — Outlook (Graph), Gmail or Zoho Mail — with the permission each grants to read
 * (src/lib/mail-reading). Each gives back the mail received or sent after a moment, oldest first, as one shape. Nothing is
 * kept here: src/lib/mail-reading/sync.ts decides what's kept, and keeps only mail with somebody already in Deskzo.
 */

export const READ_SCOPES = {
  MICROSOFT: "Mail.Read",
  GOOGLE: "https://www.googleapis.com/auth/gmail.readonly",
  ZOHO: "ZohoMail.messages.READ,ZohoMail.folders.READ",
} as const;

/** Whether what a provider granted lets Deskzo read the mailbox. */
export function grantsRead(provider: Connection["provider"], scope: string | null | undefined): boolean {
  const s = String(scope ?? "");
  if (provider === "MICROSOFT") return /\bMail\.Read(Write)?\b/i.test(s);
  if (provider === "GOOGLE") return /gmail\.readonly|gmail\.modify|mail\.google\.com/i.test(s);
  return /ZohoMail\.messages\.(READ|ALL)/i.test(s);
}

export type ReadMail = {
  providerId: string;
  threadId: string | null;
  fromEmail: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string;
  sentAt: Date;
  snippet: string;
  bodyText: string;
  hasAttachments: boolean;
};

export type ReadPage = { ok: true; mails: ReadMail[]; more: boolean } | { ok: false; status: number; error: string };

const BODY_MAX = 20_000;
const tidy = (t: string) => t.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, BODY_MAX);
const fromHtml = (h: string) =>
  h
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

async function getJson(url: string, token: string, headers: Record<string, string> = {}): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...headers } }).catch(() => null);
  if (!res) return { ok: false, status: 0, error: "The mailbox couldn't be reached." };
  if (!res.ok) return { ok: false, status: res.status, error: `The mailbox answered ${res.status}.` };
  return { ok: true, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
}

type J = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

// ─── Outlook ──────────────────────────────────────────────────────────────────

function graphAddress(r: unknown): { email: string; name: string | null } {
  const e = (r as { emailAddress?: { address?: string; name?: string } } | null)?.emailAddress;
  return { email: addressOf(e?.address), name: e?.name?.trim() || null };
}

async function readOutlook(token: string, since: Date, limit: number): Promise<ReadPage> {
  const select = "id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,sentDateTime,bodyPreview,body,hasAttachments";
  const url = `${graphBase()}/v1.0/me/messages?$filter=${encodeURIComponent(`receivedDateTime gt ${since.toISOString()}`)}&$orderby=receivedDateTime asc&$top=${limit}&$select=${select}`;
  const r = await getJson(url, token, { Prefer: 'outlook.body-content-type="text"' });
  if (!r.ok) return r;
  const mails = ((r.body.value ?? []) as J[]).map((m) => {
    const from = graphAddress(m.from);
    const body = m.body as { content?: string; contentType?: string } | undefined;
    return {
      providerId: s(m.id),
      threadId: s(m.conversationId) || null,
      fromEmail: from.email,
      fromName: from.name,
      to: ((m.toRecipients ?? []) as unknown[]).map((x) => graphAddress(x).email).filter(Boolean),
      cc: ((m.ccRecipients ?? []) as unknown[]).map((x) => graphAddress(x).email).filter(Boolean),
      subject: s(m.subject),
      sentAt: new Date(s(m.receivedDateTime) || s(m.sentDateTime)),
      snippet: s(m.bodyPreview).slice(0, 300),
      bodyText: tidy(body?.contentType === "html" ? fromHtml(s(body.content)) : s(body?.content)),
      hasAttachments: m.hasAttachments === true,
    };
  });
  return { ok: true, mails, more: !!r.body["@odata.nextLink"] };
}

// ─── Gmail ────────────────────────────────────────────────────────────────────

const b64url = (v: string) => Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function gmailText(part: J | undefined): { plain: string; html: string; attachments: boolean } {
  const out = { plain: "", html: "", attachments: false };
  const walk = (p: J | undefined) => {
    if (!p) return;
    const mime = s(p.mimeType);
    const body = p.body as { data?: string; attachmentId?: string } | undefined;
    if (s(p.filename) || body?.attachmentId) out.attachments = true;
    else if (mime === "text/plain" && body?.data && !out.plain) out.plain = b64url(body.data);
    else if (mime === "text/html" && body?.data && !out.html) out.html = b64url(body.data);
    for (const c of (p.parts ?? []) as J[]) walk(c);
  };
  walk(part);
  return out;
}

const header = (headers: J[], name: string) => s(headers.find((h) => s(h.name).toLowerCase() === name)?.value);
const list = (v: string) => v.split(",").map((x) => addressOf(x)).filter(Boolean);

async function readGmail(token: string, since: Date, limit: number): Promise<ReadPage> {
  // Gmail lists newest first, by whole seconds; the oldest `limit` after the moment are read first, so nothing is skipped.
  const ids: string[] = [];
  let pageToken = "";
  for (let i = 0; i < 20; i++) {
    const q = encodeURIComponent(`after:${Math.floor(since.getTime() / 1000)} -in:chats`);
    const r = await getJson(`${gmailBase()}/gmail/v1/users/me/messages?q=${q}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`, token);
    if (!r.ok) return r;
    for (const m of (r.body.messages ?? []) as J[]) ids.push(s(m.id));
    pageToken = s(r.body.nextPageToken);
    if (!pageToken) break;
  }
  const oldestFirst = ids.reverse();
  const mails: ReadMail[] = [];
  for (const id of oldestFirst.slice(0, limit)) {
    const r = await getJson(`${gmailBase()}/gmail/v1/users/me/messages/${id}?format=full`, token);
    if (!r.ok) return r;
    const m = r.body;
    const payload = m.payload as J | undefined;
    const headers = (payload?.headers ?? []) as J[];
    const from = header(headers, "from");
    const text = gmailText(payload);
    const sentAt = new Date(Number(m.internalDate) || Date.parse(header(headers, "date")));
    if (sentAt.getTime() <= since.getTime()) continue;
    mails.push({
      providerId: s(m.id),
      threadId: s(m.threadId) || null,
      fromEmail: addressOf(from),
      fromName: from.replace(/<[^>]+>/, "").replace(/"/g, "").trim() || null,
      to: list(header(headers, "to")),
      cc: list(header(headers, "cc")),
      subject: header(headers, "subject"),
      sentAt,
      snippet: s(m.snippet).slice(0, 300),
      bodyText: tidy(text.plain || fromHtml(text.html)),
      hasAttachments: text.attachments,
    });
  }
  return { ok: true, mails, more: oldestFirst.length > limit };
}

// ─── Zoho Mail ────────────────────────────────────────────────────────────────

async function readZoho(token: string, z: NonNullable<Connection["zoho"]>, since: Date, limit: number): Promise<ReadPage> {
  const base = `${zohoMailBase(z.region)}/api/accounts/${z.accountId}`;
  const auth = { Authorization: `Zoho-oauthtoken ${token}` };
  const get = async (url: string) => {
    const res = await fetch(url, { headers: { ...auth, Accept: "application/json" } }).catch(() => null);
    if (!res) return { ok: false as const, status: 0, error: "The mailbox couldn't be reached." };
    if (!res.ok) return { ok: false as const, status: res.status, error: `The mailbox answered ${res.status}.` };
    return { ok: true as const, body: ((await res.json().catch(() => ({}))) ?? {}) as J };
  };
  const folders = await get(`${base}/folders`);
  if (!folders.ok) return folders;
  const wanted = ((folders.body.data ?? []) as J[]).filter((f) => /^(inbox|sent)$/i.test(s(f.folderType ?? f.folderName)));
  const found: { m: J; folderId: string }[] = [];
  for (const f of wanted) {
    // Newest first; read until older than the moment.
    for (let start = 1; start < 2000; start += 100) {
      const page = await get(`${base}/messages/view?folderId=${s(f.folderId)}&start=${start}&limit=100&sortorder=false`);
      if (!page.ok) return page;
      const rows = (page.body.data ?? []) as J[];
      const newer = rows.filter((m) => Number(m.receivedTime) > since.getTime());
      for (const m of newer) found.push({ m, folderId: s(f.folderId) });
      if (rows.length < 100 || newer.length < rows.length) break;
    }
  }
  found.sort((a, b) => Number(a.m.receivedTime) - Number(b.m.receivedTime));
  const mails: ReadMail[] = [];
  for (const { m, folderId } of found.slice(0, limit)) {
    const content = await get(`${base}/folders/${folderId}/messages/${s(m.messageId)}/content`);
    const html = content.ok ? s((content.body.data as J | undefined)?.content) : "";
    mails.push({
      // Its folder too: Zoho reads an attachment by folder and message (src/lib/mail-reading/attachments.ts).
      providerId: `${folderId}/${s(m.messageId)}`,
      threadId: s(m.threadId) || null,
      fromEmail: addressOf(s(m.fromAddress)),
      fromName: s(m.sender).trim() || null,
      to: list(s(m.toAddress).replace(/&lt;/g, "<").replace(/&gt;/g, ">")),
      cc: list(s(m.ccAddress).replace(/&lt;/g, "<").replace(/&gt;/g, ">")),
      subject: s(m.subject),
      sentAt: new Date(Number(m.receivedTime)),
      snippet: s(m.summary).slice(0, 300),
      bodyText: tidy(fromHtml(html) || s(m.summary)),
      hasAttachments: s(m.hasAttachment) === "1" || m.hasAttachment === true,
    });
  }
  return { ok: true, mails, more: found.length > limit };
}

/** The mail received or sent after `since`, oldest first, at most `limit`. */
export function readMailbox(token: string, connection: Connection, since: Date, limit = 50): Promise<ReadPage> {
  if (connection.provider === "MICROSOFT") return readOutlook(token, since, limit);
  if (connection.provider === "GOOGLE") return readGmail(token, since, limit);
  if (!connection.zoho) return Promise.resolve({ ok: false, status: 0, error: "Its Zoho Mail account isn't recorded — connect it again." });
  return readZoho(token, connection.zoho, since, limit);
}
