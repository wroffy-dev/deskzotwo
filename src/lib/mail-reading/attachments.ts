import { graphBase } from "@/lib/mail/microsoft";
import { gmailBase } from "@/lib/mail/google";
import { zohoMailBase } from "@/lib/mail/zoho";
import { workplaceAccess, type Connection } from "@/lib/mail/mailbox";

/**
 * One attachment of a kept email, fetched from the mailbox when somebody asks for it (owner, 23 Nov 2026 — Arjun reading
 * a vendor bill that came by email; src/lib/mail-reading). Attachments are never kept with the email: this reads the
 * first PDF or picture of it, as the bill reader takes, at most 5 MB.
 */

export type MailFile = { name: string; type: string; bytes: Buffer };

const MAX = 5 * 1024 * 1024;
const READABLE = /^(application\/pdf|image\/(png|jpe?g|webp))$/i;
const byName = (name: string) => (/\.pdf$/i.test(name) ? "application/pdf" : /\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.webp$/i.test(name) ? "image/webp" : "");
const typeOf = (name: string, type: string | undefined) => (type && READABLE.test(type) ? type.toLowerCase() : byName(name));

async function json(url: string, headers: Record<string, string>): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers } }).catch(() => null);
  if (!res?.ok) return null;
  return ((await res.json().catch(() => null)) ?? null) as Record<string, unknown> | null;
}

async function outlookFile(token: string, id: string): Promise<MailFile | null> {
  const body = await json(`${graphBase()}/v1.0/me/messages/${encodeURIComponent(id)}/attachments`, { Authorization: `Bearer ${token}` });
  for (const a of ((body?.value ?? []) as Record<string, unknown>[])) {
    const name = String(a.name ?? "attachment");
    const type = typeOf(name, a.contentType as string | undefined);
    if (!type || Number(a.size ?? 0) > MAX || typeof a.contentBytes !== "string") continue;
    return { name, type, bytes: Buffer.from(a.contentBytes, "base64") };
  }
  return null;
}

async function gmailFile(token: string, id: string): Promise<MailFile | null> {
  const auth = { Authorization: `Bearer ${token}` };
  const msg = await json(`${gmailBase()}/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, auth);
  const parts: Record<string, unknown>[] = [];
  const walk = (p: Record<string, unknown> | undefined) => {
    if (!p) return;
    parts.push(p);
    for (const c of ((p.parts ?? []) as Record<string, unknown>[])) walk(c);
  };
  walk(msg?.payload as Record<string, unknown> | undefined);
  for (const p of parts) {
    const name = String(p.filename ?? "");
    const body = p.body as { attachmentId?: string; size?: number } | undefined;
    const type = typeOf(name, p.mimeType as string | undefined);
    if (!name || !body?.attachmentId || !type || Number(body.size ?? 0) > MAX) continue;
    const got = await json(`${gmailBase()}/gmail/v1/users/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(body.attachmentId)}`, auth);
    if (typeof got?.data !== "string") continue;
    return { name, type, bytes: Buffer.from(got.data.replace(/-/g, "+").replace(/_/g, "/"), "base64") };
  }
  return null;
}

async function zohoFile(token: string, z: NonNullable<Connection["zoho"]>, providerId: string): Promise<MailFile | null> {
  const [folderId, messageId] = providerId.split("/");
  if (!folderId || !messageId) return null;
  const base = `${zohoMailBase(z.region)}/api/accounts/${z.accountId}/folders/${folderId}/messages/${messageId}`;
  const auth = { Authorization: `Zoho-oauthtoken ${token}` };
  const info = await json(`${base}/attachmentinfo`, auth);
  const list = ((info?.data as { attachments?: Record<string, unknown>[] } | undefined)?.attachments ?? []) as Record<string, unknown>[];
  for (const a of list) {
    const name = String(a.attachmentName ?? "attachment");
    const type = typeOf(name, undefined);
    if (!type || Number(a.attachmentSize ?? 0) > MAX) continue;
    const res = await fetch(`${base}/attachments/${encodeURIComponent(String(a.attachmentId))}`, { headers: auth }).catch(() => null);
    if (!res?.ok) continue;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX) continue;
    return { name, type, bytes };
  }
  return null;
}

/** The first PDF or picture attached to an email in a person's mailbox — or null when there's none it can read. */
export async function firstReadableFile(userId: string, providerId: string): Promise<MailFile | null> {
  const access = await workplaceAccess(userId);
  if (!access.ok) return null;
  const { token, connection } = access;
  if (connection.provider === "MICROSOFT") return outlookFile(token, providerId);
  if (connection.provider === "GOOGLE") return gmailFile(token, providerId);
  return connection.zoho ? zohoFile(token, connection.zoho, providerId) : null;
}
