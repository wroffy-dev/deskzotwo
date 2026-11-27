"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setEnrichCredits } from "@/actions/enrich-credits";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { CreditsView } from "@/lib/enrich/credits";

/**
 * Credits per person (src/lib/enrich/credits.ts), on Settings › Apollo and Settings › Lusha: a monthly limit for
 * everybody, and anybody's own instead. Blank is no limit (or, for one person, everybody's).
 */
export function EnrichCredits({ provider, view }: { provider: "APOLLO" | "LUSHA"; view: CreditsView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [everybody, setEverybody] = useState(view.everybody === null ? "" : String(view.everybody));
  const [own, setOwn] = useState<Record<string, string>>(Object.fromEntries(view.people.map((p) => [p.userId, p.own === null ? "" : String(p.own)])));
  const name = provider === "LUSHA" ? "Lusha" : "Apollo";

  const save = (userId: string, raw: string) =>
    start(async () => {
      setError(null);
      const text = raw.trim();
      if (text && !/^\d+$/.test(text)) return setError("Credits are a whole number — or blank.");
      const r = await setEnrichCredits(provider, userId, text ? Number(text) : null);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });

  const limitOf = (userId: string) => {
    const typed = own[userId]?.trim();
    if (typed) return Number(typed);
    return everybody.trim() ? Number(everybody) : null;
  };

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Credits per person · {view.month}</CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          How many {name} credits each person may spend a month. {name} bills your account; this keeps one person from spending everybody&apos;s. Blank is no
          limit. Counted by Deskzo at {name}&apos;s prices: {provider === "LUSHA" ? "a company or a person 1, a phone 5 more, a search 1" : "a company or a person 1, a mobile about 8, a people search nothing"}.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted">
            Everybody, a month
            <Input inputMode="numeric" value={everybody} onChange={(e) => setEverybody(e.target.value)} placeholder="No limit" className="mt-1 w-32" />
          </label>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => save("*", everybody)}>
            Save
          </Button>
        </div>
        {view.people.length === 0 ? (
          <p className="text-xs text-subtle">Nobody has the “Enrich from Apollo or Lusha” permission yet — give it on Settings › Roles &amp; Permissions.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1">Person</th>
                <th className="py-1 text-right">Used</th>
                <th className="py-1">Their own limit</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {view.people.map((p) => {
                const limit = limitOf(p.userId);
                const over = limit !== null && p.used >= limit;
                return (
                  <tr key={p.userId} className="border-t border-line">
                    <td className="py-1.5 text-text">{p.name}</td>
                    <td className={`py-1.5 text-right tabular-nums ${over ? "text-danger" : "text-text"}`}>
                      {p.used}
                      {limit !== null ? ` / ${limit}` : ""}
                    </td>
                    <td className="py-1.5">
                      <Input
                        inputMode="numeric"
                        aria-label={`${p.name}'s own monthly ${name} credits`}
                        value={own[p.userId] ?? ""}
                        onChange={(e) => setOwn({ ...own, [p.userId]: e.target.value })}
                        placeholder={everybody.trim() ? `Everybody's (${everybody.trim()})` : "No limit"}
                        className="w-40"
                      />
                    </td>
                    <td className="py-1.5 text-right">
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => save(p.userId, own[p.userId] ?? "")}>
                        Save
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}
