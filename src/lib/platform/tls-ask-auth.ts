import { timingSafeEqual } from "node:crypto";
import { cameFromPrivateNetwork } from "@/lib/client-ip";

/**
 * Who may ask /api/platform/tls-ask whether a name is ours.
 *
 * Security audit round two, 13 Nov 2026 (R2-07, low): it answered on every host, so anyone could ask it,
 * through Traefik, which workspace names and custom domains exist. It is for the HTTPS proxy alone —
 * Caddy's `on_demand_tls ask` (deploy/azure/Caddyfile), which calls `http://app:3000/...` from inside the
 * server's own network. Now it answers only:
 *
 *   · with the shared secret, when TLS_ASK_SECRET is set — `?key=<secret>` on the ask address (Caddy keeps
 *     the address's own query and adds `domain=`) or `Authorization: Bearer <secret>`, compared in
 *     constant time like the scheduled ticks' (src/lib/platform/tick-auth.ts); or
 *   · from inside: a Host that is no public name (one label such as `app:3000`, or a loopback address), and
 *     forwarded-address headers holding only private addresses (src/lib/client-ip.ts
 *     `cameFromPrivateNetwork`). A request from the internet, through Traefik or Cloudflare, carries a
 *     public address and is refused.
 *
 * Pure, for check:audit-round2-platform.
 */
export function tlsAskAllowed(input: { headers: Pick<Headers, "get">; host?: string | null; key: string | null }, secret = process.env.TLS_ASK_SECRET?.trim() ?? ""): boolean {
  if (secret) {
    const header = input.headers.get("authorization") ?? "";
    const provided = (header.startsWith("Bearer ") ? header.slice(7).trim() : "") || (input.key ?? "").trim();
    if (provided) {
      const a = Buffer.from(provided);
      const b = Buffer.from(secret);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
  }
  const host = (input.headers.get("host") ?? input.host ?? "").trim().toLowerCase();
  return internalHost(host) && cameFromPrivateNetwork(input.headers);
}

/** A name only the server's own network uses: one label (`app`, `app:3000`) or a loopback address. */
function internalHost(host: string): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "");
  if (name === "localhost" || name === "127.0.0.1" || name === "[::1]") return true;
  return /^[a-z0-9-]+$/.test(name);
}
