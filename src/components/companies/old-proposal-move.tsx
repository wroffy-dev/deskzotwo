"use client";

import { useState, useTransition } from "react";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import { moveOldProposalTo } from "@/actions/old-proposals";
import { searchCompanyOptions } from "@/actions/company-options";
import { Button } from "@/components/ui/button";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { companyPath } from "@/lib/record-links";

/** Moves an old proposal to the company it was for — the super admin's (src/lib/old-proposals/run.ts `moveOldProposal`). */
export function MoveOldProposal({ proposalId, companyId, madeFor, offerOwn }: { proposalId: string; companyId: string; madeFor: string; offerOwn: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<CompanyComboOption | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ seq: number; name: string } | null>(null);
  const move = (to: string | null) =>
    start(async () => {
      setError(null);
      try {
        const r = await moveOldProposalTo(proposalId, to);
        if (!r.ok) return setError(r.error);
        setDone(r.data);
        router.refresh();
      } catch {
        setError("It didn't go through. Try again.");
      }
    });
  if (done)
    return (
      <p className="text-xs text-muted">
        Moved to{" "}
        <CompanyLink href={`${companyPath(done.seq)}?tab=archive`} className="text-brand hover:underline">
          {done.name}
        </CompanyLink>
        .
      </p>
    );
  if (!open)
    return (
      <button type="button" className="text-xs text-muted hover:text-text hover:underline" onClick={() => setOpen(true)}>
        Wrong company? Move it
      </button>
    );
  return (
    <div className="space-y-2 rounded-lg border border-line p-2">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-60">
          <CompanyCombobox companies={picked ? [picked] : []} value={picked?.id ?? ""} onSelect={(c) => setPicked(c && c.id !== companyId ? c : null)} search={(q) => searchCompanyOptions(q)} placeholder="Search the company it was for…" />
        </div>
        <Button type="button" size="sm" disabled={!picked || pending} onClick={() => picked && move(picked.id)}>
          {pending ? "Moving…" : "Move"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {offerOwn && (
        <button type="button" className="text-xs text-brand hover:underline disabled:opacity-50" disabled={pending} onClick={() => move(null)}>
          Or put it on its own company, {madeFor}
        </button>
      )}
      <p className="text-xs text-muted">Its files go with it, and the contact the import added for it if nothing else uses them.</p>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
