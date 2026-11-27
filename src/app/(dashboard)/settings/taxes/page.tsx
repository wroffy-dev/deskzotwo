import { notFound } from "next/navigation";
import { getTaxDefaults } from "@/actions/tax-defaults";
import { TaxDefaultsCard } from "@/components/settings/tax-defaults-card";

/** Settings › Taxes (owner, 23 Nov 2026: "see how zoho books has"): the default rate new items and lines start with. */
export default async function TaxSettingsPage() {
  const setting = await getTaxDefaults();
  if (!setting) notFound();
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Taxes</h1>
        <p className="mt-1 text-sm text-muted">
          {setting.taxName === "GST"
            ? "Your GSTIN and state are on the organisation's Profile, and each branch's under Branches & GST registrations."
            : "Your tax registration is on the organisation's Profile."}
        </p>
      </div>
      <TaxDefaultsCard setting={setting} />
    </div>
  );
}
