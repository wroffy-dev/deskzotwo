import { currentUser, viewAsContext } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { readTextWithin } from "@/lib/http/body";
import { currentMaintenance, mayBypassMaintenance, maintenanceAppName } from "@/lib/maintenance";
import { CopilotRefusal, runCopilot } from "@/lib/copilot/agent";
import type { ChatEvent } from "@/lib/copilot/types";
import { requestHost } from "@/lib/tenancy/host";

/**
 * The copilot's chat, streamed: one JSON object per line (see `ChatEvent`), so the answer appears as
 * it is written. A route handler rather than a server action because an action returns one value,
 * not a stream.
 *
 * Being under /api, the proxy doesn't stand in front of this, so it makes the proxy's checks itself:
 * signed in (and through the access gate — `currentUser` applies it), not held by maintenance mode,
 * and posted by this app rather than a page on another site carrying the person's cookie.
 */
export const dynamic = "force-dynamic";

const json = (status: number, error: string) => Response.json({ error }, { status });

/**
 * The most a message may arrive as. Security audit, 13 Nov 2026 (A6): the body was parsed whole before anything
 * was checked, so anybody signed in — with the copilot or without — could make the one shared process buffer as
 * much as they sent. A message is at most 4,000 characters (src/lib/copilot/agent.ts); 16 KB holds that in any
 * script, with the conversation id and the JSON around it.
 */
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  // The real host of this request (see src/lib/tenancy/host.ts) — a forwarded one is only a claim.
  const checked = requestHost(request.headers);
  const host = typeof checked === "string" ? checked : null;
  let sameOrigin = false;
  try {
    sameOrigin = !!origin && !!host && new URL(origin).host === host;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return json(403, "Only this app can talk to the copilot.");

  const user = await currentUser();
  if (!user) return json(401, "Sign in first.");
  // A copilot conversation is private, and "view as" would open it as somebody else's — their
  // chats, their allowance, their name on anything drafted. Not while borrowing an account.
  if (await viewAsContext()) return json(403, "Switch back to your own account to use the copilot.");
  const maintenance = await currentMaintenance();
  if (maintenance.phase === "on" && !(await mayBypassMaintenance(user.id))) return json(503, "The app is down for maintenance.");
  // Security audit, 13 Nov 2026 (A6): the permission before the body is read, and then only up to the ceiling.
  if (!(await can(user.id, "copilot.use"))) return json(403, "You don't have access to the AI copilot.");

  let body: { conversationId?: unknown; message?: unknown; page?: unknown };
  try {
    const raw = await readTextWithin(request, MAX_BODY_BYTES);
    if (raw === null) return json(413, "That's too long for one message — keep it under 4,000 characters.");
    body = JSON.parse(raw);
    if (!body || typeof body !== "object") throw new Error("not an object");
  } catch {
    return json(400, "That wasn't a message.");
  }
  const message = typeof body.message === "string" ? body.message : "";
  const conversationId = typeof body.conversationId === "string" && body.conversationId ? body.conversationId : null;
  const appName = await maintenanceAppName();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The reader went away; the work carries on to its end so what was spent is recorded.
        }
      };
      try {
        await runCopilot({ userId: user.id, userName: user.name, role: user.role, conversationId, text: message, appName, emit, signal: request.signal, page: typeof body.page === "string" ? body.page : null });
      } catch (err) {
        emit({ type: "error", message: err instanceof CopilotRefusal ? err.message : "Something went wrong on the server." });
        if (!(err instanceof CopilotRefusal)) console.error("copilot chat failed", err);
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
