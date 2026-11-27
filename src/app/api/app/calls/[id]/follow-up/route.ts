import { appRoute } from "@/lib/app/handler";
import { followUpFor, sendFollowUp } from "@/lib/app/follow-up";

/**
 * The follow-up after a call (owner, 11 Nov 2026 — src/lib/app/follow-up.ts): GET what can be sent and to whom, for
 * one of the person's own calls; POST `{ channel: "email" | "whatsapp", template_id, … }` sends it. By hand, always.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({ calls: true }, async ({ params }) => ({ data: await followUpFor(params.id ?? "") }));

export const POST = appRoute({ calls: true }, async ({ params, body }) => ({ data: await sendFollowUp(params.id ?? "", await body()) }));
