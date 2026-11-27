import Link from "next/link";
import { requireUser } from "@/lib/session";
import { listCompanyOptions } from "@/actions/company";
import { listVisitAssignees } from "@/actions/visit";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { VisitForm } from "@/components/visits/visit-form";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import { companyPickerOption } from "@/lib/companies/picker-option";

/**
 * How many companies the page sends with the form (owner, 30 Oct 2026: the whole book, each with its
 * contacts, held the form up). One more is asked for: when it comes back the list is incomplete, and the
 * picker searches the server instead. The form fetches the chosen company's people itself.
 */
const COMPANIES_SENT = 300;

/**
 * "now, rounded to the next half hour" on the workspace's clock — a sensible default for a visit you're
 * planning today. Rounded on the wall clock rather than in UTC: some zones sit a quarter hour off it.
 */
function defaultSlot(clock: Clock) {
  const now = clock.parts(new Date());
  // Minutes past midnight overflow into the next day as `at` normalises them.
  const minutes = (Math.floor((now.hour * 60 + now.minute) / 30) + 1) * 30;
  return clock.input(clock.at(now.year, now.month, now.day, 0, minutes));
}

export default async function NewVisitPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; leadId?: string }>;
}) {
  const enabled = await isModuleEnabled("visits");
  if (!enabled) return <ModuleDisabledNotice moduleKey="visits" />;

  const [params, viewer, companyRows, assignees, clock, w] = await Promise.all([
    searchParams,
    requireUser(),
    listCompanyOptions({ withContacts: false, take: COMPANIES_SENT + 1 }),
    listVisitAssignees(),
    workspaceClock(),
    getWording(),
  ]);
  // The URL's company, only if the picker would offer it — as when it was looked for in the whole list.
  const prefill = await companyPickerOption(viewer.id, params.companyId);
  const sentCompanies = companyRows.slice(0, COMPANIES_SENT);
  // Always in the list, wherever it falls in the alphabet, so the picker can name it.
  const companies = prefill && !sentCompanies.some((c) => c.id === prefill.id) ? [prefill, ...sentCompanies] : sentCompanies;

  return (
    <div>
      <div className="mb-5">
        <Link href="/visits" className="text-sm text-muted hover:text-text">
          ← {slot(w, "Field visits", "visit")}
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">{slot(w, "Plan a visit", "visit", "Plan {a}")}</h1>
        <p className="mt-1 text-sm text-muted">
          Check in when you arrive, write up the outcome afterwards, and claim the travel against it.
        </p>
      </div>

      <VisitForm
        companies={companies}
        companySearch={companyRows.length > COMPANIES_SENT}
        assignees={assignees}
        currentUserId={viewer.id}
        defaults={{
          companyId: prefill?.id ?? "",
          contactId: "",
          leadId: params.leadId ?? "",
          locationId: "",
          purpose: "INTRO_MEETING",
          agenda: "",
          scheduledFor: defaultSlot(clock),
          address: "",
          distanceKm: "",
          userId: viewer.id,
        }}
      />
    </div>
  );
}
