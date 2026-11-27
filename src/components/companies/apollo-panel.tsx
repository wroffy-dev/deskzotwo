"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addPersonFromApollo, applyApolloCompany, enrichCompanyFromApollo, enrichContactFromApollo, findPeopleInApollo, type CompanyEnrichView } from "@/actions/apollo";
import { addPersonFromLusha, enrichCompanyFromLusha, enrichContactFromLusha, findPeopleInLusha } from "@/actions/lusha";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ApolloCompany, ApolloSearchPerson } from "@/lib/apollo/client";

type FieldKey = "website" | "linkedinUrl" | "employeeCount" | "industry";
const FIELD_LABELS: Record<FieldKey, string> = { website: "Website", linkedinUrl: "LinkedIn", employeeCount: "Employees", industry: "Industry" };

export type EnrichProvider = "apollo" | "lusha";
const PROVIDER_NAME: Record<EnrichProvider, string> = { apollo: "Apollo", lusha: "Lusha" };
/** Each provider's actions, the same shapes — applying a company's lookup reads either's (applyApolloCompany). */
const ACTIONS = {
  apollo: { company: enrichCompanyFromApollo, contact: enrichContactFromApollo, search: findPeopleInApollo, add: addPersonFromApollo },
  lusha: { company: enrichCompanyFromLusha, contact: enrichContactFromLusha, search: findPeopleInLusha, add: addPersonFromLusha },
} as const;

/**
 * Apollo on a company's page (owner, 14 Nov 2026 — src/lib/apollo): the company's details as a preview to apply field by
 * field, what else Apollo knows of it (social links, founded, revenue), a contact's email and mobile, and people at the
 * company by title. Shown to people with "Enrich from Apollo", where the workspace has connected Apollo.
 */
export function ApolloPanel({
  companyId,
  contacts,
  last,
  providers,
}: {
  companyId: string;
  contacts: { id: string; name: string; email: string | null; phone: string | null }[];
  last: { at: string | Date; found: ApolloCompany; provider?: string } | null;
  /** Those the workspace has connected (owner, 14 Nov 2026: Apollo and Lusha). */
  providers: EnrichProvider[];
}) {
  const router = useRouter();
  const [provider, setProvider] = useState<EnrichProvider>(providers[0] ?? "apollo");
  const act = ACTIONS[provider];
  const name = PROVIDER_NAME[provider];
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<CompanyEnrichView | null>(null);
  const [picked, setPicked] = useState<Set<FieldKey>>(new Set());
  const [titles, setTitles] = useState("");
  const [people, setPeople] = useState<ApolloSearchPerson[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const shown = preview?.found ?? last?.found ?? null;

  const lookUp = () =>
    start(async () => {
      setError(null);
      setNote(null);
      const r = await act.company(companyId);
      if (!r.ok) return setError(r.error);
      setPreview(r.data);
      // Blanks ticked; anything typed left alone unless ticked.
      const found = r.data.found;
      const offered: Record<FieldKey, string | null> = { website: found.website, linkedinUrl: found.linkedinUrl, employeeCount: found.employees === null ? null : String(found.employees), industry: found.industry };
      setPicked(new Set((Object.keys(offered) as FieldKey[]).filter((k) => offered[k] && !r.data.current[k])));
    });
  const apply = () =>
    start(async () => {
      if (!preview) return;
      setError(null);
      const r = await applyApolloCompany(preview.lookupId, [...picked]);
      if (!r.ok) return setError(r.error);
      setNote(r.data.changed.length ? `Filled from ${name}: ${r.data.changed.map((c) => FIELD_LABELS[c as FieldKey] ?? c).join(", ")}.` : "Nothing was changed.");
      setPreview(null);
      router.refresh();
    });
  const findContact = (contactId: string, mobile: boolean) => {
    setBusy(`${contactId}:${mobile}`);
    start(async () => {
      setError(null);
      setNote(null);
      const r = await act.contact(contactId, mobile);
      setBusy(null);
      if (!r.ok) return setError(r.error);
      const d = r.data;
      const parts = [
        d.filled.length ? `filled ${d.filled.join(", ")}` : null,
        d.kept.email ? `Apollo has another email, ${d.kept.email}` : null,
        d.mobile === "WAITING" ? "the mobile comes in a few minutes — you'll be told" : d.mobile === "KEPT" ? "a phone was found but one is already on file" : null,
        "doNotCall" in d && d.doNotCall ? "a number on a do-not-call list was left out" : null,
      ].filter(Boolean);
      setNote(parts.length ? `${parts.join("; ")}.` : d.found ? `${name} found them, with nothing new.` : `${name} didn't find them.`);
      router.refresh();
    });
  };
  const search = () =>
    start(async () => {
      setError(null);
      const r = await act.search(
        companyId,
        titles.split(",").map((t) => t.trim()).filter(Boolean),
      );
      if (!r.ok) return setError(r.error);
      setPeople(r.data.people);
    });
  const add = (apolloId: string, mobile: boolean) => {
    setBusy(`add:${apolloId}:${mobile}`);
    start(async () => {
      setError(null);
      const r = await act.add(companyId, apolloId, mobile);
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setNote(`${r.data.person.name ?? "They"} added as a contact${r.data.mobile === "WAITING" ? " — the mobile comes in a few minutes" : ""}.`);
      setPeople((list) => list?.filter((p) => p.apolloId !== apolloId) ?? null);
      router.refresh();
    });
  };

  return (
    <Card className="space-y-4 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium text-text">{providers.length > 1 ? "Look up" : name}</h3>
          <p className="text-xs text-subtle">Each lookup spends your {name} credits. Nothing you typed is changed without your tick.</p>
        </div>
        {providers.length > 1 && (
          <div className="flex gap-1 rounded-base border border-line p-0.5 text-xs" role="group" aria-label="Look up with">
            {providers.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={provider === p}
                onClick={() => {
                  setProvider(p);
                  setPreview(null);
                  setPeople(null);
                }}
                className={`rounded-base px-2.5 py-1 ${provider === p ? "bg-brand text-brand-contrast" : "text-muted hover:text-text"}`}
              >
                {PROVIDER_NAME[p]}
              </button>
            ))}
          </div>
        )}
        <Button size="sm" variant="secondary" disabled={pending} onClick={lookUp}>
          {pending && !busy ? `Asking ${name}…` : "Fill in details"}
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {note && <p className="text-xs text-success">{note}</p>}

      {preview && (
        <div className="space-y-2 rounded-base border border-line p-3">
          <table className="w-full text-xs">
            <thead className="text-left text-muted">
              <tr>
                <th className="w-8" />
                <th className="py-1">Field</th>
                <th className="py-1">On file</th>
                <th className="py-1">{name}</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(FIELD_LABELS) as FieldKey[]).map((k) => {
                const theirs = k === "employeeCount" ? (preview.found.employees === null ? null : String(preview.found.employees)) : k === "website" ? preview.found.website : k === "linkedinUrl" ? preview.found.linkedinUrl : preview.found.industry;
                if (!theirs) return null;
                return (
                  <tr key={k} className="border-t border-line">
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Use ${name}'s ${FIELD_LABELS[k]}`}
                        checked={picked.has(k)}
                        onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(k); else n.delete(k); return n; })}
                      />
                    </td>
                    <td className="py-1 text-muted">{FIELD_LABELS[k]}</td>
                    <td className="py-1 break-all text-text">{preview.current[k] ?? <span className="text-subtle">blank</span>}</td>
                    <td className="py-1 break-all text-text">{theirs}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex gap-2">
            <Button size="sm" disabled={pending || picked.size === 0} onClick={apply}>
              Apply {picked.size || ""}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {shown && (
        <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          {shown.description && <p className="text-muted sm:col-span-2">{shown.description}</p>}
          {shown.industry && <Fact label="Industry" value={shown.industry} />}
          {shown.employees !== null && <Fact label="Employees" value={String(shown.employees)} />}
          {shown.foundedYear !== null && <Fact label="Founded" value={String(shown.foundedYear)} />}
          {shown.revenue && <Fact label="Revenue" value={shown.revenue} />}
          {shown.phone && <Fact label="Phone" value={shown.phone} />}
          {[["LinkedIn", shown.linkedinUrl], ["X / Twitter", shown.twitterUrl], ["Facebook", shown.facebookUrl]].map(([label, url]) =>
            url ? (
              <p key={label}>
                <span className="text-muted">{label}: </span>
                <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-brand hover:underline">
                  {url.replace(/^https?:\/\/(www\.)?/, "")}
                </a>
              </p>
            ) : null,
          )}
          {last && !preview && <p className="text-subtle sm:col-span-2">From {last.provider === "LUSHA" ? "Lusha" : "Apollo"}, {new Date(last.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.</p>}
        </div>
      )}

      {contacts.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted">A contact&apos;s email and mobile</h4>
          {contacts.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-1.5">
              <span className="text-text">
                {c.name}
                <span className="ml-2 text-xs text-subtle">{[c.email, c.phone].filter(Boolean).join(" · ") || "no email or phone"}</span>
              </span>
              <span className="flex gap-1.5">
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => findContact(c.id, false)}>
                  {busy === `${c.id}:false` ? "Asking…" : "Find email"}
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => findContact(c.id, true)}>
                  {busy === `${c.id}:true` ? "Asking…" : "Email + mobile"}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted">People at this company</h4>
        <div className="flex flex-wrap gap-2">
          <Input value={titles} onChange={(e) => setTitles(e.target.value)} placeholder="Titles, comma-separated — IT Head, CFO, Purchase Manager" className="max-w-md" aria-label="Job titles to look for" />
          <Button size="sm" variant="secondary" disabled={pending} onClick={search}>
            Search {name}
          </Button>
        </div>
        <p className="text-xs text-subtle">{provider === "apollo" ? "Searching is free; adding somebody spends a credit, and their mobile more." : "Searching and adding spend Lusha credits; a mobile more."}</p>
        {people && people.length === 0 && <p className="text-xs text-muted">Nobody found with those titles.</p>}
        {people?.map((p) => (
          <div key={p.apolloId} className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-1.5">
            <span className="text-text">
              {[p.firstName, p.lastNameHint].filter(Boolean).join(" ")}
              <span className="ml-2 text-xs text-subtle">{[p.title, p.hasEmail ? "has email" : null, p.hasPhone ? "has phone" : null].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="flex gap-1.5">
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => add(p.apolloId, false)}>
                {busy === `add:${p.apolloId}:false` ? "Adding…" : "Add"}
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => add(p.apolloId, true)}>
                {busy === `add:${p.apolloId}:true` ? "Adding…" : "Add + mobile"}
              </Button>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <span className="text-muted">{label}: </span>
      <span className="text-text">{value}</span>
    </p>
  );
}
