import { HOST_MISMATCH, protocolFor, requestHost } from "@/lib/tenancy/host";
import { legacyTenant, subdomainHost, tenantForHost } from "@/lib/tenancy/registry";
import { tenancyState, type Tenant } from "@/lib/tenancy/state";
import { rememberHostCountry } from "@/lib/tenancy/workspace-country";

/**
 * Which workspace the work in hand is for — the one question every database call asks first.
 *
 * In order:
 *
 *   1. What was set with `runAsTenant` — by proxy.ts for its own checks, by cron fan-out, by
 *      workers, by tests. Explicit beats inferred.
 *   2. The host of the request being served (pages, server actions, route handlers). Next keeps
 *      the request in its own async context, so this works from any depth of the call stack.
 *   3. Only for scripts and check suites, and only when switched on: the first workspace, as if
 *      nothing had changed (DESKZO_TENANCY_FALLBACK=legacy, and not inside the Next server —
 *      src/instrumentation.ts marks that). Inside `next dev` or `next start` there is no fallback:
 *      a request whose workspace can't be told apart fails, rather than being answered as the
 *      first customer.
 */

export class TenantNotFound extends Error {
  constructor(readonly host: string) {
    super(`No workspace answers at ${host}.`);
  }
}
export class TenantHostMismatch extends Error {
  constructor() {
    super("The request named two different workspaces.");
  }
}
export class TenantNotResolved extends Error {
  constructor() {
    super("No workspace for this work — outside a request, wrap it in runAsTenant().");
  }
}

export function runAsTenant<T>(tenant: Tenant, fn: () => T): T {
  return tenancyState().als.run(tenant, fn);
}

/** What runAsTenant set, if anything — without looking at the request. */
export function explicitTenant(): Tenant | undefined {
  return tenancyState().als.getStore();
}

/**
 * The one error from headers() that means "there is no request here" — a script, a check suite, a
 * timer in the server. Next marks it E251. Anything else headers() throws is either one of Next's
 * own signals (dynamic rendering, a prerender being interrupted) or headers() used where it must
 * not be (inside after(), "use cache", generateStaticParams), and both go up untouched: a workspace
 * is never guessed. If Next ever renames it, this fails loudly, not open.
 */
function isOutsideRequest(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (err as { __NEXT_ERROR_CODE?: string }).__NEXT_ERROR_CODE === "E251" || err.message.includes("was called outside a request scope");
}

function insideNextServer(): boolean {
  return (globalThis as { __deskzoInNext?: boolean }).__deskzoInNext === true;
}

async function requestHeaders(): Promise<Headers | null> {
  // next/headers is CommonJS: imported this way its functions may arrive as named exports or only on
  // `default` (a check suite's stand-in for it does the latter), so both are looked at.
  const mod = (await import("next/headers")) as { headers?: () => Promise<Headers>; default?: { headers?: () => Promise<Headers> } };
  const read = mod.headers ?? mod.default?.headers;
  if (typeof read !== "function") return null;
  try {
    return await read();
  } catch (err) {
    if (isOutsideRequest(err)) return null;
    throw err;
  }
}

export async function currentTenant(): Promise<Tenant> {
  const explicit = explicitTenant();
  if (explicit) return explicit;

  const headers = await requestHeaders();
  if (headers) {
    const host = requestHost(headers);
    if (host === HOST_MISMATCH) throw new TenantHostMismatch();
    if (host) {
      const tenant = await tenantForHost(host);
      if (!tenant) throw new TenantNotFound(host);
      rememberHostCountry(host, tenant.country, tenant.defaultTaxRate ?? null);
      return tenant;
    }
  }

  if (process.env.DESKZO_TENANCY_FALLBACK === "legacy" && !insideNextServer()) {
    const legacy = await legacyTenant();
    if (legacy) return legacy;
  }
  throw new TenantNotResolved();
}

/** The workspace, or null where there is none (the public site, the console, an unknown host). */
export async function currentTenantOrNull(): Promise<Tenant | null> {
  try {
    return await currentTenant();
  } catch (err) {
    if (err instanceof TenantNotFound || err instanceof TenantNotResolved) return null;
    throw err;
  }
}

/**
 * The origin to put in a link for this workspace — an email, a PDF, a redirect back from Microsoft.
 *
 * The host the request came in on, when there is one and it belongs to this workspace, so somebody
 * using an old address gets links to the same address; otherwise the workspace's primary host.
 * Never a forwarded host that hasn't been through `requestHost`.
 */
export async function tenantOrigin(tenant?: Tenant): Promise<string> {
  const t = tenant ?? (await currentTenant());
  const headers = explicitTenant() ? null : await requestHeaders();
  const host = headers ? requestHost(headers) : null;
  const useHost = typeof host === "string" && (await tenantForHost(host))?.id === t.id ? host : t.primaryHost;
  return `${protocolFor(useHost)}://${useHost}`;
}

/**
 * The origin for a link that carries a credential — a password reset, a setup or invitation link.
 * Always the workspace's own platform subdomain, never a custom domain and never the request's host
 * (security audit, Nov 2026).
 *
 * `tenantOrigin` follows the request host and the primary domain, and a custom domain's DNS is in
 * somebody else's hands: staff can add, verify and make primary a domain for any workspace from the
 * console, and a workspace's domain can lapse or be re-pointed. A reset token sent to such a host
 * can be read there and redeemed on the real workspace — the token is not bound to a host. The
 * platform subdomain is ours, so a token only ever travels to a host the platform serves.
 */
export async function credentialLinkOrigin(tenant?: Tenant): Promise<string> {
  const t = tenant ?? (await currentTenant());
  const host = subdomainHost(t.slug);
  return `${protocolFor(host)}://${host}`;
}
