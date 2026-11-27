"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { CircleAlert, CircleCheck, CloudDownload, Download, LoaderCircle, RotateCcw, Upload } from "lucide-react";
import {
  addMigrationAdjustment,
  checkMigrationPart,
  finishMigrationAction,
  finishSalesOnlyAction,
  importMigrationPart,
  migrationTemplate,
  moveSwitchDayAction,
  retryMigrationWaiting,
  bringWaitingFromZoho,
  sectionUndoPreview,
  startMigrationAction,
  undoMigrationAction,
  undoMigrationSection,
} from "@/actions/migration";
import { startZohoPull } from "@/actions/zoho";
import { FREES, WAIT_LABELS, WAIT_WHERE, type WaitFor } from "@/lib/migration/sections";
import { BackupUpload, EarlierYears, OldChart, sendMigrationUpload } from "./old-chart";
import { PULL_STARTED, ZohoPull } from "./zoho-pull";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { useClock } from "@/components/time/clock-provider";
import { csvFilename, csvRow } from "@/lib/csv";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";

/**
 * Settings › Import & export › Switch to Deskzo (src/lib/migration): one screen from choosing the old system
 * to a finished, locked year. The steps run in order — the year's start; invoices, credit notes, receipts;
 * bills, vendor credits, vendor payments; expenses and manual journals; then the month-end check — and each
 * file goes in a part at a time, so a big year shows its progress and a closed tab carries on where it stopped.
 */

type MigrationRow = { id: string; source: string; yearStart: string; switchDate: string; status: "OPEN" | "FINISHED" | "UNDONE"; counts: Record<string, number> };
type Failure = { line: number; key: string; error: string; unit?: number; waitFor?: WaitFor };
type StepFile = { id: string; step: string; filename: string; units: number; done: number; failures: Failure[]; createdAt?: Date | string };
/** What the page knows of Zoho for the sections (page.tsx): connected, what a running pull still has to fetch. */
type ZohoSections = { connected: boolean; superAdmin: boolean; pulling: { status: string; module: string | null; coming: string[] } | null } | null;
type Masters = { customers: number; vendors: number; items: number } | null;

/** A section brought across: the sections whose waiting rows it frees are told, and try them again (`StepCard`). */
const IMPORTED = "deskzo:migration-imported";
type MonthCheck = { month: string; uploaded: boolean; agrees: boolean; accounts: number; differences: { accountId: string; code: string; name: string; deskzo: number; old: number; difference: number }[] };
type Adjustment = { id: string; entryNumber: string; date: string; reason: string; amount: number; debit: { code: string; name: string } | null; credit: { code: string; name: string } | null };
type Account = { id: string; code: string; name: string };

const STEPS = [
  { key: "invoices", modules: ["invoices"], label: "Invoices", units: "invoices", hint: "Every invoice from the start of the year to the day before the switch, paid or not — one row a line, as Zoho Books exports them. Void and draft ones are left behind." },
  { key: "credit-notes", modules: ["creditnotes"], label: "Credit notes", units: "credit notes", hint: "Each names the invoice it reduces, which must already be here. It's applied to that invoice — by the amount the file says, else by what the invoice still owed." },
  { key: "receipts", modules: ["customerpayments"], label: "Customer receipts", units: "payments", hint: "One row an invoice a payment paid, as Zoho Books exports customer payments. What isn't applied to an invoice stays on account." },
  {
    key: "bills",
    modules: ["bills"],
    label: "Bills",
    units: "bills",
    hint: "Every vendor bill in the year, one row a line. Each line goes to the account the old system posted it to (Account), Purchases when blank — so add any account Deskzo's chart lacks first. Numbered in Deskzo's bill series; the vendor's own number is kept as the reference. TDS at the file's rate.",
  },
  { key: "vendor-credits", modules: ["vendorcredits"], label: "Vendor credits", units: "vendor credits", hint: "Credits and debit notes from vendors, one row a line, each to its account (Purchase Rebates when blank). Set against the bill each names, by the vendor's number for it." },
  { key: "vendor-payments", modules: ["vendorpayments"], label: "Vendor payments", units: "vendor payments", hint: "One row a bill a payment settled, as Zoho Books exports vendor payments; what isn't applied stays as an advance. Paid through the bank account named, or cash." },
  { key: "expenses", modules: ["expenses"], label: "Expenses", units: "expenses", hint: "What was paid without a bill — rent, travel, subscriptions — each as a payment voucher: its expense account, its input tax, and the account it was paid through." },
  {
    key: "journals",
    modules: ["journals", "banking", "refunds"],
    label: "Manual journals",
    units: "journals",
    hint: "Journals written by hand, one row a line, each as a voucher of its kind. Anything else the old system posted that no file here brings — a fund transfer, a deposit, a stock adjustment — can go in this file, so the months agree.",
  },
  { key: "quotes", modules: ["estimates"], label: "Open quotes", units: "quotes", hint: "Quotes still open on the day of the switch — drafts, sent and accepted ones — as Deskzo proposals with their own numbers, ready to convert. Invoiced, declined and expired ones stay behind. Nothing here is posted." },
  { key: "sales-orders", modules: ["salesorders"], label: "Open sales orders", units: "sales orders", hint: "Sales orders not yet invoiced, as Deskzo proformas — for what is left of each line when part of it was invoiced. Invoiced, closed and void ones stay behind." },
  { key: "purchase-orders", modules: ["purchaseorders"], label: "Open purchase orders", units: "purchase orders", hint: "Purchase orders not yet billed, as Deskzo vendor POs — for what is left of each line. Billed, closed and cancelled ones stay behind." },
] as const;

const money = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A balance as an accountant reads one: the amount, then Dr or Cr. */
const drCr = (n: number) => (Math.abs(n) < 0.005 ? "—" : `${money(Math.abs(n))} ${n > 0 ? "Dr" : "Cr"}`);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MONTH_NAMES[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

/** A trial balance by the upload route, which takes a file a server action can't (src/app/api/migration/upload). */
async function sendBalances(f: File, month: string): Promise<{ ok: true; data: { failed: { line: number; error: string }[] } } | { ok: false; error: string }> {
  const form = new FormData();
  form.append("kind", "balances");
  if (month) form.append("month", month);
  form.append("files", f);
  try {
    const res = await fetch("/api/migration/upload", { method: "POST", body: form });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: { failed: { line: number; error: string }[] }; error?: string } | null;
    if (!res.ok || !body?.ok || !body.data) return { ok: false, error: body?.error ?? `The upload didn't go through (${res.status}).` };
    return { ok: true, data: body.data };
  } catch {
    return { ok: false, error: "The upload didn't go through — check the connection and try again." };
  }
}

async function downloadTemplate(step: string, setError: (e: string | null) => void) {
  const result = await migrationTemplate(step);
  if (!result.ok) return setError(result.error);
  const url = URL.createObjectURL(new Blob([result.data.csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = result.data.filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function SwitchToDeskzo(props: {
  migration: MigrationRow | null;
  latest: MigrationRow | null;
  sources: { value: string; label: string }[];
  defaults: { yearStart: string; switchDate: string };
  files: StepFile[];
  months: MonthCheck[];
  adjustments: Adjustment[];
  accounts: Account[];
  canFinish: boolean;
  /** The steps the plan has room for (src/lib/migration/steps.ts `stepsInPlan`). */
  steps: string[];
  zoho?: ZohoSections;
  masters?: Masters;
}) {
  if (!props.migration) return <StartForm sources={props.sources} defaults={props.defaults} latest={props.latest} />;
  const m = props.migration;
  const agreed = props.months.length > 0 && props.months.every((x) => x.agrees);
  const steps = STEPS.filter((s) => props.steps.includes(s.key));
  // The month-end check comes after the start, the backup, the steps and the earlier years.
  const checkSection = steps.length + 4;
  return (
    <div className="space-y-5">
      <Summary migration={m} sources={props.sources} />
      <Section number={1} title="The start of the year" done={false}>
        <p className="text-sm text-text">Bring what the company had on {dayLabel(m.yearStart)} first, with today&apos;s imports, starting the books on {dayLabel(m.yearStart)}:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
          <li>
            Its balances: the trial balance as on the day before, from{" "}
            <Link href="/accounting/journal" className="text-brand hover:underline">
              Accounting › Journal › Import opening balances
            </Link>
            .
          </li>
          <li>
            Invoices from before {dayLabel(m.yearStart)} still unpaid on it, with what was left on them then, from{" "}
            <Link href="/sales/invoices" className="text-brand hover:underline">
              Sales › Tax Invoices › Import
            </Link>{" "}
            — and those customers left out of the trial balance&apos;s party rows.
          </li>
          <li>
            Bills from before {dayLabel(m.yearStart)} still unpaid on it, the same way, from{" "}
            <Link href="/purchase/bills" className="text-brand hover:underline">
              Purchase › Vendor bills › Import
            </Link>
            .
          </li>
        </ul>
      </Section>
      <Section number={2} title={m.source === "zoho-books" ? "Zoho's backup and chart of accounts" : "The old chart of accounts"} done={false}>
        {m.source === "zoho-books" ? (
          <>
            <BackupUpload stepLabels={Object.fromEntries(STEPS.map((s) => [s.key, s.label]))} />
            <Suspense fallback={null}>
              <ZohoPull />
            </Suspense>
          </>
        ) : (
          <p className="text-sm text-muted">The accounts each file names are found in Deskzo&apos;s chart by code, then by name. Add the ones it lacks under Accounting › Chart of accounts first.</p>
        )}
        <OldChart />
        {props.zoho?.connected && <PullOnly modules={["chart"]} label="the chart of accounts" coming={props.zoho.pulling?.coming.includes("chart") ?? false} pulling={!!props.zoho.pulling} />}
      </Section>
      {props.masters && <MastersCard masters={props.masters} zoho={props.zoho ?? null} />}
      <NextUp files={props.files} steps={steps.map((s) => s.key)} />
      {steps.map((s, i) => (
        <StepCard
          key={s.key}
          number={i + 3}
          step={s}
          file={props.files.find((f) => f.step === s.key) ?? null}
          count={m.counts[s.key] ?? 0}
          zoho={props.zoho ?? null}
        />
      ))}
      <Section number={checkSection - 1} title="Earlier years" done={false}>
        <EarlierYears />
        {/* Delivery challans go to the archive whatever their year (owner, 16 Nov 2026 — src/lib/migration/archive.ts): a pull run before they were fetched brings them on their own. */}
        {props.zoho?.connected && !props.zoho.pulling && (
          <p className="mt-3 text-xs text-muted">
            <PullMaster module="deliverychallans" label="delivery challans" /> — every challan, kept here to read.
          </p>
        )}
        {/* The earlier years' quotes by themselves (owner, 25 Nov 2026): a part-fetched pull of the quotes had taken them out. */}
        {props.zoho?.connected && !props.zoho.pulling && (
          <p className="mt-2 text-xs text-muted">
            <PullMaster module="estimates" label="the earlier years' quotes" earlier /> — every quote dated before {dayLabel(m.yearStart)}, added to what&apos;s here: its number, date, customer, status and total. From
            Zoho&apos;s list, one call per 200, so without their lines; their PDFs come with &ldquo;Fetch the archive&apos;s PDFs only&rdquo;, a call each.
          </p>
        )}
      </Section>
      <BalancesCard number={checkSection} months={props.months} />
      <DifferencesCard number={checkSection + 1} months={props.months} adjustments={props.adjustments} accounts={props.accounts} />
      <FinishCard
        number={checkSection + 2}
        migration={m}
        agreed={agreed}
        canFinish={props.canFinish}
        waiting={props.files.reduce((n, f) => n + f.failures.filter((x) => x.waitFor).length, 0)}
        pulling={!!props.zoho?.pulling}
      />
    </div>
  );
}

function Section({ number, title, done, children, actions }: { number: number; title: string; done: boolean; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-surface-sunken text-[11px] text-muted" aria-hidden="true">
            {number}
          </span>
          {title}
          {done && <CircleCheck className="h-4 w-4 text-success" aria-label="Done" />}
        </h2>
        {actions}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function StartForm({ sources, defaults, latest }: { sources: { value: string; label: string }[]; defaults: { yearStart: string; switchDate: string }; latest: MigrationRow | null }) {
  const router = useRouter();
  const [source, setSource] = useState(sources[0]?.value ?? "zoho-books");
  const [yearStart, setYearStart] = useState(defaults.yearStart);
  const [switchDate, setSwitchDate] = useState(defaults.switchDate);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-text">Bring this financial year across</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted">
          For a company moving to Deskzo partway through its year. Its invoices, credit notes and receipts come across on their own dates with their own
          numbers, and every month is checked against the old system&apos;s trial balance. Until it&apos;s finished, Undo takes all of it back.
        </p>
        {latest && latest.status !== "OPEN" && (
          <p className="text-xs text-muted">
            The last one, {dayLabel(latest.yearStart)} to {dayLabel(latest.switchDate)}, was {latest.status === "FINISHED" ? "finished" : "undone"}.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="mig-source">Moving from</Label>
            <Select id="mig-source" value={source} onChange={(e) => setSource(e.target.value)}>
              {sources.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mig-year">The year started on</Label>
            <Input id="mig-year" type="date" value={yearStart} onChange={(e) => setYearStart(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mig-switch">First day in Deskzo</Label>
            <Input id="mig-switch" type="date" value={switchDate} onChange={(e) => setSwitchDate(e.target.value)} />
            <p className="text-xs text-muted">The first of a month.</p>
          </div>
        </div>
        <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await startMigrationAction({ source, yearStart, switchDate });
              if (!r.ok) return setError(r.error);
              router.refresh();
            })
          }
        >
          {pending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Start
        </Button>
      </CardContent>
    </Card>
  );
}

function Summary({ migration, sources }: { migration: MigrationRow; sources: { value: string; label: string }[] }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const brought = Object.entries(migration.counts).filter(([, n]) => n > 0);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-warning/40 bg-warning-bg/40 px-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-text">
          Bringing {dayLabel(migration.yearStart)} to the day before {dayLabel(migration.switchDate)} across from {sources.find((s) => s.value === migration.source)?.label ?? migration.source}
        </p>
        <p className="text-xs text-muted">
          {brought.length ? `So far: ${brought.map(([k, n]) => `${n.toLocaleString("en-IN")} ${STEPS.find((s) => s.key === k)?.units ?? k.replace(/-/g, " ")}`).join(", ")}. ` : "Nothing brought yet. "}
          Accounting reports say their figures aren&apos;t final until it&apos;s finished.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <MoveSwitchDay migration={migration} />
        <Button type="button" variant="ghost" size="sm" className="text-danger hover:bg-danger-bg hover:text-danger" onClick={() => setConfirming(true)}>
          Undo all of it
        </Button>
      </div>
      <Dialog open={confirming} onClose={() => !pending && setConfirming(false)} title="Undo the migration">
        <div className="space-y-4">
          <p className="text-sm text-text">Every invoice, bill, credit, payment, expense, journal and entry it brought is taken back, and it&apos;s marked undone. You can start again after.</p>
          <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
              Keep it
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await undoMigrationAction();
                  if (!r.ok) return setError(r.error);
                  setConfirming(false);
                  router.refresh();
                })
              }
            >
              {pending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Undo all of it
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * The switch moved later (owner, 29 Oct 2026: Zoho stays the books a few months while Deskzo is tried) — the first of a
 * later month, up to the financial year's end. What the old system dates after the old day then comes across too.
 */
function MoveSwitchDay({ migration }: { migration: MigrationRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const last = `${Number(migration.yearStart.slice(0, 4)) + 1}-04-01`;
  const later: string[] = [];
  for (let [y, m] = migration.switchDate.split("-").map(Number) as [number, number]; ; ) {
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
    const day = `${y}-${String(m).padStart(2, "0")}-01`;
    if (day > last) break;
    later.push(day);
  }
  const [chosen, setChosen] = useState(later[0] ?? "");
  if (!later.length) return null;
  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Move the switch later
      </Button>
      <Dialog open={open} onClose={() => !pending && setOpen(false)} title="Move the switch later">
        <div className="space-y-4">
          <p className="text-sm text-text">
            Keep working in the old system longer: the year brought across runs to the day before the new switch, so what it dates after{" "}
            {dayLabel(migration.switchDate)} comes across too — with each top-up from Zoho. Nothing brought so far changes. It can only move later.
          </p>
          <div>
            <Label htmlFor="switch-later">Switch to Deskzo on</Label>
            <Select id="switch-later" value={chosen} onChange={(e) => setChosen(e.target.value)}>
              {later.map((d) => (
                <option key={d} value={d}>
                  {dayLabel(d)}
                </option>
              ))}
            </Select>
          </div>
          <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Keep {dayLabel(migration.switchDate)}
            </Button>
            <Button
              type="button"
              disabled={pending || !chosen}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await moveSwitchDayAction(chosen);
                  if (!r.ok) return setError(r.error);
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              {pending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Move to {chosen ? dayLabel(chosen) : "…"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

type Outcome = { kind: "create"; label: string; detail: string } | { kind: "skip"; label: string; why: string } | { kind: "error"; label: string; line: number; error: string };

/**
 * "Pull this from Zoho" (owner, 28 Oct 2026): a pull of only this section's modules, which hands them to it the moment
 * they are fetched. One pull at a time — while one runs, it says whether this section is still to come in it.
 *
 * A section that already has its file — the backup's, uploaded — is topped up (owner, 29 Oct 2026): only what Zoho has
 * created or changed on or after `since` is fetched, and added to the file rather than replacing it, so Zoho's daily
 * calls aren't spent on what is here already. The day starts at when the file came, and can be moved earlier — to the
 * day the backup was taken. Fetching all of it again stays a smaller choice beside it.
 */
function PullOnly({ modules, label, coming, pulling, since: from }: { modules: string[]; label: string; coming: boolean; pulling: boolean; since?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [since, setSince] = useState(from ?? "");
  if (pulling) {
    return <p className="mt-2 text-xs text-muted">{coming ? `Being fetched from Zoho — ${label} land here as soon as they are.` : "A pull from Zoho is running; this section isn't in it."}</p>;
  }
  const pull = (mode: "full" | "topup") =>
    start(async () => {
      setError(null);
      const r = await startZohoPull({}, { only: modules, mode, since: mode === "topup" ? since : undefined });
      if (!r.ok) return setError(r.error);
      window.dispatchEvent(new Event(PULL_STARTED));
      router.refresh();
    });
  const icon = pending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <CloudDownload className="h-3.5 w-3.5" aria-hidden="true" />;
  if (from) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <Button type="button" size="sm" variant="ghost" disabled={pending || !since} onClick={() => pull("topup")}>
          {icon}
          Pull new and changed {label} from Zoho since
        </Button>
        <Input type="date" value={since} onChange={(e) => setSince(e.target.value)} className="h-8 w-40" aria-label={`Since when to pull new and changed ${label}`} />
        <span className="text-muted">— added to what&apos;s here.</span>
        <button type="button" disabled={pending} onClick={() => pull("full")} className="text-muted hover:text-text hover:underline disabled:opacity-50">
          or pull all of them again
        </button>
        <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
      </div>
    );
  }
  return (
    <div className="mt-2">
      <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => pull("full")}>
        {icon}
        Pull {label} from Zoho
      </Button>
      <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
    </div>
  );
}

/**
 * The customers, vendors and items the books name (owner, 28 Oct 2026): brought in by the imports that bring them —
 * Zoho's Contacts.csv and Vendors.csv go straight into Import & export — or pulled from Zoho to the old-CRM import's
 * master lists. Their counts here, so an invoice waiting for its customer says where to go.
 */
function MastersCard({ masters, zoho }: { masters: NonNullable<Masters>; zoho: ZohoSections }) {
  const rows: { key: string; label: string; count: number; module: string; file: string }[] = [
    { key: "customers", label: "Customers", count: masters.customers, module: "customers", file: "Contacts.csv" },
    { key: "vendors", label: "Vendors", count: masters.vendors, module: "vendors", file: "Vendors.csv" },
    { key: "items", label: "Items", count: masters.items, module: "items", file: "Item.csv" },
  ];
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-text">Customers, vendors and items</h2>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted">
          What the invoices and bills name. Bring them first, or any time: an invoice whose customer isn&apos;t here yet waits for it, and is tried again once it is.
        </p>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="text-text">
                {r.label} <Badge tone={r.count ? "green" : "default"}>{r.count ? `${r.count.toLocaleString("en-IN")} in Deskzo` : "None yet"}</Badge>
              </span>
              <span className="flex flex-wrap items-center gap-3 text-xs">
                <Link href="/settings/data" className="text-brand hover:underline">
                  Upload Zoho&apos;s {r.file} in Import &amp; export
                </Link>
                {zoho?.connected && zoho.superAdmin && !zoho.pulling && <PullMaster module={r.module} label={r.label.toLowerCase()} />}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">
          Pulled from Zoho, the lists go to the{" "}
          <Link href="/settings/data/old-crm" className="text-brand hover:underline">
            old-CRM import
          </Link>
          &apos;s master lists, matched against what Deskzo has, to check and bring across.
        </p>
      </CardContent>
    </Card>
  );
}

function PullMaster({ module, label, earlier = false }: { module: string; label: string; earlier?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        type="button"
        disabled={pending}
        className="inline-flex items-center gap-1 text-brand hover:underline disabled:opacity-50"
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await startZohoPull({}, { only: [module], ...(earlier ? { earlier } : {}) });
            if (!r.ok) return setError(r.error);
            window.dispatchEvent(new Event(PULL_STARTED));
            router.refresh();
          })
        }
      >
        <CloudDownload className="h-3.5 w-3.5" aria-hidden="true" />
        Pull {label} from Zoho
      </button>
      {error && <span className="ml-2 text-danger">{error}</span>}
    </span>
  );
}

/** What to do next: the sections with rows waiting, and what they wait for (src/lib/migration/sections.ts). */
function NextUp({ files, steps }: { files: StepFile[]; steps: string[] }) {
  const waiting = new Map<WaitFor, { n: number; sections: Set<string> }>();
  for (const file of files) {
    for (const f of file.failures) {
      if (!f.waitFor) continue;
      const w = waiting.get(f.waitFor) ?? { n: 0, sections: new Set<string>() };
      w.n += 1;
      w.sections.add(STEPS.find((s) => s.key === file.step)?.label ?? file.step);
      waiting.set(f.waitFor, w);
    }
  }
  if (waiting.size === 0) return null;
  return (
    <div className="rounded-xl border border-warning/40 bg-warning-bg/40 px-4 py-3 text-sm" role="status">
      <p className="font-medium text-text">Next</p>
      <ul className="mt-1 space-y-1 text-text">
        {[...waiting].map(([w, { n, sections }]) => {
          const where = WAIT_WHERE[w];
          const step = where.step && steps.includes(where.step) ? STEPS.find((s) => s.key === where.step) : undefined;
          return (
            <li key={w}>
              {n.toLocaleString("en-IN")} {n === 1 ? "row" : "rows"} in {[...sections].join(", ")} {n === 1 ? "waits" : "wait"} for {WAIT_LABELS[w]}. {step ? `${where.how} (section “${step.label}” below).` : where.how}
              {where.href && (
                <>
                  {" "}
                  <Link href={where.href} className="text-brand hover:underline">
                    Go there
                  </Link>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StepCard({ number, step, file: initial, count, zoho }: { number: number; step: (typeof STEPS)[number]; file: StepFile | null; count: number; zoho: ZohoSections }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<StepFile | null>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ creates: number; skips: number; errors: { line: number; label: string; error: string }[] } | null>(null);
  const [failures, setFailures] = useState<Failure[]>(initial?.failures ?? []);
  // The server's word wins when the page is drawn again — a pull handed this section a new file, or it was undone.
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    setFile(initial);
    setFailures(initial?.failures ?? []);
  }
  const done = !!file && file.done >= file.units;
  const waiting = failures.filter((f) => f.waitFor);
  const failed = failures.filter((f) => !f.waitFor);
  const waitsFor = [...new Set(waiting.map((f) => f.waitFor!))];
  const coming = zoho?.pulling?.coming.includes(step.key) ?? false;

  const upload = async (f: File) => {
    setError(null);
    setChecked(null);
    setBusy("Reading the file…");
    try {
      const r = await sendMigrationUpload([f], step.key);
      if (!r.ok) return setError(r.error);
      const kept = r.data.stored[0];
      if (!kept) return setError(r.data.refused[0]?.error ?? "That file has nothing in it to bring across.");
      setFile({ id: kept.fileId, step: step.key, filename: f.name, units: kept.units, done: 0, failures: [] });
      setFailures([]);
      if (kept.unknown.length) setError(`Columns not read: ${kept.unknown.join(", ")}. Check the headings against the template.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file couldn't be read.");
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    if (!file) return;
    setError(null);
    const tally = { creates: 0, skips: 0, errors: [] as { line: number; label: string; error: string }[] };
    for (let offset = 0; offset < file.units; ) {
      setBusy(`Checking ${offset.toLocaleString("en-IN")} of ${file.units.toLocaleString("en-IN")}…`);
      const r = await checkMigrationPart(file.id, offset);
      if (!r.ok) {
        setBusy(null);
        return setError(r.error);
      }
      for (const o of r.data.outcomes as Outcome[]) {
        if (o.kind === "create") tally.creates += 1;
        else if (o.kind === "skip") tally.skips += 1;
        else tally.errors.push({ line: o.line, label: o.label, error: o.error });
      }
      offset = r.data.next;
    }
    setChecked(tally);
    setBusy(null);
  };

  /** Brought across, a part at a time from where it stopped — then whoever waits for this section is told. */
  const importAll = async (from: StepFile | null = file) => {
    if (!from) return;
    setError(null);
    let current = from;
    while (current.done < current.units) {
      setBusy(`Bringing ${current.done.toLocaleString("en-IN")} of ${current.units.toLocaleString("en-IN")} across…`);
      const r = await importMigrationPart(current.id);
      if (!r.ok) {
        setBusy(null);
        return setError(r.error);
      }
      current = { ...current, done: r.data.done };
      setFile(current);
      setFailures(r.data.failed);
    }
    setBusy(null);
    window.dispatchEvent(new CustomEvent(IMPORTED, { detail: step.key }));
    router.refresh();
  };

  /**
   * "Bring these from Zoho" (owner, 26 Nov 2026): the customers or vendors the waiting rows name, found in Zoho and brought
   * in (src/lib/zoho/waiting-parties.ts) — then those rows tried again.
   */
  const [brought, setBrought] = useState<string | null>(null);
  const bringFromZoho = async (w: "customers" | "vendors", n: number) => {
    if (!file) return;
    setError(null);
    setBrought(null);
    setBusy(`Finding ${n.toLocaleString("en-IN")} ${w} in Zoho…`);
    const r = await bringWaitingFromZoho(file.id, w);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    const d = r.data;
    const said = [
      d.created.length ? `${d.created.length} brought from Zoho` : null,
      d.linked.length ? `${d.linked.length} joined to ones Deskzo had` : null,
      d.notInZoho.length ? `not in Zoho by that name: ${d.notInZoho.join(", ")} — correct the name in Deskzo or add it by hand` : null,
      ...d.failed.map((f) => `${f.name}: ${f.error}`),
      d.busy,
    ].filter(Boolean);
    setBrought(said.length ? `${said.join("; ")}.` : null);
    if (d.created.length + d.linked.length > 0) await retry([w]);
  };

  /** The rows waiting for `waitFor` (all, when null) tried again, a part at a time. */
  const retry = async (waitFor: WaitFor[] | null) => {
    if (!file) return;
    setError(null);
    let after = -1;
    let created = 0;
    for (;;) {
      setBusy("Trying the waiting rows again…");
      const r = await retryMigrationWaiting(file.id, waitFor, after);
      if (!r.ok) {
        setBusy(null);
        return setError(r.error);
      }
      setFailures(r.data.failed);
      created += r.data.created;
      // Kept before rows were numbered: the file goes through again instead, passing over what came.
      if (r.data.restart) {
        setBusy(null);
        return importAll({ ...file, done: 0 });
      }
      if (r.data.left === 0) break;
      after = r.data.after;
    }
    setBusy(null);
    if (created > 0) window.dispatchEvent(new CustomEvent(IMPORTED, { detail: step.key }));
    router.refresh();
  };

  // Another section brought across: the rows here waiting for it are tried again by themselves.
  const waitsForRef = useRef(waitsFor);
  waitsForRef.current = waitsFor;
  const retryRef = useRef(retry);
  retryRef.current = retry;
  useEffect(() => {
    const imported = (e: Event) => {
      const freed = FREES[(e as CustomEvent<string>).detail as keyof typeof FREES];
      if (freed && waitsForRef.current.includes(freed)) void retryRef.current([freed]);
    };
    window.addEventListener(IMPORTED, imported);
    return () => window.removeEventListener(IMPORTED, imported);
  }, []);

  return (
    <Section
      number={number}
      title={step.label}
      done={done && failures.length === 0}
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          <SectionStatus file={file} count={count} coming={coming} waiting={waiting} failed={failed.length} />
          <Button type="button" size="sm" variant="ghost" onClick={() => downloadTemplate(step.key, setError)}>
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Template
          </Button>
        </div>
      }
    >
      <p className="text-sm text-muted">{step.hint}</p>
      {count > 0 && <p className="mt-1 text-xs text-text">{count.toLocaleString("en-IN")} {step.units} brought across so far.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept=".csv,.xlsx" className="sr-only" aria-label={`Upload the ${step.units}`} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <Button type="button" size="sm" variant="secondary" disabled={!!busy} onClick={() => input.current?.click()}>
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          {file ? "Upload again" : "Upload file"}
        </Button>
        {file && !done && (
          <>
            <Button type="button" size="sm" variant="secondary" disabled={!!busy} onClick={check}>
              Check
            </Button>
            <Button type="button" size="sm" disabled={!!busy || (checked !== null && checked.errors.length > 0 && checked.creates === 0)} onClick={() => importAll()}>
              {file.done > 0 ? "Carry on" : "Import"}
            </Button>
          </>
        )}
        {waiting.length > 0 && (
          <Button type="button" size="sm" variant="secondary" disabled={!!busy} onClick={() => retry(null)}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Retry waiting
          </Button>
        )}
        {count > 0 && <UndoSection step={step} disabled={!!busy} />}
        {file && (
          <span className="text-xs text-muted">
            {file.filename}: {file.done.toLocaleString("en-IN")} of {file.units.toLocaleString("en-IN")} {step.units} gone through
          </span>
        )}
      </div>
      {/* A file here already: top it up from the day it came (src/lib/zoho/pull.ts "topup"), rather than fetch it all again. */}
      {zoho?.connected && <PullOnly modules={[...step.modules]} label={step.units} coming={coming} pulling={!!zoho.pulling} since={file?.createdAt ? new Date(file.createdAt).toISOString().slice(0, 10) : undefined} />}
      <div aria-live="polite" className="mt-2 space-y-2">
        {busy && (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {busy}
          </p>
        )}
        {checked && (
          <p className="text-xs text-text">
            Checked: {checked.creates.toLocaleString("en-IN")} to bring, {checked.skips.toLocaleString("en-IN")} left out or already here,{" "}
            <span className={checked.errors.length ? "text-danger" : ""}>{checked.errors.length.toLocaleString("en-IN")} with a problem</span>.
          </p>
        )}
        {waitsFor.map((w) => {
          const n = waiting.filter((f) => f.waitFor === w).length;
          return (
            <p key={w} className="text-xs text-text">
              <Badge tone="amber">
                Waiting for {WAIT_LABELS[w]}: {n.toLocaleString("en-IN")}
              </Badge>{" "}
              {zoho?.connected && zoho.superAdmin && (w === "customers" || w === "vendors") ? (
                <>
                  <Button type="button" size="sm" variant="secondary" className="ml-1 h-7" disabled={!!busy} onClick={() => bringFromZoho(w, n)}>
                    <CloudDownload className="h-3.5 w-3.5" aria-hidden="true" />
                    Bring {n === 1 ? "this" : `these ${n.toLocaleString("en-IN")}`} from Zoho
                  </Button>{" "}
                  <span className="text-muted">— or {WAIT_WHERE[w].how.charAt(0).toLowerCase() + WAIT_WHERE[w].how.slice(1)}.</span>
                </>
              ) : (
                <>{WAIT_WHERE[w].how}.</>
              )}
            </p>
          );
        })}
        {brought && <p className="text-xs text-text">{brought}</p>}
        <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
      </div>
      <Problems title="Problems found by the check" rows={checked?.errors ?? []} file={step.label} />
      <Problems title="Waiting" tone="warning" rows={waiting.map((f) => ({ line: f.line, label: f.key, error: f.error }))} file={step.label} />
      <Problems title="Not brought across" rows={failed.map((f) => ({ line: f.line, label: f.key, error: f.error }))} file={step.label} />
    </Section>
  );
}

/** Not started · Being fetched · Ready (N) · Importing · Imported (N) — and rows waiting or failed beside it. */
function SectionStatus({ file, count, coming, waiting, failed }: { file: StepFile | null; count: number; coming: boolean; waiting: Failure[]; failed: number }) {
  const main = !file
    ? count > 0
      ? { tone: "green" as const, text: `Imported ${count.toLocaleString("en-IN")}` }
      : coming
        ? { tone: "blue" as const, text: "Being fetched" }
        : { tone: "default" as const, text: "Not started" }
    : file.done === 0 && count === 0
      ? { tone: "blue" as const, text: `Ready: ${file.units.toLocaleString("en-IN")}` }
      : file.done < file.units
        ? { tone: "amber" as const, text: `Importing ${file.done.toLocaleString("en-IN")} of ${file.units.toLocaleString("en-IN")}` }
        : { tone: "green" as const, text: `Imported ${count.toLocaleString("en-IN")}` };
  const firstWait = waiting[0]?.waitFor;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge tone={main.tone}>{main.text}</Badge>
      {firstWait && (
        <Badge tone="amber">
          Waiting for {WAIT_LABELS[firstWait]}
          {new Set(waiting.map((w) => w.waitFor)).size > 1 ? " and more" : ""}: {waiting.length.toLocaleString("en-IN")}
        </Badge>
      )}
      {failed > 0 && <Badge tone="red">Failed: {failed.toLocaleString("en-IN")}</Badge>}
    </span>
  );
}

/**
 * Undo this section (owner, 28 Oct 2026): what it brought, and what is set against it, taken back — said before it
 * happens. The file stays, as if not yet imported.
 */
function UndoSection({ step, disabled }: { step: (typeof STEPS)[number]; disabled: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<{ own: number; dependents: { step: string; count: number }[]; refusal: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const label = (k: string) => STEPS.find((s) => s.key === k)?.units ?? k.replace(/-/g, " ");
  const show = () =>
    start(async () => {
      setError(null);
      setPlan(null);
      setOpen(true);
      const r = await sectionUndoPreview(step.key);
      if (!r.ok) return setError(r.error);
      setPlan(r.data);
    });
  return (
    <>
      <Button type="button" size="sm" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger" disabled={disabled || pending} onClick={show}>
        Undo this section
      </Button>
      <Dialog open={open} onClose={() => !pending && setOpen(false)} title={`Undo ${step.label.toLowerCase()}`}>
        <div className="space-y-4">
          {!plan && !error && (
            <p className="flex items-center gap-1.5 text-sm text-muted">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              Working out what goes with it…
            </p>
          )}
          {plan && (
            <div className="space-y-2 text-sm text-text">
              <p>
                {plan.own.toLocaleString("en-IN")} {step.units} {plan.own === 1 ? "is" : "are"} taken back, with every entry they posted.
              </p>
              {plan.dependents.length > 0 && (
                <p>
                  With them go what is set against them:{" "}
                  <strong>
                    {plan.dependents.map((d) => `${d.count.toLocaleString("en-IN")} ${label(d.step)}`).join(" and ")}
                  </strong>
                  . Import those sections again after this one.
                </p>
              )}
              <p className="text-muted">The files stay, as if not yet imported: importing again brings them back. Nothing else in the switch changes.</p>
              {plan.refusal && <p className="text-danger">{plan.refusal}</p>}
            </div>
          )}
          <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Keep it
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={pending || !plan || !!plan.refusal || plan.own === 0}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await undoMigrationSection(step.key);
                  if (!r.ok) return setError(r.error);
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              {pending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Undo {step.label.toLowerCase()}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/** `tone` "warning": rows waiting for another section — tried again by themselves, nothing to fix in the file. */
function Problems({ title, rows, file, tone = "danger" }: { title: string; rows: { line: number; label: string; error: string }[]; file?: string; tone?: "danger" | "warning" }) {
  const clock = useClock();
  if (rows.length === 0) return null;
  // Every row, not only the 500 shown, as a CSV to work through (owner, 27 Oct 2026).
  const download = () => {
    const text = [csvRow(["Row", "Record", "Why"]), ...rows.map((r) => csvRow([r.line, r.label, r.error]))].join("\n");
    const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff) + text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = csvFilename(`${(file ?? "switch").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.replace(/-+$/, ""), new Date(), clock);
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <details className={`mt-3 rounded-lg border px-3 py-2 ${tone === "warning" ? "border-warning/40" : "border-danger/30"}`} open={rows.length <= 5}>
      <summary className={`cursor-pointer text-xs font-medium ${tone === "warning" ? "text-warning" : "text-danger"}`}>
        {title} ({rows.length.toLocaleString("en-IN")}) —{" "}
        {tone === "warning" ? "each comes across by itself once what it waits for is here" : "fix them in the file and upload it again; what already came is passed over"}
        <button
          type="button"
          // Inside the summary: a click downloads, and leaves the list open or shut as it was.
          onClick={(e) => {
            e.preventDefault();
            download();
          }}
          className="ml-3 inline-flex items-center gap-1 font-medium text-brand hover:underline">
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          Download
        </button>
      </summary>
      <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto text-xs">
        {rows.slice(0, 500).map((r, i) => (
          <li key={`${r.line}-${i}`} className="flex gap-2">
            <span className="shrink-0 text-muted">Row {r.line}</span>
            <span className="shrink-0 font-medium text-text">{r.label}</span>
            <span className="text-text">{r.error}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function BalancesCard({ number, months }: { number: number; months: MonthCheck[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement | null>(null);
  const [month, setMonth] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ line: number; error: string }[]>([]);
  const [pending, start] = useTransition();
  const uploadedAll = months.every((x) => x.uploaded);
  return (
    <Section
      number={number}
      title="The old system's month-end trial balances"
      done={uploadedAll}
      actions={
        <Button type="button" size="sm" variant="ghost" onClick={() => downloadTemplate("balances", setError)}>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          Template
        </Button>
      }
    >
      <p className="text-sm text-muted">
        The trial balance at the end of every month from {monthLabel(months[0]?.month ?? "")} to {monthLabel(months[months.length - 1]?.month ?? "")}: one file with a Month
        column, or one file a month with the month chosen here. Uploading a month again replaces it.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="mig-tb-month">Month</Label>
          <Select id="mig-tb-month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-56">
            <option value="">From a Month column</option>
            {months.map((x) => (
              <option key={x.month} value={x.month}>
                {monthLabel(x.month)}
              </option>
            ))}
          </Select>
        </div>
        <input
          ref={input}
          type="file"
          accept=".csv,.xlsx"
          className="sr-only"
          aria-label="Upload a trial balance"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            start(async () => {
              setError(null);
              setFailed([]);
              const r = await sendBalances(f, month);
              if (!r.ok) return setError(r.error);
              if (r.data.failed.length) return setFailed(r.data.failed);
              router.refresh();
            });
          }}
        />
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => input.current?.click()}>
          {pending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Upload className="h-3.5 w-3.5" aria-hidden="true" />}
          Upload trial balance
        </Button>
      </div>
      <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} className="mt-2" />
      <Problems file="Trial balance" title="Nothing was kept — these rows can't be read" rows={failed.map((f) => ({ line: f.line, label: "", error: f.error }))} />
      <ul className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-label="Months">
        {months.map((x) => (
          <li key={x.month} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm">
            <span className="whitespace-nowrap text-text">{monthLabel(x.month)}</span>
            {!x.uploaded ? (
              <Badge>Not uploaded</Badge>
            ) : x.agrees ? (
              <Badge tone="green">Agrees</Badge>
            ) : (
              <Badge tone="red">{x.differences.length} off</Badge>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function DifferencesCard({ number, months, adjustments, accounts }: { number: number; months: MonthCheck[]; adjustments: Adjustment[]; accounts: Account[] }) {
  const off = months.filter((x) => x.uploaded && !x.agrees);
  return (
    <Section number={number} title="Differences" done={months.length > 0 && months.every((x) => x.agrees)}>
      {off.length === 0 ? (
        <p className="text-sm text-muted">
          {months.some((x) => x.uploaded) ? "Every month uploaded agrees with the old system, account by account." : "Upload the trial balances to see how each month compares."}
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Where Deskzo&apos;s books and the old system&apos;s differ. Usually something a file didn&apos;t carry — fix the file and bring it again. Last year&apos;s profit
            sitting in Opening Balance Equity here and in Retained Earnings there is one adjustment between the two, in the year&apos;s first month.
          </p>
          {off.map((x) => (
            <details key={x.month} className="rounded-lg border border-line px-3 py-2" open={off.length === 1}>
              <summary className="cursor-pointer text-sm font-medium text-text">
                {monthLabel(x.month)} — {x.differences.length} account{x.differences.length === 1 ? "" : "s"} off
              </summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[440px] text-left text-xs">
                  <thead>
                    <tr className="text-muted">
                      <th className="py-1 pr-3 font-medium">Account</th>
                      <th className="py-1 pr-3 text-right font-medium">Deskzo</th>
                      <th className="py-1 pr-3 text-right font-medium">Old system</th>
                      <th className="py-1 text-right font-medium">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {x.differences.map((d) => (
                      <tr key={d.accountId} className="border-t border-line">
                        <td className="py-1 pr-3 text-text">
                          {d.code} {d.name}
                        </td>
                        <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap text-text">{drCr(d.deskzo)}</td>
                        <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap text-text">{drCr(d.old)}</td>
                        <td className="py-1 text-right tabular-nums whitespace-nowrap text-danger">{drCr(d.difference)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 text-[11px] text-muted">The difference is what Deskzo has more of: a debit (Dr) or a credit (Cr).</p>
              </div>
            </details>
          ))}
        </div>
      )}
      <AdjustmentForm months={months.map((x) => x.month)} accounts={accounts} />
      {adjustments.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-muted">Adjustments made</h3>
          <ul className="mt-1 space-y-1 text-xs">
            {adjustments.map((a) => (
              <li key={a.id} className="text-text">
                {a.entryNumber} · {dayLabel(a.date)} · {money(a.amount)} from {a.credit?.name ?? "?"} to {a.debit?.name ?? "?"} — {a.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function AdjustmentForm({ months, accounts }: { months: string[]; accounts: Account[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ month: months[0] ?? "", debitAccountId: "", creditAccountId: "", amount: "", reason: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <div className="mt-4">
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Add an adjustment…
      </Button>
      <Dialog open={open} onClose={() => !pending && setOpen(false)} title="Adjustment">
        <div className="space-y-3">
          <p className="text-sm text-muted">One entry on the month&apos;s last day, between two accounts, with the reason kept beside it. Undo takes it back with the rest.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="adj-month">Month</Label>
              <Select id="adj-month" value={form.month} onChange={(e) => set("month", e.target.value)}>
                {months.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="adj-amount">Amount (₹)</Label>
              <Input id="adj-amount" inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="adj-debit">Debit</Label>
              <Select id="adj-debit" value={form.debitAccountId} onChange={(e) => set("debitAccountId", e.target.value)}>
                <option value="">Choose an account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="adj-credit">Credit</Label>
              <Select id="adj-credit" value={form.creditAccountId} onChange={(e) => set("creditAccountId", e.target.value)}>
                <option value="">Choose an account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="adj-reason">Why</Label>
            <Input id="adj-reason" value={form.reason} onChange={(e) => set("reason", e.target.value)} maxLength={300} />
          </div>
          <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await addMigrationAdjustment(form);
                  if (!r.ok) return setError(r.error);
                  setOpen(false);
                  setForm((f) => ({ ...f, amount: "", reason: "" }));
                  router.refresh();
                })
              }
            >
              {pending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Post adjustment
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function FinishCard({
  number,
  migration,
  agreed,
  canFinish,
  waiting,
  pulling,
}: {
  number: number;
  migration: MigrationRow;
  agreed: boolean;
  canFinish: boolean;
  /** Rows still waiting in the sections — they don't come across once it's finished. */
  waiting: number;
  /** A Zoho pull still bringing things across. */
  pulling: boolean;
}) {
  const router = useRouter();
  const clock = useClock();
  // Finishing locks to the day before the switch, which has to have ended — and the old system is in use till then.
  const early = clock.today() < migration.switchDate;
  const [confirming, setConfirming] = useState(false);
  const [salesOnly, setSalesOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // The buttons are always there (owner, 21 Nov 2026: "atleast show finish button here"); when one can't go ahead yet,
  // its dialog says why instead of finishing — and the server refuses the same cases whatever the page shows.
  const notYet = `Finish on or after ${dayLabel(migration.switchDate)}, the switch day — the books lock to the day before it, which hasn't ended yet.`;
  const noRight = "Finishing locks the months, so it needs the right to close the books — ask an admin to finish it.";
  const fullWhy = !agreed
    ? "Every month's trial balance has to be uploaded and agree with the old system first. Keeping the books in another system this year? Finish for sales only, below."
    : early
      ? notYet
      : !canFinish
        ? noRight
        : null;
  const salesWhy = !canFinish ? noRight : early ? `${notYet} Until then keep invoicing in the old system; on the day, bring its last days across ("Top up since the backup" in the Zoho section), then finish.` : pulling ? "The Zoho pull is still bringing things across — finish once it has." : null;
  return (
    <Section number={number} title="Finish" done={false}>
      <div className="space-y-2">
        {!agreed ? (
          <p className="flex items-start gap-1.5 text-sm text-muted">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            A full finish needs every month&apos;s trial balance uploaded and agreeing.
          </p>
        ) : fullWhy ? (
          <p className="text-sm text-muted">Every month agrees. {fullWhy}</p>
        ) : (
          <p className="text-sm text-text">
            Every month agrees with the old system. Finishing locks the books to the day before {dayLabel(migration.switchDate)}: nothing more can be posted into the year
            that came across, and it can&apos;t be undone.
          </p>
        )}
        <Button type="button" variant={fullWhy ? "secondary" : "primary"} onClick={() => setConfirming(true)}>
          Finish and lock the months
        </Button>
      </div>
      {!agreed && (
        // The books kept elsewhere this year (owner, 29 Oct 2026): Deskzo runs the sales side, and the check is skipped.
        <div className="mt-4 space-y-2 rounded-lg border border-line p-3">
          <p className="text-sm font-medium text-text">Keeping this year&apos;s books in another system — Tally, say?</p>
          <p className="text-sm text-muted">
            Finish for sales only: what came across stays — customers, invoices, credit notes, receipts, the open quotes and orders, the earlier years&apos;
            archive — without the month-end check. Deskzo runs proposals, invoicing and payments from {dayLabel(migration.switchDate)}; the books for the
            months before it stay in the other system.
          </p>
          {salesWhy && <p className="text-sm text-muted">{salesWhy}</p>}
          <Button type="button" variant={salesWhy ? "secondary" : "primary"} onClick={() => setSalesOnly(true)}>
            Finish — sales only
          </Button>
        </div>
      )}
      <Dialog open={salesOnly} onClose={() => !pending && setSalesOnly(false)} title="Finish for sales only">
        {salesWhy ? (
          <div className="space-y-4">
            <p className="flex items-start gap-1.5 text-sm text-text">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              Not yet. {salesWhy}
            </p>
            <div className="flex justify-end">
              <Button type="button" variant="secondary" onClick={() => setSalesOnly(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
        <div className="space-y-4">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-text">
            <li>
              The books lock to the day before {dayLabel(migration.switchDate)}: nothing more can be posted into those months. Do first anything still to change in
              them — &quot;Open the ones still owing&quot;, an invoice to bring by hand, an opening entry to take back.
            </li>
            {waiting > 0 && (
              <li className="text-warning">
                {waiting.toLocaleString("en-IN")} row{waiting === 1 ? " is" : "s are"} still waiting in the sections above, and won&apos;t come across.
              </li>
            )}
            <li>The month-end check is skipped: Deskzo&apos;s accounts for those months aren&apos;t the books — the other system&apos;s are.</li>
            <li>The files kept for the import are deleted, Undo is no longer offered, and the &quot;figures not final&quot; notice goes.</li>
          </ul>
          <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setSalesOnly(false)} disabled={pending}>
              Not yet
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await finishSalesOnlyAction();
                  if (!r.ok) return setError(r.error);
                  setSalesOnly(false);
                  router.refresh();
                })
              }
            >
              {pending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Finish — sales only
            </Button>
          </div>
        </div>
        )}
      </Dialog>
      <Dialog open={confirming} onClose={() => !pending && setConfirming(false)} title="Finish the migration">
        {fullWhy ? (
          <div className="space-y-4">
            <p className="flex items-start gap-1.5 text-sm text-text">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              Not yet. {fullWhy}
            </p>
            <div className="flex justify-end">
              <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
        <div className="space-y-4">
          <p className="text-sm text-text">The books lock to the day before {dayLabel(migration.switchDate)}, and the files kept for the import are deleted. Undo is no longer offered.</p>
          <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
              Not yet
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await finishMigrationAction();
                  if (!r.ok) return setError(r.error);
                  setConfirming(false);
                  router.refresh();
                })
              }
            >
              {pending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Finish
            </Button>
          </div>
        </div>
        )}
      </Dialog>
    </Section>
  );
}
