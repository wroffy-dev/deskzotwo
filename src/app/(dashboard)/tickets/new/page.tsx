import { notFound } from "next/navigation";
import { listCompanyOptions } from "@/actions/company";
import { listCompanyOrderOptions, listSupportAgents, listTicketContacts } from "@/actions/ticket";
import { isModuleEnabled } from "@/actions/module";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { NewTicketForm } from "@/components/tickets/new-ticket-form";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import { companyPickerOption } from "@/lib/companies/picker-option";
import { liveFirst, liveNamesakes, liveOf } from "@/lib/ticket-companies";

/**
 * How many companies the page sends with the form (owner, 30 Oct 2026: about 12,000, each with its
 * contacts, held the form up before anything could be typed). One more is asked for: when it comes back
 * the list is incomplete, and the picker searches the server instead; the chosen company's people are
 * fetched when it is picked.
 */
const COMPANIES_SENT = 300;

export default async function NewTicketPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  if (!(await isModuleEnabled("helpdesk"))) return <ModuleDisabledNotice moduleKey="helpdesk" />;
  const sessionUser = await currentUser();
  const userId = sessionUser!.id;
  const canCreate = await hasEffectivePermission(userId, "tickets.create");
  if (!canCreate) notFound();

  // Whether the workspace sells items, not whether this person may open its catalogue (owner, 25 Nov 2026: Tech Support,
  // with Items & Inventory off, had no order to pick). Which orders are offered is the orders' own rule.
  const itemsEnabled = await moduleAvailableForTenant("items");
  const [{ companyId }, companyRows, users] = await Promise.all([
    searchParams,
    listCompanyOptions({ withContacts: false, take: COMPANIES_SENT + 1 }),
    listSupportAgents(),
  ]);
  // The URL's company, as the picker would offer it, with its people — fetched on pick for any other.
  const [prefill, initialContacts] = await Promise.all([
    companyPickerOption(userId, companyId),
    companyId ? listTicketContacts(companyId) : null,
  ]);
  const companySearch = companyRows.length > COMPANIES_SENT;
  const sentCompanies = companyRows.slice(0, COMPANIES_SENT);
  // The prefilled company is always in the list, wherever it falls in the alphabet, so the picker can name it.
  const listed = prefill && !sentCompanies.some((c) => c.id === prefill.id) ? [prefill, ...sentCompanies] : sentCompanies;
  // Those with an active order marked, and first — two of a name are told apart (owner, 25 Nov 2026; src/lib/ticket-companies.ts).
  const live = itemsEnabled ? await liveOf(userId, listed.map((c) => c.id)) : new Set<string>();
  const companies = liveFirst(listed.map((c) => ({ ...c, live: live.has(c.id) })));
  const initialNamesakes = prefill && itemsEnabled && !live.has(prefill.id) ? await liveNamesakes(userId, prefill.id) : [];
  const initialOrders = companyId && itemsEnabled ? await listCompanyOrderOptions(companyId) : [];
  const w = await getWording();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">{slot(w, "New ticket", "ticket", "New {one:lower}")}</h1>
      <p className="mt-1 text-sm text-muted">{slot(w, "Log a support request against a company.", "company", "Log a support request against {a}.")}</p>
      <div className="mt-6">
        <NewTicketForm
          companies={companies}
          initialCompanyId={companyId}
          initialContacts={prefill ? initialContacts : null}
          companySearch={companySearch}
          itemsEnabled={itemsEnabled}
          initialOrders={initialOrders}
          initialNamesakes={initialNamesakes}
          users={users}
        />
      </div>
    </div>
  );
}
