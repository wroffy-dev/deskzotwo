"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, FileUp, ShieldCheck } from "lucide-react";
import type { MarketingTopic } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/bulk-select";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { TOPICS } from "@/lib/marketing/topics";
import type { ImportSummary, ListCheck } from "@/lib/marketing/list-import";

/**
 * Upload a CSV of people for a mass mail. Asks the one question the law asks — how did they agree to
 * hear from us — and won't go without an answer. Each row becomes a contact, so an unsubscribe sticks.
 *
 * Checked first (owner, 1 Nov 2026): every address, who's already in Deskzo, who bounced or unsubscribed
 * before — and only then imported, leaving out what doesn't work (onto the suppression list) and, if asked,
 * existing customers. What was left out downloads as a CSV.
 */
export function ListUploader({ defaultTopic, onUploaded }: { defaultTopic?: MarketingTopic; onUploaded?: (listId: string, name: string) => void }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [topics, setTopics] = useState<MarketingTopic[]>([defaultTopic ?? "OFFERS"]);
  const [consentNote, setConsentNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [leaveOutCustomers, setLeaveOutCustomers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<ListCheck | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const form = (mode: "preview" | "import") => {
    const data = new FormData();
    data.set("file", file!);
    data.set("mode", mode);
    data.set("name", name);
    data.set("consentNote", consentNote);
    data.set("confirmed", confirmed ? "yes" : "no");
    data.set("leaveOutCustomers", leaveOutCustomers ? "yes" : "no");
    for (const t of topics) data.append("topics", t);
    return data;
  };

  const send = <T,>(mode: "preview" | "import", done: (data: T) => void) =>
    startTransition(async () => {
      if (!file) return;
      setError(null);
      const response = await fetch("/api/marketing/lists/upload", { method: "POST", body: form(mode) });
      const result = (await response.json().catch(() => ({ ok: false, error: "The upload failed." }))) as { ok: true; data: T } | { ok: false; error: string };
      if (!result.ok) return setError(result.error);
      done(result.data);
    });

  // Anything changed after the check is checked again.
  const changed = () => setCheck(null);

  if (summary) {
    const left = Object.values(summary.rejected).reduce((a, b) => a + b, 0);
    return (
      <div className="space-y-2 text-sm">
        <ActionNotice tone="success">
          “{name}” uploaded — {summary.imported} people on the list: {summary.matchedContacts} already in Deskzo, {summary.createdContacts} added as new contacts
          {summary.createdCompanies ? ` (under ${summary.createdCompanies} new companies)` : ""}.
        </ActionNotice>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
          <li>Consent recorded for {summary.consentRecorded} topic subscriptions, with your note as the evidence.</li>
          {summary.alreadyUnsubscribed > 0 && <li>{summary.alreadyUnsubscribed} had already unsubscribed — they stay unsubscribed and won&apos;t be mailed.</li>}
          {summary.suppressed > 0 && <li>{summary.suppressed} addresses that don&apos;t work are now on the suppression list, so no later list mails them either.</li>}
          {summary.tooMany && <li>Only the first 5,000 were taken — split bigger lists.</li>}
        </ul>
        {left > 0 && (
          <a href={`/api/marketing/lists/${summary.listId}/rejected`} className="inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:underline">
            <Download className="h-3.5 w-3.5" aria-hidden /> Download the {left} rows left out, with why
          </a>
        )}
      </div>
    );
  }

  const c = check;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="list-name">List name</Label>
          <Input id="list-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pune roundtable, Sep 2026" />
        </div>
        <div className="space-y-1.5">
          <Label>CSV file</Label>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              setFile(f);
              changed();
              if (f && !name) setName(f.name.replace(/\.(csv|txt)$/i, ""));
            }}
          />
          <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()} className="w-full justify-start">
            <FileUp className="h-3.5 w-3.5" /> {file ? file.name : "Choose a .csv"}
          </Button>
          <p className="text-[11px] text-subtle">Columns: Email (required), Name, Company, Phone, Designation — the first row names them.</p>
        </div>
      </div>

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-text">What did they agree to hear about?</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {TOPICS.map((t) => (
            <label key={t.key} className="flex cursor-pointer items-center gap-1.5 text-xs text-text">
              <Checkbox
                checked={topics.includes(t.key)}
                onChange={(e) => {
                  setTopics((v) => (e.target.checked ? [...v, t.key] : v.filter((k) => k !== t.key)));
                  changed();
                }}
              />
              {t.label}
            </label>
          ))}
        </div>
      </fieldset>

      {c && (
        <div className="space-y-2 rounded-lg border border-line bg-surface-sunken px-3 py-2.5 text-xs text-text">
          <p className="text-sm font-medium">
            {c.rows} addresses checked — {c.good + c.unknown} can be mailed
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted">
            <li>
              {c.good} work{c.shared ? ` (${c.shared} of them shared inboxes like info@ or free mailboxes like Gmail — they're mailed too)` : ""}
              {c.unknown ? `; ${c.unknown} couldn't be looked up just now — they come in and are checked again before a send` : ""}.
            </li>
            {c.invalid > 0 && <li className="text-danger">{c.invalid} don&apos;t work (a throwaway service, or a domain that takes no mail) — left out, and put on the suppression list.</li>}
            {c.bounced > 0 && <li className="text-danger">{c.bounced} bounced or complained before — left out.</li>}
            {c.format > 0 && <li>{c.format} rows aren&apos;t an email address — left out.</li>}
            {c.duplicates > 0 && <li>{c.duplicates} repeated addresses counted once.</li>}
            {c.unsubscribed > 0 && <li>{c.unsubscribed} had unsubscribed from these topics — they stay unsubscribed.</li>}
            {c.tooMany && <li>Only the first 5,000 will be taken — split bigger lists.</li>}
          </ul>
          {c.existing.total > 0 && (
            <p className="text-muted">
              {c.existing.total} already in Deskzo:{" "}
              {[
                c.existing.customers && `${c.existing.customers} customers' contacts`,
                c.existing.vendors && `${c.existing.vendors} vendors'`,
                c.existing.staff && `${c.existing.staff} your own team`,
                c.existing.others && `${c.existing.others} others`,
              ]
                .filter(Boolean)
                .join(", ")}
              . Their details in Deskzo are kept as they are — the file never overwrites them.
            </p>
          )}
          {c.existing.customers > 0 && (
            <label className="flex cursor-pointer items-center gap-2 text-text">
              <Checkbox checked={leaveOutCustomers} onChange={(e) => setLeaveOutCustomers(e.target.checked)} />
              Leave out the {c.existing.customers} existing customers&apos; contacts — for a campaign to new prospects only
            </label>
          )}
          <p className="text-subtle">What&apos;s left out downloads as a CSV once the list is in, each row with why.</p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="consent-note">How did they agree?</Label>
        <Textarea id="consent-note" rows={2} value={consentNote} onChange={(e) => setConsentNote(e.target.value)} placeholder="Signed up for updates at our Pune roundtable on 12 Sep 2026" />
      </div>
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs text-text">
        <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
        <span>
          <ShieldCheck className="mr-1 inline h-3.5 w-3.5 text-success" aria-hidden />
          These people agreed to hear from us about the topics ticked. This list wasn&apos;t bought or scraped. My note above is recorded as the
          evidence against every one of them.
        </span>
      </label>

      {error && <ActionNotice tone="error">{error}</ActionNotice>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={c ? "secondary" : "primary"} disabled={pending || !file || topics.length === 0} onClick={() => send<ListCheck>("preview", setCheck)}>
          {pending && !c ? "Checking addresses…" : c ? "Check again" : "Check the list"}
        </Button>
        {c && (
          <Button
            size="sm"
            disabled={pending || !name.trim() || !confirmed || consentNote.trim().length < 10 || topics.length === 0 || c.good + c.unknown === 0}
            onClick={() =>
              send<ImportSummary>("import", (data) => {
                setSummary(data);
                onUploaded?.(data.listId, name);
                router.refresh();
              })
            }
          >
            {pending ? "Importing…" : `Import ${Math.max(0, c.good + c.unknown - (leaveOutCustomers ? c.existing.customers : 0))} people`}
          </Button>
        )}
      </div>
    </div>
  );
}
