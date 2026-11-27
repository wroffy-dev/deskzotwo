import { setWorkspaceCountryResolver, setWorkspaceTaxRateResolver } from "@/lib/country-pack";
import { HOST_MISMATCH, requestHost } from "@/lib/tenancy/host";
import { tenancyState } from "@/lib/tenancy/state";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";

/**
 * The server's answer to `workspaceCountry()` (src/lib/country-pack.ts), synchronously.
 *
 * `runAsTenant` work answers from its store. A request answers by its host, from what
 * `currentTenant()` last found there (`rememberHostCountry`) — every page and action resolves its
 * workspace before it reads a row, so by the time an amount is formatted the host is known. The
 * request's headers are read from Next's own request store, the one `headers()` itself reads, since
 * `headers()` is a promise.
 */
const HOSTS = Symbol.for("deskzo.workspace-country.hosts");

function hostCountries(): Map<string, string> {
  const g = globalThis as { [key: symbol]: Map<string, string> | undefined };
  return (g[HOSTS] ??= new Map());
}

const RATES = Symbol.for("deskzo.workspace-country.rates");

/** Each host's workspace default tax rate, where it chose one (Settings › Taxes) — kept beside its country. */
function hostRates(): Map<string, number | null> {
  const g = globalThis as { [key: symbol]: Map<string, number | null> | undefined };
  return (g[RATES] ??= new Map());
}

export function rememberHostCountry(host: string, country: string, defaultTaxRate: number | null = null): void {
  hostCountries().set(host, country);
  hostRates().set(host, defaultTaxRate);
}

function requestStoreHeaders(): Headers | null {
  const store = workUnitAsyncStorage.getStore() as { headers?: Headers } | undefined;
  return store?.headers && typeof store.headers.get === "function" ? store.headers : null;
}

/** This request's host, or null outside one. */
function hostNow(): string | null {
  const headers = requestStoreHeaders();
  if (!headers) return null;
  const host = requestHost(headers);
  return !host || host === HOST_MISMATCH ? null : host;
}

setWorkspaceTaxRateResolver(() => {
  const explicit = tenancyState().als.getStore();
  if (explicit) return explicit.defaultTaxRate ?? null;
  const host = hostNow();
  return host ? (hostRates().get(host) ?? null) : null;
});

setWorkspaceCountryResolver(() => {
  const explicit = tenancyState().als.getStore();
  if (explicit) return explicit.country;
  const headers = requestStoreHeaders();
  if (!headers) return null;
  const host = requestHost(headers);
  if (!host || host === HOST_MISMATCH) return null;
  return hostCountries().get(host) ?? null;
});
