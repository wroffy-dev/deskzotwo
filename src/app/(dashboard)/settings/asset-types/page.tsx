import { notFound } from "next/navigation";
import { assetTypeSettings } from "@/actions/asset-types";
import { SettingsPage } from "@/components/settings/settings-page";
import { planGate } from "@/components/settings/module-disabled-notice";
import { AssetTypesManager } from "@/components/assets/asset-types-manager";

/**
 * Settings › Asset types (owner, 18 Nov 2026: "make it a list each workspace manages" — src/lib/assets/types.ts): the kinds
 * of asset the register offers, for whoever manages it (`assets.manage`).
 */
export default async function AssetTypesSettingsPage() {
  const gate = await planGate("it_assets", "IT Assets");
  if (gate) return gate;
  const types = await assetTypeSettings();
  if (!types) notFound();
  return (
    <SettingsPage
      settingsKey="asset-types"
      description="What kinds of asset the register offers when one is added, in this order. Deskzo's own may be renamed or hidden; add your own — each physical, or not (a licence or subscription, which has no site and doesn't move). A hidden type stays on the assets that have it."
    >
      <AssetTypesManager types={types} />
    </SettingsPage>
  );
}
