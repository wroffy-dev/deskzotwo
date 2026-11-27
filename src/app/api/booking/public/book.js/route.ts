import { BOOKING_SCRIPT } from "@/lib/booking/embed";

/**
 * A booking page's pop-up, as a script any website may include (src/lib/booking/embed.ts). The same for every
 * workspace and page — the tag's data-page says which — so it is cached a while and reads nothing. Outside the proxy
 * (src/proxy.ts), as the forms' pop-up is.
 */

export const dynamic = "force-static";

export function GET() {
  return new Response(BOOKING_SCRIPT, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    },
  });
}
