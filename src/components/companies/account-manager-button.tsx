"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserRound } from "lucide-react";
import { setCompanyOwner } from "@/actions/company";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/search-select";
import { Dialog } from "@/components/ui/dialog";
import { PersonChip } from "@/components/companies/person-chip";

type Owner = { id: string; name: string; photoUpdatedAt?: Date | string | null } | null;
/** `takes`: what a department may be given (src/lib/companies/assign-teams.ts) — absent, anyone. */
type AssignableUser = { id: string; name: string; role: string; takes?: { accountManager: boolean } };

export function AccountManagerButton({
  companyId,
  owner,
  users,
  canChange,
  canUnassign,
}: {
  companyId: string;
  owner: Owner;
  users: AssignableUser[];
  /** From `src/lib/authz/reassign.ts`, decided on the server — without it this is a label, not a button. */
  canChange: boolean;
  /** Only a reassigner may leave it with nobody; somebody handing off their own must name a colleague. */
  canUnassign: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(owner?.id ?? "");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    setSelected(owner?.id ?? "");
    setOpen(true);
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await setCompanyOwner(companyId, selected || null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  // Shown as a plain label to somebody who may not change it — a button that only ever refuses is
  // worse than no button.
  if (!canChange) {
    return (
      <PersonChip icon={UserRound} label="Account manager" person={owner} title={owner ? `Account manager: ${owner.name}` : "No account manager"} empty="No account manager" muted />
    );
  }

  return (
    <>
      <PersonChip
        icon={UserRound} label="Account manager"
        person={owner}
        title={owner ? `Account manager: ${owner.name} — change` : "Assign an account manager"}
        empty="Assign account manager"
        onClick={openDialog}
      />

      <Dialog open={open} onClose={() => setOpen(false)} title="Account manager">
        <div className="space-y-3">
          {error && <p className="text-xs text-danger">{error}</p>}
          <SearchSelect aria-label="Account manager" searchPlaceholder="Search people…" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {canUnassign && <option value="">Unassigned</option>}
            {users.filter((u) => u.takes?.accountManager !== false || u.id === owner?.id).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role})
              </option>
            ))}
          </SearchSelect>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={handleSave} disabled={isPending}>
              {isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
