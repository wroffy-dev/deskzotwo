"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Plus, Search, X } from "lucide-react";
import { addLookalikes, findLookalikes, type AddedProspect, type LookalikesPage } from "@/actions/prospects";
import { SIZE_LABELS, SIZE_RANGES, type Counted, type LookalikeFilters } from "@/lib/prospects/profile";
import type { ProspectRow } from "@/lib/prospects/server";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";

type ListKey = "titles" | "places" | "industries";

/**
 * Ved's lookalikes (owner, 22 Nov 2026 — src/lib/prospects): what the best customers have in common as chips to keep or
 * drop, Apollo's free search for people like their buyers, and the ones picked added as leads — a credit each.
 */
export function Lookalikes({ data }: { data: LookalikesPage }) {
  const ved = useTeammate("ved");
  const p = data.profile;
  const [filters, setFilters] = useState<LookalikeFilters>(data.start);
  const [rows, setRows] = useState<ProspectRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ added: AddedProspect[]; skipped: { name: string; why: string }[] } | null>(null);
  const [busy, setBusy] = useState<"find" | "add" | null>(null);
  const [, start] = useTransition();

  const toggle = (key: ListKey | "sizes", value: string) =>
    setFilters((f) => ({ ...f, [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value] }));

  const find = (at: number) =>
    start(async () => {
      setBusy("find");
      setError(null);
      setResult(null);
      const r = await findLookalikes({ filters, page: at });
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setRows(r.data.rows);
      setTotal(r.data.total);
      setPage(at);
      setPicked(new Set());
    });

  const add = () =>
    start(async () => {
      setBusy("add");
      setError(null);
      const chosen = (rows ?? []).filter((r) => picked.has(r.apolloId)).map((r) => ({ apolloId: r.apolloId, organizationName: r.organizationName ?? null }));
      const r = await addLookalikes(chosen);
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setResult(r.data);
      setPicked(new Set());
      setRows((list) => (list ?? []).map((row) => (chosen.some((c) => c.apolloId === row.apolloId) ? { ...row, alreadyHere: true } : row)));
    });

  if (!data.connected) {
    return (
      <Card className="p-6 text-sm text-muted">
        Ved finds people in Apollo. Connect Apollo first, under{" "}
        <Link href="/settings/apollo" className="text-brand hover:underline">
          Settings › Apollo
        </Link>
        .
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
          <TeammateAvatar teammate="ved" size="sm" />
          <span>
            {p.basedOn
              ? `${ved.name} looked at your ${p.basedOn} best customer${p.basedOn === 1 ? "" : "s"} — this is what they have in common`
              : `${ved.name} needs a few customers to learn from — say what you're looking for`}
          </span>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted">
            Your best customers are those who&apos;ve spent the most with you, and those you won a deal with in the last two years. Keep what fits, drop what
            doesn&apos;t, or add your own. Searching is free; each person you add uses one Apollo credit. Only these filters go to Apollo — nothing about your
            customers or their people.
          </p>
          <ChipGroup label="Who bought" hint="their buyers' designations" items={p.titles} chosen={filters.titles} onToggle={(v) => toggle("titles", v)} onAdd={(v) => toggle("titles", v)} placeholder="Add a job title" />
          <ChipGroup label="Where" hint="where the companies are" items={p.places} chosen={filters.places} onToggle={(v) => toggle("places", v)} onAdd={(v) => toggle("places", v)} placeholder="Add a state, city or country" />
          <ChipGroup label="Industry" hint="Apollo's industry names work best" items={p.industries} chosen={filters.industries} onToggle={(v) => toggle("industries", v)} onAdd={(v) => toggle("industries", v)} placeholder="Add an industry" />
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-text">
              Size <span className="font-normal text-subtle">· people at the company</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SIZE_RANGES.map((r) => {
                const seen = p.sizes.find((s) => s.value === r)?.count ?? 0;
                return (
                  <Chip key={r} on={filters.sizes.includes(r)} onClick={() => toggle("sizes", r)}>
                    {SIZE_LABELS[r]}
                    {seen > 0 && <span className="ml-1 text-subtle">{seen}</span>}
                  </Chip>
                );
              })}
            </div>
          </div>
          {p.seeds.length > 0 && (
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={filters.useSeeds} onChange={(e) => setFilters((f) => ({ ...f, useSeeds: e.target.checked }))} />
              <span>
                Companies like your top {p.seeds.length}
                <span className="block text-xs text-subtle">Apollo looked these customers up before, so it can find companies like them.</span>
              </span>
            </label>
          )}
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={busy !== null} onClick={() => find(1)}>
              <Search className="mr-1.5 h-3.5 w-3.5" />
              {busy === "find" ? `${ved.name} is looking…` : "Find people like them"}
            </Button>
            {error && <span className="text-xs text-danger">{error}</span>}
          </div>
        </CardContent>
      </Card>

      {result && (
        <Card className="space-y-1 p-4 text-sm">
          {result.added.length > 0 && (
            <p className="text-success">
              Added {result.added.length} as your leads:{" "}
              {result.added.map((a, i) => (
                <span key={a.href}>
                  {i > 0 && ", "}
                  <Link href={a.href} className="text-brand hover:underline">
                    {a.name} ({a.company})
                  </Link>
                </span>
              ))}
              . Ved can research and plan each from the lead.
            </p>
          )}
          {result.skipped.map((s, i) => (
            <p key={i} className="text-xs text-muted">
              {s.name}: {s.why}.
            </p>
          ))}
        </Card>
      )}

      {rows && (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-muted">
              {total ? `${total.toLocaleString("en-IN")} people fit — page ${page}` : "Nobody fits all of that — drop a filter or two."}
            </span>
            {rows.length > 0 && (
              <Button size="sm" disabled={busy !== null || picked.size === 0} onClick={add}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                {busy === "add" ? "Adding…" : picked.size ? `Add ${picked.size} as leads · ${picked.size} Apollo credit${picked.size === 1 ? "" : "s"}` : "Pick people to add"}
              </Button>
            )}
          </CardHeader>
          {rows.length > 0 && (
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-subtle">
                      <th className="w-8 px-3 py-2" />
                      <th className="px-3 py-2 font-medium">Person</th>
                      <th className="px-3 py-2 font-medium">Title</th>
                      <th className="px-3 py-2 font-medium">Company</th>
                      <th className="px-3 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const mayPick = !r.alreadyHere && r.hasEmail;
                      const on = picked.has(r.apolloId);
                      return (
                        <tr key={r.apolloId} className="border-b border-line last:border-0">
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              aria-label={`Pick ${r.firstName ?? "this person"}`}
                              disabled={!mayPick || (!on && picked.size >= 10)}
                              checked={on}
                              onChange={() =>
                                setPicked((s) => {
                                  const next = new Set(s);
                                  if (next.has(r.apolloId)) next.delete(r.apolloId);
                                  else next.add(r.apolloId);
                                  return next;
                                })
                              }
                            />
                          </td>
                          <td className="px-3 py-2 text-text">{[r.firstName, r.lastNameHint].filter(Boolean).join(" ") || "—"}</td>
                          <td className="px-3 py-2 text-muted">{r.title ?? "—"}</td>
                          <td className="px-3 py-2 text-text">{r.organizationName ?? "—"}</td>
                          <td className="px-3 py-2 text-right">
                            {r.alreadyHere ? <Badge>In Deskzo</Badge> : r.hasEmail ? <span className="inline-flex items-center gap-1 text-xs text-success"><Check className="h-3 w-3" />work email</span> : <span className="text-xs text-subtle">no email</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between gap-2 p-3 text-xs text-subtle">
                <span>Names are half hidden until added. At most 10 at a time.</span>
                <span className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={busy !== null || page <= 1} onClick={() => find(page - 1)}>
                    Previous
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy !== null || page * 25 >= total || page >= 20} onClick={() => find(page + 1)}>
                    Next
                  </Button>
                </span>
              </div>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-brand bg-brand-subtle text-brand" : "border-line bg-surface text-muted hover:text-text"}`}
    >
      {children}
    </button>
  );
}

function ChipGroup({ label, hint, items, chosen, onToggle, onAdd, placeholder }: { label: string; hint: string; items: Counted[]; chosen: string[]; onToggle: (v: string) => void; onAdd: (v: string) => void; placeholder: string }) {
  const [typed, setTyped] = useState("");
  // What was typed or kept that isn't one of the profile's own.
  const extra = chosen.filter((c) => !items.some((i) => i.value === c));
  const submit = () => {
    const v = typed.replace(/\s+/g, " ").trim().slice(0, 80);
    if (v && !chosen.includes(v)) onAdd(v);
    setTyped("");
  };
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-text">
        {label} <span className="font-normal text-subtle">· {hint}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((i) => (
          <Chip key={i.value} on={chosen.includes(i.value)} onClick={() => onToggle(i.value)}>
            {i.value}
            <span className="ml-1 text-subtle">{i.count}</span>
          </Chip>
        ))}
        {extra.map((v) => (
          <Chip key={v} on onClick={() => onToggle(v)}>
            {v}
            <X className="ml-1 h-3 w-3" aria-hidden="true" />
          </Chip>
        ))}
        <Input
          aria-label={placeholder}
          placeholder={placeholder}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          className="h-7 w-48 text-xs"
        />
      </div>
    </div>
  );
}
