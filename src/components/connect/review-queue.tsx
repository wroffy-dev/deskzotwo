"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { companyPath } from "@/lib/record-links";
import { toast } from "@/components/ui/toast";
import { acceptCorrection, createFromSuggestion, declineSuggestion, linkSuggestion, type ReviewItem } from "@/actions/connect-review";

/**
 * Guests' suggestions waiting for the workspace (owner, 20 Nov 2026 — Deskzo Connect phase 3): each with what it looks
 * like in Companies — seen only here, never by the guest — and the three ways to decide.
 */
export function ReviewQueue({ items }: { items: ReviewItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error ?? "That didn't work.");
      toast.success(done);
      setDeclining(null);
      setReason("");
      router.refresh();
    });

  if (items.length === 0) return <Card className="p-6 text-sm text-muted">Nothing waiting. Guests&apos; suggestions show up here.</Card>;

  return (
    <ul className="space-y-3">
      {items.map((s) => (
        <li key={s.id}>
          <Card className="space-y-3 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-text">{s.kind === "CORRECTION" ? `Correction to ${s.company?.name ?? "a company"}` : s.name}</span>
                  <Badge tone={s.kind === "CORRECTION" ? "blue" : "amber"}>{s.kind === "CORRECTION" ? "Correction" : "New company"}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  From {s.guest.name} ({s.guest.connection}) for{" "}
                  <Link href={`/smart-lists/${s.list.id}`} className="text-brand hover:underline">
                    {s.list.name}
                  </Link>{" "}
                  · {new Date(s.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                </p>
              </div>
            </div>

            {s.kind === "NEW_COMPANY" && (
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {[
                  ["City", s.city],
                  ["Website", s.website],
                  ["GSTIN", s.gstin],
                  ["They spoke to", s.contactName],
                ]
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <dt className="w-28 shrink-0 text-muted">{k}</dt>
                      <dd className="text-text">{v}</dd>
                    </div>
                  ))}
              </dl>
            )}
            <p className="whitespace-pre-wrap rounded-base bg-surface-sunken px-3 py-2 text-sm text-text">{s.note}</p>

            {s.kind === "NEW_COMPANY" && (
              <div className="rounded-base border border-line p-3">
                <p className="text-xs font-medium text-muted">{s.matches.length ? "Looks like a company you have — only you see this:" : "No company like it in what you can see."}</p>
                <ul className="mt-2 space-y-1.5">
                  {s.matches.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span>
                        <span className="font-medium text-text">{m.name}</span> <span className="text-xs text-muted">· {m.why}</span>
                      </span>
                      <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => linkSuggestion(s.id, m.id), `Linked to ${m.name} and added to the list.`)}>
                        Link and add
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {declining === s.id ? (
              <div className="flex flex-wrap gap-2">
                <Input aria-label="Why not" value={reason} maxLength={300} placeholder="Why not — the guest sees this" onChange={(e) => setReason(e.target.value)} className="min-w-56 flex-1" />
                <Button variant="secondary" onClick={() => setDeclining(null)}>
                  Cancel
                </Button>
                <Button variant="danger" disabled={pending} onClick={() => act(() => declineSuggestion(s.id, reason), "Declined.")}>
                  Decline
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" disabled={pending} onClick={() => setDeclining(s.id)}>
                  {s.kind === "CORRECTION" ? "Not needed" : "Don't add"}
                </Button>
                {s.kind === "CORRECTION" ? (
                  <>
                    {s.company && (
                      <CompanyLink hideWhenShut href={companyPath(s.company.companySeq)}>
                        <Button variant="secondary">Open the company</Button>
                      </CompanyLink>
                    )}
                    <Button disabled={pending} onClick={() => act(() => acceptCorrection(s.id), "Marked as done.")}>
                      Done — I&apos;ve changed it
                    </Button>
                  </>
                ) : (
                  <Button disabled={pending} onClick={() => act(() => createFromSuggestion(s.id), `${s.name} created and added to the list.`)}>
                    Create company and add
                  </Button>
                )}
              </div>
            )}
          </Card>
        </li>
      ))}
    </ul>
  );
}
