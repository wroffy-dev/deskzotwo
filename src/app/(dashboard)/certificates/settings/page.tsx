import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getBranding } from "@/actions/branding";
import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { VerifiableSearchSettings } from "@/components/documents/verifiable-search-settings";
import { VerifyDesignForm } from "@/components/verifiable/verify-design-form";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getOrganisation } from "@/lib/organisation";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { verifiableSearchSettings, verifiableSettingsRow } from "@/lib/verifiable/search";
import { readAccreditations, readTemplate } from "@/lib/verifiable/design";

export const metadata = { title: "Certificate pages" };

/** Certificates › Public pages (owner, 7 Nov 2026): the public search, and how the pages look. For whoever may change settings. */
export default async function CertificatePagesSettings() {
  if (!(await isModuleEnabled("companies"))) return <ModuleDisabledNotice moduleKey="companies" />;
  if (!(await viewerHas("settings.manage"))) notFound();
  const [search, row, origin, branding, org] = await Promise.all([verifiableSearchSettings(), verifiableSettingsRow(), tenantOrigin(), getBranding(), getOrganisation()]);
  const named = org.tradeName?.trim() || org.legalName.trim();
  return (
    <div className="animate-fade-rise">
      <Link href="/certificates" className="mb-2 inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden /> Certificates
      </Link>
      <h1 className="text-xl font-semibold text-text">Public pages</h1>
      <p className="mt-1 text-sm text-muted">What people see when they scan a certificate&apos;s QR code, or search for one.</p>
      <VerifiableSearchSettings searchOn={search.searchOn} nameSearch={search.nameSearch} pageUrl={`${origin}/verify`} canChange />
      <VerifyDesignForm
        issuer={named || branding.appName}
        nameSet={!!named}
        brandLogo={branding.logoDataUrl ?? null}
        brandColor={branding.primaryColor ?? null}
        start={{
          template: readTemplate(row?.template),
          heading: row?.heading ?? "",
          intro: row?.intro ?? "",
          accent: row?.accent ?? "",
          contactEmail: row?.contactEmail ?? "",
          contactPhone: row?.contactPhone ?? "",
          accreditations: readAccreditations(row?.accreditations),
        }}
      />
    </div>
  );
}
