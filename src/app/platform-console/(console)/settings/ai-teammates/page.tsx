import type { Metadata } from "next";
import Link from "next/link";
import { Banner } from "@/components/console/kit/banner";
import { PageHeader } from "@/components/console/kit/page-header";
import { StatusPill } from "@/components/console/kit/status";
import { ConsoleAiTeammates, type ConsoleTeammatesData, type LookCell } from "@/components/console/settings/ai-teammates";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import { countryPack } from "@/lib/country-pack";
import { workspaceCountries } from "@/lib/platform/console-page-reads";
import { notMigratedYet } from "@/lib/not-migrated";
import { consoleStaff } from "@/lib/platform/console-page";
import { DEFAULT_TEAMMATE_PHOTOS } from "@/lib/ai/teammate-default-photos";
import { EVERY_COUNTRY, allLookRows } from "@/lib/ai/teammate-looks";
import type { TeammateKey } from "@/lib/ai/teammates";

export const metadata: Metadata = { title: "AI teammates" };

/**
 * Settings › AI teammates (owner, 23 Nov 2026 — src/lib/ai/teammate-looks.ts): the AI teammates' names and photos, for
 * every country or one — workspaces no longer set their own. Settings' own gate to read; owners and admins change them
 * (the actions check again).
 */
export default async function ConsoleAiTeammatesPage() {
  const staff = await consoleStaff(PAGE_ROLES.settings);
  const canEdit = capsFor(staff.role).manage;
  const loaded = await Promise.all([allLookRows(), workspaceCountries()]).catch((err) => {
    if (notMigratedYet(err) || (err instanceof Error && /platform_teammate_looks/.test(err.message))) return null;
    throw err;
  });

  let data: ConsoleTeammatesData | null = null;
  if (loaded) {
    const [rows, tenants] = loaded;
    const codes = [...new Set(["IN", "AE", ...tenants.map((t) => t.country), ...rows.map((r) => r.country)].filter((c) => c && c !== EVERY_COUNTRY).map((c) => c.toUpperCase()))];
    const byCountry: ConsoleTeammatesData["rows"] = {};
    for (const r of rows) (byCountry[r.country] ??= {})[r.key] = { name: r.name, photo: r.photo } satisfies LookCell;
    data = {
      countries: [{ code: EVERY_COUNTRY, label: "Every country" }, ...codes.map((code) => ({ code, label: countryPack(code).countryName })).sort((a, b) => a.label.localeCompare(b.label))],
      rows: byCountry,
      defaultPhotos: DEFAULT_TEAMMATE_PHOTOS as Partial<Record<TeammateKey, string>>,
      canEdit,
    };
  }

  return (
    <>
      <PageHeader
        title="AI teammates"
        chips={canEdit ? undefined : <StatusPill tone="neutral">View only</StatusPill>}
        subtitle="The AI teammates' names and photos, for every country or one. Workspaces see their country's; they can't change them."
        actions={
          <Link href="/settings/ai" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
            Deskzo AI settings
          </Link>
        }
      />
      {data ? (
        <ConsoleAiTeammates data={data} />
      ) : (
        <Banner tone="warning" title="Not ready yet">
          {"This release's control-plane migration hasn't run here. Run npm run control:migrate, then reload."}
        </Banner>
      )}
    </>
  );
}
