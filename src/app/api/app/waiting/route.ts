import { appRoute } from "@/lib/app/handler";
import { waitingForPhone } from "@/lib/app/waiting";

/**
 * What the AI teammates left for the person — "Waiting for you" on the phone (owner, 22 Nov 2026; src/lib/app/waiting.ts).
 * The emails among it carry `decide`, to check and send in place.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor }) => ({ data: await waitingForPhone(actor.userId) }));
