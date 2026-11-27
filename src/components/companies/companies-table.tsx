"use client";

import { useState, useTransition } from "react";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import type { CompanyStage, CompanyRelationshipType, VendorStatus } from "@prisma/client";
import { bulkUpdateCompanies } from "@/actions/company";
import { bulkDeleteVendors } from "@/actions/company-delete";
import { relationshipTypeLabels, vendorStatusLabels, vendorStatusValues } from "@/lib/validation/company";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { useColumns, ColumnsTable } from "@/components/ui/table-columns";
import { Ago } from "@/components/ui/ago";
import { formatCompanyId } from "@/lib/order-id";
import { companyPath } from "@/lib/record-links";
import { PORTAL_STATE_LABEL, type PortalState } from "@/lib/portal/state-labels";
import { CategoryIcon } from "@/components/customers/category-chip";
import type { CategoryWithParent } from "@/lib/customers/categories";
import { CustomFieldBodyCells, CustomFieldHeaderCells, type CustomColumn } from "@/components/custom-fields/custom-field-cells";
import { useWording } from "@/components/terms/wording-provider";
import { slot, type Wording } from "@/lib/terms/dictionary";
import { HistoryValue } from "@/components/customers/customer-history";
import { HISTORY_COLUMNS } from "@/lib/customers/history-columns";
import type { CustomerHistory } from "@/lib/customers/stats";
import type { ElsewhereSummary } from "@/lib/tables/list-extras";
import { formatCalendarDay } from "@/lib/time/zone";

const STAGE_TONE: Record<CompanyStage, "default" | "green" | "blue" | "red" | "amber"> = {
  PROSPECT: "default",
  LEAD: "blue",
  CUSTOMER: "green",
  DISQUALIFIED: "red",
};

const VENDOR_STATUS_TONE: Record<VendorStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  ONBOARDING: "amber",
  ACTIVE: "green",
  INACTIVE: "default",
};

type CompanyRow = {
  id: string;
  /** The short reference people quote — COM-000123. `id` is a cuid, which nobody can read out. */
  companySeq: number;
  name: string;
  stage: CompanyStage;
  relationshipType: CompanyRelationshipType;
  vendorStatus?: VendorStatus | null;
  source: string;
  createdAt: string | Date;
  _count: { contacts: number; leads: number; products?: number };
  owner: { id: string; name: string } | null;
  createdBy: { id: string; name: string };
  assignedTo: { id: string; name: string } | null;
  industry?: { id: string; name: string } | null;
  /** Its head office — the City / State and GSTIN columns. */
  locations?: { city: string | null; state: string | null; gstNumber: string | null }[];
  /** Read by the page only when its column is shown (src/lib/tables/list-extras.ts); undefined when it isn't. */
  renewalManager?: { id: string; name: string; own: boolean } | null;
  lastActivityAt?: string | null;
  /** Its history with us and loyalty tier (owner, 31 Oct 2026 — src/lib/customers/stats.ts): null for none or not migrated. */
  history?: CustomerHistory | null;
  /** What it uses that it didn't buy from us (src/lib/tables/list-extras.ts elsewhereOfCompanies): null for nothing noted. */
  elsewhere?: ElsewhereSummary | null;
  /** Where the customer sits — its icon goes beside the name. Absent on the vendor lists. */
  customerCategory?: CategoryWithParent | null;
  /**
   * Resolved by the page, not here.
   *
   * It depends on the global portal settings, and a client component asking the server per row is
   * fifty round trips to paint one column. Absent means "this list did not ask", and the column is
   * then never drawn — see the guards below.
   */
  portal?: PortalState | null;
};

/** A won deal (`stage: "CUSTOMER"`) only counts as a real Customer once it has at least one order on file — otherwise it's a closed deal still awaiting its first order to be punched in. */
function stageDisplay(c: CompanyRow, w: Wording): { label: string; tone: "default" | "green" | "blue" | "red" | "amber" } {
  if (c.stage === "CUSTOMER" && (c._count.products ?? 0) === 0) {
    return { label: slot(w, "Awaiting Order", "order", "Awaiting {one}"), tone: "amber" };
  }
  return { label: c.stage, tone: STAGE_TONE[c.stage] };
}

/** `takes`: what a department may be given (src/lib/companies/assign-teams.ts) — absent, anyone. */
type AssignableUser = { id: string; name: string; role: string; takes?: { caller: boolean; accountManager: boolean } };

export function CompaniesTable({
  companies,
  assignableUsers,
  mode = "companies",
  reassign,
  customColumns = { columns: [], texts: {} },
  canSeeOrders = true,
  canSeeLeads = true,
  canDeleteVendors = false,
}: {
  companies: CompanyRow[];
  assignableUsers: AssignableUser[];
  /** Whether this person may change callers at all, and leave them with nobody — see src/lib/authz/reassign.ts. */
  reassign: { show: boolean; canUnassign: boolean };
  mode?: "companies" | "vendors" | "customers" | "commission-parties";
  /**
   * The workspace's own fields this person may see (src/lib/custom-fields/server.ts `listColumns`),
   * after the registered columns: the ones they show in the column picker, or each field's default.
   */
  customColumns?: { columns: CustomColumn[]; texts: Record<string, Record<string, string>> };
  /** Holds "View orders": Customers counts each one's orders, which is order data (owner, 8 Oct 2026). */
  canSeeOrders?: boolean;
  /** Leads in the plan and theirs to see (owner, 14 Oct 2026) — otherwise no Leads column to count them. */
  canSeeLeads?: boolean;
  /** On Vendors, for the super admin or "Delete vendors" (owner, 28 Oct 2026): the ticked ones deleted together. */
  canDeleteVendors?: boolean;
}) {
  const router = useRouter();
  const w = useWording();
  const selection = useRowSelection(companies);
  const [assignTo, setAssignTo] = useState("");
  const [managerTo, setManagerTo] = useState("");
  const [vendorStatus, setVendorStatus] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The first press only asks.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const hasOnboardingStatusColumn = mode === "vendors" || mode === "commission-parties";
  // Keyed on the mode, so each of the four lists this component renders remembers its own
  // columns. They are not the same table: Customers has no Leads column and counts orders where
  // the sourcing pool shows pipeline stage, so one shared preference would put a Leads entry in a
  // picker on a screen that has none.
  const cols = useColumns(mode);
  // On Customers the status column is the order count — not there for somebody who can't see orders.
  const statusAllowed = mode !== "customers" || canSeeOrders;
  // No adjustment needed: `leads` is simply absent from every registry but Companies, so
  // `cols.show("leads")` is already false elsewhere and the count is already right.
  /**
   * Whether this list computed portal state at all.
   *
   * Companies, Customers and Vendors share this component but not their queries — only the pages
   * that ask for it pass it through. Without this the column would be drawn full of dashes on the
   * lists that never looked.
   */
  const hasPortalData = companies.some((c) => c.portal !== undefined);
  // The empty-state colspan has to match what is actually drawn, not what the registry allows.
  // Its history with us is order and invoice data: only for somebody who can see orders (owner, 31 Oct 2026).
  const historyAllowed = canSeeOrders;
  const hiddenHistory = historyAllowed ? 0 : HISTORY_COLUMNS.filter((k) => cols.show(k)).length;
  const columnCount = cols.count - (cols.show("portal") && !hasPortalData ? 1 : 0) - (cols.show("leads") && !canSeeLeads ? 1 : 0) - hiddenHistory;
  // The fields this person shows, worked out once: the header and every row draw this one list.
  const fieldColumns = customColumns.columns.filter((c) => cols.showCustom(c.key, c.default));
  const emptyText =
    mode === "vendors"
      ? slot(w, "No vendors yet.", "vendor", "No {many:lower} yet.")
      : mode === "commission-parties"
        ? "No commission parties yet."
        : mode === "customers"
          ? slot(w, "No customers yet.", "customer", "No {many:lower} yet.")
          : slot(w, "No companies yet.", "company", "No {many:lower} yet.");
  // "Caller" (lead generation) only makes sense for Companies/Customer — Vendors/Commission Parties
  // keep the generic "Assigned to" wording, since that assignment isn't about calling to generate a sales lead.
  const assignedColumnLabel = hasOnboardingStatusColumn ? "Assigned to" : "Caller";
  const assignActionLabel = hasOnboardingStatusColumn ? "Assign to…" : "Assign caller…";

  const addTags = tagInput
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const hasChanges = !!assignTo || !!managerTo || !!vendorStatus || addTags.length > 0;

  function apply() {
    if (!hasChanges || selection.count === 0) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkUpdateCompanies({
        companyIds: selection.ids,
        assignedToUserId: assignTo,
        ownerUserId: managerTo,
        vendorStatus,
        addTags,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`Updated ${result.data.count} record(s).`);
      selection.clear();
      setAssignTo("");
      setManagerTo("");
      setVendorStatus("");
      setTagInput("");
      router.refresh();
    });
  }

  function removeTicked() {
    if (selection.count === 0) return;
    if (!confirmingDelete) return setConfirmingDelete(true);
    setConfirmingDelete(false);
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkDeleteVendors(selection.ids);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const kept = result.data.kept;
      const shown = kept.slice(0, 5).map((k) => `${k.name}: ${k.why}`).join(" ");
      setNotice(`Deleted ${result.data.deleted}.${kept.length ? ` Kept ${kept.length} with history — ${shown}${kept.length > 5 ? " …" : ""}` : ""}`);
      selection.clear();
      router.refresh();
    });
  }

  return (
    <div>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
        {/* The bulk bar has no room for captions — each control's own placeholder or first option is
            the only wording on screen, so the name has to be carried on the control itself. */}
        {/* Only for somebody who may change callers — a picker that only ever refuses is worse than none. */}
        {reassign.show && (
          <SearchSelect
            value={assignTo}
            onChange={(e) => setAssignTo(e.target.value)}
            aria-label={slot(w, "Assign selected companies to", "company", "Assign selected {many:lower} to")}
            searchPlaceholder="Search people…"
            className="h-9 w-56"
          >
            <option value="">{assignActionLabel}</option>
            {reassign.canUnassign && <option value="unassign">Unassign</option>}
            {/* A vendor's "assigned to" is its onboarding — the caller rule is a client's. */}
            {assignableUsers.filter((u) => hasOnboardingStatusColumn || u.takes?.caller !== false).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role})
              </option>
            ))}
          </SearchSelect>
        )}
        {/* The account manager too (owner, 30 Oct 2026) — customers and companies, on the same terms as one at a time. */}
        {reassign.show && !hasOnboardingStatusColumn && (
          <SearchSelect
            value={managerTo}
            onChange={(e) => setManagerTo(e.target.value)}
            aria-label="Make an account manager of the selected"
            searchPlaceholder="Search people…"
            className="h-9 w-60"
          >
            <option value="">Assign account manager…</option>
            {reassign.canUnassign && <option value="unassign">No account manager</option>}
            {assignableUsers.filter((u) => u.takes?.accountManager !== false).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role})
              </option>
            ))}
          </SearchSelect>
        )}
        {hasOnboardingStatusColumn && (
          <Select
            value={vendorStatus}
            onChange={(e) => setVendorStatus(e.target.value)}
            aria-label="Set onboarding status"
            className="h-9 w-52"
          >
            <option value="">Onboarding — no change</option>
            {vendorStatusValues.map((v) => (
              <option key={v} value={v}>
                {vendorStatusLabels[v]}
              </option>
            ))}
          </Select>
        )}
        <Input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          placeholder="Add tags (comma separated)"
          aria-label="Add tags (comma separated)"
          className="h-9 w-56"
        />
        <Button size="sm" disabled={!hasChanges || isPending} onClick={apply}>
          {isPending ? "Applying…" : "Apply"}
        </Button>
        {mode === "vendors" && canDeleteVendors && (
          // Only a vendor nothing has happened with goes; the rest stay and are named (src/actions/company-delete.ts).
          <Button size="sm" variant={confirmingDelete ? "danger" : "ghost"} className={confirmingDelete ? "" : "text-danger"} disabled={isPending} onClick={removeTicked} onBlur={() => setConfirmingDelete(false)}>
            {confirmingDelete ? `Delete ${selection.count} — sure?` : "Delete"}
          </Button>
        )}
      </BulkBar>

      <Card className="overflow-hidden">
        <div className="relative overflow-x-auto">
          <ColumnsTable columns={cols} className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>{cols.arrange(<>
                {cols.show("select") && (
                  <th data-col="select" className="w-10 px-4 py-2.5">
                    <Checkbox
                      checked={selection.allSelected}
                      onChange={selection.toggleAll}
                      aria-label="Select all rows on this page"
                    />
                  </th>
                )}
                {cols.show("id") && <th data-col="id" className="px-4 py-2.5">ID</th>}
                {cols.show("company") && <th data-col="company" className="px-4 py-2.5">{slot(w, "Company", "company", "{one}")}</th>}
                {cols.show("status") && statusAllowed &&
                  (hasOnboardingStatusColumn ? (
                    <th data-col="status" className="px-4 py-2.5">Onboarding status</th>
                  ) : mode === "customers" ? (
                    <th data-col="status" className="px-4 py-2.5">{slot(w, "Orders", "order")}</th>
                  ) : (
                    <th data-col="status" className="px-4 py-2.5">Stage</th>
                  ))}
                {cols.show("relationship") && <th data-col="relationship" className="px-4 py-2.5">Relationship</th>}
                {cols.show("source") && <th data-col="source" className="px-4 py-2.5">Source</th>}
                {cols.show("contacts") && <th data-col="contacts" className="px-4 py-2.5">{slot(w, "Contacts", "contact")}</th>}
                {cols.show("leads") && canSeeLeads && <th data-col="leads" className="px-4 py-2.5">{slot(w, "Leads", "lead")}</th>}
                {cols.show("accountManager") && <th data-col="accountManager" className="px-4 py-2.5">Account manager</th>}
                {cols.show("assigned") && <th data-col="assigned" className="px-4 py-2.5">{assignedColumnLabel}</th>}
                {cols.show("renewalManager") && <th data-col="renewalManager" className="px-4 py-2.5">Renewal manager</th>}
                {cols.show("place") && <th data-col="place" className="px-4 py-2.5">City / State</th>}
                {cols.show("gstin") && <th data-col="gstin" className="px-4 py-2.5">GSTIN</th>}
                {cols.show("industry") && <th data-col="industry" className="px-4 py-2.5">Industry</th>}
                {cols.show("lastActivity") && <th data-col="lastActivity" className="px-4 py-2.5">Last activity</th>}
                {cols.show("elsewhere") && <th data-col="elsewhere" className="px-4 py-2.5">Installed elsewhere</th>}
                {cols.show("elsewhereRenewal") && <th data-col="elsewhereRenewal" className="px-4 py-2.5">Next outside renewal</th>}
                {cols.show("customerSince") && historyAllowed && <th data-col="customerSince" className="px-4 py-2.5">Customer since</th>}
                {cols.show("lifetimeValue") && historyAllowed && <th data-col="lifetimeValue" className="px-4 py-2.5 text-right">Lifetime value</th>}
                {cols.show("last12") && historyAllowed && <th data-col="last12" className="px-4 py-2.5 text-right">Last 12 months</th>}
                {cols.show("orderHistory") && historyAllowed && <th data-col="orderHistory" className="px-4 py-2.5">Orders (live)</th>}
                {cols.show("lastPurchase") && historyAllowed && <th data-col="lastPurchase" className="px-4 py-2.5">Last purchase</th>}
                {cols.show("renewalRate") && historyAllowed && <th data-col="renewalRate" className="px-4 py-2.5">Renewal rate</th>}
                {cols.show("paysIn") && historyAllowed && <th data-col="paysIn" className="px-4 py-2.5">Pays in</th>}
                {cols.show("products") && historyAllowed && <th data-col="products" className="px-4 py-2.5">Products</th>}
                {cols.show("loyalty") && historyAllowed && <th data-col="loyalty" className="px-4 py-2.5">Loyalty</th>}
                {cols.show("portal") && hasPortalData && <th data-col="portal" className="px-4 py-2.5">Portal</th>}
                {cols.show("addedBy") && <th data-col="addedBy" className="px-4 py-2.5">Added by</th>}
                {cols.show("addedOn") && <th data-col="addedOn" className="px-4 py-2.5">Added on</th>}
                <CustomFieldHeaderCells columns={fieldColumns} className="px-4 py-2.5" />
              </>)}</tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">{cols.arrange(<>
                  {cols.show("select") && (
                    <td data-col="select" className="px-4 py-2.5">
                      <Checkbox
                        checked={selection.isSelected(c.id)}
                        onChange={() => selection.toggle(c.id)}
                        aria-label={`Select ${c.name}`}
                      />
                    </td>
                  )}
                  {/* One sequence across all four lists, so a customer and a vendor can never
                      carry the same number. */}
                  {cols.show("id") && (
                    <td data-col="id" className="px-4 py-2.5 font-mono text-xs text-muted">{formatCompanyId(c.companySeq)}</td>
                  )}
                  {cols.show("company") && (
                    <td data-col="company" className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <CategoryIcon category={c.customerCategory} />
                        <CompanyLink href={companyPath(c.companySeq)} className="font-medium text-text hover:underline">
                          {c.name}
                        </CompanyLink>
                        {/* Found by a search on Companies (owner, 30 Oct 2026): it has bought, so it's a customer already. */}
                        {mode === "companies" && (c._count.products ?? 0) > 0 && <Badge tone="green">Already a customer</Badge>}
                      </span>
                    </td>
                  )}
                  {cols.show("status") && statusAllowed &&
                    (hasOnboardingStatusColumn ? (
                      <td data-col="status" className="px-4 py-2.5">
                        {c.vendorStatus ? (
                          <Badge tone={VENDOR_STATUS_TONE[c.vendorStatus]}>{vendorStatusLabels[c.vendorStatus]}</Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                    ) : mode === "customers" ? (
                      <td data-col="status" className="px-4 py-2.5 text-muted">{c._count.products ?? 0}</td>
                    ) : (
                      <td data-col="status" className="px-4 py-2.5">
                        <Badge tone={stageDisplay(c, w).tone}>{stageDisplay(c, w).label}</Badge>
                      </td>
                    ))}
                  {cols.show("relationship") && (
                    <td data-col="relationship" className="px-4 py-2.5 text-muted">{relationshipTypeLabels[c.relationshipType]}</td>
                  )}
                  {cols.show("source") && <td data-col="source" className="px-4 py-2.5 text-muted">{c.source}</td>}
                  {cols.show("contacts") && <td data-col="contacts" className="px-4 py-2.5 text-muted">{c._count.contacts}</td>}
                  {cols.show("leads") && canSeeLeads && (
                    <td data-col="leads" className="px-4 py-2.5 text-muted">{c._count.leads}</td>
                  )}
                  {cols.show("accountManager") && <td data-col="accountManager" className="px-4 py-2.5 text-muted">{c.owner?.name ?? "—"}</td>}
                  {cols.show("assigned") && (
                    <td data-col="assigned" className="px-4 py-2.5 text-muted">{c.assignedTo?.name ?? "—"}</td>
                  )}
                  {cols.show("renewalManager") && (
                    <td data-col="renewalManager" className="px-4 py-2.5 text-muted">
                      {c.renewalManager?.own ? c.renewalManager.name : <span className="text-subtle">Account manager</span>}
                    </td>
                  )}
                  {cols.show("place") && (
                    // A masked city and state (src/lib/companies/masking.ts) read "********" once, not twice.
                    <td data-col="place" className="px-4 py-2.5 text-muted">
                      {[c.locations?.[0]?.city, c.locations?.[0]?.state].filter(Boolean).filter((p, i, all) => i === 0 || p !== all[i - 1]).join(", ") || "—"}
                    </td>
                  )}
                  {cols.show("gstin") && <td data-col="gstin" className="px-4 py-2.5 font-mono text-xs text-muted">{c.locations?.[0]?.gstNumber || "—"}</td>}
                  {cols.show("industry") && <td data-col="industry" className="px-4 py-2.5 text-muted">{c.industry?.name ?? "—"}</td>}
                  {cols.show("lastActivity") && (
                    <td data-col="lastActivity" className="whitespace-nowrap px-4 py-2.5 text-muted">
                      <Ago at={c.lastActivityAt} />
                    </td>
                  )}
                  {cols.show("elsewhere") && (
                    <td data-col="elsewhere" className="max-w-72 px-4 py-2.5 text-muted" title={c.elsewhere?.products.join(" · ")}>
                      {c.elsewhere?.products.length ? (
                        <span className="line-clamp-2">
                          {c.elsewhere.products.slice(0, 2).join(", ")}
                          {c.elsewhere.products.length > 2 && <span className="text-subtle"> +{c.elsewhere.products.length - 2} more</span>}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  )}
                  {cols.show("elsewhereRenewal") && (
                    <td data-col="elsewhereRenewal" className="whitespace-nowrap px-4 py-2.5 text-muted">
                      {c.elsewhere?.next ? (
                        <>
                          <span className="text-text">{formatCalendarDay(c.elsewhere.next.on)}</span>
                          <span className="block max-w-48 truncate text-[11px] text-subtle">{c.elsewhere.next.product}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  )}
                  {cols.show("customerSince") && historyAllowed && (
                    <td data-col="customerSince" className="whitespace-nowrap px-4 py-2.5 text-muted"><HistoryValue column="customerSince" history={c.history} /></td>
                  )}
                  {cols.show("lifetimeValue") && historyAllowed && (
                    <td data-col="lifetimeValue" className="whitespace-nowrap px-4 py-2.5 text-right text-text"><HistoryValue column="lifetimeValue" history={c.history} /></td>
                  )}
                  {cols.show("last12") && historyAllowed && (
                    <td data-col="last12" className="whitespace-nowrap px-4 py-2.5 text-right text-muted"><HistoryValue column="last12" history={c.history} /></td>
                  )}
                  {cols.show("orderHistory") && historyAllowed && (
                    <td data-col="orderHistory" className="whitespace-nowrap px-4 py-2.5 text-muted"><HistoryValue column="orderHistory" history={c.history} /></td>
                  )}
                  {cols.show("lastPurchase") && historyAllowed && (
                    <td data-col="lastPurchase" className="whitespace-nowrap px-4 py-2.5 text-muted"><HistoryValue column="lastPurchase" history={c.history} /></td>
                  )}
                  {cols.show("renewalRate") && historyAllowed && (
                    <td data-col="renewalRate" className="whitespace-nowrap px-4 py-2.5 text-muted"><HistoryValue column="renewalRate" history={c.history} /></td>
                  )}
                  {cols.show("paysIn") && historyAllowed && (
                    <td data-col="paysIn" className="whitespace-nowrap px-4 py-2.5 text-muted"><HistoryValue column="paysIn" history={c.history} /></td>
                  )}
                  {cols.show("products") && historyAllowed && (
                    <td data-col="products" className="px-4 py-2.5 text-muted"><HistoryValue column="products" history={c.history} /></td>
                  )}
                  {cols.show("loyalty") && historyAllowed && (
                    <td data-col="loyalty" className="px-4 py-2.5"><HistoryValue column="loyalty" history={c.history} /></td>
                  )}
                  {cols.show("portal") && hasPortalData && (
                    <td data-col="portal" className="px-4 py-2.5">
                      {c.portal ? (
                        <Badge tone={PORTAL_STATE_LABEL[c.portal.kind].tone} title={PORTAL_STATE_LABEL[c.portal.kind].hint}>
                          {c.portal.kind === "on"
                            ? `On · ${c.portal.links}`
                            : PORTAL_STATE_LABEL[c.portal.kind].label}
                        </Badge>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </td>
                  )}
                  {cols.show("addedBy") && <td data-col="addedBy" className="px-4 py-2.5 text-muted">{c.createdBy.name}</td>}
                  {cols.show("addedOn") && (
                    <td data-col="addedOn" className="px-4 py-2.5 text-muted">
                      {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(c.createdAt))}
                    </td>
                  )}
                  <CustomFieldBodyCells columns={fieldColumns} texts={customColumns.texts[c.id]} className="px-4 py-2.5 text-muted" />
                </>)}</tr>
              ))}
              {companies.length === 0 && (
                <tr>
                  <td colSpan={columnCount + fieldColumns.length} className="px-4 py-8 text-center text-subtle">
                    {emptyText}
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
