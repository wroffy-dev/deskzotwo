import { appRoute } from "@/lib/app/handler";
import { lookupNumber } from "@/lib/app/calls";

/**
 * Caller ID for the Deskzo app (owner, 18 Oct 2026): who a number is as this person may see them, with the company's
 * open leads, the last call and a callback owed; `{ data: null }` for nobody they can see.
 *
 * Security audit round two, 13 Nov 2026 (R2-11, and the Low "the lookup puts it in a URL"): POST `{ number }` is the
 * way the app asks now, so the number stays out of URLs and access logs. GET `?number=` stays for app builds made
 * before it.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({ calls: true }, async ({ url, device }) => ({ data: await lookupNumber((url.searchParams.get("number") ?? "").slice(0, 40), device.id) }));

export const POST = appRoute({ calls: true }, async ({ body, device }) => {
  const sent = (await body()).number;
  return { data: await lookupNumber((typeof sent === "string" ? sent : "").slice(0, 40), device.id) };
});
