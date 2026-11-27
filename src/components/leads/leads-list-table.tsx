"use client";

import { ContactReveal } from "@/components/contacts/contact-reveal";
import { useState, useTransition } from "react";
import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import type { LeadSource, LeadStatus } from "@prisma/client";
import { bulkUpdateLeads } from "@/actions/lead";
import { startNurtureMany } from "@/actions/nurture";
import { OwnerCell } from "@/components/leads/owner-cell";
import type { LeadStageDef } from "@/lib/pipeline/rules";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { useClock } from "@/components/time/clock-provider";
import { formatLeadId } from "@/lib/order-id";
import { companyPath, leadPath } from "@/lib/record-links";
import { LeadStatusBadge } from "@/components/leads/lead-status-badge";
import { useColumns, ColumnsTable } from "@/components/ui/table-columns";
import { Ago } from "@/components/ui/ago";
import { RemindMeButton } from "@/components/reminders/remind-me-button";
import { LeadScoreBadge } from "@/components/leads/lead-score";
import { LeadQuoteCell } from "@/components/leads/lead-quote-badge";
import type { LeadQuote } from "@/lib/leads/quotes";
import { leadSourceLabel } from "@/lib/leads/source";
import { CustomFieldBodyCells, CustomFieldHeaderCells, type CustomColumn } from "@/components/custom-fields/custom-field-cells";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";

type LeadRow = {
  id: string;
  /** Something of it is masked in this list that "Show" may reveal for the day (src/lib/leads/masking.ts). */
  revealable?: boolean;
  /** The short reference — LEAD-000123. Stable while the title, which is free text, is not. */
  leadSeq: number;
  title: string;
  status: LeadStatus;
  /** The workspace's own stage it is at (`stageOfLead`, src/lib/pipeline). */
  stage: LeadStageDef;
  /** Why a lost or disqualified deal died — shown on hover, never set for an open one. */
  lostReason: string | null;
  estimatedValue: string | null;
  expectedCloseDate: Date | string | null;
  updatedAt: Date | string;
  /** With its account manager and caller, for those columns. */
  company: { id: string; name: string; companySeq: number; owner?: { id: string; name: string } | null; assignedTo?: { id: string; name: string } | null };
  createdBy?: { id: string; name: string } | null;
  createdAt?: Date | string;
  pipelineName?: string | null;
  /** Read by the page only when its column is shown (src/lib/tables/list-extras.ts); undefined when it isn't. */
  lastActivityAt?: string | null;
  nextFollowUpAt?: string | null;
  /** Whole days since it last moved stage. */
  daysInStage?: number | null;
  /** This person's own "Remind me" on it (src/lib/lead-reminders.ts). */
  myReminder?: { remindOn: string | null; note: string | null } | null;
  /** The lead's contact — with their email and phone only where the page read them (`contactDetails`). */
  contact?: { name: string; email?: string | null; phone?: string | null } | null;
  owner: { id: string; name: string } | null;
  /** 0–100, or null for a closed lead — see src/lib/leads/score.ts. */
  score: number | null;
  source: LeadSource;
  sourceDetail: string | null;
};

export function LeadsListTable({
  leads,
  stages,
  assignableUsers,
  reassign,
  customColumns = { columns: [], texts: {} },
  contactDetails = false,
  quotes = null,
  nurture = null,
  shutCompanies = [],
}: {
  leads: LeadRow[];
  /** Companies among these the person can't open — a lead of theirs on somebody else's account (src/lib/companies/out-of-reach.ts). */
  shutCompanies?: string[];
  /** The workspace's stages still in use (Settings → Pipeline) — what the bulk bar can move leads to. */
  stages: LeadStageDef[];
  assignableUsers: { id: string; name: string; role: string; takes?: { leadOwner: boolean } }[];
  /** Whether this person may change lead owners at all — see src/lib/authz/reassign.ts. */
  reassign: { show: boolean; canUnassign: boolean };
  /**
   * The workspace's own fields this person may see (src/lib/custom-fields/server.ts `listColumns`):
   * the ones they show in the column picker, or each field's default.
   */
  customColumns?: { columns: CustomColumn[]; texts: Record<string, Record<string, string>> };
  /**
   * Whether the Email and Phone columns exist for this person — `contacts.view`, as on a lead's own
   * page. Their values come masked from the server where the list masks them for this person.
   */
  contactDetails?: boolean;
  /**
   * Each lead's quotation (src/lib/leads/quote-status.ts), or null where the Quotation column doesn't
   * exist for this person — no sales documents to see, or a pipeline that isn't sales.
   */
  quotes?: Record<string, LeadQuote | null> | null;
  /**
   * The AI teammate who nurtures leads, where this person may start it (src/lib/nurture, phase 4 — "start many at once"):
   * the bulk bar offers it for the leads chosen. Null where nurturing is off or not theirs to start.
   */
  nurture?: { name: string } | null;
}) {
  const cols = useColumns("leads");
  // The fields this person shows, worked out once: the header and every row draw this one list.
  const fieldColumns = customColumns.columns.filter((c) => cols.showCustom(c.key, c.default));
  // "No leads yet" spans the shown columns, the workspace's own fields and the View column after them.
  const VIEW_COLUMN = 1;
  const emptySpan = cols.count + fieldColumns.length + VIEW_COLUMN;
  const router = useRouter();
  const clock = useClock();
  const w = useWording();
  const selection = useRowSelection(leads);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ownerUserId, setOwnerUserId] = useState("");
  const [stageId, setStageId] = useState("");
  const [lostReason, setLostReason] = useState("");

  const chosenStage = stages.find((s) => s.id === stageId);
  const needsReason = chosenStage?.status === "LOST" || chosenStage?.status === "DISQUALIFIED";

  function nurtureChosen() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await startNurtureMany(selection.ids);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const d = result.data;
      const parts = [`${nurture?.name ?? "Deskzo AI"} is nurturing ${d.started} lead${d.started === 1 ? "" : "s"} — the first emails wait for their owners.`];
      if (d.needPlan) parts.push(`${d.needPlan} need a Research & plan first.`);
      if (d.refused) parts.push(`${d.refused} couldn't start${d.firstReason ? ` (${d.firstReason})` : ""}.`);
      if (d.cantChange) parts.push(`${d.cantChange} aren't yours to change.`);
      setNotice(parts.join(" "));
      selection.clear();
      router.refresh();
    });
  }

  function apply() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkUpdateLeads({ leadIds: selection.ids, ownerUserId, stageId, lostReason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`Updated ${result.data.count} lead(s).`);
      setOwnerUserId("");
      setStageId("");
      setLostReason("");
      selection.clear();
      router.refresh();
    });
  }

  return (
    <div>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
        {/* Bulk-bar controls have no captions; the "no change" option is a placeholder, not a name. */}
        {reassign.show && (
          <SearchSelect
            value={ownerUserId}
            onChange={(e) => setOwnerUserId(e.target.value)}
            className="h-9 w-52"
            aria-label="Owner"
            searchPlaceholder="Search people…"
          >
            <option value="">Owner — no change</option>
            {reassign.canUnassign && <option value="unassign">Unassign</option>}
            {/* Only who may own a lead (Settings › Departments — src/lib/companies/assign-teams.ts). */}
            {assignableUsers.filter((u) => u.takes?.leadOwner !== false).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role})
              </option>
            ))}
          </SearchSelect>
        )}
        <Select value={stageId} onChange={(e) => setStageId(e.target.value)} className="h-9 w-48" aria-label="Stage">
          <option value="">Stage — no change</option>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        {needsReason && (
          <Input
            value={lostReason}
            onChange={(e) => setLostReason(e.target.value)}
            placeholder="Reason (required)"
            className="h-9 w-56"
            aria-label="Reason"
          />
        )}
        <Button size="sm" disabled={isPending || (!ownerUserId && !stageId)} onClick={apply}>
          {isPending ? "Applying…" : "Apply"}
        </Button>
        {nurture && (
          <Button size="sm" variant="secondary" disabled={isPending} onClick={nurtureChosen}>
            Nurture with {nurture.name}
          </Button>
        )}
      </BulkBar>

      <Card className="overflow-hidden">
        {/* `relative`: the header's screen-reader-only words are positioned, and without a positioned box to
            hold them they escaped this scroller and widened the whole page — a sideways scrollbar at 1366px. */}
        <div className="relative overflow-x-auto">
          <ColumnsTable columns={cols} className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>{cols.arrange(<>
                {cols.show("select") && (
                  <th data-col="select" className="w-10 px-4 py-2.5">
                    <Checkbox checked={selection.allSelected} onChange={selection.toggleAll} aria-label={slot(w, "Select all leads", "lead", "Select all {many:lower}")} />
                  </th>
                )}
                {cols.show("id") && <th data-col="id" className="px-4 py-2.5">ID</th>}
                {cols.show("title") && <th data-col="title" className="px-4 py-2.5">Title</th>}
                {cols.show("company") && <th data-col="company" className="px-4 py-2.5">{slot(w, "Company", "company", "{one}")}</th>}
                {cols.show("email") && contactDetails && <th data-col="email" className="px-4 py-2.5">Email</th>}
                {cols.show("phone") && contactDetails && <th data-col="phone" className="px-4 py-2.5">Phone</th>}
                {cols.show("status") && <th data-col="status" className="px-4 py-2.5">Status</th>}
                {cols.show("score") && <th data-col="score" className="px-4 py-2.5">Score</th>}
                {cols.show("source") && <th data-col="source" className="px-4 py-2.5">Source</th>}
                {cols.show("owner") && <th data-col="owner" className="px-4 py-2.5">Owner</th>}
                {cols.show("accountManager") && <th data-col="accountManager" className="px-4 py-2.5">Account manager</th>}
                {cols.show("caller") && <th data-col="caller" className="px-4 py-2.5">Caller</th>}
                {cols.show("value") && <th data-col="value" className="px-4 py-2.5">Value</th>}
                {cols.show("quote") && quotes && <th data-col="quote" className="px-4 py-2.5">Quotation</th>}
                {cols.show("expectedClose") && <th data-col="expectedClose" className="px-4 py-2.5">Expected close</th>}
                {cols.show("updated") && <th data-col="updated" className="px-4 py-2.5">Updated</th>}
                {cols.show("addedBy") && <th data-col="addedBy" className="px-4 py-2.5">Added by</th>}
                {cols.show("addedOn") && <th data-col="addedOn" className="px-4 py-2.5">Added on</th>}
                {cols.show("contact") && <th data-col="contact" className="px-4 py-2.5">Contact</th>}
                {cols.show("lastActivity") && <th data-col="lastActivity" className="px-4 py-2.5">Last activity</th>}
                {cols.show("nextFollowUp") && <th data-col="nextFollowUp" className="px-4 py-2.5">Next follow-up</th>}
                {cols.show("daysInStage") && <th data-col="daysInStage" className="px-4 py-2.5">Days in stage</th>}
                {cols.show("pipeline") && <th data-col="pipeline" className="px-4 py-2.5">Pipeline</th>}
                {cols.show("lostReason") && <th data-col="lostReason" className="px-4 py-2.5">Lost reason</th>}
                <CustomFieldHeaderCells columns={fieldColumns} className="px-4 py-2.5" />
                <th className="px-4 py-2.5 text-right">
                  <span className="sr-only">Open</span>
                </th>
              </>)}</tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">{cols.arrange(<>
                  {cols.show("select") && (
                    <td data-col="select" className="px-4 py-2.5">
                      <Checkbox
                        checked={selection.isSelected(lead.id)}
                        onChange={() => selection.toggle(lead.id)}
                        aria-label={`Select ${lead.title}`}
                      />
                    </td>
                  )}
                  {/* The title is mutable free text that changes as a deal evolves — this is the
                      reference that does not. */}
                  {cols.show("id") && (
                    <td data-col="id" className="px-4 py-2.5 font-mono text-xs text-muted">{formatLeadId(lead.leadSeq)}</td>
                  )}
                  {cols.show("title") && (
                    <td data-col="title" className="px-4 py-2.5">
                      <Link href={leadPath(lead.leadSeq)} className="font-medium text-text hover:underline">
                        {lead.title}
                      </Link>
                    </td>
                  )}
                  {cols.show("company") && (
                    <td data-col="company" className="px-4 py-2.5">
                      <CompanyLink shut={shutCompanies.includes(lead.company.id)} href={companyPath(lead.company.companySeq)} className="text-muted hover:underline">
                        {lead.company.name}
                      </CompanyLink>
                    </td>
                  )}
                  {cols.show("email") && contactDetails && (
                    <td data-col="email" className="max-w-[14rem] truncate px-4 py-2.5 text-muted" title={lead.contact?.email ?? undefined}>
                      {lead.contact?.email ?? <span className="text-subtle">—</span>}
                    </td>
                  )}
                  {cols.show("phone") && contactDetails && (
                    <td data-col="phone" className="whitespace-nowrap px-4 py-2.5 text-muted">{lead.contact?.phone ?? <span className="text-subtle">—</span>}</td>
                  )}
                  {cols.show("status") && (
                    <td data-col="status" className="px-4 py-2.5">
                      <LeadStatusBadge status={lead.status} stage={lead.stage} lostReason={lead.lostReason} />
                    </td>
                  )}
                  {cols.show("score") && (
                    <td data-col="score" className="px-4 py-2.5">
                      {lead.score === null ? <span className="text-subtle">—</span> : <LeadScoreBadge score={lead.score} />}
                    </td>
                  )}
                  {cols.show("source") && (
                    <td data-col="source" className="px-4 py-2.5 text-muted" title={lead.sourceDetail ?? undefined}>
                      {leadSourceLabel(lead.source)}
                    </td>
                  )}
                  {cols.show("owner") && (
                    <td data-col="owner" className="px-4 py-2.5 text-muted">
                      {/* Changed right here, as the bulk bar would — for whoever may reassign (owner, 20 Nov 2026). */}
                      {reassign.show ? (
                        <OwnerCell
                          leadId={lead.id}
                          owner={lead.owner}
                          people={assignableUsers.filter((u) => u.takes?.leadOwner !== false)}
                          canUnassign={reassign.canUnassign}
                        />
                      ) : (
                        (lead.owner?.name ?? "Unassigned")
                      )}
                    </td>
                  )}
                  {cols.show("accountManager") && <td data-col="accountManager" className="px-4 py-2.5 text-muted">{lead.company.owner?.name ?? "—"}</td>}
                  {cols.show("caller") && <td data-col="caller" className="px-4 py-2.5 text-muted">{lead.company.assignedTo?.name ?? "—"}</td>}
                  {cols.show("value") && (
                    <td data-col="value" className="px-4 py-2.5 text-muted">{formatCurrency(lead.estimatedValue?.toString())}</td>
                  )}
                  {cols.show("quote") && quotes && (
                    <td data-col="quote" className="whitespace-nowrap px-4 py-2.5">
                      <LeadQuoteCell quote={quotes[lead.id] ?? null} status={lead.status} />
                    </td>
                  )}
                  {cols.show("expectedClose") && (
                    <td data-col="expectedClose" className="px-4 py-2.5 text-muted">{formatCalendarDay(lead.expectedCloseDate)}</td>
                  )}
                  {cols.show("updated") && (
                    <td data-col="updated" className="px-4 py-2.5 text-muted">{clock.date(lead.updatedAt)}</td>
                  )}
                  {cols.show("addedBy") && <td data-col="addedBy" className="px-4 py-2.5 text-muted">{lead.createdBy?.name ?? "—"}</td>}
                  {cols.show("addedOn") && <td data-col="addedOn" className="px-4 py-2.5 text-muted">{lead.createdAt ? clock.date(lead.createdAt) : "—"}</td>}
                  {cols.show("contact") && <td data-col="contact" className="px-4 py-2.5 text-muted">{lead.contact?.name ?? "—"}</td>}
                  {cols.show("lastActivity") && (
                    <td data-col="lastActivity" className="whitespace-nowrap px-4 py-2.5 text-muted">
                      <Ago at={lead.lastActivityAt} />
                    </td>
                  )}
                  {cols.show("nextFollowUp") && (
                    <td data-col="nextFollowUp" className="whitespace-nowrap px-4 py-2.5 text-muted">
                      {lead.nextFollowUpAt ? clock.date(lead.nextFollowUpAt) : <span className="text-subtle">None</span>}
                    </td>
                  )}
                  {cols.show("daysInStage") && (
                    <td data-col="daysInStage" className="px-4 py-2.5 tabular-nums text-muted">
                      {lead.daysInStage ?? "—"}
                    </td>
                  )}
                  {cols.show("pipeline") && <td data-col="pipeline" className="px-4 py-2.5 text-muted">{lead.pipelineName ?? "—"}</td>}
                  {cols.show("lostReason") && <td data-col="lostReason" className="px-4 py-2.5 text-muted">{lead.lostReason ?? "—"}</td>}
                  <CustomFieldBodyCells columns={fieldColumns} texts={customColumns.texts[lead.id]} className="px-4 py-2.5 text-muted" />
                  {/* Show: reveals what this list masks, for the day, with an optional reason (src/components/contacts/contact-reveal.tsx); View: the lead's page, with its own Show (src/components/leads/lead-unmask.tsx). */}
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    {/* Their own "Remind me", showing its day once set (owner, 31 Oct 2026). */}
                    {lead.revealable && (
                      <span className="mr-1 inline-flex align-middle">
                        <ContactReveal kind="lead" contactId={lead.id} name={formatLeadId(lead.leadSeq)} />
                      </span>
                    )}
                    <span className="mr-1 inline-flex align-middle">
                      <RemindMeButton target={{ kind: "lead", leadId: lead.id }} label={`${formatLeadId(lead.leadSeq)} — ${lead.title}`} reminder={lead.myReminder ?? null} />
                    </span>
                    <Link
                      href={leadPath(lead.leadSeq)}
                      className="inline-flex h-7 items-center rounded-base border border-line bg-surface px-2.5 text-xs font-medium text-text hover:bg-surface-sunken"
                      aria-label={`View ${formatLeadId(lead.leadSeq)}`}
                    >
                      View
                    </Link>
                  </td>
                </>)}</tr>
              ))}
              {leads.length === 0 && (
                <tr>
                  <td colSpan={emptySpan} className="px-4 py-8 text-center text-subtle">
                    {slot(w, "No leads yet.", "lead", "No {many:lower} yet.")}
                  </td>
                </tr>
              )}
            </tbody>
          </ColumnsTable>
        </div>
      </Card>
    </div>
  );
}
