import { UNRESTRICTED, parseEntitlements } from "@/lib/entitlements";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { openForTenant } from "@/lib/platform/kek";
import { browseHostOf } from "@/lib/tenancy/browse-host";
import { PLATFORM_DOMAIN, classifyHost, legacyHosts, normaliseHost, type HostKind } from "@/lib/tenancy/host";
import { tenancyState, type Tenant } from "@/lib/tenancy/state";

/**
 * The list of workspaces, and which host reaches which.
 *
 * ## From the control plane
 *
 * With CONTROL_DATABASE_URL set, workspaces are the control plane's `Tenant` rows: `<slug>.<domain>`
 * by slug, anything else by `TenantDomain`. Lookups are kept thirty seconds when found and five
 * when not, so a new workspace or address answers within seconds and a mistyped one costs one
 * query every five.
 *
 * ## From the environment
 *
 *   DATABASE_URL           the first workspace, until it is adopted into the control plane
 *   TENANCY_DEFAULT_SLUG   its name in the address (default "deskzo")
 *   TENANCY_DEFAULT_NAME   its display name
 *   TENANCY_LEGACY_HOSTS   addresses from before workspaces, still reaching it ("localhost:3000")
 *   TENANT_DB_<SLUG>       further workspaces — check suites only ("TENANT_DB_ACME=postgres://…")
 *   PLATFORM_PORT          the port to put in links in development ("3000")
 *
 * The first workspace comes from the environment only while the control plane has no default
 * workspace — before `npm run platform:adopt`, or with no control plane at all. Once adopted, the
 * control plane's row is the only one, with the same addresses.
 */

const FOUND_MS = 30_000;
const MISSING_MS = 5_000;

const portSuffix = () => (process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : "");
export const subdomainHost = (slug: string) => `${slug}.${PLATFORM_DOMAIN}${portSuffix()}`;

export function defaultSlug(): string {
  return (process.env.TENANCY_DEFAULT_SLUG ?? "deskzo").trim().toLowerCase();
}

// ─── The environment ─────────────────────────────────────────────────────────────────────────────

function environmentDefault(): Tenant | null {
  const main = process.env.DATABASE_URL;
  if (!main) return null;
  const slug = defaultSlug();
  const legacy = legacyHosts();
  return {
    id: slug,
    slug,
    name: process.env.TENANCY_DEFAULT_NAME?.trim() || slug,
    status: "ACTIVE",
    dbUrl: main,
    // Links keep going to the address people already use, until it is retired on purpose.
    primaryHost: legacy[0] ?? subdomainHost(slug),
    hosts: [subdomainHost(slug), ...legacy],
    source: "env",
    isDefault: true,
    keyBundleCipher: null,
    country: "IN",
    timezone: "Asia/Kolkata",
    // The installation as it was before plans: nothing it had is taken away.
    entitlements: UNRESTRICTED,
    holdReason: null,
  };
}

function environmentExtras(): Tenant[] {
  const tenants: Tenant[] = [];
  for (const [key, url] of Object.entries(process.env)) {
    const m = key.match(/^TENANT_DB_([A-Z0-9_]+)$/);
    if (!m || !url) continue;
    const slug = m[1].toLowerCase().replace(/_/g, "-");
    tenants.push({ id: slug, slug, name: slug, status: "ACTIVE", dbUrl: url, primaryHost: subdomainHost(slug), hosts: [subdomainHost(slug)], source: "env", isDefault: false, keyBundleCipher: null, country: "IN", timezone: "Asia/Kolkata", entitlements: UNRESTRICTED, holdReason: null });
  }
  return tenants;
}

// ─── The control plane ───────────────────────────────────────────────────────────────────────────

type ControlRow = {
  id: string;
  slug: string;
  name: string;
  status: Tenant["status"];
  isDefault: boolean;
  dbUrlCipher: string | null;
  keyBundleCipher: string;
  country: string;
  timezone: string;
  defaultTaxRate: { toString(): string } | null;
  entitlements: unknown;
  suspendedFor: "STAFF" | "BILLING" | null;
  domains: { host: string; isPrimary: boolean; failingSince: Date | null }[];
};

const SELECT = {
  id: true,
  slug: true,
  name: true,
  status: true,
  isDefault: true,
  dbUrlCipher: true,
  keyBundleCipher: true,
  country: true,
  timezone: true,
  defaultTaxRate: true,
  entitlements: true,
  suspendedFor: true,
  // Only addresses that are served: a PENDING one has not been proved, a BROKEN one stopped checking out.
  domains: { where: { status: "ACTIVE" as const }, select: { host: true, isPrimary: true, failingSince: true }, orderBy: { createdAt: "asc" as const } },
};

function fromControl(row: ControlRow): Tenant {
  const own = subdomainHost(row.slug);
  const primary = row.domains.find((d) => d.isPrimary)?.host ?? own;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    // None while it is being set up or after it is closed; the proxy serves only an active one.
    dbUrl: row.dbUrlCipher ? openForTenant(row.id, "db-url", row.dbUrlCipher) : "",
    primaryHost: primary,
    browseHost: browseHostOf(row.domains),
    hosts: [own, ...row.domains.map((d) => d.host)],
    source: "control",
    isDefault: row.isDefault,
    keyBundleCipher: row.keyBundleCipher,
    country: row.country,
    timezone: row.timezone,
    defaultTaxRate: row.defaultTaxRate == null ? null : Number(row.defaultTaxRate.toString()),
    // Malformed or never worked out: the core only.
    entitlements: parseEntitlements(row.entitlements),
    holdReason: row.status === "SUSPENDED" ? (row.suspendedFor ?? "STAFF") : null,
  };
}

/**
 * Security audit round two, 13 Nov 2026 (R2-07): the remembered lookups used to be kept for ever,
 * misses included, so a stream of made-up Host names grew the map without limit. Now it holds at most
 * REGISTRY_MAX entries: when full, lapsed entries (misses after MISSING_MS, finds after FOUND_MS) are
 * swept first, and if it is still full the oldest go. A lapsed entry is also dropped when it is read.
 */
export const REGISTRY_MAX = 5_000;

function lapsed(entry: { tenant: Tenant | null; at: number }, now: number): boolean {
  return now - entry.at >= (entry.tenant ? FOUND_MS : MISSING_MS);
}

function makeRoom(registry: Map<string, { tenant: Tenant | null; at: number }>, now: number): void {
  if (registry.size < REGISTRY_MAX) return;
  for (const [key, entry] of registry) if (lapsed(entry, now)) registry.delete(key);
  // Map keeps insertion order, and every set re-inserts, so the first keys are the oldest.
  while (registry.size >= REGISTRY_MAX) {
    const oldest = registry.keys().next();
    if (oldest.done) break;
    registry.delete(oldest.value);
  }
}

/** A registry lookup, kept briefly — found or not. */
async function remembered(key: string, load: () => Promise<Tenant | null>): Promise<Tenant | null> {
  const { registry } = tenancyState();
  const hit = registry.get(key);
  const now = Date.now();
  if (hit && !lapsed(hit, now)) return hit.tenant;
  if (hit) registry.delete(key);
  const tenant = await load();
  makeRoom(registry, Date.now());
  registry.set(key, { tenant, at: now });
  return tenant;
}

/** The same, for the check suite (R2-07): a lookup with a loader of its own. */
export const rememberedLookup = remembered;

/** How many lookups are remembered now — for the check suite (R2-07). */
export function registrySize(): number {
  return tenancyState().registry.size;
}

/** Drops every remembered lookup — after a workspace or an address is added, changed or removed. */
export function forgetRegistry(): void {
  tenancyState().registry.clear();
  tenancyState().keys.clear();
}

async function controlBy(key: string, where: { slug: string } | { id: string } | { isDefault: true }): Promise<Tenant | null> {
  return remembered(key, async () => {
    const row = await controlDb().tenant.findFirst({ where, select: SELECT });
    return row ? fromControl(row) : null;
  });
}

async function controlByDomain(host: string): Promise<Tenant | null> {
  return remembered(`domain:${host}`, async () => {
    const domain = await controlDb().tenantDomain.findFirst({ where: { host, status: "ACTIVE" }, select: { tenant: { select: SELECT } } });
    return domain ? fromControl(domain.tenant) : null;
  });
}

/** Whether the first workspace has been adopted into the control plane. */
async function adopted(): Promise<boolean> {
  if (!controlConfigured()) return false;
  return !!(await controlBy("default", { isDefault: true }));
}

/** The environment's first workspace, while it has not been adopted. */
async function environmentDefaultIfUnadopted(): Promise<Tenant | null> {
  return (await adopted()) ? null : environmentDefault();
}

// ─── Lookups ─────────────────────────────────────────────────────────────────────────────────────

export async function tenantBySlug(slug: string): Promise<Tenant | null> {
  const extra = environmentExtras().find((t) => t.slug === slug);
  if (extra) return extra;
  if (controlConfigured()) {
    const found = await controlBy(`slug:${slug}`, { slug });
    if (found) return found;
  }
  const env = await environmentDefaultIfUnadopted();
  return env?.slug === slug ? env : null;
}

export async function tenantById(id: string): Promise<Tenant | null> {
  const extra = environmentExtras().find((t) => t.id === id);
  if (extra) return extra;
  if (controlConfigured()) {
    const found = await controlBy(`id:${id}`, { id });
    if (found) return found;
  }
  const env = await environmentDefaultIfUnadopted();
  return env?.id === id ? env : null;
}

/** The workspace a host reaches, or null — the console and the public site are not workspaces. */
export async function tenantForHost(host: string): Promise<Tenant | null> {
  return tenantForKind(classifyHost(host));
}

export async function tenantForKind(kind: HostKind): Promise<Tenant | null> {
  if (kind.kind === "tenant") return tenantBySlug(kind.slug);
  if (kind.kind !== "other") return null;
  const host = normaliseHost(kind.host);
  if (!host) return null;
  const extra = environmentExtras().find((t) => t.hosts.includes(host));
  if (extra) return extra;
  if (controlConfigured()) {
    const found = await controlByDomain(host);
    if (found) return found;
  }
  const env = await environmentDefaultIfUnadopted();
  return env?.hosts.includes(host) ? env : null;
}

/** The workspace scripts and check suites act as when nothing else says (see resolve.ts). */
export async function legacyTenant(): Promise<Tenant | null> {
  if (controlConfigured()) {
    const found = await controlBy("default", { isDefault: true });
    if (found) return found;
  }
  return environmentDefault();
}

/** Every workspace that can be served now — for cron fan-out and the migration runner. */
export async function activeTenants(): Promise<Tenant[]> {
  const tenants = [...environmentExtras()];
  if (controlConfigured()) {
    const rows = await controlDb().tenant.findMany({ where: { status: "ACTIVE" }, select: SELECT, orderBy: { createdAt: "asc" } });
    tenants.push(...rows.map(fromControl));
  }
  const env = await environmentDefaultIfUnadopted();
  if (env) tenants.push(env);
  return tenants;
}

/**
 * Every workspace a full Backup & Restore bundle carries (src/lib/bundle/build.ts): each control-plane workspace that
 * isn't closed — suspended ones and ones still being set up too, unlike `activeTenants` — and the environment's first
 * workspace while it isn't adopted. Never the TENANT_DB_* extras: those are check suites' stand-ins, not data.
 */
export async function tenantsForBackup(): Promise<Tenant[]> {
  const tenants: Tenant[] = [];
  if (controlConfigured()) {
    const rows = await controlDb().tenant.findMany({ where: { status: { not: "DEPROVISIONED" } }, select: SELECT, orderBy: { createdAt: "asc" } });
    tenants.push(...rows.map(fromControl));
  }
  const env = await environmentDefaultIfUnadopted();
  if (env) tenants.push(env);
  return tenants;
}
