import { cameFromPrivateNetwork } from "@/lib/client-ip";
import { normaliseHost } from "@/lib/tenancy/host";

/**
 * Where the internal API answers, checked by the proxy before anything else reads a database.
 *
 *   · Only when DESKZO_INTERNAL_API=on, on this CRM server.
 *   · Only on DESKZO_INTERNAL_API_HOST: the private name or address the admin app calls this server by
 *     (e.g. "10.0.1.4:3000" or "crm-internal:3000"). Never on a workspace's address, the public site
 *     or a custom domain, so no browser that reaches the CRM can reach it.
 *   · Only from the private network: no forwarded address from the internet, no CDN header.
 *
 * And the signature on every call (src/lib/internal-api/signing.ts), which the route checks.
 * Anywhere else, /api/internal answers a plain 404, the same as a path that does not exist.
 */
export const INTERNAL_API_PATH = /^\/api\/internal(\/|$)/;

export function internalApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DESKZO_INTERNAL_API?.trim().toLowerCase() === "on";
}

export function internalApiHost(env: NodeJS.ProcessEnv = process.env): string | null {
  return normaliseHost(env.DESKZO_INTERNAL_API_HOST);
}

export function internalApiReachable(host: string | null, headers: Pick<Headers, "get">, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!internalApiEnabled(env)) return false;
  const expected = internalApiHost(env);
  if (!expected || !host || host !== expected) return false;
  return cameFromPrivateNetwork(headers);
}
