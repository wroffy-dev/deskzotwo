import { NextResponse, type NextRequest } from "next/server";
import { restoreInProgressFor } from "@/lib/backup/maintenance";
import { createHash } from "node:crypto";
import { callerKeyIp, clientIpFrom } from "@/lib/client-ip";
import { readTextWithin } from "@/lib/http/body";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { siteAllowance } from "@/lib/platform/find-workspaces";
import { contentDisposition } from "@/lib/content-disposition";
import { rateWeb, receiveWebMessage, typicalReply, visitorBlocked, visitorFile, visitorSeen, visitorTyping, webChannel, webMessages, webPresence, type VisitorInfo } from "@/lib/inbox/server";
import { deviceFromUserAgent, locationFromHeaders, validLanguage, validZone } from "@/lib/inbox/visitor";
import { INBOX_LIMITS, channelSettings, withinHours } from "@/lib/inbox/settings";
import { forgetVisitor, linkVisitorToConversation, pingVisitor, recordLeave, recordView } from "@/lib/inbox/activity";
import { checkPrechat } from "@/lib/inbox/team-rules";
import { workspaceClock } from "@/lib/time/workspace";
import { TenantHostMismatch, TenantNotFound, TenantNotResolved, currentTenant } from "@/lib/tenancy/resolve";
import { teammate } from "@/lib/ai/teammates-server";

/**
 * A website's chat bubble talking to the Customer inbox (src/lib/inbox/widget-script.ts): POST, from any
 * site the channel allows, with a text/plain JSON body so no preflight is needed.
 *
 *   { op: "config" }                          the bubble's title, colour, corner, greeting, and what it
 *                                             asks first and says on its own
 *   { op: "send", token?, text, page?, name?, company?, email?, phone?, opener? }
 *                                             a visitor's message — a new conversation without a token,
 *                                             with the details asked before it where the channel asks
 *   { op: "poll", token, after? }             what was said since
 *   { op: "rate", token, rating, comment? }   "How did we do?", once it's closed
 *   { op: "file", token, id }                 a file in their conversation, as itself
 *   { op: "view", vid, title?, ref?, m?, scr?, touch?, net? }   a page, from a visitor who agreed (website activity)
 *   { op: "leave", vid, sec }                 how long they stayed on it
 *   { op: "ping", vid }                       still here, every 20 seconds while the tab shows; answers with a chat somebody started
 *
 * Files from the visitor come to ./upload. A visitor the team blocked gets `blocked: true` and nothing else.
 *
 * No session: the visitor's token — kept by their browser, its digest by us — is their credential, and
 * says nothing about anybody else's conversation. Limited by address and by channel, small bodies only,
 * and outside the proxy (src/proxy.ts matcher), so the workspace is found from the host here.
 */

export const dynamic = "force-dynamic";

const BODY_LIMIT = 8 * 1024;
const TEN_MINUTES = 10 * 60_000;
/** How far past the channel-wide cap on new conversations a known caller under its own cap may go (RL-03, at "send"). */
const NEW_HELD_FACTOR = 10;

function cors(origin: string | null): Record<string, string> {
  return { "access-control-allow-origin": origin ?? "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin", "cache-control": "no-store" };
}

const answer = (body: Record<string, unknown>, status: number, origin: string | null) => NextResponse.json(body, { status, headers: cors(origin) });

export function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: { ...cors(req.headers.get("origin")), "access-control-max-age": "600" } });
}

async function readBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  // Security audit, 11 Nov 2026 (SEC-27): read streamed and stopped at BODY_LIMIT, chunked bodies included.
  const text = await readTextWithin(req, BODY_LIMIT).catch(() => null);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

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
  const body = await readBody(req);
  if (!body) return answer({ ok: false, error: "That message couldn't be read." }, 400, origin);

  const channel = await webChannel((await params).key);
  if (!channel || !(await moduleAvailableForTenant("inbox"))) return answer({ ok: false }, 404, origin);
  const settings = channelSettings(channel.settings, "WEB");
  // A channel limited to some sites answers no other — a browser says which site a call came from.
  if (settings.allowedSites.length && (!origin || !settings.allowedSites.includes(origin.toLowerCase()))) return answer({ ok: false, error: "This site can't show the chat." }, 403, origin);

  // By /64 for IPv6 (callerKeyIp). Null when the address isn't known: a new conversation then has no per-caller cap
  // and shares only the channel-wide one (RL-03, at "send"); the other ops still count such callers together.
  const caller = clientIpFrom(req.headers);
  const ip = caller ? callerKeyIp(caller) : "unknown";
  const k = (what: string) => `inbox|${tenantId}|${channel.id}|${what}`;
  const op = str(body.op);
  /** Who they are, as far as the request and their browser tell: no outside lookup, no IP address kept. */
  const visitor = (): VisitorInfo => {
    const where = locationFromHeaders(req.headers);
    const page = str(body.page);
    return {
      page: /^https?:\/\//.test(page) ? page.slice(0, 500) : null,
      timezone: validZone(body.tz),
      language: validLanguage(body.lang),
      device: deviceFromUserAgent(req.headers.get("user-agent")),
      country: where.country,
      region: where.region,
      city: where.city,
    };
  };

  // A visitor the team blocked: their conversation is gone from their side, and they can't add to it.
  if (op !== "config" && (await visitorBlocked(str(body.token)))) return answer({ ok: false, blocked: true, error: "This chat isn't available." }, 403, origin);

  if (op === "seen") {
    if (!siteAllowance([{ key: k(`seen:${ip}`), max: 120 }], TEN_MINUTES)) return answer({ ok: false }, 429, origin);
    await visitorSeen(channel.id, str(body.token), visitor());
    return answer({ ok: true }, 200, origin);
  }

  if (op === "typing") {
    if (!siteAllowance([{ key: k(`typing:${ip}`), max: 600 }], TEN_MINUTES)) return answer({ ok: false }, 429, origin);
    const known = await visitorTyping(channel, str(body.token), { active: body.active === true, text: typeof body.text === "string" ? body.text : null });
    return answer({ ok: known }, 200, origin);
  }

  if (op === "config") {
    if (!siteAllowance([{ key: k(`config:${ip}`), max: 120 }], TEN_MINUTES)) return answer({ ok: false }, 429, origin);
    // Outside the channel's office hours the bubble says so up front, as the conversation will.
    const away = settings.hours.on && !withinHours(settings.hours, (await workspaceClock()).parts(new Date())) ? settings.hours.away : null;
    return answer(
      {
        ok: true,
        title: settings.look.title,
        colour: settings.look.colour,
        position: settings.look.position,
        greeting: settings.greeting,
        // A channel that names no assistant answers as Kabir, the front desk — or the workspace's own name for him
        // (src/lib/ai/teammates.ts). Only while its bot answers at all.
        assistant: settings.bot.name || (settings.bot.on ? (await teammate("kabir")).name : null),
        away,
        peek: settings.peek,
        // "Usually replies within 15 minutes" — only while the team is in.
        replyIn: away ? null : await typicalReply(channel.id),
        prechat: settings.prechat.on ? { fields: settings.prechat.fields } : null,
        proactive: settings.proactive,
        // Questions offered as buttons under the welcome, while the bot is on to answer them.
        suggestions: settings.bot.on ? settings.bot.suggestions : [],
        // Whether the bubble offers its attach button.
        files: settings.files.customers,
        // Website activity: on, and how the visitor agrees to it. Nothing is reported without that.
        activity: settings.activity.on ? { consent: settings.activity.consent, notice: settings.activity.notice } : null,
      },
      200,
      origin,
    );
  }

  // Honoured whether or not the channel still has it on: agreement withdrawn takes back what was kept.
  if (op === "forget") {
    if (!siteAllowance([{ key: k(`forget:${ip}`), max: 30 }], TEN_MINUTES)) return answer({ ok: false }, 429, origin);
    await forgetVisitor(channel.id, body.vid).catch((err) => console.error("[activity] forget failed", err instanceof Error ? err.message : ""));
    return answer({ ok: true }, 200, origin);
  }

  if (op === "ping") {
    if (!settings.activity.on) return answer({ ok: false }, 200, origin);
    if (!siteAllowance([{ key: k(`ping:${ip}`), max: 1500 }], TEN_MINUTES)) return answer({ ok: false }, 429, origin);
    const invite = await pingVisitor(channel.id, body.vid).catch((err) => {
      console.error("[activity] a ping failed", err instanceof Error ? err.message : "");
      return null;
    });
    return answer({ ok: true, invite }, 200, origin);
  }

  if (op === "view" || op === "leave") {
    if (!settings.activity.on) return answer({ ok: false }, 200, origin);
    // Security audit, 11 Nov 2026 (SEC-48): by address only — a channel-wide cap was one outsider's to use up
    // for every visitor. What is kept is bounded per visitor a day instead (SEC-34, src/lib/inbox/activity.ts).
    if (!siteAllowance([{ key: k(`view:${ip}`), max: 300 }], TEN_MINUTES)) return answer({ ok: false }, 429, origin);
    try {
      if (op === "leave") await recordLeave(channel.id, { visitorId: body.vid, page: body.page, seconds: body.sec });
      else
        await recordView(
          channel.id,
          {
            visitorId: body.vid,
            page: body.page,
            title: body.title,
            referrer: body.ref,
            fromEmail: body.m,
            screen: body.scr,
            touchPoints: body.touch,
            connection: body.net,
            language: body.lang,
            timezone: body.tz,
            ip: clientIpFrom(req.headers),
            headers: req.headers,
          },
          settings.activity.keyPages,
        );
    } catch (err) {
      // A page on a customer's website never hears about it.
      console.error("[activity] a page couldn't be recorded", err instanceof Error ? err.message : "");
    }
    return answer({ ok: true }, 200, origin);
  }

  if (op === "rate") {
    if (!siteAllowance([{ key: k(`rate:${ip}`), max: 20 }], TEN_MINUTES)) return answer({ ok: false }, 429, origin);
    const kept = await rateWeb(channel.id, str(body.token), { rating: str(body.rating), comment: typeof body.comment === "string" ? body.comment : null });
    return answer({ ok: kept }, kept ? 200 : 400, origin);
  }

  if (op === "file") {
    if (!siteAllowance([{ key: k(`file:${ip}`), max: 200 }], TEN_MINUTES)) return answer({ ok: false }, 429, origin);
    const file = await visitorFile(channel.id, str(body.token), str(body.id));
    if (!file) return answer({ ok: false }, 404, origin);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        ...cors(origin),
        "content-type": file.mime,
        "content-disposition": contentDisposition("attachment", file.name ?? "file"),
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
      },
    });
  }

  if (op === "poll") {
    // Every 2.5 seconds while a chat is open, so typing shows as it happens.
    if (!siteAllowance([{ key: k(`poll:${ip}`), max: 900 }], TEN_MINUTES)) return answer({ ok: false }, 429, origin);
    const token = str(body.token);
    const [messages, presence] = await Promise.all([webMessages(channel.id, token, str(body.after) || null), webPresence(channel.id, token), visitorSeen(channel.id, token, visitor())]);
    // As a chat app shows it: who on the team is typing, and whether the visitor's last message was seen.
    return answer(messages ? { ok: true, messages, typing: presence?.typing ?? null, seen: presence?.seen ?? false, rate: presence?.rate ?? false } : { ok: true, messages: [], forget: true }, 200, origin);
  }

  if (op === "send") {
    const text = str(body.text).trim();
    if (!text) return answer({ ok: false, error: "Write something first." }, 400, origin);
    if (text.length > INBOX_LIMITS.message) return answer({ ok: false, error: "That message is too long." }, 400, origin);
    const token = str(body.token) || null;
    // Security audit, 11 Nov 2026 (SEC-48): limited by address. The channel-wide cap now holds new conversations
    // only, so one outsider using it up can't silence visitors already chatting.
    /**
     * Security review, 15 Nov 2026 — RL-03: one caller could use up the channel's 300 new conversations and stop every
     * other visitor starting one. A caller whose address is known is held to its own caps first (by address or IPv6
     * /64), and past the channel-wide cap may still start a conversation, up to NEW_HELD_FACTOR times it. A caller
     * whose address isn't known no longer shares one "unknown" bucket for new conversations: it is limited by the
     * channel-wide cap alone and refused past it. Its messages in a conversation it already has are counted by that
     * conversation instead.
     */
    const busy = () => answer({ ok: false, error: "Too many messages just now. Please wait a few minutes." }, 429, origin);
    const own = caller
      ? [
          { key: k(`send:${ip}`), max: 40 },
          // A new conversation each time is what a script filling the inbox would do.
          ...(token ? [] : [{ key: k(`new:${ip}`), max: 6 }]),
        ]
      : token
        ? [{ key: k(`send-conversation:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`), max: 40 }]
        : [];
    if (!token) {
      const all = { key: k("new:all"), max: 300 };
      if (!caller) {
        if (!siteAllowance([all], TEN_MINUTES)) return busy();
      } else {
        if (!siteAllowance(own, TEN_MINUTES)) return busy();
        if (!siteAllowance([all], TEN_MINUTES) && !siteAllowance([{ key: `${all.key}:held`, max: all.max * NEW_HELD_FACTOR }], TEN_MINUTES)) return busy();
      }
    } else if (!siteAllowance(own, TEN_MINUTES)) return busy();
    // Where the channel asks first: the details its form asks for, before a new conversation starts.
    let details: { name: string | null; company: string | null; email: string | null; phone: string | null } | null = null;
    if (!token && settings.prechat.on) {
      const checked = checkPrechat({ name: body.name, company: body.company, email: body.email, phone: body.phone }, settings.prechat.fields);
      if (!checked.ok) return answer({ ok: false, error: checked.error, prechat: true }, 400, origin);
      details = checked.details;
    }
    const page = str(body.page);
    const made = await receiveWebMessage(channel, {
      token,
      text,
      ...(details ?? {}),
      opener: token ? null : str(body.opener) || null,
      pageUrl: /^https?:\/\//.test(page) ? page.slice(0, 500) : null,
      visitor: visitor(),
    });
    // A chat from a visitor being remembered: the conversation says who they are from now on.
    if (settings.activity.on && body.vid) await linkVisitorToConversation(body.vid, made.token).catch((err) => console.error("[activity] link failed", err instanceof Error ? err.message : ""));
    return answer({ ok: true, token: made.token, messages: (await webMessages(channel.id, made.token, null)) ?? [] }, 200, origin);
  }

  return answer({ ok: false, error: "Unknown request." }, 400, origin);
}
