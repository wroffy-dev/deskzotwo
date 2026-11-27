"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { Button } from "@/components/ui/button";
import { searchCompanyOptions } from "@/actions/company-options";
import { leaveCompanyGroup, linkCompanyGroup } from "@/actions/company-group";

/** Links another company into this one's customer group, by search and select; or takes this one out. */
export function CompanyGroupControls({ companyId, inGroup, memberIds }: { companyId: string; inGroup: boolean; memberIds: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<CompanyComboOption | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setError(null);
    start(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      after?.();
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <CompanyCombobox
            companies={picked ? [picked] : []}
            value={picked?.id ?? ""}
            onSelect={(c) => setPicked(c && !memberIds.includes(c.id) && c.id !== companyId ? c : null)}
            search={(q) => searchCompanyOptions(q, { side: "customer" })}
            placeholder={inGroup ? "Add another company to the group…" : "Search the other company…"}
          />
        </div>
        <Button size="sm" disabled={!picked || pending} onClick={() => picked && run(() => linkCompanyGroup(companyId, picked.id), () => setPicked(null))}>
          {pending ? "Linking…" : "Link"}
        </Button>
      </div>
      {inGroup &&
        (confirmLeave ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>Take this company out of the group? What its payments already settled stays settled.</span>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => leaveCompanyGroup(companyId), () => setConfirmLeave(false))}>
              Take it out
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmLeave(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <button type="button" className="text-xs text-muted hover:text-text hover:underline" onClick={() => setConfirmLeave(true)}>
            Take this company out of the group
          </button>
        ))}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
