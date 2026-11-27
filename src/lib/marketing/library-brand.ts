import { getBranding } from "@/actions/branding";
import { getOrganisation } from "@/lib/organisation";
import { safeColor, type LibraryBrand } from "@/lib/marketing/template-library";

/** This workspace's look, for the template library's templates and their previews (src/lib/marketing/template-library.ts). */
export async function libraryBrand(): Promise<LibraryBrand> {
  const [branding, org] = await Promise.all([getBranding(), getOrganisation()]);
  return {
    name: org.tradeName || org.legalName || branding.appName,
    color: safeColor(branding.primaryColor),
    logo: branding.logoDataUrl ?? null,
    email: org.email,
    phone: org.phone,
  };
}
