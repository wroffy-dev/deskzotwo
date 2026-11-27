"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { DEFAULT_BRANDING, PLATFORM_BRANDING, type Branding } from "@/lib/branding";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";
import { brandingSettingsSchema } from "@/lib/validation/branding";
import { recordAudit } from "@/lib/audit";
import type { ActionResult } from "@/actions/company";

/**
 * Branding is what every page and every sign-in screen wears, so a change to it is a workspace setting like any
 * other: logged (owner, 2 Nov 2026 — "Phase 1 security fixes", audit M-9), with who made it and, for an edit, what it
 * changed. An image itself never goes in the log — only that it was replaced or removed (as the letter signature).
 */
async function auditBranding(userId: string, entityLabel: string) {
  await recordAudit({ userId, action: "UPDATE", entityType: "BrandingSettings", entityId: "global", entityLabel });
}

/**
 * Read by the root layout on every request, so it must never throw — an unseeded database or a
 * missing row falls back to the defaults rather than taking the whole app down.
 *
 * Deskzo's own hosts — the public site, the console, the CMS, the partner portal — have no workspace, and
 * wear Deskzo's own branding (owner, 23 Oct 2026). They used to reach the defaults by the query failing.
 */
export async function getBranding(): Promise<Branding> {
  try {
    if (!(await currentTenantOrNull())) return PLATFORM_BRANDING;
    const row = await db.brandingSettings.findUnique({ where: { id: "global" } });
    if (!row) return DEFAULT_BRANDING;
    return {
      appName: row.appName,
      shortName: row.shortName,
      tagline: row.tagline,
      logoDataUrl: row.logoDataUrl,
      faviconDataUrl: row.faviconDataUrl,
      primaryColor: row.primaryColor,
      defaultTheme: row.defaultTheme,
    };
  } catch {
    return DEFAULT_BRANDING;
  }
}

export async function updateBranding(input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) {
    return { ok: false, error: "You can't change branding." };
  }
  const parsed = brandingSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  const before = await db.brandingSettings.findUnique({ where: { id: "global" }, select: { appName: true, shortName: true, tagline: true, primaryColor: true, defaultTheme: true } });

  await db.brandingSettings.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      appName: data.appName.trim(),
      shortName: data.shortName || null,
      tagline: data.tagline || null,
      primaryColor: data.primaryColor,
      defaultTheme: data.defaultTheme,
    },
    update: {
      appName: data.appName.trim(),
      shortName: data.shortName || null,
      tagline: data.tagline || null,
      primaryColor: data.primaryColor,
      defaultTheme: data.defaultTheme,
    },
  });
  const was = before ?? DEFAULT_BRANDING;
  const now = { appName: data.appName.trim(), shortName: data.shortName || null, tagline: data.tagline || null, primaryColor: data.primaryColor, defaultTheme: data.defaultTheme };
  const names = { appName: "name", shortName: "short name", tagline: "tagline", primaryColor: "colour", defaultTheme: "theme" } as const;
  const changed = (Object.keys(names) as (keyof typeof names)[]).filter((k) => (was[k] ?? null) !== now[k]).map((k) => `${names[k]} ${was[k] ?? "(none)"} → ${now[k] ?? "(none)"}`);
  await auditBranding(user.id, `Branding saved — ${changed.length ? changed.join("; ") : "nothing changed"}`.slice(0, 1000));

  // Branding is in the root layout, so every route's shell is stale until the whole tree revalidates.
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

const MAX_IMAGE_BYTES = 256 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/svg+xml", "image/webp", "image/x-icon"];

/**
 * Logos are stored as data URLs on the settings row, which keeps deployment simple (no writable
 * disk, no bucket) at the cost of a size ceiling — hence the 256KB cap and the type allow-list.
 */
export async function uploadBrandingImage(kind: "logo" | "favicon", dataUrl: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) {
    return { ok: false, error: "You can't change branding." };
  }

  const match = /^data:([a-z+/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) {
    return { ok: false, error: "That doesn't look like an image file." };
  }
  const [, mimeType, base64] = match;
  if (!ALLOWED_TYPES.includes(mimeType)) {
    return { ok: false, error: "Use a PNG, JPEG, SVG, WebP or ICO file." };
  }
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    return { ok: false, error: `That image is ${Math.round(bytes / 1024)}KB — keep it under ${MAX_IMAGE_BYTES / 1024}KB.` };
  }

  await db.brandingSettings.upsert({
    where: { id: "global" },
    create: { id: "global", ...(kind === "logo" ? { logoDataUrl: dataUrl } : { faviconDataUrl: dataUrl }) },
    update: kind === "logo" ? { logoDataUrl: dataUrl } : { faviconDataUrl: dataUrl },
  });
  await auditBranding(user.id, `Branding ${kind} replaced (${mimeType}, ${Math.round(bytes / 1024)}KB)`);

  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

export async function removeBrandingImage(kind: "logo" | "favicon"): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) {
    return { ok: false, error: "You can't change branding." };
  }
  await db.brandingSettings.upsert({
    where: { id: "global" },
    create: { id: "global" },
    update: kind === "logo" ? { logoDataUrl: null } : { faviconDataUrl: null },
  });
  await auditBranding(user.id, `Branding ${kind} removed`);
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}
