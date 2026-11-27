"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import { Download, FileUp, Loader2 } from "lucide-react";
import { previewOldProposalsFile, startOldProposalsImport, stepOldProposalsImport } from "@/actions/old-proposals";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { csvRow } from "@/lib/csv";
import type { OldOutcome, PreviewResult, PreviewRow } from "@/lib/old-proposals/preview";
import type { Decision } from "@/lib/old-proposals/run";
import { companyPath } from "@/lib/record-links";

/** What bringing the Excel proposals in would do (src/lib/old-proposals/preview.ts): the counts, then each proposal. */

const n = (v: number) => v.toLocaleString("en-IN");
const OUTCOMES: { key: OldOutcome; label: string; about: string; tone: "green" | "brand" | "amber" | "default" }[] = [
  { key: "BRING", label: "Would come in", about: "The company is here, by name", tone: "green" },
  { key: "CREATE", label: "Come in, company made", about: "The company isn't here", tone: "brand" },
  { key: "LOOK", label: "Needs a look", about: "Only suggested, or more than one fits", tone: "amber" },
  { key: "HERE", label: "Here already", about: "Brought in before", tone: "default" },
];
const STATUS: Record<PreviewRow["status"], string> = { WON: "Won", LOST: "Lost", PENDING: "Pending", OTHER: "Closed or other", UNKNOWN: "Not known" };
const JOINED: Record<PreviewRow["joined"], string> = { REFERENCE: "Sheet and file", DATE: "Sheet and file, by date", SHEET_ONLY: "Status sheet only", FILE_ONLY: "File only" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d: string | null) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : "—");
const PAGE = 100;

function saveCsv(rows: PreviewRow[], name: string) {
  const head = ["Outcome", "Why", "Deskzo company", "Company on the proposal", "Reference", "Date", "Status", "Product", "Total", "Item lines", "Versions", "Made by", "Contact", "Email", "New contact", "Contact left", "Zoho quote that looks the same", "From", "To check"];
  const body = rows.map((r) =>
    csvRow([OUTCOMES.find((o) => o.key === r.outcome)!.label, r.why, r.to?.name ?? "", r.company, r.ref, r.date ?? "", STATUS[r.status], r.product, r.total ?? "", r.lines, r.files, r.madeBy, r.contact, r.email, r.newContact ? "Yes" : "", r.left ? "Yes" : "", r.zoho ?? "", JOINED[r.joined], r.issues.join("; ")]),
  );
  const url = URL.createObjectURL(new Blob([`﻿${[csvRow(head), ...body].join("\n")}\n`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const base64Of = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

export function OldProposalsPreview({ canImport = false }: { canImport?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [packed, setPacked] = useState("");
  const choose = (file: File | undefined) => {
    if (!file) return;
    start(async () => {
      setError(null);
      try {
        const bytes = await base64Of(file);
        const r = await previewOldProposalsFile(bytes);
        if (!r.ok) return setError(r.error);
        setPacked(bytes);
        setResult(r.data);
      } catch {
        setError("The preview didn't go through. Try again.");
      }
    });
  };
  return (
    <div className="mt-5 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept=".gz,application/gzip"
          className="hidden"
          aria-label="The prepared file"
          onChange={(e) => {
            choose(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <Button type="button" disabled={pending} onClick={() => input.current?.click()}>
          {pending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : <FileUp className="mr-1.5 h-4 w-4" aria-hidden="true" />}
          {pending ? "Matching…" : result ? "Choose another file" : "Choose the prepared file"}
        </Button>
        <span className="text-xs text-muted">old-proposals.json.gz</span>
      </div>
      <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
      {result && <Result key={result.made + result.total} result={result} packed={canImport ? packed : ""} />}
    </div>
  );
}

/** Takes what was found; its own component so a page can be shown one without choosing a file. */
export function Result({ result, packed = "" }: { result: PreviewResult; packed?: string }) {
  // Those that need a look: one answer for all of them, and one of its own for any.
  const [all, setAll] = useState<Decision>("LATER");
  const [own, setOwn] = useState<Record<string, Decision>>({});
  const decided = (r: PreviewRow): Decision => {
    const d = own[r.key] ?? all;
    return d === "SUGGESTED" && !r.to ? "LATER" : d;
  };
  const [outcome, setOutcome] = useState<OldOutcome | null>(null);
  const [search, setSearch] = useState("");
  const [toCheck, setToCheck] = useState(false);
  const [page, setPage] = useState(0);
  const rows = useMemo(() => {
    const words = search.trim().toLowerCase();
    return result.rows.filter((r) => (!outcome || r.outcome === outcome) && (!toCheck || r.issues.length > 0 || !!r.zoho) && (!words || `${r.company} ${r.ref} ${r.product} ${r.to?.name ?? ""} ${r.email} ${r.madeBy}`.toLowerCase().includes(words)));
  }, [result, outcome, search, toCheck]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const at = Math.min(page, pages - 1);
  const totals = (key: OldOutcome) => result.byStatus.reduce((t, s) => t + s[key], 0);
  const facts: [string, number][] = [
    ["proposals", result.total],
    ["older versions", result.versions],
    ["other papers, kept beside them", result.papers],
    ["companies would be made", result.newCompanies],
    ["contacts would be added", result.newContacts],
    ["of those have left", result.contactsLeft],
    ["look the same as a Zoho quote here", result.alreadyZoho],
    ["with something to check", result.withIssues],
    ["files not read", result.unread.total],
  ];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {OUTCOMES.map((o) => (
          <button
            key={o.key}
            type="button"
            aria-pressed={outcome === o.key}
            onClick={() => {
              setOutcome(outcome === o.key ? null : o.key);
              setPage(0);
            }}
            className={`rounded-lg border p-3 text-left ${outcome === o.key ? "border-brand bg-brand/5" : "border-line bg-surface hover:bg-surface-sunken"}`}
          >
            <span className="block text-xs text-muted">{o.label}</span>
            <span className="block text-xl font-semibold tabular-nums text-text">{n(totals(o.key))}</span>
            <span className="block text-xs text-subtle">{o.about}</span>
          </button>
        ))}
      </div>
      <Card>
        <CardHeader className="text-sm font-medium text-text">What was read, prepared {dayLabel(result.made.slice(0, 10))}</CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted">
            {facts.map(([label, v], i) => (
              <span key={label}>
                {i > 0 && " · "}
                <span className="font-medium tabular-nums text-text">{n(v)}</span> {label}
              </span>
            ))}
          </p>
          <p className="text-sm text-muted">
            Status sheet and file joined by reference {n(result.joined.REFERENCE)}, by company and date {n(result.joined.DATE)}; in the status sheet only {n(result.joined.SHEET_ONLY)}; a file only {n(result.joined.FILE_ONLY)}. A total read on{" "}
            {n(result.withTotal)}, item lines on {n(result.withLines)}.
          </p>
          {result.unread.byWhy.length > 0 && <p className="text-xs text-subtle">Files not read — {result.unread.byWhy.map((u) => `${u.why}: ${n(u.count)}`).join(" · ")}.</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1 pr-3 font-medium">How it ended</th>
                  {OUTCOMES.map((o) => (
                    <th key={o.key} className="py-1 pr-3 text-right font-medium">
                      {o.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.byStatus.map((s) => (
                  <tr key={s.status} className="border-t border-line">
                    <td className="py-1 pr-3 text-text">{STATUS[s.status]}</td>
                    {OUTCOMES.map((o) => (
                      <td key={o.key} className="py-1 pr-3 text-right tabular-nums text-text">
                        {s[o.key] ? n(s[o.key]) : "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      {packed && <BringIn result={result} packed={packed} all={all} setAll={setAll} decided={decided} />}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search company, reference, product…"
            aria-label="Search the proposals"
            className="h-8 w-64"
          />
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={toCheck}
              onChange={(e) => {
                setToCheck(e.target.checked);
                setPage(0);
              }}
            />
            Only those with something to check
          </label>
          <span className="text-xs text-muted">
            {n(rows.length)} {rows.length === 1 ? "proposal" : "proposals"}
          </span>
          <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => saveCsv(rows, "old-proposals-preview.csv")} disabled={rows.length === 0}>
            <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Download these
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Proposal</th>
                <th className="px-3 py-2 font-medium">Company on it</th>
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 font-medium">What would happen</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(at * PAGE, (at + 1) * PAGE).map((r) => {
                const o = OUTCOMES.find((x) => x.key === r.outcome)!;
                return (
                  <tr key={r.key} className="border-t border-line align-top">
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className="block text-text">{r.ref || "No reference"}</span>
                      <span className="block text-xs text-muted">
                        {dayLabel(r.date)} · {STATUS[r.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="block text-text">{r.company}</span>
                      {(r.contact || r.email) && <span className="block text-xs text-muted">{[r.contact, r.email].filter(Boolean).join(" · ")}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <span className="block text-text">{r.product || "—"}</span>
                      <span className="block text-xs text-muted">
                        {r.lines ? `${n(r.lines)} ${r.lines === 1 ? "line" : "lines"}` : "No lines"}
                        {r.files > 1 ? ` · ${n(r.files)} versions` : ""}{r.papers ? ` · ${n(r.papers)} ${r.papers === 1 ? "paper" : "papers"}` : ""} · {JOINED[r.joined]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-text">{r.total === null ? "—" : `₹${r.total.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={o.tone}>{o.label}</Badge>
                        {r.to && (
                          <CompanyLink href={companyPath(r.to.seq)} className="text-brand hover:underline" target="_blank">
                            {r.to.name}
                          </CompanyLink>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {r.why}
                        {r.newContact ? ` · adds ${r.left ? "a contact, marked as left" : "a contact"}` : ""}
                      </span>
                      {packed && r.outcome === "LOOK" && (
                        <Select value={decided(r)} onChange={(e) => setOwn({ ...own, [r.key]: e.target.value as Decision })} aria-label={`What to do with ${r.company}, ${r.ref}`} className="mt-1 h-8 w-56 text-xs">
                          <option value="LATER">Leave for later</option>
                          {r.to && <option value="SUGGESTED">Put on {r.to.name}</option>}
                          <option value="NEW">Make its own company</option>
                        </Select>
                      )}
                      {r.zoho && <span className="block text-xs text-warning">Looks the same as Zoho&apos;s {r.zoho}</span>}
                      {r.issues.map((i) => (
                        <span key={i} className="block text-xs text-warning">
                          {i}
                        </span>
                      ))}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted">
                    None.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-xs text-muted">
            <Button type="button" size="sm" variant="ghost" disabled={at === 0} onClick={() => setPage(at - 1)}>
              Previous
            </Button>
            Page {n(at + 1)} of {n(pages)}
            <Button type="button" size="sm" variant="ghost" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
              Next
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

/** What will be brought in, and the button. The backup is taken first; then a part at a time, with the page open. */
function BringIn({ result, packed, all, setAll, decided }: { result: PreviewResult; packed: string; all: Decision; setAll: (d: Decision) => void; decided: (r: PreviewRow) => Decision }) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const look = result.rows.filter((r) => r.outcome === "LOOK");
  const waiting = look.filter((r) => decided(r) === "LATER").length;
  const coming = result.rows.filter((r) => r.outcome === "BRING" || r.outcome === "CREATE").length + look.length - waiting;
  const go = async () => {
    setError(null);
    setWorking("Taking a full backup first…");
    try {
      const started = await startOldProposalsImport(packed, Object.fromEntries(look.map((r) => [r.key, decided(r)])), confirmed);
      if (!started.ok) return setError(started.error);
      for (;;) {
        const r = await stepOldProposalsImport(started.data.id);
        if (!r.ok) return setError(r.error);
        setWorking(`${n(r.data.progress.at)} of ${n(r.data.progress.total)}…`);
        if (r.data.status !== "IMPORTING") break;
      }
      router.refresh();
    } catch {
      setError("It stopped — the connection dropped. Reload the page and press Carry on.");
    } finally {
      setWorking(null);
    }
  };
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Bring them in</CardHeader>
      <CardContent className="space-y-3 text-sm">
        {look.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">The {n(look.length)} that need a look:</span>
            <Select value={all} onChange={(e) => setAll(e.target.value as Decision)} aria-label="What to do with all that need a look" className="h-8 w-72 text-xs">
              <option value="LATER">Leave for later</option>
              <option value="SUGGESTED">Put on the company suggested, where there is one</option>
              <option value="NEW">Make a company for each</option>
            </Select>
            <span className="text-xs text-muted">or choose for each in the list below.</span>
          </div>
        )}
        <p className="text-muted">
          <span className="font-medium text-text">{n(coming)}</span> will come in to their companies&apos; Earlier years tabs, to read. {waiting > 0 && <>{n(waiting)} wait for a decision and can come in later. </>}
          Companies made are prospects tagged &ldquo;Old proposals&rdquo;, with no account manager. No lead, document or entry in the books is made, and nobody is told or emailed.
        </p>
        <label className="flex items-start gap-2 text-text">
          <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I&apos;ve read what will happen. Take a full backup and bring them in.
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={!confirmed || !!working || coming === 0} onClick={go}>
            {working ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {working ? "Bringing in" : `Bring in ${n(coming)}`}
          </Button>
          {working && <span className="text-xs text-muted">{working} Keep this page open.</span>}
        </div>
        <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
      </CardContent>
    </Card>
  );
}
