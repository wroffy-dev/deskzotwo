import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getVisit, listVisitAssignees } from "@/actions/visit";
import { listCompanyOptions } from "@/actions/company";
import { VisitForm } from "@/components/visits/visit-form";
import { isVisitOpen } from "@/lib/visits";
import { workspaceClock } from "@/lib/time/workspace";
import { visitPath } from "@/lib/record-links";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import { companyPickerOption } from "@/lib/companies/picker-option";

/** As on the new-visit page: the first few hundred companies, and the picker searches for the rest (owner, 30 Oct 2026). */
const COMPANIES_SENT = 300;

export default async function EditVisitPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("visits"))) return <ModuleDisabledNotice moduleKey="visits" />;
  const { id } = await params;
  const [visit, viewer, w] = await Promise.all([getVisit(id), requireUser(), getWording()]);
  if (!visit) notFound();

  if (!isVisitOpen(visit.status)) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">{slot(w, "This visit is closed", "visit", "This {one:lower} is closed")}</h1>
        <p className="mt-2 text-sm text-muted">
          {slot(w, "A completed or cancelled visit is a record of what happened, so it can't be rescheduled.", "visit", "A completed or cancelled {one:lower} is a record of what happened, so it can't be rescheduled.")}
        </p>
        <Link href={visitPath(visit.visitSeq)} className="mt-3 inline-block text-sm text-brand hover:underline">
          ← {slot(w, "Back to the visit", "visit", "Back to the {one:lower}")}
        </Link>
      </div>
    );
  }

  const [companyRows, own, assignees, clock] = await Promise.all([
    listCompanyOptions({ withContacts: false, take: COMPANIES_SENT + 1 }),
    // The visit's own company, as the picker would offer it, so the field can name it wherever it sorts.
    companyPickerOption(viewer.id, visit.companyId),
    listVisitAssignees(),
    workspaceClock(),
  ]);
  const sentCompanies = companyRows.slice(0, COMPANIES_SENT);
  const companies = own && !sentCompanies.some((c) => c.id === own.id) ? [own, ...sentCompanies] : sentCompanies;

  return (
    <div>
      <div className="mb-5">
        <Link href={visitPath(visit.visitSeq)} className="text-sm text-muted hover:text-text">
          ← {slot(w, "Back to the visit", "visit", "Back to the {one:lower}")}
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">{slot(w, "Edit visit", "visit", "Edit {one:lower}")}</h1>
      </div>

      <VisitForm
        companies={companies}
        companySearch={companyRows.length > COMPANIES_SENT}
        assignees={assignees}
        currentUserId={viewer.id}
        defaults={{
          id: visit.id,
          visitSeq: visit.visitSeq,
          companyId: visit.companyId,
          contactId: visit.contactId ?? "",
          leadId: visit.leadId ?? "",
          locationId: visit.locationId ?? "",
          purpose: visit.purpose,
          agenda: visit.agenda ?? "",
          // The time as it was planned on the workspace's clock, not in the server's own zone.
          scheduledFor: clock.input(visit.scheduledFor),
          address: visit.address ?? "",
          distanceKm: visit.distanceKm !== null ? String(visit.distanceKm) : "",
          userId: visit.userId,
        }}
      />
    </div>
  );
}
