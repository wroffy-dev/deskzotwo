import Link from "next/link";
import { listLeadsPaged } from "@/actions/lead";
import { listAssignableUsers } from "@/actions/company";
import { LeadsListTable } from "@/components/leads/leads-list-table";
import { ColumnPicker } from "@/components/ui/table-columns";
import { leadStages, stagesOfLeads } from "@/lib/pipeline/server";
import { viewerReassignControls } from "@/lib/authz/reassign";
import { listColumns } from "@/lib/custom-fields/server";
import { leadQuotes, seesLeadQuotes } from "@/lib/leads/quote-status";
import { requireUser } from "@/lib/session";

/** The most a company's tab shows at once; past it, the tab says so and the Leads list has the rest. */
const SHOWN = 100;

/**
 * A company's Leads tab, drawn as the Leads list is (owner, 27 Oct 2026): the same table — ID, title, the person's
 * email and phone, stage, score, source, owner, value, quotation, close date — the same columns this person chose
 * there, masking and bulk actions. Every pipeline's leads of the company, newest activity first, by the list's own
 * rules (`listLeadsPaged` with `companyId`), so the tab shows no lead the list wouldn't.
 */
export async function CompanyLeads({ companyId, companyName, emptyMessage }: { companyId: string; companyName: string; emptyMessage: string }) {
  const user = await requireUser();
  const [listed, pipelines, assignableUsers, reassign] = await Promise.all([
    listLeadsPaged({ companyId, pipeline: "all", page: 1, pageSize: SHOWN }),
    leadStages(),
    listAssignableUsers(),
    viewerReassignControls(),
  ]);
  const stageOf = await stagesOfLeads(listed.rows);
  // Prisma's Decimal can't cross into the client table: the value as text, as the Leads page sends it.
  const leads = listed.rows.map((lead) => ({ ...lead, estimatedValue: lead.estimatedValue?.toString() ?? null, stage: stageOf.get(lead.id)! }));
  const [quotes, customColumns] = await Promise.all([
    (await seesLeadQuotes(user.id)) ? leadQuotes(user.id, leads.map((l) => l.id)) : null,
    listColumns("LEAD", user.id, leads.map((l) => l.id)),
  ]);

  if (listed.total === 0) return <p className="px-4 py-6 text-center text-sm text-subtle">{emptyMessage}</p>;
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ColumnPicker tableKey="leads" customColumns={customColumns.columns} />
      </div>
      <LeadsListTable
        leads={leads}
        stages={pipelines.stages.filter((s) => !s.archived)}
        assignableUsers={assignableUsers}
        reassign={reassign}
        customColumns={customColumns}
        contactDetails={listed.contactDetails}
        quotes={quotes}
      />
      {listed.total > SHOWN && (
        <p className="text-xs text-muted">
          The {SHOWN} with the newest activity of {listed.total.toLocaleString("en-IN")} — the{" "}
          <Link href={`/leads?view=list&pipeline=all&q=${encodeURIComponent(companyName)}`} className="text-brand hover:underline">
            Leads list
          </Link>{" "}
          has them all.
        </p>
      )}
    </div>
  );
}
