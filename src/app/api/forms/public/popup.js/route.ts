import { POPUP_SCRIPT } from "@/lib/forms/website-rules";

/**
 * A form's pop-up, as a script any website may include (src/lib/forms/website-rules.ts). The same for every workspace and
 * form — the tag's data-form says which — so it is cached a while and reads nothing. Outside the proxy (src/proxy.ts).
 */

export const dynamic = "force-static";

export function GET() {
  return new Response(POPUP_SCRIPT, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    },
  });
}
