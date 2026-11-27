"use client";

import { useState, useTransition } from "react";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import type { ResellerOnboardingStatus, ResellerTier } from "@prisma/client";
import { bulkUpdateResellers } from "@/actions/reseller";
import {
  resellerStatusValues,
  resellerStatusLabels,
  resellerTierValues,
  resellerTierLabels,
} from "@/lib/reseller-onboarding";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { useClock } from "@/components/time/clock-provider";
import { companyPath } from "@/lib/record-links";
import { useColumns, ColumnsTable } from "@/components/ui/table-columns";
import { Ago } from "@/components/ui/ago";

const STATUS_TONE: Record<ResellerOnboardingStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  ONBOARDING: "amber",
  ACTIVE: "green",
  SUSPENDED: "red",
  INACTIVE: "default",
};

type ResellerRow = {
  id: string;
  companySeq: number;
  name: string;
  source: string;
  createdAt: string | Date;
  resellerProfile: { status: ResellerOnboardingStatus; tier: ResellerTier | null } | null;
  _count: { contacts: number; products: number; endCustomers: number };
  owner: { id: string; name: string } | null;
  assignedTo?: { id: string; name: string } | null;
  industry?: { id: string; name: string } | null;
  locations?: { city: string | null; state: string | null; gstNumber: string | null }[];
  /** Read by the page only when its column is shown (src/lib/tables/list-extras.ts). */
  renewalManager?: { id: string; name: string; own: boolean } | null;
  lastActivityAt?: string | null;
};

export function ResellersTable({ resellers }: { resellers: ResellerRow[] }) {
  const router = useRouter();
  const clock = useClock();
  const selection = useRowSelection(resellers);
  const cols = useColumns("resellers");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [tier, setTier] = useState("");

  function apply() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkUpdateResellers({ companyIds: selection.ids, status, tier });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { count, blocked } = result.data;
      setNotice(`Updated ${count} reseller(s).`);
      if (blocked.length > 0) {
        setError(`Couldn't activate ${blocked.join(", ")} — their onboarding isn't complete.`);
      }
      setStatus("");
      setTier("");
      selection.clear();
      router.refresh();
    });
  }

  return (
    <div>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
        {/* The bulk bar has no room for captions; the first option is a prompt, not a name. */}
        <Select
          aria-label="Onboarding status for the selected resellers"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 w-48"
        >
          <option value="">Status — no change</option>
          {resellerStatusValues.map((s) => (
            <option key={s} value={s}>
              {resellerStatusLabels[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Tier for the selected resellers"
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          className="h-9 w-44"
        >
          <option value="">Tier — no change</option>
          {resellerTierValues.map((t) => (
            <option key={t} value={t}>
              {resellerTierLabels[t]}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={isPending || (!status && !tier)} onClick={apply}>
          {isPending ? "Applying…" : "Apply"}
        </Button>
      </BulkBar>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <ColumnsTable columns={cols} className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>{cols.arrange(<>
                {cols.show("select") && (
                  <th data-col="select" className="w-10 px-4 py-2.5">
                    <Checkbox checked={selection.allSelected} onChange={selection.toggleAll} aria-label="Select all resellers on this page" />
                  </th>
                )}
                {cols.show("reseller") && <th data-col="reseller" className="px-4 py-2.5">Reseller</th>}
                {cols.show("onboarding") && <th data-col="onboarding" className="px-4 py-2.5">Onboarding</th>}
                {cols.show("tier") && <th data-col="tier" className="px-4 py-2.5">Tier</th>}
                {cols.show("endCustomers") && <th data-col="endCustomers" className="px-4 py-2.5">End customers</th>}
                {cols.show("orders") && <th data-col="orders" className="px-4 py-2.5">Orders</th>}
                {cols.show("contacts") && <th data-col="contacts" className="px-4 py-2.5">Contacts</th>}
                {cols.show("source") && <th data-col="source" className="px-4 py-2.5">Source</th>}
                {cols.show("accountManager") && <th data-col="accountManager" className="px-4 py-2.5">Account manager</th>}
                {cols.show("assigned") && <th data-col="assigned" className="px-4 py-2.5">Caller</th>}
                {cols.show("renewalManager") && <th data-col="renewalManager" className="px-4 py-2.5">Renewal manager</th>}
                {cols.show("place") && <th data-col="place" className="px-4 py-2.5">City / State</th>}
                {cols.show("gstin") && <th data-col="gstin" className="px-4 py-2.5">GSTIN</th>}
                {cols.show("industry") && <th data-col="industry" className="px-4 py-2.5">Industry</th>}
                {cols.show("lastActivity") && <th data-col="lastActivity" className="px-4 py-2.5">Last activity</th>}
                {cols.show("addedOn") && <th data-col="addedOn" className="px-4 py-2.5">Added on</th>}
              </>)}</tr>
            </thead>
            <tbody>
              {resellers.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">{cols.arrange(<>
                  {cols.show("select") && (
                    <td data-col="select" className="px-4 py-2.5">
                      <Checkbox checked={selection.isSelected(r.id)} onChange={() => selection.toggle(r.id)} aria-label={`Select ${r.name}`} />
                    </td>
                  )}
                  {cols.show("reseller") && (
                    <td data-col="reseller" className="px-4 py-2.5">
                      <CompanyLink href={companyPath(r.companySeq)} className="font-medium text-text hover:underline">
                        {r.name}
                      </CompanyLink>
                    </td>
                  )}
                  {cols.show("onboarding") && (
                    <td data-col="onboarding" className="px-4 py-2.5">
                      {r.resellerProfile ? (
                        <Badge tone={STATUS_TONE[r.resellerProfile.status]}>{resellerStatusLabels[r.resellerProfile.status]}</Badge>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </td>
                  )}
                  {cols.show("tier") && (
                    <td data-col="tier" className="px-4 py-2.5 text-muted">{r.resellerProfile?.tier ? resellerTierLabels[r.resellerProfile.tier] : "—"}</td>
                  )}
                  {cols.show("endCustomers") && (
                    <td data-col="endCustomers" className="px-4 py-2.5">
                      {r._count.endCustomers > 0 ? <Badge tone="blue">{r._count.endCustomers}</Badge> : <span className="text-subtle">None yet</span>}
                    </td>
                  )}
                  {cols.show("orders") && <td data-col="orders" className="px-4 py-2.5 text-muted">{r._count.products}</td>}
                  {cols.show("contacts") && <td data-col="contacts" className="px-4 py-2.5 text-muted">{r._count.contacts}</td>}
                  {cols.show("source") && <td data-col="source" className="px-4 py-2.5 text-muted">{r.source}</td>}
                  {cols.show("accountManager") && <td data-col="accountManager" className="px-4 py-2.5 text-muted">{r.owner?.name ?? "—"}</td>}
                  {cols.show("assigned") && <td data-col="assigned" className="px-4 py-2.5 text-muted">{r.assignedTo?.name ?? "—"}</td>}
                  {cols.show("renewalManager") && (
                    <td data-col="renewalManager" className="px-4 py-2.5 text-muted">
                      {r.renewalManager?.own ? r.renewalManager.name : <span className="text-subtle">Account manager</span>}
                    </td>
                  )}
                  {cols.show("place") && (
                    <td data-col="place" className="px-4 py-2.5 text-muted">{[r.locations?.[0]?.city, r.locations?.[0]?.state].filter(Boolean).join(", ") || "—"}</td>
                  )}
                  {cols.show("gstin") && <td data-col="gstin" className="px-4 py-2.5 font-mono text-xs text-muted">{r.locations?.[0]?.gstNumber || "—"}</td>}
                  {cols.show("industry") && <td data-col="industry" className="px-4 py-2.5 text-muted">{r.industry?.name ?? "—"}</td>}
                  {cols.show("lastActivity") && (
                    <td data-col="lastActivity" className="whitespace-nowrap px-4 py-2.5 text-muted">
                      <Ago at={r.lastActivityAt} />
                    </td>
                  )}
                  {cols.show("addedOn") && <td data-col="addedOn" className="px-4 py-2.5 text-muted">{clock.date(r.createdAt)}</td>}
                </>)}</tr>
              ))}
              {resellers.length === 0 && (
                <tr>
                  <td colSpan={cols.count} className="px-4 py-8 text-center text-subtle">
                    No resellers yet.
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
