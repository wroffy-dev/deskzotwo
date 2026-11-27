import { captureFieldGuide, listCaptureKeys } from "@/actions/lead-capture";
import { planGate } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { LeadCaptureManager } from "@/components/settings/lead-capture-manager";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { listAssignableUsers } from "@/actions/company";
import { enquiryHoldSetting } from "@/actions/website-enquiries";
import { EnquiryHoldSetting } from "@/components/leads/website-enquiries";

/**
 * API keys for websites, and the documentation their developers need — with this workspace's own
 * fields, so a developer can map a form to their keys.
 *
 * The address in the documentation is the one this page was opened on — behind a proxy, the
 * forwarded host — because that is the address a developer outside can reach.
 */
export default async function Page() {
  // Configures leads rather than showing them, so the plan decides — not the viewer's leads.view.
  const gate = await planGate("leads", "Lead capture API");
  if (gate) return gate;
  const [keys, origin, ownFields, people, hold] = await Promise.all([listCaptureKeys(), tenantOrigin(), captureFieldGuide(), listAssignableUsers(), enquiryHoldSetting()]);

  return (
    <SettingsPage
      title="Lead capture API"
      description="Let your websites send enquiries straight into the CRM as leads — scored, assigned by your rules, and marked with the website they came from."
      settingsKey="lead-capture"
    >
      {hold && <EnquiryHoldSetting hold={hold.hold} waiting={hold.waiting} />}
      <LeadCaptureManager keys={keys} baseUrl={origin} ownFields={ownFields} people={people.map((p) => ({ id: p.id, name: p.name }))} />
    </SettingsPage>
  );
}
