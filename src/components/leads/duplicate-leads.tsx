"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import { removeDuplicateLeadCopies } from "@/actions/duplicate-leads";
import type { DuplicateGroup, DuplicateLead, RemoveResult } from "@/lib/leads/duplicates";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { companyPath, leadPath } from "@/lib/record-links";
import { formatLeadId } from "@/lib/order-id";

type Lead = Omit<DuplicateLead, "createdAt"> & { createdAt: string };
type Group = Omit<DuplicateGroup, "keep" | "copies"> & { keep: Lead; copies: Lead[] };

const PAGE = 100;

/** How a copy differs from the lead kept — what's worth a look before it goes. */
function differences(keep: Lead, copy: Lead): string[] {
  const out: string[] = [];
  if ((keep.stage ?? keep.status) !== (copy.stage ?? copy.status)) out.push("stage");
  if ((keep.value ?? "") !== (copy.value ?? "")) out.push("value");
  if ((keep.owner ?? "") !== (copy.owner ?? "")) out.push("owner");
  if (keep.createdAt.slice(0, 10) !== copy.createdAt.slice(0, 10)) out.push("created on");
  return out;
}

/**
 * The review: each group's lead kept and its copies, a copy ticked to start with where it's an exact copy nobody has
 * worked on; a copy somebody has worked on can't be ticked. Two clicks to take the ticked ones away.
 */
export function DuplicateLeads({ groups }: { groups: Group[] }) {
  const router = useRouter();
  const removable = useMemo(() => groups.flatMap((g) => g.copies.filter((c) => c.workedOn.length === 0).map((c) => ({ group: g, copy: c }))), [groups]);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(removable.filter(({ group, copy }) => differences(group.keep, copy).length === 0).map(({ copy }) => copy.id)));
  const [shown, setShown] = useState(PAGE);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<RemoveResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copies = groups.reduce((n, g) => n + g.copies.length, 0);
  const worked = copies - removable.length;

  const toggle = (id: string) => {
    setConfirming(false);
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  function remove() {
    if (!confirming) return setConfirming(true);
    setConfirming(false);
    setError(null);
    startTransition(async () => {
      const done = await removeDuplicateLeadCopies([...ticked]);
      if (!done.ok) return setError(done.error);
      setResult(done.data);
      setTicked(new Set());
      router.refresh();
    });
  }

  if (groups.length === 0) {
    return (
      <Card className="p-6 text-sm text-muted">
        {result ? `${result.removed} duplicate lead(s) taken away. ` : ""}No duplicate leads from an import — nothing to clean up.
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Card className="flex flex-wrap items-center gap-3 p-4 text-sm">
        <span className="text-text">
          {groups.length} lead(s) with copies · {copies} copies · {removable.length} nobody has worked on
          {worked > 0 && <span className="text-warning"> · {worked} worked on (open them)</span>}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => (setConfirming(false), setTicked(new Set(removable.map(({ copy }) => copy.id))))}>
            Tick every copy nobody&apos;s worked on
          </Button>
          <Button size="sm" variant="secondary" onClick={() => (setConfirming(false), setTicked(new Set()))}>
            Untick all
          </Button>
          <Button size="sm" variant={confirming ? "danger" : "primary"} disabled={pending || ticked.size === 0} onClick={remove}>
            {pending ? "Taking away…" : confirming ? `Delete ${ticked.size} lead(s) — sure?` : `Take away ${ticked.size} cop${ticked.size === 1 ? "y" : "ies"}`}
          </Button>
        </span>
        <p className="w-full text-xs text-subtle">
          Ticked to start with: copies identical to the lead kept (stage, value, owner, created on). Untick any that are a real
          second deal. A deleted copy goes with only what is its own, and the audit log says which lead it copied.
        </p>
      </Card>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {result && (
        <Card className="p-4 text-sm">
          <p className="text-success">{result.removed} duplicate lead(s) taken away.</p>
          {result.refused.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-muted">
              {result.refused.slice(0, 20).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {groups.slice(0, shown).map((g) => (
        <Card key={g.key} className="p-0 text-sm">
          <div className="flex flex-wrap items-baseline gap-2 border-b border-line px-4 py-2.5">
            <CompanyLink href={companyPath(g.company.companySeq)} className="font-medium text-text hover:underline">
              {g.company.name}
            </CompanyLink>
            <span className="text-muted">— {g.keep.title}</span>
            {g.contact && <span className="text-subtle">· {g.contact}</span>}
          </div>
          <table className="w-full">
            <tbody>
              {[g.keep, ...g.copies].map((lead, i) => {
                const keep = i === 0;
                const diff = keep ? [] : differences(g.keep, lead);
                const locked = !keep && lead.workedOn.length > 0;
                return (
                  <tr key={lead.id} className="border-b border-line last:border-0">
                    <td className="w-10 px-4 py-2">
                      {!keep && (
                        <input
                          type="checkbox"
                          aria-label={`Take away ${formatLeadId(lead.leadSeq)}`}
                          checked={ticked.has(lead.id)}
                          disabled={locked}
                          onChange={() => toggle(lead.id)}
                        />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">
                      <Link href={leadPath(lead.leadSeq)} className="font-mono text-xs text-brand hover:underline" target="_blank">
                        {formatLeadId(lead.leadSeq)}
                      </Link>
                    </td>
                    <td className="px-2 py-2">{keep ? <Badge tone="green">Kept</Badge> : lead.imported ? <Badge tone="amber">Imported copy</Badge> : <Badge>Copy</Badge>}</td>
                    <td className="px-2 py-2 text-muted">{lead.stage ?? lead.status}</td>
                    <td className="px-2 py-2 text-muted">{lead.owner ?? "Unassigned"}</td>
                    <td className="px-2 py-2 text-muted">{lead.value ?? "—"}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-muted">{lead.createdAt.slice(0, 10)}</td>
                    <td className="px-4 py-2 text-xs">
                      {locked ? (
                        <span className="text-warning">Worked on: {lead.workedOn.join(", ")}</span>
                      ) : diff.length > 0 ? (
                        <span className="text-subtle">Differs: {diff.join(", ")}</span>
                      ) : keep && lead.workedOn.length > 0 ? (
                        <span className="text-subtle">{lead.workedOn.join(", ")}</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ))}
      {shown < groups.length && (
        <Button size="sm" variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, groups.length - shown)} more of {groups.length - shown}
        </Button>
      )}
    </div>
  );
}
