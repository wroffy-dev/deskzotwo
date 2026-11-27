"use client";

import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { acceptWebsiteEnquiry, dismissWebsiteEnquiry, setEnquiryHold } from "@/actions/website-enquiries";
import { searchCompanyOptions } from "@/actions/company-options";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { Input } from "@/components/ui/input";
import { companyPath } from "@/lib/record-links";
import type { EnquiryRow } from "@/lib/lead-capture/review";

/** Website enquiries held for review (owner, 9 Nov 2026 — src/lib/lead-capture/review.ts), one card each. */
export function EnquiryList({ rows, decided }: { rows: EnquiryRow[]; decided: boolean }) {
  if (rows.length === 0) return <Card className="p-6 text-center text-sm text-muted">{decided ? "Nothing decided yet." : "No enquiries waiting."}</Card>;
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <EnquiryCard key={r.id} row={r} decided={decided} />
      ))}
    </div>
  );
}

type Mode = "existing" | "new" | "individual";

function EnquiryCard({ row, decided }: { row: EnquiryRow; decided: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const p = row.payload;
  const domain = p.email?.split("@")[1] ?? "";
  const [mode, setMode] = useState<Mode>(row.suggested ? "existing" : "new");
  const [company, setCompany] = useState<CompanyComboOption | null>(row.suggested ? { id: row.suggested.id, name: row.suggested.name } : null);
  const [name, setName] = useState(p.company ?? "");

  const accept = () =>
    start(async () => {
      setError(null);
      const choice = mode === "existing" ? { kind: "existing" as const, companyId: company?.id ?? "" } : mode === "new" ? { kind: "new" as const, name } : { kind: "individual" as const };
      if (mode === "existing" && !company) return setError("Choose the company.");
      const r = await acceptWebsiteEnquiry(row.id, choice);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });
  const dismiss = () =>
    start(async () => {
      setError(null);
      const r = await dismissWebsiteEnquiry(row.id, "Not a real enquiry");
      if (!r.ok) return setError(r.error);
      router.refresh();
    });

  return (
    <Card className="space-y-3 p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium text-text">
            {p.name} {p.company && <span className="text-muted">· typed “{p.company}”</span>}
          </div>
          <div className="text-xs text-muted">
            {[p.email, p.phone, p.city, p.product_interest].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="text-right text-xs text-muted">
          {row.ref} · {row.website ?? "Website"} · {new Date(row.receivedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
        </div>
      </div>
      {p.message && <p className="whitespace-pre-wrap rounded-md bg-surface-sunken px-3 py-2 text-text">{p.message}</p>}

      {decided ? (
        <p className="text-xs text-muted">
          <Badge tone={row.status === "ACCEPTED" ? "green" : "default"}>{row.status === "ACCEPTED" ? "Accepted" : "Dismissed"}</Badge> {row.decisionNote ? `${row.decisionNote} · ` : ""}
          {row.decidedBy ?? ""}
          {row.leadHref && (
            <>
              {" · "}
              <Link href={row.leadHref} className="text-brand hover:underline">the lead</Link>
            </>
          )}
        </p>
      ) : (
        <>
          {row.suggested && (
            <p className="text-xs text-muted">
              {row.suggested.why === "email" ? `Their email (@${domain}) is` : "The name typed is"}{" "}
              <CompanyLink href={companyPath(row.suggested.companySeq)} className="text-brand hover:underline">{row.suggested.name}</CompanyLink>, already on file.
            </p>
          )}
          <div className="flex flex-wrap gap-3 text-xs">
            {(["existing", "new", "individual"] as Mode[]).map((m) => (
              <label key={m} className="flex items-center gap-1.5 text-text">
                <input type="radio" name={`mode-${row.id}`} checked={mode === m} onChange={() => setMode(m)} />
                {m === "existing" ? "A company on file" : m === "new" ? "A new company" : "An individual, no company"}
              </label>
            ))}
          </div>
          {mode === "existing" && (
            <CompanyCombobox companies={company ? [company] : []} value={company?.id ?? ""} onSelect={(c) => setCompany(c)} search={(q) => searchCompanyOptions(q, { side: "customer" })} />
          )}
          {mode === "new" && <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={domain ? `Its proper name — their email is @${domain}` : "Its proper name"} />}
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={accept}>Accept as a lead</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={dismiss}>Dismiss — not a real enquiry</Button>
          </div>
        </>
      )}
    </Card>
  );
}

/** The admin's choice, on Settings › Lead capture API. */
export function EnquiryHoldSetting({ hold, waiting }: { hold: boolean; waiting: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const choose = (next: boolean) =>
    start(async () => {
      setError(null);
      const r = await setEnquiryHold(next);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });
  return (
    <Card className="mb-4 space-y-2 p-4 text-sm">
      <div className="font-medium text-text">When a website sends an enquiry</div>
      <label className="flex items-start gap-2 text-text">
        <input type="radio" name="enquiry-hold" checked={!hold} disabled={pending} onChange={() => choose(false)} className="mt-1" />
        <span>Make the lead at once — with the company typed in the form, or the one their work email points at.</span>
      </label>
      <label className="flex items-start gap-2 text-text">
        <input type="radio" name="enquiry-hold" checked={hold} disabled={pending} onChange={() => choose(true)} className="mt-1" />
        <span>
          Hold it for review — somebody who assigns leads accepts it onto the right company, a new one, or the person alone, or dismisses it. Nothing is made until then, so a
          typed &quot;Twentytwelve&quot; never becomes a company.
        </span>
      </label>
      {hold && waiting > 0 && (
        <p className="text-xs text-muted">
          {waiting} waiting · <Link href="/leads/enquiries" className="text-brand hover:underline">review them</Link>
        </p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </Card>
  );
}
