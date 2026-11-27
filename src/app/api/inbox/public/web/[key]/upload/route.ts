import { NextResponse, type NextRequest } from "next/server";
import { restoreInProgressFor } from "@/lib/backup/maintenance";
import { clientIpFrom } from "@/lib/client-ip";
import { readFormWithin } from "@/lib/http/body";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { siteAllowance } from "@/lib/platform/find-workspaces";
import { receiveWebFile, visitorBlocked, webChannel, webMessages } from "@/lib/inbox/server";
import { channelSettings } from "@/lib/inbox/settings";
import { TEAM_LIMITS } from "@/lib/inbox/team-rules";
import { TenantHostMismatch, TenantNotFound, TenantNotResolved, currentTenant } from "@/lib/tenancy/resolve";

/**
 * A file from a website visitor's chat bubble (owner, 24 Oct 2026: "files both ways"): a multipart POST —
 * `token`, `file` and an optional `caption` — into a conversation they've already begun. Photos, PDFs and
 * office documents up to 5 MB (src/lib/inbox/team-rules.ts `SENDABLE_TYPES`), from the sites the channel
 * allows, limited by address and by channel. Like ../route.ts, outside the proxy: the workspace is found
 * from the host here, and the visitor's token is their only credential.
 */

export const dynamic = "force-dynamic";

/** The file and the form around it. */
const BODY_LIMIT = TEAM_LIMITS.file + 64 * 1024;
const TEN_MINUTES = 10 * 60_000;

function cors(origin: string | null): Record<string, string> {
  return { "access-control-allow-origin": origin ?? "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin", "cache-control": "no-store" };
}

const answer = (body: Record<string, unknown>, status: number, origin: string | null) => NextResponse.json(body, { status, headers: cors(origin) });

export function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: { ...cors(req.headers.get("origin")), "access-control-max-age": "600" } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const origin = req.headers.get("origin");
  let tenantId: string;
  try {
    const tenant = await currentTenant();
    if (tenant.status !== "ACTIVE" || restoreInProgressFor(tenant)) return answer({ ok: false, error: "The chat is unavailable just now." }, 503, origin);
    tenantId = tenant.id;
  } catch (err) {
    if (err instanceof TenantHostMismatch || err instanceof TenantNotFound || err instanceof TenantNotResolved) return answer({ ok: false }, 404, origin);
    throw err;
  }
  if (Number(req.headers.get("content-length") ?? 0) > BODY_LIMIT) return answer({ ok: false, error: "Files can be up to 5 MB." }, 413, origin);

  const channel = await webChannel((await params).key);
  if (!channel || !(await moduleAvailableForTenant("inbox"))) return answer({ ok: false }, 404, origin);
  const settings = channelSettings(channel.settings, "WEB");
  if (settings.allowedSites.length && (!origin || !settings.allowedSites.includes(origin.toLowerCase()))) return answer({ ok: false, error: "This site can't show the chat." }, 403, origin);
  // Files switched off for this chat: refused before the file is read (src/lib/inbox/server.ts refuses it too).
  if (!settings.files.customers) return answer({ ok: false, error: "This chat doesn't take files. Please describe it in a message instead." }, 403, origin);

  const ip = clientIpFrom(req.headers) ?? "unknown";
  const k = (what: string) => `inbox|${tenantId}|${channel.id}|${what}`;
  // Security audit, 11 Nov 2026 (SEC-48): by address only — the channel-wide cap was one outsider's to use up for
  // every visitor. What is kept is held by byte budgets per conversation and workspace (SEC-34, receiveWebFile).
  if (!siteAllowance([{ key: k(`upload:${ip}`), max: 20 }], TEN_MINUTES)) {
    return answer({ ok: false, error: "Too many files just now. Please wait a few minutes." }, 429, origin);
  }

  // Security audit, 11 Nov 2026 (SEC-27): read streamed and stopped at BODY_LIMIT before it is parsed.
  const form = await readFormWithin(req, BODY_LIMIT).catch(() => null);
  const file = form?.get("file");
  const token = form?.get("token");
  const caption = form?.get("caption");
  if (!form || !(file instanceof File) || typeof token !== "string") return answer({ ok: false, error: "That file couldn't be read." }, 400, origin);
  if (file.size > TEAM_LIMITS.file) return answer({ ok: false, error: "Files can be up to 5 MB." }, 413, origin);
  if (await visitorBlocked(token)) return answer({ ok: false, blocked: true, error: "This chat isn't available." }, 403, origin);

  const kept = await receiveWebFile(channel, token, { bytes: Buffer.from(await file.arrayBuffer()), mime: file.type, name: file.name, caption: typeof caption === "string" ? caption : null });
  if (!kept) return answer({ ok: false, forget: true, error: "Start the chat with a message first." }, 404, origin);
  if (!kept.ok) return answer({ ok: false, error: kept.error }, 400, origin);
  return answer({ ok: true, messages: (await webMessages(channel.id, token, null)) ?? [] }, 200, origin);
}
