"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { cleanDomain, utmSlug, type UtmSettings } from "@/lib/marketing/utm";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Mail & messaging › Link tracking (owner, 1 Nov 2026): whether Deskzo's emails carry UTM tags, the word
 * they give as the source, and whether only the workspace's own websites are tagged (src/lib/marketing/utm.ts). For
 * whoever may change settings, as the rest of that page is.
 */
export async function updateUtmSettings(input: { on: boolean; source: string; ownSitesOnly: boolean; domains: string }): Promise<ActionResult<UtmSettings>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return { ok: false, error: "You don't have permission to change settings." };

  const source = utmSlug(String(input?.source ?? "")) || "deskzo";
  const typed = String(input?.domains ?? "")
    .split(/[,;\n]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  const bad = typed.filter((d) => !cleanDomain(d));
  if (bad.length) return { ok: false, error: `${bad.slice(0, 3).join(", ")} ${bad.length === 1 ? "isn't a website" : "aren't websites"} — write each like wroffy.com.` };
  const domains = [...new Set(typed.map((d) => cleanDomain(d)!))].slice(0, 20);
  const ownSitesOnly = !!input?.ownSitesOnly;
  if (ownSitesOnly && domains.length === 0) return { ok: false, error: "Name your websites to tag only those — or tag every link." };
  const settings: UtmSettings = { on: !!input?.on, source, ownSitesOnly, domains };

  try {
    await db.organisationSettings.upsert({
      where: { id: "global" },
      create: { id: "global", legalName: "", marketingUtm: settings as unknown as Prisma.InputJsonValue },
      update: { marketingUtm: settings as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace is being updated — try again in a few minutes." };
    throw err;
  }
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "global",
    entityLabel: settings.on ? `Email links tagged: utm_source=${source}, ${ownSitesOnly ? `only ${domains.join(", ")}` : "every site"}` : "Email links no longer tagged",
  });
  revalidatePath("/settings/messaging");
  return { ok: true, data: settings };
}
