"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { CloudDownload, LoaderCircle } from "lucide-react";
import { chooseZohoOrganisation, countZohoRecords, disconnectZoho, handOverZohoPull, saveZohoApp, setZohoDailyLimit, setZohoNightly, startZohoPull, stepZohoPull, stopZohoPull, zohoHandedPreview, zohoPullPreview, zohoState } from "@/actions/zoho";
import { ReceiptsCheck } from "@/components/settings/migration/receipts-check";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { confirmAction } from "@/components/ui/confirm";
import { CompletenessCheck } from "./completeness-check";
import { IrnsFromZoho } from "./irns-from-zoho";
import { noPdfsWhy } from "@/lib/zoho/archive-pdf-words";
import { GstFromZoho } from "./gst-from-zoho";

/**
 * Switch to Deskzo › Pull from Zoho Books (src/lib/zoho): the workspace's own Zoho app, connecting it, and the
 * pull — everything the backup brings, fetched through Zoho's API a few seconds at a time while the page is open,
 * within Zoho's limits, carrying on tomorrow when the day's calls are used.
 */

type State = Extract<Awaited<ReturnType<typeof zohoState>>, { ok: true }>["data"];
type Pull = NonNullable<State["pull"]>;

const OUTCOMES: Record<string, { tone: "success" | "error"; message: string }> = {
  connected: { tone: "success", message: "Connected to Zoho Books." },
  choose: { tone: "success", message: "Connected — choose which of the Zoho organisations to pull from." },
  declined: { tone: "error", message: "Zoho's access wasn't allowed, so nothing was connected." },
  expired: { tone: "error", message: "That sign-in took too long or came back to another session — connect again." },
  failed: { tone: "error", message: "Zoho refused the sign-in. Check the client id, secret, data centre and callback address, then connect again." },
  refused: { tone: "error", message: "Connecting to Zoho needs the rights to post journal entries and to import finance data." },
  "viewing-as": { tone: "error", message: "Stop viewing as somebody else before connecting to Zoho." },
  "no-app": { tone: "error", message: "Save the Zoho app's client id and secret first." },
};
/** The master lists handed on before the pull ends (src/lib/zoho/pull.ts handOver). */
const HANDED: Record<string, string> = { customers: "Customers", vendors: "Vendors", items: "Items" };
/** Fired by a section's "Pull this from Zoho" (switch-to-deskzo.tsx), so this panel picks the new pull up. */
export const PULL_STARTED = "deskzo:zoho-pull-started";
const listOf = (names: string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const STATUS: Record<string, string> = { FETCHING: "Fetching from Zoho", STORING: "Handing it to the steps", PDFS: "Fetching earlier years' PDFs", WAITING: "Waiting for Zoho", DONE: "Done", FAILED: "Stopped" };

export function ZohoPull() {
  const router = useRouter();
  const params = useSearchParams();
  const known = OUTCOMES[params.get("zoho") ?? ""];
  // What Zoho said, when it refused: its own error code or words, so the cause is plain.
  const why = params.get("why");
  const outcome = known && why ? { ...known, message: `${known.message} (${why})` } : known;
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  const [form, setForm] = useState({ dataCentre: "in", clientId: "", clientSecret: "" });
  const [editing, setEditing] = useState(false);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [counting, setCounting] = useState(false);
  const [since, setSince] = useState("");

  const count = async () => {
    setError(null);
    setCounting(true);
    try {
      const r = await countZohoRecords();
      if (!r.ok) setError(r.error);
      else setCounts(r.data);
    } catch {
      setError("Zoho couldn't be counted just now — try again.");
    } finally {
      setCounting(false);
    }
  };

  const load = useCallback(
    () =>
      start(async () => {
        try {
          const r = await zohoState();
          if (!r.ok) return setError(r.error);
          setState(r.data);
          if (r.data.app) setForm((f) => ({ ...f, dataCentre: r.data.app!.dataCentre, clientId: r.data.app!.clientId }));
          // The top-up starts, unless changed, from the day the backup came in.
          setSince((s) => s || r.data.lastUpload || "");
        } catch {
          setError("The Zoho connection couldn't be read — reload the page.");
        }
      }),
    [],
  );
  useEffect(load, [load]);
  // A section's "Pull this from Zoho" started one (switch-to-deskzo.tsx): show it, and drive it while the page is open.
  useEffect(() => {
    const started = () => load();
    window.addEventListener(PULL_STARTED, started);
    return () => window.removeEventListener(PULL_STARTED, started);
  }, [load]);
  // Each book module goes to its section the moment it is fetched: the page shows it as it lands.
  const handedBooks = state?.pull?.progress.booksHanded?.length ?? 0;
  const seenBooks = useRef(handedBooks);
  useEffect(() => {
    if (handedBooks > seenBooks.current) router.refresh();
    seenBooks.current = handedBooks;
  }, [handedBooks, router]);
  // With the page not driving it, the server is: its progress, every 15 seconds.
  const active = !!state?.pull && ["FETCHING", "STORING", "PDFS", "WAITING"].includes(state.pull.status);
  useEffect(() => {
    if (!active || running) return;
    const timer = setInterval(() => {
      zohoState()
        .then((r) => r.ok && setState((s) => (s ? { ...s, pull: r.data.pull } : s)))
        .catch(() => undefined);
    }, 15_000);
    return () => clearInterval(timer);
  }, [active, running]);

  const save = () =>
    start(async () => {
      setError(null);
      const r = await saveZohoApp(form);
      if (!r.ok) return setError(r.error);
      setEditing(false);
      setForm((f) => ({ ...f, clientSecret: "" }));
      load();
    });

  const pullLoop = async (first: Pull) => {
    setRunning(true);
    stop.current = false;
    let pull = first;
    try {
      while (!stop.current && ["FETCHING", "STORING", "PDFS"].includes(pull.status)) {
        const r = await stepZohoPull(pull.id);
        if (!r.ok) {
          setError(r.error);
          break;
        }
        pull = r.data;
        setState((s) => (s ? { ...s, pull } : s));
        // The server's tick has it this moment: look again in a few seconds rather than ask on top of it.
        if (pull.busy) await new Promise((done) => setTimeout(done, 5000));
      }
    } catch {
      setError("The pull stopped — the connection dropped. Press the button again to carry on.");
    } finally {
      setRunning(false);
      if (pull.status === "DONE") router.refresh();
    }
  };

  const pull = (mode: "full" | "topup" | "pdfs" = "full", everything = false) =>
    start(async () => {
      setError(null);
      // What was counted rides along, so the pull shows "150 of 412" as it goes.
      const r = await startZohoPull(Object.fromEntries((counts?.kinds ?? []).filter((k) => k.total !== null).map((k) => [k.key, k.total!])), { mode, since: mode === "topup" ? since : undefined, everything });
      if (!r.ok) return setError(r.error);
      setState((s) => (s ? { ...s, pull: r.data } : s));
      // A pull waiting for tomorrow carries on from where it got to.
      const go = r.data.status === "WAITING" ? { ...r.data, status: "FETCHING" } : r.data;
      void pullLoop(go);
    });

  if (!state) return <ActionNoticeRegion notice={error ? { tone: "error", message: error } : outcome ?? null} />;
  const p = state.pull;
  const showForm = !state.app || editing;

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-text">
          <CloudDownload className="h-4 w-4" aria-hidden="true" />
          Or pull it straight from Zoho Books
        </h3>
        {state.organisation && <Badge tone="green">{state.organisation.name}</Badge>}
      </div>
      <ActionNoticeRegion notice={error ? { tone: "error", message: error } : (outcome ?? null)} />

      {/* A pull still open holds Finish back; stopping it keeps what came and lets the switch finish (owner, 29 Oct 2026). */}
      {active && !running && p && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
          <span>
            A pull is still open — {STATUS[p.status]?.toLowerCase() ?? p.status}
            {state.connected ? "" : ", and Deskzo isn't connected to Zoho to finish it"}. Stop it to keep what came across and finish without the rest.
          </span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={async () => {
              if (!(await confirmAction("Stop the Zoho pull? What it brought across stays; the rest won't come unless you pull again."))) return;
              start(async () => {
                const r = await stopZohoPull();
                if (!r.ok) return setError(r.error);
                load();
                router.refresh();
              });
            }}
          >
            Stop the pull
          </Button>
        </div>
      )}

      {showForm ? (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
            <li>
              In Zoho&apos;s API console (api-console.zoho.{form.dataCentre === "ca" ? "ca" : form.dataCentre}), add a client: <strong className="text-text">Server-based Applications</strong>.
            </li>
            <li>
              Homepage URL: <code className="text-text">{state.homepage}</code> · Authorized Redirect URI: <code className="text-text">{state.callback}</code>
            </li>
            <li>Copy its client id and secret here. Deskzo asks Zoho for read access only, and keeps the secret encrypted.</li>
          </ol>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="zoho-dc">Data centre</Label>
              <Select id="zoho-dc" value={form.dataCentre} onChange={(e) => setForm({ ...form, dataCentre: e.target.value })}>
                {state.dataCentres.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="zoho-id">Client id</Label>
              <Input id="zoho-id" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} autoComplete="off" />
            </div>
            <div>
              <Label htmlFor="zoho-secret">Client secret</Label>
              <Input id="zoho-secret" type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} autoComplete="new-password" />
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={pending} onClick={save}>
              Save the app
            </Button>
            {state.app && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      ) : !state.connected ? (
        <div className="flex flex-wrap items-center gap-2">
          <a href="/api/zoho/connect" className="inline-flex h-8 items-center rounded-base bg-brand px-3 text-sm font-medium text-white hover:opacity-90">
            Connect to Zoho
          </a>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Change the app
          </Button>
        </div>
      ) : !state.organisation ? (
        <div className="space-y-2">
          <p className="text-sm text-text">Which organisation should Deskzo pull from?</p>
          <div className="flex flex-wrap gap-2">
            {state.organisations.map((o) => (
              <Button
                key={o.id}
                type="button"
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await chooseZohoOrganisation(o.id);
                    if (!r.ok) return setError(r.error);
                    load();
                  })
                }
              >
                {o.name}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            Brings everything the backup does — the master lists&apos; customers, vendors and items to the old-CRM import (when the super admin pulls), and the
            year&apos;s books, the open quotes and orders and the earlier years to the steps below. About {state.organisation.allowance.toLocaleString("en-IN")} of Zoho&apos;s
            calls a day; a big year takes more than one day. It keeps going on the server every few minutes — you can close this page, and it carries on by itself the day after Zoho&apos;s calls run out; with the page open it goes faster.
          </p>
          <DailyLimit organisation={state.organisation} onSaved={load} />
          <Nightly on={state.nightly.on} onSaved={load} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={pending || running} onClick={() => pull("full")}>
              {running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <CloudDownload className="h-3.5 w-3.5" aria-hidden="true" />}
              {p && ["FETCHING", "STORING", "PDFS", "WAITING"].includes(p.status) ? "Carry on pulling" : p?.status === "DONE" ? "Pull again" : "Pull from Zoho"}
            </Button>
            {/* "Pull again" brings only what changed since the last whole pull (owner, 23 Nov 2026 — "skip repeats"); this reads it all. */}
            {p && !["FETCHING", "STORING", "PDFS", "WAITING"].includes(p.status) && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending || running}
                title="Every record read again, every year — days of Zoho's calls"
                onClick={async () => {
                  if (!(await confirmAction("Read everything in Zoho again? Every year's invoices, quotes, receipts and bills are fetched again — several days of Zoho's calls, and the nightly top-up waits until it's done. \"Pull again\" brings only what changed."))) return;
                  pull("full", true);
                }}
              >
                Read everything again
              </Button>
            )}
            {running && (
              <Button type="button" size="sm" variant="ghost" onClick={() => (stop.current = true)}>
                Pause
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending || running}
              onClick={async () => {
                if (!(await confirmAction("Disconnect Deskzo from Zoho? What was pulled stays. Remove the app in Zoho's API console too."))) return;
                start(async () => {
                  const r = await disconnectZoho();
                  if (!r.ok) return setError(r.error);
                  load();
                });
              }}
            >
              Disconnect
            </Button>
          </div>
          {!(p && ["FETCHING", "STORING", "PDFS", "WAITING"].includes(p.status)) && (
            <div className="space-y-2 rounded-lg border border-line p-3">
              <p className="text-xs text-muted">
                Uploaded Zoho&apos;s backup already? Bring only what Zoho has created or changed since — added on top of the backup, a changed record replacing its
                backup copy. A few dozen calls, not days. Lists are read whole (they&apos;re cheap); only what changed is read in full.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="zoho-since">Changed since</Label>
                  <Input id="zoho-since" type="date" className="h-8" value={since} onChange={(e) => setSince(e.target.value)} />
                </div>
                <Button type="button" size="sm" variant="secondary" disabled={pending || running || !since} onClick={() => pull("topup")}>
                  Top up since the backup
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={pending || running || state.archivePdfs === 0} onClick={() => pull("pdfs")} title="Zoho's own PDFs of the earlier years' documents, one call each — the backup has none">
                  Fetch the archive&apos;s PDFs only{state.archivePdfs ? ` (${state.archivePdfs.toLocaleString("en-IN")})` : ""}
                </Button>
              </div>
              {state.archivePdfs === 0 && <p className="text-xs text-muted">{noPdfsWhy(state)}</p>}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={counting || pending} onClick={count}>
              {counting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              {counting ? "Counting what's in Zoho…" : counts ? "Count again" : "Count what's in Zoho"}
            </Button>
            {!counts && !counting && <span className="text-xs text-muted">See how many customers, invoices and the rest there are before pulling — about 30 of Zoho&apos;s calls.</span>}
          </div>
          {counts && <CountTable counts={counts} />}
          {/* Is everything in? Zoho's count beside Deskzo's, kind by kind (owner, 20 Nov 2026). */}
          <CompletenessCheck />
          {/* Invoices pulled without their IRN (owner, 21 Nov 2026) — asked of Zoho again. */}
          <IrnsFromZoho />
          {/* Items without a GST rate (owner, 21 Nov 2026) — read from their own Zoho record. */}
          <GstFromZoho />
          {p && <PullStatus pull={p} counted={counts} onChange={(next) => setState((s) => (s ? { ...s, pull: next } : s))} />}
          <ReceiptsCheck connected={state.connected} />
        </div>
      )}
    </div>
  );
}

/**
 * The night's top-up (owner, 29 Oct 2026; src/lib/zoho/nightly.ts): while Zoho stays the books, what it changed comes
 * across every night by itself — fetched, then imported section by section.
 */
function Nightly({ on, onSaved }: { on: boolean; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-1 rounded-lg border border-line p-3">
      <label className="flex items-start gap-2 text-sm text-text">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={on}
          disabled={pending}
          onChange={(e) => {
            const want = e.target.checked;
            start(async () => {
              setError(null);
              const r = await setZohoNightly(want);
              if (!r.ok) return setError(r.error);
              onSaved();
            });
          }}
        />
        <span>
          Top up every night
          <span className="block text-xs text-muted">
            Between 1 and 5 am, what Zoho created or changed since the last pull is fetched and imported into each section — invoices, receipts, bills and the rest —
            as you. One way, Zoho to Deskzo. A customer or vendor new in Zoho still needs importing (Import &amp; export, or the old-CRM import); what waits for
            them comes across the night after. Only what is dated before the switch day comes across — move the switch later to keep going.
          </span>
        </span>
      </label>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

type Counts = Extract<Awaited<ReturnType<typeof countZohoRecords>>, { ok: true }>["data"];

/**
 * Zoho's calls a day, as Zoho shows it (owner, 29 Oct 2026): the plan's unless the admin types the organisation's own —
 * Zoho can raise it past the plan's, and its plan name can't tell. Deskzo uses nine in ten of it.
 */
function DailyLimit({ organisation, onSaved }: { organisation: NonNullable<State["organisation"]>; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = (limit: number | null) =>
    start(async () => {
      setError(null);
      const r = await setZohoDailyLimit(limit);
      if (!r.ok) return setError(r.error);
      setEditing(false);
      onSaved();
    });
  const n = (v: number) => v.toLocaleString("en-IN");
  if (!editing) {
    return (
      <p className="text-xs text-muted">
        Zoho&apos;s calls a day: <span className="font-medium text-text">{n(organisation.limit)}</span>{" "}
        {organisation.typed ? "(as you set it)" : `(${organisation.plan ?? "this"} plan's)`} — Deskzo uses up to {n(organisation.allowance)}, leaving the rest for your team.{" "}
        <button
          type="button"
          className="font-medium text-brand hover:underline"
          onClick={() => {
            setTyped(String(organisation.limit));
            setEditing(true);
          }}
        >
          Change
        </button>
      </p>
    );
  }
  return (
    <div className="space-y-1.5 rounded-lg border border-line p-3">
      <Label htmlFor="zohoDailyLimit">Zoho&apos;s calls a day</Label>
      <p className="text-xs text-muted">As Zoho shows it under Settings › Developer Space › API usage. Zoho can raise it past the plan&apos;s {n(organisation.planLimit)}.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input id="zohoDailyLimit" type="number" inputMode="numeric" min={100} step={100} className="w-36" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <Button type="button" size="sm" disabled={pending || !typed.trim()} onClick={() => save(Number(typed))}>
          Save
        </Button>
        {organisation.typed && (
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => save(null)}>
            Use the plan&apos;s
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/** What Zoho holds, kind by kind, and about how long the pull will take on this plan. */
function CountTable({ counts }: { counts: Counts }) {
  const n = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-IN"));
  return (
    <div className="rounded-lg border border-line text-xs">
      <table className="w-full">
        <thead className="bg-surface-sunken text-left text-muted">
          <tr>
            <th className="px-3 py-1.5 font-medium">In Zoho</th>
            <th className="px-3 py-1.5 text-right font-medium">All</th>
            <th className="px-3 py-1.5 text-right font-medium">This year — into the books</th>
            <th className="px-3 py-1.5 text-right font-medium">Earlier — to the archive</th>
          </tr>
        </thead>
        <tbody>
          {counts.kinds.map((k) => (
            <tr key={k.key} className="border-t border-line">
              <td className="px-3 py-1 text-text">{k.label}</td>
              <td className="px-3 py-1 text-right tabular-nums text-text">{n(k.total)}</td>
              <td className="px-3 py-1 text-right tabular-nums text-muted">{k.thisYear === null ? "" : n(k.thisYear)}</td>
              <td className="px-3 py-1 text-right tabular-nums text-muted">{k.thisYear === null || k.total === null ? "" : n(Math.max(0, k.total - k.thisYear))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-3 py-2 text-muted">
        About {counts.calls.toLocaleString("en-IN")} of Zoho&apos;s calls to pull it all — {counts.days === 1 ? "within a day" : `about ${counts.days} days`} at {counts.allowance.toLocaleString("en-IN")} a day on this plan. Customers, quotes and orders are read
        one by one; earlier invoices and credit notes each bring their PDF. Expenses and journals before the year stay in the opening balances. A dash is a count Zoho didn&apos;t give.
      </p>
    </div>
  );
}

function PullStatus({ pull, counted, onChange }: { pull: Pull; counted: Counts | null; onChange: (pull: Pull) => void }) {
  // Hand over what has come so far (owner, 5 Nov 2026), without waiting for its module to finish.
  const [handing, startHanding] = useTransition();
  const [handError, setHandError] = useState<string | null>(null);
  const handOver = () =>
    startHanding(async () => {
      setHandError(null);
      const r = await handOverZohoPull(pull.id);
      if (!r.ok) return setHandError(r.error);
      if (r.data.busy) return setHandError("The pull is busy fetching this moment. Try again in a few seconds.");
      onChange(r.data);
    });
  const refusals = (pull.progress.booksHanded ?? []).filter((b) => b.refused.length > 0);
  // "150 of 412": what the pull was started with, else what was just counted.
  const expected: Record<string, number> = { ...Object.fromEntries((counted?.kinds ?? []).filter((k) => k.total !== null).map((k) => [k.key, k.total!])), ...(pull.progress.expected ?? {}) };
  const counts = Object.entries(pull.progress.counts ?? {});
  // Each section a module was handed to, once — journals takes three modules' (src/lib/zoho/pull.ts MODULE_STEPS).
  const handedSteps = [...new Map((pull.progress.booksHanded ?? []).flatMap((b) => b.steps).map((x) => [x.step, x] as const)).values()];
  return (
    <div className="rounded-lg border border-line px-3 py-2 text-xs" aria-live="polite">
      <p className="text-text">
        {STATUS[pull.status] ?? pull.status}
        {pull.status === "FETCHING" && pull.module ? ` — ${pull.module}` : ""} · {pull.callsToday.toLocaleString("en-IN")} of about {pull.allowance.toLocaleString("en-IN")} calls today
        {pull.status === "PDFS" && pull.progress.pdfsLeft !== undefined ? ` · ${pull.progress.pdfsLeft.toLocaleString("en-IN")} PDFs to go` : ""}
      </p>
      {pull.progress.note && <p className="mt-1 text-warning">{pull.progress.note}</p>}
      {pull.error && <p className="mt-1 text-danger">{pull.error}</p>}
      {counts.length > 0 && <p className="mt-1 text-muted">{counts.map(([k, v]) => `${v.toLocaleString("en-IN")}${expected[k] !== undefined ? ` of ${expected[k]!.toLocaleString("en-IN")}` : ""} ${k}`).join(" · ")}</p>}
      {Object.keys(pull.progress.alreadyIn ?? {}).length > 0 && (
        <p className="mt-1 text-muted">
          Already in Deskzo and unchanged in Zoho, so not read again:{" "}
          {Object.entries(pull.progress.alreadyIn ?? {})
            .map(([k, v]) => `${v.toLocaleString("en-IN")} ${k}`)
            .join(" · ")}
          .
        </p>
      )}
      {["FETCHING", "WAITING"].includes(pull.status) && !!pull.progress.handed?.length && (
        <p className="mt-1 text-text">
          {listOf(pull.progress.handed.map((k) => HANDED[k] ?? k))} {pull.progress.handed.length === 1 ? "is" : "are"} in the{" "}
          <Link href="/settings/data/old-crm" className="text-brand hover:underline">
            old-CRM import
          </Link>{" "}
          already — check and bring them across now.
        </p>
      )}
      {["FETCHING", "WAITING"].includes(pull.status) && !!pull.progress.booksHanded?.some((b) => b.steps.length) && (
        <p className="mt-1 text-text">
          In their sections already, ready to check and import while the rest is fetched:{" "}
          {pull.progress.booksHanded
            .flatMap((b) => b.steps)
            .map((x) => `${x.units.toLocaleString("en-IN")} ${x.step.replace(/-/g, " ")}`)
            .join(", ")}
          .
        </p>
      )}
      {refusals.map((b) => (
        <p key={b.module} className="mt-1 text-danger">
          {b.module} couldn&apos;t go to its section: {b.refused.join(" ")} What was fetched is kept, and goes when you hand over again.
        </p>
      ))}
      {["FETCHING", "WAITING"].includes(pull.status) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="secondary" disabled={handing} onClick={handOver}>
            {handing ? "Handing over…" : "Hand over what's fetched so far"}
          </Button>
          <span className="text-muted">Whole documents go to their sections now, to check and import. The rest is added as it comes.</span>
          {handError && <span className="text-danger">{handError}</span>}
        </div>
      )}
      {!!pull.progress.only?.length &&<p className="mt-1 text-muted">Pulling only what one section asked for — the rest of Zoho is left as it is.</p>}
      {(["FETCHING", "WAITING"].includes(pull.status) || handedSteps.length > 0) && <Fetched pullId={pull.id} tick={pull.callsToday} handed={handedSteps} />}
      {["PDFS", "DONE"].includes(pull.status) && <p className="mt-1 text-muted">Handed over — the files are in the old-CRM import and the steps below, waiting for you to check and bring them across.</p>}
    </div>
  );
}

type Preview = Extract<Awaited<ReturnType<typeof zohoPullPreview>>, { ok: true }>["data"];
type Section = NonNullable<Extract<Awaited<ReturnType<typeof zohoHandedPreview>>, { ok: true }>["data"]>;
/** The switch's sections, as its steps are named (src/lib/migration/steps.ts STEPS). */
const STEP_NAMES: Record<string, string> = {
  invoices: "Invoices",
  "credit-notes": "Credit notes",
  receipts: "Customer receipts",
  bills: "Bills",
  "vendor-credits": "Vendor credits",
  "vendor-payments": "Vendor payments",
  expenses: "Expenses",
  journals: "Manual journals",
  quotes: "Open quotes",
  "sales-orders": "Open sales orders",
  "purchase-orders": "Open purchase orders",
};
const FILE_NAMES: Record<string, string> = {
  "Contacts.csv": "Customers",
  "Vendors.csv": "Vendors",
  "Contact_Persons.csv": "Customer contacts",
  "Vendor_Contact_Persons.csv": "Vendor contacts",
  "Item.csv": "Items",
  "Chart_of_Accounts.csv": "Chart of accounts",
  "Invoice.csv": "Invoice lines",
  "Credit_Note.csv": "Credit note lines",
  "Creditnotes_Invoice.csv": "Credits applied",
  "Customer_Payment.csv": "Customer payments",
  "Bill.csv": "Bill lines",
  "Vendor_Credits.csv": "Vendor credit lines",
  "Vendor_Payment.csv": "Vendor payments",
  "Expense.csv": "Expenses",
  "Journal.csv": "Journal lines",
  "Quote.csv": "Quote lines",
  "Sales_Order.csv": "Sales order lines",
  "Purchase_Order.csv": "Purchase order lines",
  "Transfer_Fund.csv": "Transfers",
  "Refund.csv": "Refunds",
};

/**
 * What the pull has fetched so far, before anything is handed on: each file's count, and the newest 200 of the
 * one chosen — refreshed as the pull moves (`tick` is its calls so far). Beside it, what has been handed over
 * (owner, 5 Nov 2026: "also show what all is handed over"): each section's count, and the last 200 it holds. Seeing
 * either changes nothing.
 */
function Fetched({ pullId, tick, handed }: { pullId: string; tick: number; handed: { step: string; units: number }[] }) {
  const [file, setFile] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [section, setSection] = useState<{ step: string; data: Section | null } | null>(null);
  useEffect(() => {
    let live = true;
    zohoPullPreview(pullId, file)
      .then((r) => live && r.ok && setPreview(r.data))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [pullId, file, tick]);
  useEffect(() => {
    if (!step) return;
    let live = true;
    zohoHandedPreview(step)
      .then((r) => live && r.ok && setSection({ step, data: r.data }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [step, tick]);
  const fetched = preview?.files ?? [];
  if (fetched.length === 0 && handed.length === 0) return null;
  const chip = (on: boolean) => `rounded-full border px-2.5 py-0.5 ${on ? "border-brand bg-brand/10 text-text" : "border-line text-muted hover:text-text"}`;
  // A section chosen shows its file; else the fetched file chosen, as before.
  const held = step && section?.step === step ? section : null;
  const shown = step ? held?.data ?? null : preview;
  return (
    <div className="mt-2 space-y-2 border-t border-line pt-2">
      {fetched.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-muted">Fetched, not handed over yet</span>
          {fetched.map((f) => (
            <button
              key={f.file}
              type="button"
              onClick={() => {
                setStep(null);
                setFile(f.file);
              }}
              className={chip(!step && preview?.file === f.file)}
            >
              {FILE_NAMES[f.file] ?? f.file} <span className="tabular-nums">{f.rows.toLocaleString("en-IN")}</span>
            </button>
          ))}
        </div>
      )}
      {handed.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-muted">Handed over, in their sections</span>
          {handed.map((h) => (
            <button key={h.step} type="button" onClick={() => setStep(h.step)} className={chip(step === h.step)}>
              {STEP_NAMES[h.step] ?? h.step.replace(/-/g, " ")} <span className="tabular-nums">{h.units.toLocaleString("en-IN")}</span>
            </button>
          ))}
        </div>
      )}
      {shown && shown.rows.length > 0 && (
        <div className="max-h-80 overflow-auto rounded-lg border border-line">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-sunken text-left text-muted">
              <tr>
                {shown.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-2 py-1.5 font-medium">
                    {c === "GST Identification Number (GSTIN)" ? "GSTIN" : c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.rows.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  {r.map((v, j) => (
                    <td key={j} className="whitespace-nowrap px-2 py-1 text-text">
                      {v || <span className="text-subtle">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {step ? (
        !held ? (
          <p className="text-muted">Reading what the section holds…</p>
        ) : !held.data ? (
          <p className="text-muted">The section holds nothing from the pull now.</p>
        ) : (
          <p className="text-muted">
            {held.data.rows.length < held.data.units ? `The last ${held.data.rows.length.toLocaleString("en-IN")} of ${held.data.units.toLocaleString("en-IN")}` : `All ${held.data.units.toLocaleString("en-IN")}`} in the
            section, one row each, as handed over — check and import them in the section below. This year&apos;s only: earlier years went to the archive.
          </p>
        )
      ) : (
        preview &&
        preview.rows.length > 0 && <p className="text-muted">The newest {preview.rows.length.toLocaleString("en-IN")}, as fetched — nothing is in Deskzo until the pull hands it over and you bring it across.</p>
      )}
    </div>
  );
}
