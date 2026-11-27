"use client";

import { useState, useTransition } from "react";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import { bulkCreateRenewalTasks, bulkSetRenewalManager } from "@/actions/renewal";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatOrderId } from "@/lib/order-id";
import { companyPath } from "@/lib/record-links";
import { daysUntil, getRenewalStatus } from "@/lib/renewals";
import { formatCurrency } from "@/lib/utils";
import { Ago } from "@/components/ui/ago";
import { CustomerNoticeButton } from "@/components/marketing/customer-notice-button";
import { RenewButton } from "@/components/renewals/renew-button";
import { RenewalProposalButton } from "@/components/renewals/renewal-proposal-button";
import { RenewalStageCell, type RenewalStageCellData } from "@/components/renewals/renewal-stage-cell";
import { CallButton } from "@/components/calls/call-button";
import { RemindMeButton } from "@/components/reminders/remind-me-button";
import { useColumns, ColumnsTable } from "@/components/ui/table-columns";
import { worksRenewals, type RenewalActions } from "@/lib/renewal-actions";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";

type RenewalRow = {
  id: string;
  orderSeq: number;
  quantity: number;
  poNumber: string | null;
  startDate: Date | string | null;
  endDate: Date | string | null;
  company: {
    id: string;
    companySeq: number;
    name: string;
    owner?: { id: string; name: string } | null;
    assignedTo?: { id: string; name: string } | null;
    /** The person to ring, so the call button opens on them rather than a picker. */
    contacts?: { id: string; name: string; phone: string | null }[];
  };
  endCustomer: { id: string; companySeq: number; name: string } | null;
  item: { id: string; name: string; unit: string | null };
  /**
   * The parent and everything co-terminating with it, because "15 seats expiring on the 9th" is the
   * renewal conversation — not "10 seats, and separately 5 seats".
   */
  group?: { totalQuantity: number; addonCount: number; renewalValue: number; incomplete: boolean; estimated?: boolean; note: string };
  /** Present once a renewal has been punched — the row then says so instead of asking again. */
  renewedBy?: { id: string; orderSeq: number; orderStatus: string } | null;
  /** How far along it is — derived from the record, with room for a stage somebody pinned. */
  stage?: RenewalStageCellData;
  /** Who looks after it: the customer's renewal manager (`own`), else its account manager (owner, 30 Oct 2026). */
  renewalManager?: { id: string; name: string; own: boolean } | null;
  /** The next day it invoices itself, or why it won't (src/lib/recurring-billing/check-rules.ts). */
  nextBill?: { day: Date | string | null; what: string } | null;
  /** Read by the page only when its column is shown (src/lib/tables/list-extras.ts). */
  lastContactedAt?: string | null;
  /** This person's own "Remind me" on it (src/lib/renewal-reminders.ts). */
  myReminder?: { remindOn: string | null; note: string | null } | null;
};

export function RenewalsTable({
  renewals,
  users,
  can = { stage: false, renew: false, email: false, proposal: false, call: false },
  canSetManager = false,
  totalValue = null,
}: {
  renewals: RenewalRow[];
  /** The Renewal value column's total over everything the filters match, not the page (owner, 31 Oct 2026). */
  totalValue?: number | null;
  /** `takes`: what a department may be given (src/lib/companies/assign-teams.ts) — absent, anyone. */
  users: { id: string; name: string; takes?: { renewalManager: boolean } }[];
  /**
   * What this person may do to a renewal (src/lib/renewal-actions.ts): only those are offered — the stage picker, each
   * button, the Actions column and the tick boxes at all. The actions refuse regardless; this keeps the list honest.
   */
  can?: RenewalActions;
  /** Whether to offer "Set renewal manager" on a selection — the action asks each customer's rule again. */
  canSetManager?: boolean;
}) {
  const cols = useColumns("renewals");
  // Somebody who may only read the list (owner, 26 Nov 2026): no Actions column, no tick boxes.
  const works = worksRenewals(can);
  const selects = works || canSetManager;
  // The workspace's own words (Settings → Wording).
  const wording = useWording();
  const router = useRouter();
  const selection = useRowSelection(renewals);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [assignedToUserId, setAssignedToUserId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [managerTo, setManagerTo] = useState("");

  function setManager() {
    if (!managerTo) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkSetRenewalManager({ orderIds: selection.ids, userId: managerTo });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`Renewal manager set for ${result.data.count} customer(s).`);
      setManagerTo("");
      selection.clear();
      router.refresh();
    });
  }

  function createTasks() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkCreateRenewalTasks({ orderIds: selection.ids, assignedToUserId, dueDate });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { count, skipped } = result.data;
      setNotice(`Created ${count} renewal task(s).` + (skipped > 0 ? ` ${skipped} already had an open task.` : ""));
      setAssignedToUserId("");
      setDueDate("");
      selection.clear();
      router.refresh();
    });
  }

  return (
    <div>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
        {works && (<>
        <SearchSelect
          value={assignedToUserId}
          onChange={(e) => setAssignedToUserId(e.target.value)}
          className="h-9 w-52"
          aria-label="Assign to"
          searchPlaceholder="Search people…"
        >
          <option value="">Assign to — nobody</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </SearchSelect>
        <Input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className="h-9 w-44"
          aria-label="Task due date"
          title="Leave blank to use each subscription's own expiry date"
        />
        <Button size="sm" disabled={isPending} onClick={createTasks}>
          {isPending ? "Creating…" : slot(wording, "Create renewal tasks", "renewal", "Create {one:lower} tasks")}
        </Button>
        </>)}
        {canSetManager && (
          <>
            <SearchSelect
              value={managerTo}
              onChange={(e) => setManagerTo(e.target.value)}
              className="h-9 w-56"
              aria-label="Renewal manager of the selected renewals' customers"
              searchPlaceholder="Search people…"
            >
              <option value="">Set renewal manager…</option>
              <option value="account">Back to the account manager</option>
              {users.filter((u) => u.takes?.renewalManager !== false).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </SearchSelect>
            <Button size="sm" variant="secondary" disabled={isPending || !managerTo} onClick={setManager}>
              Set
            </Button>
          </>
        )}
      </BulkBar>

      <Card>
        <div className="overflow-x-auto">
          <ColumnsTable columns={cols} className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>{cols.arrange(<>
                {cols.show("select") && selects && (
                  <th data-col="select" className="w-10 px-4 py-2.5">
                    <Checkbox
                      checked={selection.allSelected}
                      onChange={selection.toggleAll}
                      aria-label="Select all subscriptions on this page"
                    />
                  </th>
                )}
                {cols.show("orderId") && <th data-col="orderId" className="px-4 py-2.5">{slot(wording, "Order ID", "order", "{one} ID")}</th>}
                {cols.show("company") && <th data-col="company" className="px-4 py-2.5">{slot(wording, "Company", "company", "{one}")}</th>}
                {cols.show("subscription") && <th data-col="subscription" className="px-4 py-2.5">Subscription</th>}
                {cols.show("qty") && <th data-col="qty" className="px-4 py-2.5">Qty</th>}
                {cols.show("po") && <th data-col="po" className="px-4 py-2.5">PO / Invoice #</th>}
                {cols.show("startDate") && <th data-col="startDate" className="px-4 py-2.5">Start date</th>}
                {cols.show("expiryDate") && <th data-col="expiryDate" className="px-4 py-2.5">Expiry date</th>}
                {cols.show("nextBill") && <th data-col="nextBill" className="px-4 py-2.5">Next bill</th>}
                {cols.show("accountManager") && <th data-col="accountManager" className="px-4 py-2.5">Renewal manager</th>}
                {cols.show("companyOwner") && <th data-col="companyOwner" className="px-4 py-2.5">Account manager</th>}
                {cols.show("caller") && <th data-col="caller" className="px-4 py-2.5">Caller</th>}
                {cols.show("renewalValue") && (
                  <th data-col="renewalValue" className="px-4 py-2.5 text-right">
                    Renewal value
                    {totalValue !== null && (
                      <span className="block text-[11px] font-semibold normal-case tracking-normal text-text" title="All the renewals the filters match, not just this page">
                        Total {formatCurrency(totalValue)}
                      </span>
                    )}
                  </th>
                )}
                {cols.show("lastContacted") && <th data-col="lastContacted" className="px-4 py-2.5">Last contacted</th>}
                {cols.show("daysLeft") && <th data-col="daysLeft" className="px-4 py-2.5 text-right">Days left</th>}
                {cols.show("endCustomer") && <th data-col="endCustomer" className="px-4 py-2.5">End customer</th>}
                {cols.show("status") && <th data-col="status" className="px-4 py-2.5">Status</th>}
                {cols.show("stage") && <th data-col="stage" className="px-4 py-2.5">Stage</th>}
                {cols.show("actions") && works && <th data-col="actions" className="px-4 py-2.5 text-right">Actions</th>}
              </>)}</tr>
            </thead>
            <tbody>
              {renewals.map((r) => {
                const status = getRenewalStatus(r.endDate);
                return (
                  <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">{cols.arrange(<>
                    {cols.show("select") && selects && (
                      <td data-col="select" className="px-4 py-2.5">
                        <Checkbox
                          checked={selection.isSelected(r.id)}
                          onChange={() => selection.toggle(r.id)}
                          aria-label={`Select ${formatOrderId(r.orderSeq)}`}
                        />
                      </td>
                    )}
                    {cols.show("orderId") && (
                      <td data-col="orderId" className="px-4 py-2.5 font-mono text-xs text-muted">{formatOrderId(r.orderSeq)}</td>
                    )}
                    {cols.show("company") && (
                      <td data-col="company" className="px-4 py-2.5">
                        <CompanyLink
                          href={`${companyPath((r.endCustomer ?? r.company).companySeq)}?tab=renewals`}
                          className="font-medium text-text hover:underline"
                        >
                          {(r.endCustomer ?? r.company).name}
                        </CompanyLink>
                        {r.endCustomer && (
                          <div className="mt-0.5 text-xs text-info">
                            Renew via{" "}
                            <CompanyLink href={companyPath(r.company.companySeq)} className="hover:underline">
                              {r.company.name}
                            </CompanyLink>
                          </div>
                        )}
                      </td>
                    )}
                    {cols.show("subscription") && (
                      <td data-col="subscription" className="px-4 py-2.5 text-muted">
                        {r.item.name}
                        {r.item.unit ? ` (${r.item.unit})` : ""}
                      </td>
                    )}
                    {cols.show("qty") && (
                      <td data-col="qty" className="px-4 py-2.5 text-muted">
                        {r.group?.totalQuantity ?? r.quantity}
                        {/* Only worth saying where seats were added mid-term — otherwise it is noise. */}
                        {r.group && r.group.addonCount > 0 && (
                          <span className="block text-[11px] text-subtle" title={r.group.note}>
                            {r.quantity} + {r.group.totalQuantity - r.quantity} added
                          </span>
                        )}
                      </td>
                    )}
                    {cols.show("po") && (
                      <td data-col="po" className="px-4 py-2.5 text-muted">{r.poNumber ?? "—"}</td>
                    )}
                    {cols.show("startDate") && (
                      <td data-col="startDate" className="whitespace-nowrap px-4 py-2.5 text-muted">{formatCalendarDay(r.startDate)}</td>
                    )}
                    {cols.show("expiryDate") && (
                      <td data-col="expiryDate" className="whitespace-nowrap px-4 py-2.5 text-muted">{formatCalendarDay(r.endDate)}</td>
                    )}
                    {cols.show("nextBill") && (
                      <td data-col="nextBill" className="whitespace-nowrap px-4 py-2.5">
                        {r.nextBill?.day ? (
                          <>
                            <span className="text-text">{formatCalendarDay(r.nextBill.day)}</span>
                            <span className="block text-xs text-subtle">{r.nextBill.what}</span>
                          </>
                        ) : (
                          <span className={r.nextBill?.what === "Held up" ? "text-warning" : "text-subtle"}>{r.nextBill?.what ?? "—"}</span>
                        )}
                      </td>
                    )}
                    {cols.show("accountManager") && (
                      <td data-col="accountManager" className="px-4 py-2.5 text-muted">
                        {/* The customer's renewal manager, else its account manager — said so (owner, 30 Oct 2026). */}
                        {r.renewalManager ? (
                          <>
                            {r.renewalManager.name}
                            {!r.renewalManager.own && <span className="block text-xs text-subtle">Account manager</span>}
                          </>
                        ) : r.company.owner?.name ?? (
                          <span className="text-subtle">Nobody</span>
                        )}
                      </td>
                    )}
                    {cols.show("companyOwner") && <td data-col="companyOwner" className="px-4 py-2.5 text-muted">{r.company.owner?.name ?? "—"}</td>}
                    {cols.show("caller") && <td data-col="caller" className="px-4 py-2.5 text-muted">{r.company.assignedTo?.name ?? "—"}</td>}
                    {cols.show("renewalValue") && (
                      <td data-col="renewalValue" className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-text" title={r.group?.incomplete || r.group?.estimated ? r.group.note : undefined}>
                        {r.group ? formatCurrency(r.group.renewalValue) : "—"}
                        {r.group?.incomplete && <span className="text-warning">*</span>}
                        {/* The product's current selling price, the order having none (owner, 3 Nov 2026). */}
                        {!r.group?.incomplete && r.group?.estimated && <span className="ml-1 text-[11px] text-subtle">est.</span>}
                      </td>
                    )}
                    {cols.show("lastContacted") && (
                      <td data-col="lastContacted" className="whitespace-nowrap px-4 py-2.5 text-muted">
                        <Ago at={r.lastContactedAt} empty="Never" />
                      </td>
                    )}
                    {cols.show("daysLeft") && (
                      <td data-col="daysLeft" className="px-4 py-2.5 text-right tabular-nums text-muted" suppressHydrationWarning>
                        {r.endDate ? daysUntil(new Date(r.endDate)) : "—"}
                      </td>
                    )}
                    {cols.show("endCustomer") && <td data-col="endCustomer" className="px-4 py-2.5 text-muted">{r.endCustomer?.name ?? "—"}</td>}
                    {cols.show("status") && (
                      <td data-col="status" className="px-4 py-2.5">
                        <Badge tone={status.tone}>{status.label}</Badge>
                        {r.renewedBy && (
                          <span className="mt-0.5 block text-[11px] text-success">
                            Renewed — {formatOrderId(r.renewedBy.orderSeq)}
                          </span>
                        )}
                      </td>
                    )}
                    {cols.show("stage") && (
                      <td data-col="stage" className="px-4 py-2.5">
                        {r.stage ? (
                          <RenewalStageCell companyProductId={r.id} stage={r.stage} canEdit={can.stage} />
                        ) : (
                          <span className="text-xs text-subtle">—</span>
                        )}
                      </td>
                    )}
                    {cols.show("actions") && works && (
                      <td data-col="actions" className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          {/* Their own "Remind me", showing its day once set (owner, 31 Oct 2026). */}
                          <RemindMeButton target={{ kind: "renewal", orderId: r.id, endDate: r.endDate }} label={`${formatOrderId(r.orderSeq)} — ${r.item.name}, ${(r.endCustomer ?? r.company).name}`} reminder={r.myReminder ?? null} />
                          {/* Ring them, write to them, quote them, or punch the order — the four
                              things this list exists to lead to. */}
                          {can.call && (
                            <CallButton
                              companyId={r.company.id}
                              companyName={r.company.name}
                              companyProductId={r.id}
                              preferContact={r.company.contacts?.[0]}
                              size="icon"
                              variant="ghost"
                            />
                          )}
                          {/* Renewed: the reminder would be wrong by now — the icon confirms the renewal instead,
                              written about the renewal order. */}
                          {can.email && (
                            <CustomerNoticeButton
                              companyProductId={r.renewedBy?.id ?? r.id}
                              companyName={(r.endCustomer ?? r.company).name}
                              kind={r.renewedBy ? "RENEWED" : "RENEWAL"}
                            />
                          )}
                          {can.proposal && (
                            <RenewalProposalButton
                              companyProductId={r.id}
                              companyName={(r.endCustomer ?? r.company).name}
                              alreadyRenewed={Boolean(r.renewedBy)}
                            />
                          )}
                          {can.renew && <RenewButton companyProductId={r.id} />}
                        </div>
                      </td>
                    )}
                  </>)}</tr>
                );
              })}
              {renewals.length === 0 && (
                <tr>
                  <td colSpan={cols.count} className="px-4 py-8 text-center text-subtle">
                    No subscriptions with an expiry date match this filter.
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
