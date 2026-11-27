"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveVerifiableSearch } from "@/actions/verifiable";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/** Whether this workspace has a public search page, and whether it finds by company name (src/lib/verifiable/search.ts). */
export function VerifiableSearchSettings({ searchOn, nameSearch, pageUrl, canChange }: { searchOn: boolean; nameSearch: boolean; pageUrl: string; canChange: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(searchOn);
  const [byName, setByName] = useState(nameSearch);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();
  const changed = on !== searchOn || byName !== nameSearch;
  const save = () =>
    run(async () => {
      setError(null);
      const r = await saveVerifiableSearch({ searchOn: on, nameSearch: byName });
      if (!r.ok) return setError(r.error);
      router.refresh();
    });
  return (
    <Card className="mt-4 space-y-2 px-4 py-3 text-sm">
      <div className="font-medium text-text">Public search page</div>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={on} disabled={!canChange} onChange={(e) => setOn(e.target.checked)} />
        <span>
          Let anybody check a document by its number
          {searchOn && (
            <>
              {" at "}
              <a href={pageUrl} target="_blank" rel="noreferrer" className="break-all text-brand hover:underline">
                {pageUrl}
              </a>
            </>
          )}
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={byName} disabled={!canChange || !on} onChange={(e) => setByName(e.target.checked)} />
        <span>
          Also by company name
          <span className="block text-xs text-subtle">Somebody could learn who your clients are by trying names. Never finds a document issued to a person.</span>
        </span>
      </label>
      {error && <p className="text-danger">{error}</p>}
      {canChange && changed && (
        <Button size="sm" disabled={pending} onClick={save}>
          {pending ? "Saving…" : "Save"}
        </Button>
      )}
    </Card>
  );
}
