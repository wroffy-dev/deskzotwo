"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import type { workbookFilterOptions } from "@/actions/workspace";
import type { listAudiences } from "@/actions/marketing";
import { previewAudience, saveAudience } from "@/actions/marketing";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { FilterBuilder } from "@/components/workspace/filter-builder";
import { parseContactFilters, type ContactFilters } from "@/lib/marketing/audience";
import type { WorkbookFilters } from "@/lib/workspace/filters";
import type { SmartListChoice } from "@/lib/marketing/smart-list-audience";

type Audience = Awaited<ReturnType<typeof listAudiences>>[number];
type Options = Awaited<ReturnType<typeof workbookFilterOptions>>;

const DESIGNATIONS = ["IT_MANAGER", "PURCHASE_MANAGER", "IT_HEAD", "DIRECTOR", "CEO", "CIO", "HR", "OTHER"];

/**
 * Building a list.
 *
 * The company half is the very same `FilterBuilder` the calling workspace uses — one list builder,
 * one place it can be wrong, and the reseller exclusion it applies is inherited rather than
 * reimplemented. The contact half is the part marketing needs and calling does not: *which people*
 * at each company, and how many of them.
 */
export function AudienceEditor({ audience, options, smartLists = [] }: { audience?: Audience; options: Options; smartLists?: SmartListChoice[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<{ sendable: number; suppressed: number; toCheck: number } | null>(null);

  const [name, setName] = useState(audience?.name ?? "");
  const [description, setDescription] = useState(audience?.description ?? "");
  const [companyFilters, setCompanyFilters] = useState<WorkbookFilters>(
    (audience?.companyFilters ?? {}) as WorkbookFilters,
  );
  const [contactFilters, setContactFilters] = useState<ContactFilters>(parseContactFilters(audience?.contactFilters));
  // A Smart List to follow instead of filters here (owner, 16 Nov 2026) — src/lib/marketing/smart-list-audience.ts.
  const [smartListId, setSmartListId] = useState(audience?.smartList?.id ?? "");
  const followed = smartLists.find((l) => l.id === smartListId) ?? audience?.smartList ?? null;

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        {audience ? "Edit" : <><Plus className="mr-1.5 h-3.5 w-3.5" />New audience</>}
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title={audience ? "Edit audience" : "New audience"}>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="aname">Name</Label>
            <Input
              id="aname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Customers with a renewal inside 90 days"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="adesc">What it&apos;s for</Label>
            <Input
              id="adesc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional — so it still makes sense in three months."
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="asmart">Which companies</Label>
            <Select
              id="asmart"
              value={smartListId}
              onChange={(e) => {
                setCount(null);
                setSmartListId(e.target.value);
              }}
            >
              <option value="">Pick them with filters, below</option>
              {smartLists.length > 0 && (
                <optgroup label="Or follow a Smart List">
                  {smartLists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                      {l.calling ? " (calling activity)" : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              {/* A list that has gone from the choices (made private by its owner) still shows as followed. */}
              {smartListId && !smartLists.some((l) => l.id === smartListId) && followed && <option value={smartListId}>{followed.name}</option>}
            </Select>
          </div>

          {smartListId ? (
            <Card className="bg-surface-sunken px-3 py-2.5 text-xs text-muted">
              The companies on the Smart List <span className="font-medium text-text">{followed?.name ?? "chosen"}</span>, as
              its filters say today. Change the list and this audience changes with it.
            </Card>
          ) : (
            <FilterBuilder
              filters={companyFilters}
              onChange={(update) => {
                setCount(null);
                setCompanyFilters((previous) => update(previous));
              }}
              options={options}
            />
          )}

          <Card className="space-y-3 px-3 py-3">
            <p className="text-sm font-medium text-text">Who at each company</p>
            <p className="text-xs text-muted">
              A renewal notice goes to whoever signs off the spend, not to all eleven contacts on the account —
              mailing all eleven is how a company becomes the one everybody filters.
            </p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="adesig">Job titles</Label>
                <Select
                  id="adesig"
                  value={contactFilters.designation?.[0] ?? ""}
                  onChange={(e) => {
                    setCount(null);
                    setContactFilters((f) => ({ ...f, designation: e.target.value ? [e.target.value] : [] }));
                  }}
                >
                  <option value="">Anybody</option>
                  {DESIGNATIONS.map((d) => (
                    <option key={d} value={d}>
                      {d.toLowerCase().replaceAll("_", " ")}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="acap">At most, per company</Label>
                <Input
                  id="acap"
                  type="number"
                  min={0}
                  value={String(contactFilters.maxPerCompany ?? 2)}
                  onChange={(e) => {
                    setCount(null);
                    setContactFilters((f) => ({ ...f, maxPerCompany: Number(e.target.value) }));
                  }}
                />
                <p className="text-xs text-subtle">The primary contact is always kept first. 0 means no limit.</p>
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={contactFilters.primaryOnly ?? false}
                onChange={(e) => {
                  setCount(null);
                  setContactFilters((f) => ({ ...f, primaryOnly: e.target.checked }));
                }}
                className="mt-0.5 h-4 w-4 accent-brand"
              />
              <span className="text-sm text-text">Primary contact only</span>
            </label>

            {/* By what they've done with our email (owner, 1 Nov 2026 — src/lib/marketing/audience.ts ENGAGEMENT). */}
            <label className="flex items-center gap-2.5 text-sm text-text">
              Engagement
              <select
                value={contactFilters.engagement ?? ""}
                onChange={(e) => {
                  setCount(null);
                  setContactFilters((f) => ({ ...f, engagement: (e.target.value || null) as "active" | "inactive" | null }));
                }}
                className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm"
              >
                <option value="">Everybody</option>
                <option value="active">Opened or clicked in the last 90 days</option>
                <option value="inactive">Gone quiet — sent 3+ in 180 days, opened none</option>
              </select>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={contactFilters.verifiedOnly !== false}
                onChange={(e) => {
                  setCount(null);
                  setContactFilters((f) => ({ ...f, verifiedOnly: e.target.checked }));
                }}
                className="mt-0.5 h-4 w-4 accent-brand"
              />
              <span>
                <span className="block text-sm text-text">Only verified addresses</span>
                <span className="block text-xs text-subtle">
                  Protects the sending domain, at the cost of missing people nobody has got round to checking.
                </span>
              </span>
            </label>
          </Card>

          {count && (
            <Card className="bg-surface-sunken px-3 py-2.5 text-sm">
              <span className="font-semibold tabular-nums text-text">{count.sendable}</span> would receive it;{" "}
              <span className="tabular-nums text-muted">{count.suppressed}</span> would not
              {count.toCheck > 0 && <>, and {count.toCheck} more once their addresses are checked when it&apos;s sent</>}. Open the
              audience afterwards to see why.
            </Card>
          )}

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending || !name.trim()}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await saveAudience({
                    id: audience?.id,
                    name,
                    description,
                    companyFilters,
                    contactFilters,
                    smartListId: smartListId || null,
                  });
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setOpen(false);
                  router.refresh();
                });
              }}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                startTransition(async () => {
                  const result = await previewAudience({ companyFilters, contactFilters, smartListId: smartListId || null });
                  if (result) setCount({ sendable: result.sendable, suppressed: result.suppressed, toCheck: result.toCheck });
                });
              }}
            >
              Who&apos;d get this?
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
