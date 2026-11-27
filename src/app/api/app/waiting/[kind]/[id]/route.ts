import { z } from "zod";
import { appRoute } from "@/lib/app/handler";
import { ApiError } from "@/lib/api/handler";
import { DECIDE_KINDS, decideWaiting, waitingEmail } from "@/lib/app/waiting";

/**
 * One waiting email on the phone (owner, 22 Nov 2026; src/lib/app/waiting.ts): GET reads it; POST
 * `{ action: "send" | "skip", when?: "now" | "working-hours", subject, body }` sends it as changed — or holds it for the
 * working morning — or sets it aside, by the web's own action with its rules on who may.
 */

export const dynamic = "force-dynamic";

const kindOf = (raw: string | undefined) => {
  const kind = DECIDE_KINDS.find((k) => k === raw);
  if (!kind) throw new ApiError(404, "not_found", "There is nothing of that kind to send.");
  return kind;
};

const body = z.object({
  action: z.enum(["send", "skip"]),
  when: z.enum(["now", "working-hours"]).default("working-hours"),
  subject: z.string().max(300).default(""),
  body: z.string().max(5000).default(""),
});

export const GET = appRoute({}, async ({ actor, params }) => ({ data: await waitingEmail(actor.userId, kindOf(params.kind), params.id ?? "") }));

export const POST = appRoute({}, async ({ params, body: read }) => {
  const kind = kindOf(params.kind);
  const input = body.parse(await read());
  return { data: await decideWaiting(kind, params.id ?? "", input) };
});
