"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteLead } from "@/actions/super-admin-delete";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/** Deleting a lead — offered to the workspace's super admin alone (src/actions/super-admin-delete.ts). */
export function DeleteLeadButton({ leadId, label, iconOnly = false }: { leadId: string; label: string; /** A bin alone, its name on hover — the lead page's header. */ iconOnly?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await deleteLead(leadId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.push("/leads");
      router.refresh();
    });
  }

  return (
    <>
      {iconOnly ? (
        <Button type="button" variant="ghost" size="icon" className="text-danger hover:bg-danger-bg" onClick={() => setOpen(true)} title={`Delete ${label}`} aria-label={`Delete ${label}`}>
          <Trash2 className="h-4 w-4" />
        </Button>
      ) : (
        <Button type="button" variant="ghost" className="text-danger" onClick={() => setOpen(true)}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Delete
        </Button>
      )}
      <Dialog open={open} onClose={() => !pending && setOpen(false)} title={`Delete ${label}?`}>
        <div className="space-y-4 text-sm">
          <p className="text-text">This can&apos;t be undone. Its activities, tasks, requirements, proposals and notes go with it.</p>
          <p className="text-muted">
            Quotations, calls, visits, expenses and bookings raised from it stay, no longer linked to a lead. The deletion is written to the audit log.
          </p>
          {error && <p className="text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" variant="danger" disabled={pending} onClick={confirm}>
              {pending ? "Deleting…" : "Delete lead"}
            </Button>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
