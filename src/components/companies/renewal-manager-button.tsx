"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { setCompanyRenewalManager } from "@/actions/company";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/search-select";
import { Dialog } from "@/components/ui/dialog";
import { PersonChip, type ChipPerson } from "@/components/companies/person-chip";

/** `takes`: what a department may be given (src/lib/companies/assign-teams.ts) — absent, anyone. */
type Person = { id: string; name: string; role: string; takes?: { renewalManager: boolean } };

/**
 * Who looks after a customer's renewals (owner, 30 Oct 2026), beside its account manager: somebody of its own, or the
 * account manager — which is what empty means. The same rule as the account manager decides who may change it.
 */
export function RenewalManagerButton({
  companyId,
  manager,
  accountManager = null,
  users,
  canChange,
}: {
  companyId: string;
  /** Its own renewal manager; null when the account manager looks after its renewals. */
  manager: ChipPerson | null;
  /** The account manager, who looks after its renewals when it has no renewal manager of its own. */
  accountManager?: ChipPerson | null;
  users: Person[];
  canChange: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(manager?.id ?? "");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const label = manager
    ? `Renewal manager: ${manager.name}`
    : accountManager
      ? `Renewals: the account manager, ${accountManager.name}`
      : "Renewals: the account manager";
  // Its own renewal manager's photo; else the account manager's, faded — standing in.
  const shown = manager ?? accountManager;

  if (!canChange) {
    return (
      <PersonChip icon={RefreshCw} label="Renewals" person={shown} standIn={!manager} title={label} empty="Renewals: account manager" muted />
    );
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await setCompanyRenewalManager(companyId, selected || null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <PersonChip
        icon={RefreshCw} label="Renewals"
        person={shown}
        standIn={!manager}
        title={`${label} — change`}
        empty="Renewals: account manager"
        onClick={() => (setError(null), setSelected(manager?.id ?? ""), setOpen(true))}
      />

      <Dialog open={open} onClose={() => setOpen(false)} title="Renewal manager">
        <div className="space-y-3">
          <p className="text-xs text-muted">Who looks after this customer&apos;s renewals. Left to the account manager, they follow whoever that is.</p>
          {error && <p className="text-xs text-danger">{error}</p>}
          <SearchSelect aria-label="Renewal manager" searchPlaceholder="Search people…" value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">The account manager</option>
            {users.filter((u) => u.takes?.renewalManager !== false || u.id === manager?.id).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role})
              </option>
            ))}
          </SearchSelect>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={save} disabled={isPending}>
              {isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
