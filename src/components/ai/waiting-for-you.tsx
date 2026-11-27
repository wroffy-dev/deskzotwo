"use client";

import { CompanyLink } from "@/components/companies/company-link";
import { Inbox } from "lucide-react";
import type { WaitingForYou } from "@/lib/ai/waiting";
import type { TeammateKey } from "@/lib/ai/teammates";
import { Card } from "@/components/ui/card";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";

/**
 * "Waiting for you" (owner, 20 Nov 2026 — src/lib/ai/waiting.ts): what the AI team left for this person to decide, one
 * list across teammates, oldest first — each item opening where it is decided. On Today and the AI team page.
 */
export function WaitingForYouCard({ waiting, className = "" }: { waiting: WaitingForYou; className?: string }) {
  if (waiting.total === 0) return null;
  const more = waiting.total - waiting.items.length;
  return (
    <Card className={`p-4 ${className}`}>
      <div className="flex items-center gap-3">
        <span className="text-brand">
          <Inbox className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-text">Waiting for you</span>
          <span className="block text-xs text-muted">Your AI team&apos;s work, ready for your decision — nothing goes until you say so</span>
        </span>
        <span className="rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-white">{waiting.total}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(Object.entries(waiting.byTeammate) as [TeammateKey, number][]).map(([key, n]) => (
          <Count key={key} teammate={key} n={n} />
        ))}
      </div>
      <ul className="mt-3 divide-y divide-line border-t border-line">
        {waiting.items.map((item, i) => (
          <li key={`${item.href}-${i}`}>
            <CompanyLink href={item.href} className="flex items-start gap-2.5 py-2.5">
              <TeammateAvatar teammate={item.teammate} size="sm" className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-text">{item.title}</span>
                {item.detail && <span className="block truncate text-xs text-subtle">{item.detail}</span>}
              </span>
            </CompanyLink>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="mt-1 text-xs text-subtle">And {more} more — each teammate&apos;s page has the rest.</p>}
    </Card>
  );
}

function Count({ teammate, n }: { teammate: TeammateKey; n: number }) {
  const t = useTeammate(teammate);
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-muted">
      <TeammateAvatar teammate={teammate} size="xs" />
      {t.name} · {n}
    </span>
  );
}
