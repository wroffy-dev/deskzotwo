"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, FileUp } from "lucide-react";
import { checkTallyExport, makeTallyExport, mapToTally, markTallyImported, saveTallySettings, uploadTallyMasters } from "@/actions/tally";
import type { AccountRow, ExportRow, TallyConfig } from "@/lib/tally/server";
import type { ExportPlan } from "@/lib/tally/build";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

/**
 * Settings › Tally (owner, 25 Oct 2026 plan; built 23 Nov 2026 — src/lib/tally): where the books are kept, Tally's own
 * masters, each account's Tally ledger, and the exports — two files a period, the totals to tie, and "imported".
 */

type Check = Pick<ExportPlan, "unmatched" | "skipped" | "summary"> & { vouchers: number };
const inr = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function TallySettings({
  config,
  accounts,
  ledgers,
  exports,
  canSetUp,
  canExport,
  defaultFrom,
  today,
}: {
  config: TallyConfig;
  accounts: AccountRow[];
  ledgers: string[];
  exports: ExportRow[];
  canSetUp: boolean;
  canExport: boolean;
  defaultFrom: string;
  today: string;
}) {
  return (
    <div className="space-y-4">
      <datalist id="tally-ledgers">
        {ledgers.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      <BooksCard config={config} canSetUp={canSetUp} />
      <MastersCard config={config} canSetUp={canSetUp} />
      <AccountsCard accounts={accounts} canSetUp={canSetUp} hasMasters={config.masters > 0} />
      {canExport && <ExportCard config={config} defaultFrom={defaultFrom} today={today} />}
      <ExportsCard exports={exports} canExport={canExport} />
    </div>
  );
}

function BooksCard({ config, canSetUp }: { config: TallyConfig; canSetUp: boolean }) {
  const router = useRouter();
  const [booksIn, setBooksIn] = useState(config.booksIn);
  const [companyName, setCompanyName] = useState(config.companyName ?? "");
  const [startDate, setStartDate] = useState(config.startDate ?? "");
  const [itemLines, setItemLines] = useState(config.itemLines);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      setMsg(null);
      const r = await saveTallySettings({ booksIn, companyName, itemLines, startDate });
      setMsg(r.ok ? { ok: true, text: "Saved." } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Where the books are kept</CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2">
            <input type="radio" name="books-in" checked={booksIn === "DESKZO"} onChange={() => setBooksIn("DESKZO")} disabled={!canSetUp} />
            In Deskzo
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="books-in" checked={booksIn === "TALLY"} onChange={() => setBooksIn("TALLY")} disabled={!canSetUp} />
            In Tally — Deskzo does the selling and billing, and sends it to Tally
          </label>
        </div>
        {booksIn === "TALLY" && (
          <p className="text-xs text-muted">
            Deskzo&apos;s ledger, trial balance, P&amp;L, balance sheet, vouchers, GST and TDS returns, banking and closing say &ldquo;Kept in Tally&rdquo; and leave the menu.
            Invoices, receipts, statements, ageing and collections stay here. Deskzo keeps posting underneath, so they stay right.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="tally-company">Tally company</Label>
            <Input id="tally-company" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Exactly as Tally shows it" disabled={!canSetUp} maxLength={200} />
          </div>
          <div>
            <Label htmlFor="tally-start">Send to Tally from</Label>
            <Input id="tally-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={!canSetUp} />
            <p className="mt-1 text-xs text-subtle">The day you started billing in Deskzo. Anything earlier is in Tally already and is never sent.</p>
          </div>
        </div>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={itemLines} onChange={(e) => setItemLines(e.target.checked)} disabled={!canSetUp} />
          <span>
            Send invoices with their item lines
            <span className="block text-xs text-subtle">Each line&apos;s item, HSN, quantity and rate, so Tally&apos;s GSTR-1 has its HSN summary. Untick for amounts by ledger only, when Tally keeps no stock.</span>
          </span>
        </label>
        {canSetUp && (
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            {msg && <span className={`text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MastersCard({ config, canSetUp }: { config: TallyConfig; canSetUp: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const upload = (file: File) =>
    start(async () => {
      setMsg(null);
      const form = new FormData();
      form.set("file", file);
      const r = await uploadTallyMasters(form);
      setMsg(r.ok ? { ok: true, text: `Read ${r.data.ledgers} ledgers and ${r.data.items} stock items.` } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Tally&apos;s own masters</CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted">
          So Deskzo uses the names Tally already has — and never creates &ldquo;Acme Ltd&rdquo; beside Tally&apos;s &ldquo;ACME LTD.&rdquo; — upload the masters from Tally: in
          TallyPrime, Display More Reports › List of Accounts, then Export (Alt+E) as XML.
        </p>
        <p className="text-xs text-subtle">
          {config.masters ? `${config.masters} masters from ${config.mastersFile ?? "the last upload"}${config.mastersAt ? `, ${new Date(config.mastersAt).toLocaleDateString("en-IN")}` : ""}.` : "None uploaded yet."} Upload again
          whenever the accountant adds ledgers in Tally.
        </p>
        {canSetUp && (
          <label className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-base border border-line-strong bg-surface px-3 text-sm font-medium text-text hover:bg-surface-sunken ${pending ? "pointer-events-none opacity-50" : ""}`}>
            <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
            {pending ? "Reading…" : "Upload Tally's masters (.xml)"}
            <input
              type="file"
              accept=".xml,text/xml,application/xml"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) upload(f);
              }}
            />
          </label>
        )}
        {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>}
      </CardContent>
    </Card>
  );
}

function AccountsCard({ accounts, canSetUp, hasMasters }: { accounts: AccountRow[]; canSetUp: boolean; hasMasters: boolean }) {
  const missing = accounts.filter((a) => a.how === "MISSING").length;
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>Accounts and their Tally ledgers</span>
        {missing > 0 ? <Badge tone="red">{missing} to match</Badge> : accounts.length > 0 ? <Badge tone="green">All matched</Badge> : null}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted">
          The accounts your invoices and receipts post to, each with the Tally ledger it goes to. An account whose name Tally has already is matched by itself; an
          export stops at one with no Tally ledger, and never guesses. Customers and items are matched by GSTIN and name, and any Tally hasn&apos;t got go as new
          masters.
        </p>
        {!hasMasters && <p className="text-xs text-warning">Upload Tally&apos;s masters first — matching by name needs them.</p>}
        {accounts.length === 0 ? (
          <p className="text-xs text-subtle">Nothing has been posted yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-subtle">
                  <th className="py-2 pr-3 font-medium">Deskzo account</th>
                  <th className="py-2 pr-3 font-medium">Tally ledger</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <AccountRowView key={a.id} a={a} canSetUp={canSetUp} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AccountRowView({ a, canSetUp }: { a: AccountRow; canSetUp: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(a.how === "MAPPED" ? (a.tallyName ?? "") : "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = (key: string, value: string) =>
    start(async () => {
      setErr(null);
      const r = await mapToTally({ key, tallyName: value });
      if (!r.ok) return setErr(r.error);
      router.refresh();
    });
  return (
    <tr className="border-b border-line align-top last:border-0">
      <td className="py-2 pr-3">
        <span className="text-text">{a.name}</span> <span className="text-xs text-subtle">{a.code}</span>
      </td>
      <td className="py-2 pr-3">
        {canSetUp ? (
          <div className="space-y-1">
            <Input list="tally-ledgers" aria-label={`Tally ledger for ${a.name}`} value={name} placeholder={a.how === "SAME NAME" ? `${a.tallyName} (same name)` : "Choose or type the Tally ledger"} onChange={(e) => setName(e.target.value)} onBlur={() => name !== (a.how === "MAPPED" ? (a.tallyName ?? "") : "") && save(`ACCOUNT:${a.id}`, name)} className="h-8 w-72 max-w-full text-sm" />
            {a.rates.length > 0 && (
              <details className="text-xs text-muted">
                <summary className="cursor-pointer">A ledger per GST rate in Tally?</summary>
                <div className="mt-1 space-y-1">
                  {a.rates.map((r) => (
                    <RateInput key={r.rate} id={a.id} rate={r.rate} value={r.tallyName ?? ""} onSave={save} />
                  ))}
                </div>
              </details>
            )}
          </div>
        ) : (
          <span className="text-text">{a.tallyName ?? "—"}</span>
        )}
        {err && <p className="text-xs text-danger">{err}</p>}
      </td>
      <td className="py-2 text-right">
        {pending ? <span className="text-xs text-muted">Saving…</span> : a.how === "MISSING" ? <Badge tone="red">Not matched</Badge> : <Badge tone="green">{a.how === "MAPPED" ? "Matched" : "Same name"}</Badge>}
      </td>
    </tr>
  );
}

function RateInput({ id, rate, value, onSave }: { id: string; rate: number; value: string; onSave: (key: string, v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <label className="flex items-center gap-2">
      <span className="w-12 text-right">{rate}%</span>
      <Input list="tally-ledgers" aria-label={`Tally ledger at ${rate}%`} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(`ACCOUNT:${id}@${rate}`, v)} placeholder="Same as above" className="h-7 w-64 max-w-full text-xs" />
    </label>
  );
}

function ExportCard({ config, defaultFrom, today }: { config: TallyConfig; defaultFrom: string; today: string }) {
  const router = useRouter();
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(today);
  const [check, setCheck] = useState<Check | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"check" | "make" | null>(null);
  const [, start] = useTransition();
  const run = (what: "check" | "make") =>
    start(async () => {
      setBusy(what);
      setMsg(null);
      if (what === "check") {
        const r = await checkTallyExport({ from, to });
        setBusy(null);
        if (!r.ok) return setMsg({ ok: false, text: r.error });
        setCheck(r.data);
      } else {
        const r = await makeTallyExport({ from, to });
        setBusy(null);
        if (!r.ok) return setMsg({ ok: false, text: r.error });
        setMsg({ ok: true, text: `Export ${r.data.exportSeq} made: ${r.data.vouchers} vouchers. Download both files below — masters first.` });
        setCheck(null);
        router.refresh();
      }
    });
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Send a period to Tally</CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          Each invoice, credit note, debit note and receipt goes once, in the first export that covers it. Check first: it shows what would go, and anything to fix.
          Purchases stay in Tally for now.
        </p>
        {!config.companyName && <p className="text-xs text-warning">Say which Tally company the files are for, above, first.</p>}
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="tally-from">From</Label>
            <Input id="tally-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="tally-to">To</Label>
            <Input id="tally-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => run("check")}>
            {busy === "check" ? "Checking…" : "Check"}
          </Button>
          <Button size="sm" disabled={busy !== null || !check || check.unmatched.length > 0 || check.vouchers === 0} onClick={() => run("make")}>
            {busy === "make" ? "Making…" : "Make the export"}
          </Button>
        </div>
        {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>}
        {check && (
          <div className="space-y-2 rounded-base border border-line bg-surface-sunken p-3 text-xs">
            <p className="text-text">
              {check.vouchers} voucher{check.vouchers === 1 ? "" : "s"} from {check.summary.from} to {check.summary.to}
              {check.summary.newParties || check.summary.newItems ? ` · new in Tally: ${check.summary.newParties} customers, ${check.summary.newItems} items` : ""}.
            </p>
            <SummaryTables summary={check.summary} />
            {check.unmatched.length > 0 && (
              <div className="text-danger">
                Match these accounts to Tally ledgers above first:
                <ul className="list-disc pl-5">
                  {check.unmatched.map((u) => (
                    <li key={u.key}>
                      {u.label} <span className="text-subtle">(first in {u.where})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {check.skipped.length > 0 && (
              <div className="text-warning">
                Left out:
                <ul className="list-disc pl-5">
                  {check.skipped.map((s, i) => (
                    <li key={i}>
                      {s.label}: {s.why}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {check.summary.withoutItems.length > 0 && (
              <div className="text-muted">
                Going with amounts only, not item lines:
                <ul className="list-disc pl-5">
                  {check.summary.withoutItems.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryTables({ summary }: { summary: ExportRow["summary"] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <table className="w-full">
        <caption className="pb-1 text-left text-subtle">By voucher type — tie with Tally&apos;s Day Book</caption>
        <tbody>
          {summary.byType.map((t) => (
            <tr key={t.type} className="border-t border-line">
              <td className="py-1 text-muted">{t.type}</td>
              <td className="py-1 tabular-nums">{t.count}</td>
              <td className="py-1 text-right tabular-nums">₹{inr(t.value)}</td>
              <td className="py-1 pl-2 text-subtle">
                {t.first}
                {t.last && t.last !== t.first ? ` – ${t.last}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full">
        <caption className="pb-1 text-left text-subtle">Sales by GST rate — tie with the Sales Register</caption>
        <tbody>
          {summary.taxByRate.map((r) => (
            <tr key={r.rate} className="border-t border-line">
              <td className="py-1 text-muted">{r.rate}%</td>
              <td className="py-1 text-right tabular-nums">₹{inr(r.taxable)}</td>
              <td className="py-1 pl-2 text-right tabular-nums text-subtle">{r.igst ? `IGST ₹${inr(r.igst)}` : `CGST ₹${inr(r.cgst)} · SGST ₹${inr(r.sgst)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExportsCard({ exports, canExport }: { exports: ExportRow[]; canExport: boolean }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const mark = (id: string) =>
    start(async () => {
      setErr(null);
      const r = await markTallyImported(id);
      if (!r.ok) return setErr(r.error);
      router.refresh();
    });
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Exports</CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-xs text-muted">
          In TallyPrime: Alt+O › Import › Masters with the masters file, then Transactions with the vouchers file. Compare the totals with the Day Book and the Sales
          Register, check Tally&apos;s Exceptions report, then mark the export imported here. Once a month, tie each customer&apos;s balance with Tally&apos;s outstandings.
        </p>
        {err && <p className="text-xs text-danger">{err}</p>}
        {exports.length === 0 ? (
          <p className="text-xs text-subtle">None yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {exports.map((x) => (
              <li key={x.id} className="space-y-1 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-text">Export {x.exportSeq}</span>
                  <span className="text-muted">
                    {x.from} to {x.to} · {x.vouchers} vouchers · {x.companyName}
                  </span>
                  {x.status === "IMPORTED" ? (
                    <Badge tone="green">Imported</Badge>
                  ) : (
                    <Badge tone={x.stale ? "red" : "default"}>{x.stale ? "Waiting for Tally — over a week" : "Waiting for Tally"}</Badge>
                  )}
                  <span className="ml-auto flex flex-wrap gap-2">
                    <a href={`/api/tally/exports/${x.id}/masters`} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                      <Download className="h-3 w-3" aria-hidden="true" />
                      1. Masters
                    </a>
                    <a href={`/api/tally/exports/${x.id}/vouchers`} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                      <Download className="h-3 w-3" aria-hidden="true" />
                      2. Vouchers
                    </a>
                    {canExport && x.status !== "IMPORTED" && (
                      <Button size="sm" variant="secondary" disabled={pending} onClick={() => mark(x.id)}>
                        Mark imported
                      </Button>
                    )}
                  </span>
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted">The totals to tie</summary>
                  <div className="mt-2">
                    <SummaryTables summary={x.summary} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
