import { getOrganisation } from "@/lib/organisation";
import { listBranchesForSettings } from "@/actions/branch";
import { SettingsPage } from "@/components/settings/settings-page";
import { EInvoiceSettings } from "@/components/settings/organisation-manager";
import { countryFeatureAvailable } from "@/lib/modules-access";

export default async function Page() {
  // India's, like the e-way bill page beside it (owner, 30 Oct 2026); the menu leaves it out elsewhere.
  if (!(await countryFeatureAvailable("einvoice"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">e-Invoicing</h1>
        <p className="mt-2 text-sm text-muted">E-invoicing is India&apos;s, and this workspace is set up for another country.</p>
      </div>
    );
  }
  // The switch and minimum are the company's; the logins are each registration's (null without settings.manage).
  const [organisation, branches] = await Promise.all([getOrganisation(), listBranchesForSettings()]);

  return (
    <SettingsPage
      title="e-Invoicing"
      description="The IRP connection that stamps an issued invoice with its IRN and signed QR code. The same credentials are used for e-way bills, so they are entered once, here."
      settingsKey="einvoicing"
    >
      <EInvoiceSettings organisation={organisation} registrations={branches?.registrations ?? []} />
    </SettingsPage>
  );
}
