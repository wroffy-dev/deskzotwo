import { notFound } from "next/navigation";
import { listMyPhones } from "@/actions/app-devices";
import { SettingsPage } from "@/components/settings/settings-page";
import { PhonePairing } from "@/components/settings/phone-pairing";
import { RecordingSettings } from "@/components/settings/recording-settings";
import { getRecordingSetup } from "@/actions/call-recordings";
import { isModuleEnabled } from "@/actions/module";
import { androidAppUrl, deskzoAppReady } from "@/lib/app/ready";

/**
 * Settings › Deskzo app (owner, 18 Oct 2026) — pairing your own phone with the app, and the phones you have
 * paired. Everybody's own; not there at all until the app is out (src/lib/app/ready.ts).
 */
export default async function PhoneSettingsPage() {
  if (!deskzoAppReady()) notFound();
  // Call recordings, where the plan has Calls (src/lib/calls/recordings.ts).
  const [phones, recordings] = await Promise.all([listMyPhones(), (await isModuleEnabled("calls")) ? getRecordingSetup().catch(() => null) : null]);
  return (
    <SettingsPage settingsKey="phone" description="The Deskzo app on your phone: calls with customers log themselves on Calls, and a Call button here can ring your phone to dial.">
      <PhonePairing phones={phones} playUrl={androidAppUrl()} />
      {recordings && (
        <div className="mt-4">
          <RecordingSettings setup={recordings} />
        </div>
      )}
    </SettingsPage>
  );
}
