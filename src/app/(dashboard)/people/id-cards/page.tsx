import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { getBranding } from "@/actions/branding";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { getOrganisation } from "@/lib/organisation";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ListHeader } from "@/components/ui/list-header";
import { IdCardsManager } from "@/components/hr/id-cards-manager";
import { fullIdCards, idCardIssuer, idCardPeople, readIdCardDesign } from "@/lib/id-cards/cards";
import { safeHex } from "@/lib/id-cards/design";

export const metadata = { title: "ID cards" };

/** People › ID cards (owner, 31 Oct 2026 — src/lib/id-cards): the card's design, and everyone's to print. */
export default async function IdCardsPage() {
  if (!(await isModuleEnabled("hr"))) return <ModuleDisabledNotice moduleKey="hr" />;
  const user = await requireUser();
  if (!(await can(user.id, "hr.manage"))) notFound();
  const design = await readIdCardDesign();
  const [issuer, people, branding, org] = await Promise.all([idCardIssuer(design), idCardPeople(), getBranding(), getOrganisation()]);
  // The preview shows the person looking, when they are on the list — else whoever is first.
  const sampleId = people.find((p) => p.id === user.id)?.id ?? people[0]?.id;
  const sample = sampleId ? ((await fullIdCards([sampleId]))[0] ?? null) : null;

  return (
    <div className="animate-fade-rise">
      <ListHeader title="ID cards" subtitle={`${people.length} ${people.length === 1 ? "person" : "people"} working here`} />
      <p className="mt-1 mb-5 text-sm text-muted">
        Photo ID cards for your people, from their employee records. The QR code on the back opens a page that says whether the card is still good — a card stops being
        valid the day someone leaves.
      </p>
      <IdCardsManager
        design={design}
        issuer={issuer}
        brandColor={safeHex(branding.primaryColor) ?? "#0249fe"}
        signatureOnFile={org.signatureDataUrl}
        people={people}
        sample={sample}
      />
    </div>
  );
}
