"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Download, LoaderCircle, Upload } from "lucide-react";
import { chooseMigrationAccount, exportMigrationArchive, makeRestOfChartNew, migrationAccounts, migrationArchive, openArchivedDocuments, rematchMigrationArchive } from "@/actions/migration";
import { bringOpenedLinesFromZoho } from "@/actions/zoho";
import { csvRow } from "@/lib/csv";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Select } from "@/components/ui/input";

/**
 * Switch to Deskzo: the old system's whole backup at once, and its chart of accounts read as Deskzo's
 * (src/lib/migration/upload.ts, accounts.ts). The backup's files go to their steps; the chart's accounts are
 * each suggested a Deskzo one, which is confirmed, changed or made new here, before the steps are checked.
 */

export type UploadOutcome = {
  stored: { step: string; fileId: string; filename: string; files: string[]; units: number; zoho: boolean; unknown: string[] }[];
  refused: { step: string; files: string[]; error: string }[];
  archived: { kind: string; count: number }[];
  earlier: { step: string; rows: number }[];
  unreadable?: { step: string; rows: number; example: string }[];
  chart: { accounts: number; suggested: number; waiting: number } | null;
  left: string[];
};

/** Sends files to /api/migration/upload — for one step, or a whole backup to sort. */
export async function sendMigrationUpload(files: File[], step: string | null): Promise<{ ok: true; data: UploadOutcome } | { ok: false; error: string }> {
  const form = new FormData();
  if (step) form.set("step", step);
  for (const f of files) form.append("files", f);
  try {
    const res = await fetch("/api/migration/upload", { method: "POST", body: form });
    const body = (await res.json().catch(() => null)) as (UploadOutcome & { ok?: boolean; error?: string }) | null;
    if (!res.ok || !body?.ok) return { ok: false, error: body?.error ?? "That upload didn't go through — try again." };
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: "That upload didn't go through — check the connection and try again." };
  }
}

const ARCHIVE_WORDS: Record<string, string> = {
  QUOTE: "quotes",
  SALES_ORDER: "sales orders",
  INVOICE: "invoices",
  CREDIT_NOTE: "credit notes",
  CUSTOMER_PAYMENT: "payments received",
  PURCHASE_ORDER: "purchase orders",
  BILL: "bills",
  VENDOR_CREDIT: "vendor credits",
  VENDOR_PAYMENT: "payments made",
};

type Row = { id: string; name: string; code: string | null; type: string; parent: string | null; accountId: string | null; reason: string | null; created: boolean; canMake: boolean };
type Choice = { id: string; code: string; name: string };

export function BackupUpload({ stepLabels }: { stepLabels: Record<string, string> }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<UploadOutcome | null>(null);

  const upload = async (files: File[]) => {
    setError(null);
    setOutcome(null);
    setBusy(true);
    const r = await sendMigrationUpload(files, null);
    setBusy(false);
    if (input.current) input.current.value = "";
    if (!r.ok) return setError(r.error);
    setOutcome(r.data);
    router.refresh();
  };

  return (
    <div>
      <p className="text-sm text-muted">
        Zoho Books&apos; backup as it downloads (Settings › Backup), as a ZIP or its CSV files: each goes to its step below, the parts of a big one put back together, Transfer_Fund, Deposit and Refund with the
        manual journals, and Chart_of_Accounts to the old chart here. Contacts and items aren&apos;t read here — the old-CRM import&apos;s master lists bring them, and should come first.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input ref={input} type="file" multiple accept=".zip,.csv" className="sr-only" aria-label="Upload the backup" onChange={(e) => e.target.files?.length && upload([...e.target.files])} />
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Upload className="h-3.5 w-3.5" aria-hidden="true" />}
          {busy ? "Reading the backup…" : "Upload the backup"}
        </Button>
      </div>
      <div aria-live="polite" className="mt-2 space-y-1 text-xs">
        <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
        {outcome && (
          <ul className="space-y-1">
            {outcome.stored.map((s) => (
              <li key={s.step} className="text-text">
                {stepLabels[s.step] ?? s.step}: {s.units.toLocaleString("en-IN")} from {s.files.length === 1 ? s.files[0] : `${s.files.length} files`}
                {s.unknown.length > 0 && <span className="text-warning"> — columns not read: {s.unknown.join(", ")}</span>}
              </li>
            ))}
            {outcome.refused.map((s) => (
              <li key={s.step} className="text-danger">
                {stepLabels[s.step] ?? s.step}: {s.error}
              </li>
            ))}
            {outcome.chart && (
              <li className="text-text">
                Chart of accounts: {outcome.chart.accounts} accounts, {outcome.chart.suggested} matched{outcome.chart.waiting > 0 ? `, ${outcome.chart.waiting} to choose below` : ""}
              </li>
            )}
            {outcome.archived.length > 0 && (
              <li className="text-text">
                Kept to be read, not brought into the books: {outcome.archived.map((a) => `${a.count.toLocaleString("en-IN")} ${ARCHIVE_WORDS[a.kind] ?? a.kind.toLowerCase()}`).join(", ")} — from earlier years, and the quotes and orders Zoho shows finished. Each company&apos;s page shows its own.
              </li>
            )}
            {outcome.earlier.length > 0 && (
              <li className="text-muted">
                Left out as earlier years, already in the opening balances: {outcome.earlier.map((e) => `${e.rows.toLocaleString("en-IN")} ${(stepLabels[e.step] ?? e.step).toLowerCase()} rows`).join(", ")}.
              </li>
            )}
            {(outcome.unreadable ?? []).map((u) => (
              <li key={`bad-${u.step}`} className="text-danger">
                {stepLabels[u.step] ?? u.step}: {u.rows.toLocaleString("en-IN")} rows have a date Deskzo can&apos;t read, such as &ldquo;{u.example}&rdquo; — send that example to support.
              </li>
            ))}
            {outcome.left.length > 0 && <li className="text-muted">Not read here: {outcome.left.join(", ")}</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The old chart beside Deskzo's: each old account, what it's read as, and why. */
export function OldChart() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [showAll, setShowAll] = useState(false);
  const [confirmingRest, setConfirmingRest] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () =>
    start(async () => {
      try {
        const r = await migrationAccounts();
        if (!r.ok) return setError(r.error);
        setRows(r.data.rows);
        setChoices(r.data.choices);
      } catch {
        setError("The old chart couldn't be read — reload the page.");
      }
    });
  useEffect(load, []);

  const choose = (row: Row, choice: string) =>
    start(async () => {
      setError(null);
      try {
        const r = await chooseMigrationAccount(row.id, choice === "" ? null : choice);
        if (!r.ok) return setError(r.error);
        // A made account joins the list to choose from.
        if (choice === "new") {
          const again = await migrationAccounts();
          if (again.ok) {
            setRows(again.data.rows);
            setChoices(again.data.choices);
            return;
          }
        }
        setRows((all) => all?.map((x) => (x.id === row.id ? r.data : x)) ?? null);
      } catch {
        setError("That didn't go through — reload the page.");
      }
    });

  // Every waiting account made new at once (owner, 27 Oct 2026); the first press only asks.
  const makeRest = () => {
    if (!confirmingRest) return setConfirmingRest(true);
    setConfirmingRest(false);
    start(async () => {
      setError(null);
      setNotice(null);
      try {
        const r = await makeRestOfChartNew();
        if (!r.ok) return setError(r.error);
        const again = await migrationAccounts();
        if (again.ok) {
          setRows(again.data.rows);
          setChoices(again.data.choices);
        }
        const left = r.data.left.map((l) => `${l.name} (${l.why})`).join("; ");
        setNotice(`${r.data.made} made new in Deskzo's chart.${left ? ` Still to choose: ${left}.` : ""}`);
      } catch {
        setError("That didn't go through — reload the page.");
      }
    });
  };

  if (rows === null) return pending ? <p className="mt-3 text-xs text-muted">Reading the old chart…</p> : null;
  if (rows.length === 0) return <p className="mt-3 text-xs text-muted">No chart of accounts yet — it comes with the backup, or upload Chart_of_Accounts.csv on its own.</p>;
  const waiting = rows.filter((r) => !r.accountId).length;
  const makeable = rows.filter((r) => !r.accountId && r.canMake).length;
  const shown = showAll ? rows : rows.filter((r) => !r.accountId || r.reason);

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text">
          The old chart: {rows.length} accounts{" "}
          {waiting > 0 ? <Badge tone="amber">{waiting} to choose</Badge> : <Badge tone="green">all read as Deskzo&apos;s</Badge>}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {makeable > 0 && (
            <Button type="button" size="sm" variant={confirmingRest ? "primary" : "secondary"} disabled={pending} onClick={makeRest}>
              {confirmingRest ? `Make ${makeable} new — sure?` : "Make the rest new"}
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Only what needs a look" : "Show all"}
          </Button>
        </div>
      </div>
      {confirmingRest && (
        <p className="mt-1 text-xs text-muted">
          Each of the {makeable} still waiting becomes an account of its own under the group its Zoho type belongs in, as &quot;Make it new&quot; does. Pick one of Deskzo&apos;s first for any that already has a home, such as Automobile Expense as Fuel.
        </p>
      )}
      <p className="mt-1 text-xs text-muted">
        Every bill line, expense, journal and trial balance row that names an old account is read as the Deskzo account beside it. Two old accounts may be read as one; the month-end check adds them up.
      </p>
      <ActionNoticeRegion notice={error ? { tone: "error", message: error } : notice ? { tone: "success", message: notice } : null} />
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-xs text-muted">
            <tr>
              <th className="py-2 pr-3 font-medium">In the old system</th>
              <th className="py-2 pr-3 font-medium">Read as</th>
              <th className="py-2 font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-line align-top last:border-0">
                <td className="py-2 pr-3 text-text">
                  {r.name}
                  <span className="block text-xs text-muted">
                    {r.type}
                    {r.parent ? ` · under ${r.parent}` : ""}
                  </span>
                </td>
                <td className="py-2 pr-3">
                  <Select className="h-8 min-w-56" aria-label={`What ${r.name} is read as`} value={r.accountId ?? ""} disabled={pending} onChange={(e) => choose(r, e.target.value)}>
                    <option value="">Choose…</option>
                    {r.canMake && !r.accountId && <option value="new">Make it new in Deskzo&apos;s chart</option>}
                    {choices.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} · {c.name}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className={`py-2 text-xs ${r.accountId ? "text-muted" : "text-warning"}`}>{r.created ? "Made for it in Deskzo's chart" : (r.reason ?? "Chosen")}</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={3} className="py-4 text-center text-xs text-subtle">
                  Every account is read as one you chose.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type ArchiveState = {
  counts: { kind: string; count: number; unmatched: number }[];
  agree: number;
  differences: { kind: string; number: string; partyName: string; companyId: string | null; currency: string; zoho: number; deskzo: number | null; why: string }[];
};
/** An amount in the document's own currency — a dollar invoice's balance is dollars, not rupees (owner, 17 Nov 2026). */
const money = (n: number, currency: string) => {
  const figure = n.toLocaleString(currency === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "INR" ? `₹${figure}` : `${currency} ${figure}`;
};

/**
 * The earlier years kept to be read (src/lib/migration/archive.ts), and the per-company check: every earlier
 * invoice and bill the old system still shows owing is open in Deskzo for the same amount.
 */
/** A CSV handed to the browser to save, a byte-order mark first so Excel reads its rupee signs and names right. */
function saveCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff) + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function EarlierYears() {
  const [state, setState] = useState<ArchiveState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const load = () =>
    start(async () => {
      try {
        const r = await migrationArchive();
        if (!r.ok) return setError(r.error);
        setError(null);
        setState(r.data);
      } catch {
        setError("The earlier years couldn't be read — reload the page.");
      }
    });
  useEffect(load, []);

  if (!state) return pending ? <p className="text-xs text-muted">Reading the earlier years…</p> : <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />;
  if (state.counts.length === 0) return <p className="text-sm text-muted">Nothing yet — the earlier years come with Zoho&apos;s backup, kept apart from what is brought into the books.</p>;
  const unmatched = state.counts.reduce((t, c) => t + c.unmatched, 0);
  const notOpen = state.differences.filter((d) => d.deskzo === null).length;
  // As spreadsheets (owner, 29 Oct 2026: "export option here"): the companies to bring in, their documents, every one.
  const exportAs = (which: "companies" | "unmatched" | "all") =>
    start(async () => {
      try {
        const r = await exportMigrationArchive(which);
        if (!r.ok) return setError(r.error);
        setError(null);
        saveCsv(r.data.filename, r.data.csv);
      } catch {
        setError("The export didn't go through — reload the page.");
      }
    });
  const exportDifferences = () =>
    saveCsv(
      `earlier-years-to-look-at-${new Date().toISOString().slice(0, 10)}.csv`,
      [csvRow(["Company", "Document", "Number", "Currency", "Old system", "Deskzo", "Why"]), ...state.differences.map((d) => csvRow([d.partyName, d.kind === "BILL" ? "Bill" : "Invoice", d.number, d.currency, d.zoho, d.deskzo === null ? "" : d.deskzo, d.why]))].join("\n"),
    );
  // The ones still owing that Deskzo hasn't open, opened from the archive (owner, 27 Oct 2026).
  const openThem = () =>
    start(async () => {
      try {
        const r = await openArchivedDocuments();
        if (!r.ok) return setError(r.error);
        setError(null);
        const left = r.data.left.slice(0, 8).map((l) => `${l.number} (${l.party}): ${l.why}`).join("; ");
        setNotice(
          `${r.data.opened.toLocaleString("en-IN")} opened in Deskzo as they stood on the year's first day.${r.data.more ? " More to open — press again." : ""}${r.data.left.length ? ` Not opened (${r.data.left.length.toLocaleString("en-IN")}): ${left}${r.data.left.length > 8 ? "…" : ""}` : ""}`,
        );
        const again = await migrationArchive();
        if (again.ok) setState(again.data);
      } catch {
        setError("That didn't go through — reload the page.");
      }
    });
  // Their own lines in place of "Brought forward" (src/lib/migration/opened-lines.ts), forty seconds a call until done.
  const bringLines = () =>
    start(async () => {
      try {
        let brought = 0;
        const left: string[] = [];
        for (;;) {
          const r = await bringOpenedLinesFromZoho();
          if (!r.ok) return setError(r.error);
          setError(null);
          brought += r.data.brought;
          left.push(...r.data.left.map((l) => `${l.number} (${l.party}): ${l.why}`));
          const tail = r.data.stopped ?? (r.data.remaining ? `${r.data.remaining.toLocaleString("en-IN")} still to do — working…` : "");
          setNotice(
            brought || left.length || r.data.remaining
              ? `Their own lines are on ${brought.toLocaleString("en-IN")} opened invoice(s) and bill(s) now, in place of "Brought forward" — totals as they were.${left.length ? ` Left as they are (${left.length.toLocaleString("en-IN")}): ${left.slice(0, 8).join("; ")}${left.length > 8 ? "…" : ""}` : ""} ${tail}`.trim()
              : `None of the opened ones is still on a "Brought forward" line.`,
          );
          if (r.data.stopped || !r.data.remaining || (!r.data.brought && !r.data.left.length)) break;
        }
      } catch {
        setError("It stopped part-way; what's done is kept. Press it again to carry on.");
      }
    });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <ul className="flex flex-wrap gap-1.5">
          {state.counts.map((c) => (
            <li key={c.kind}>
              <Badge>
                {c.count.toLocaleString("en-IN")} {ARCHIVE_WORDS[c.kind] ?? c.kind.toLowerCase()}
              </Badge>
            </li>
          ))}
        </ul>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => exportAs("all")} title="Every earlier-year document kept, as a spreadsheet">
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          Export all
        </Button>
      </div>
      {unmatched > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-warning">{unmatched.toLocaleString("en-IN")} of them name a company Deskzo doesn&apos;t have yet — they find it once it comes in through the old-CRM import&apos;s master lists.</p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                try {
                  const r = await rematchMigrationArchive();
                  if (!r.ok) return setError(r.error);
                  setError(null);
                  setNotice(r.data.matched ? `${r.data.matched.toLocaleString("en-IN")} matched to their companies${r.data.left ? ` — ${r.data.left.toLocaleString("en-IN")} still name a company Deskzo doesn't have` : ""}.` : "None of them names a company Deskzo has yet.");
                  const again = await migrationArchive();
                  if (again.ok) setState(again.data);
                } catch {
                  setError("That didn't go through — reload the page.");
                }
              })
            }
          >
            Match the archive again
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => exportAs("companies")} title="One row a company — customer or vendor — with how many documents name it">
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            The companies
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => exportAs("unmatched")} title="The documents themselves">
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Their documents
          </Button>
        </div>
      )}
      {notice && <p className="text-xs text-text">{notice}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text">
          The per-company check: {state.agree.toLocaleString("en-IN")} earlier invoices and bills agree{" "}
          {state.differences.length > 0 ? <Badge tone="amber">{state.differences.length.toLocaleString("en-IN")} to look at</Badge> : <Badge tone="green">nothing to look at</Badge>}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {notOpen > 0 && (
            <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={openThem}>
              Open the ones still owing
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={bringLines}>
            Bring their own lines
          </Button>
          {state.differences.length > 0 && (
            <Button type="button" size="sm" variant="ghost" onClick={exportDifferences}>
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Export the {state.differences.length.toLocaleString("en-IN")}
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={load}>
            Check again
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted">
        What each still owes in the old system against what it owes in Deskzo, once the open-documents import and this year&apos;s payments are in. &quot;Open the ones still owing&quot; does the open-documents import from the archive: each as it stood on the year&apos;s first day — what it owes now plus what this year&apos;s files pay of it — posted against Opening Balance Equity. Leave those parties out of the opening trial balance&apos;s party rows, as the import asks.
        Each opens on one line, &quot;Brought forward&quot;; &quot;Bring their own lines&quot; puts its own on in its place — from the
        archive, else from Zoho, one call each — at their amounts before tax, with the tax and charges as billed on a line
        of their own, so its total, balance and opening entry stay as they are.
      </p>
      <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
      {state.differences.length > 0 && (
        <div className="max-h-96 overflow-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-sunken text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">Document</th>
                <th className="px-3 py-2 text-right font-medium">Old system</th>
                <th className="px-3 py-2 text-right font-medium">Deskzo</th>
                <th className="px-3 py-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {state.differences.slice(0, 500).map((d) => (
                <tr key={`${d.kind}:${d.partyName}:${d.number}`} className="border-t border-line align-top">
                  <td className="px-3 py-1.5 text-text">{d.partyName}</td>
                  <td className="px-3 py-1.5 text-text">
                    {d.kind === "BILL" ? "Bill" : "Invoice"} {d.number}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{money(d.zoho, d.currency)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{d.deskzo === null ? "—" : money(d.deskzo, d.currency)}</td>
                  <td className="px-3 py-1.5 text-xs text-warning">{d.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
