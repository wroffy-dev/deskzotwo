import { lushaSettings } from "@/actions/lusha";
import { enrichCredits } from "@/actions/enrich-credits";
import { EnrichCredits } from "@/components/settings/enrich-credits";
import { SettingsPage } from "@/components/settings/settings-page";
import { LushaSettings } from "@/components/settings/lusha-settings";

export const metadata = { title: "Lusha" };

/** Settings › Lusha (owner, 14 Nov 2026 — src/lib/lusha): the workspace's own Lusha API key. `settings.manage` opens it. */
export default async function Page() {
  return (
    <SettingsPage
      settingsKey="lusha"
      description="Your Lusha account. Its API key lets people with the “Enrich from Apollo or Lusha” permission fill a company's details, find a contact's email and phone, and find people at a company. Every lookup spends your Lusha credits."
    >
      <Overview />
    </SettingsPage>
  );
}

async function Overview() {
  const [view, credits] = await Promise.all([lushaSettings(), enrichCredits("LUSHA")]);
  if (!view.ok) return <p className="text-sm text-danger">{view.error}</p>;
  return (
    <div className="space-y-4">
      <LushaSettings setup={view.data} />
      {credits.ok && <EnrichCredits provider="LUSHA" view={credits.data} />}
    </div>
  );
}
