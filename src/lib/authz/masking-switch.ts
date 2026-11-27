import { db } from "@/lib/db";
import { tenantKey } from "@/lib/tenancy/cache";
import { shared } from "@/lib/cluster/hub";

/**
 * Field masking's master switch (owner, 30 Oct 2026; FieldMaskingSettings in the schema): whether the masking
 * rules apply at all. Read on every masked read path, so cached a few seconds per workspace like the security
 * settings are; switching it drops the cache everywhere.
 *
 * Anything but a stored "off" is on — no row, a workspace not migrated yet, a database that didn't answer. The
 * switch only ever widens what people see, so the failure it must never have is widening it by accident.
 */
export const FIELD_MASKING_SETTINGS_ID = "global";

async function fetchMaskingEnabled(): Promise<boolean> {
  try {
    const row = await db.fieldMaskingSettings.findUnique({ where: { id: FIELD_MASKING_SETTINGS_ID }, select: { enabled: true } });
    return row?.enabled ?? true;
  } catch {
    return true;
  }
}

const cache = new Map<string, { value: boolean; expiresAt: number }>();
const CACHE_TTL_MS = 10_000;

export async function fieldMaskingEnabled(): Promise<boolean> {
  const key = await tenantKey();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await fetchMaskingEnabled();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Everything, every workspace — dropping a cache only costs a re-read. */
export const invalidateFieldMaskingCache = shared("invalidateFieldMaskingCache", (): void => {
  cache.clear();
});
