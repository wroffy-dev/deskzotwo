import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { assetFormOptions, listAssets } from "@/actions/it-asset";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { Card } from "@/components/ui/card";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { ListFilter } from "lucide-react";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { AssetTable } from "@/components/assets/asset-table";
import { NewAssetDialog } from "@/components/assets/new-asset-dialog";
import { coverState, ownershipLabels, statusLabels } from "@/lib/assets/lifecycle";
import { assetTypes } from "@/lib/assets/types";
import type { AssetOwnership, AssetStatus } from "@prisma/client";

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; ownership?: string; status?: string; kind?: string; scope?: string }>;
}) {
  const enabled = await isModuleEnabled("it_assets");
  if (!enabled) return <ModuleDisabledNotice moduleKey="it_assets" />;

  const params = await searchParams;
  const user = await currentUser();
  const [assets, options, canManage, types] = await Promise.all([
    listAssets(params),
    assetFormOptions(),
    user ? hasEffectivePermission(user.id, "assets.manage") : Promise.resolve(false),
    assetTypes({ includeHidden: true }),
  ]);

  const live = assets.filter((a) => a.status !== "RETIRED");
  const ours = live.filter((a) => a.ownership !== "CLIENT_OWNED").length;
  const managed = live.filter((a) => a.ownership === "CLIENT_OWNED").length;
  // Expired counts as needing attention, not as settled — it's more urgent than "expiring", not less.
  const needsCover = live.filter((a) => {
    const c = coverState(a);
    return c.daysLeft !== null && c.daysLeft <= 30;
  }).length;

  return (
    <div className="animate-fade-rise">
      <ListHeader
        title="IT assets"
        search={<ToolbarSearch paramName="search" placeholder="Search" label="Tag, serial, make or model" />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="ownership"
              label="Whose"
              options={(Object.keys(ownershipLabels) as AssetOwnership[]).map((o) => ({ value: o, label: ownershipLabels[o] }))}
            />
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="status"
              label="Status"
              options={(Object.keys(statusLabels) as AssetStatus[]).map((s) => ({ value: s, label: statusLabels[s] }))}
            />
            <MoreFilters params={["type", "kind"]}>
              {/* The workspace's own types (owner, 18 Nov 2026 — Settings › Asset types), hidden ones too: assets keep them. */}
              <SelectParamFilter
                variant="stacked"
                paramName="type"
                label="Type"
                options={types.map((t) => ({ value: t.id, label: t.hidden ? `${t.name} (hidden)` : t.name }))}
              />
            </MoreFilters>
            <ClearFilters params={["search", "ownership", "status", "type", "kind"]} />
          </>
        }
        actions={canManage && <NewAssetDialog options={options} />}
      />
      <p className="mt-1 text-sm text-muted">
        Every machine and licence — ours, ours sitting at a client, and the estates we look after for clients.
        What a client owns never reaches our balance sheet, however much of it we manage.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="On the register" value={live.length} hint="not retired" />
        <Stat label="Ours" value={ours} hint="internal and deployed" />
        <Stat label="Managed for clients" value={managed} hint="their property, our responsibility" />
        <Stat
          label="Cover running out"
          value={needsCover}
          hint={needsCover > 0 ? "within 30 days, or already lapsed" : "everything is covered"}
        />
      </div>

      <div className="mt-4">
        <AssetTable
          assets={assets}
          emptyHint="Nothing on the register. Add the laptops, servers and licences the company owns — and the client estates you look after."
        />
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-text">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
