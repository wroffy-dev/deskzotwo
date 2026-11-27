"use client";

import { useState, useTransition } from "react";
import { DatabaseZap } from "lucide-react";
import { companyFromWebsite } from "@/actions/enrich-credits";
import { Button } from "@/components/ui/button";
import type { EnrichProvider } from "@/components/companies/apollo-panel";

const NAME: Record<EnrichProvider, string> = { apollo: "Apollo", lusha: "Lusha" };

/**
 * "Fill from website" on a new company's form (owner, 15 Nov 2026): Apollo or Lusha's details for the website typed —
 * name, LinkedIn, industry — into the fields still blank. What's typed stays. A lookup is 1 credit.
 */
export function FillFromWebsite({
  providers,
  website,
  apply,
}: {
  providers: EnrichProvider[];
  website: string;
  /** Hands back what was found; the form fills its blanks and says which. */
  apply: (found: { name: string | null; website: string | null; linkedinUrl: string | null; industry: string | null }) => string[];
}) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (providers.length === 0) return null;

  const run = (p: EnrichProvider) =>
    start(async () => {
      setError(null);
      setNote(null);
      const r = await companyFromWebsite(p === "lusha" ? "LUSHA" : "APOLLO", website);
      if (!r.ok) return setError(r.error);
      const filled = apply({ name: r.data.name, website: r.data.website, linkedinUrl: r.data.linkedinUrl, industry: r.data.industry });
      const extra = [r.data.employees !== null ? `${r.data.employees} employees` : null, r.data.city, r.data.country].filter(Boolean).join(" · ");
      setNote(`${filled.length ? `Filled from ${NAME[p]}: ${filled.join(", ")}.` : `${NAME[p]} found it — nothing blank to fill.`}${extra ? ` ${extra}.` : ""}`);
    });

  return (
    <div className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <DatabaseZap className="h-4 w-4 text-subtle" aria-hidden />
        <span className="text-muted">Type the website below, then</span>
        {providers.map((p) => (
          <Button key={p} type="button" size="sm" variant="secondary" disabled={pending || !website.trim()} onClick={() => run(p)}>
            {pending ? "Looking up…" : `Fill from ${NAME[p]}`}
          </Button>
        ))}
        <span className="text-xs text-subtle">1 credit · only blank fields</span>
      </div>
      {note && <p className="mt-1 text-xs text-success">{note}</p>}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
