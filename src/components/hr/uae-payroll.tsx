"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CheckCircle2, Download, Lock, RefreshCw, Trash2, Unlock } from "lucide-react";
import {
  addUaeLeave,
  adjustUaePayslip,
  deleteUaeRun,
  markUaeRunPaid,
  saveUaePerson,
  saveWpsSetup,
  setUaeRunLocked,
  startUaeRun,
  uaeGratuityFor,
  uaeRun,
  uaeSalaryFile,
  type UaePerson,
  type UaeSlip,
  type UaeView,
} from "@/actions/uae-payroll";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { formatCurrency } from "@/lib/utils";

type Tab = "run" | "people" | "setup" | "gratuity" | "expiries";
const TABS: { key: Tab; label: string }[] = [
  { key: "run", label: "Monthly run" },
  { key: "people", label: "People" },
  { key: "setup", label: "WPS setup" },
  { key: "gratuity", label: "Gratuity" },
  { key: "expiries", label: "Document expiries" },
];
const STATUS: Record<string, string> = { DRAFT: "Draft", LOCKED: "Locked", PAID: "Paid" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * UAE payroll (owner, 15 Nov 2026 — src/lib/uae, src/actions/uae-payroll.ts): a UAE workspace's payroll page. Monthly
 * pay in AED, the WPS salary file for the bank, gratuity, UAE leave and document expiries.
 */
export function UaePayroll({ view }: { view: UaeView }) {
  const [tab, setTab] = useState<Tab>("run");
  const soon = view.expiries.filter((e) => e.daysLeft <= 30).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b border-line" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.key ? "border-brand font-medium text-text" : "border-transparent text-muted hover:text-text"}`}
          >
            {t.label}
            {t.key === "expiries" && soon > 0 && <span className="ml-1.5 rounded-full bg-danger-bg px-1.5 text-xs text-danger">{soon}</span>}
          </button>
        ))}
      </div>
      {tab === "run" && <RunTab view={view} />}
      {tab === "people" && <PeopleTab view={view} />}
      {tab === "setup" && <SetupTab view={view} />}
      {tab === "gratuity" && <GratuityTab view={view} />}
      {tab === "expiries" && <ExpiriesTab view={view} />}
    </div>
  );
}

// ─── Monthly run ────────────────────────────────────────────────────────────────────────────────────

function RunTab({ view }: { view: UaeView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [open, setOpen] = useState<{ id: string; label: string; status: string; slips: UaeSlip[]; total: number } | null>(null);
  const [problems, setProblems] = useState<string | null>(null);
  const missingSetup = !view.setup.establishmentId || !view.setup.payingRoutingCode;

  const load = (id: string) =>
    start(async () => {
      setProblems(null);
      const r = await uaeRun(id);
      if (!r.ok) return void toast.error(r.error);
      setOpen(r.data);
    });
  const work = (m: number, y: number) =>
    start(async () => {
      const r = await startUaeRun(m, y);
      if (!r.ok) return void toast.error(r.error);
      if (r.data.skipped.length) toast.success(`Left out: ${r.data.skipped.join("; ")}.`);
      router.refresh();
      const again = await uaeRun(r.data.runId);
      if (again.ok) setOpen(again.data);
    });
  const lock = (locked: boolean) =>
    open &&
    start(async () => {
      const r = await setUaeRunLocked(open.id, locked);
      if (!r.ok) return void toast.error(r.error);
      router.refresh();
      const again = await uaeRun(open.id);
      if (again.ok) setOpen(again.data);
    });
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const paid = () =>
    open &&
    start(async () => {
      const r = await markUaeRunPaid(open.id, paidOn);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${open.label} marked paid.`);
      router.refresh();
      const again = await uaeRun(open.id);
      if (again.ok) setOpen(again.data);
    });
  const remove = () =>
    open &&
    start(async () => {
      const r = await deleteUaeRun(open.id);
      if (!r.ok) return void toast.error(r.error);
      setOpen(null);
      router.refresh();
    });
  const file = () =>
    open &&
    start(async () => {
      setProblems(null);
      const r = await uaeSalaryFile(open.id);
      if (!r.ok) return setProblems(r.error);
      const url = URL.createObjectURL(new Blob([r.data.content], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.data.fileName;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`${r.data.fileName} — ${formatCurrency(r.data.total)}. Upload it on your bank's WPS page.`);
    });

  return (
    <div className="space-y-4">
      {missingSetup && <p className="rounded-base bg-warning-bg px-3 py-2 text-sm text-warning">Fill in the WPS setup — the MOHRE establishment ID and the paying bank — before making the salary file.</p>}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 pt-4 text-sm">
          <label className="text-xs text-muted">
            Month
            <Select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="mt-1 w-36">
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-xs text-muted">
            Year
            <Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} className="mt-1 w-24" />
          </label>
          <Button disabled={pending} onClick={() => work(month, year)}>
            Work out the month
          </Button>
          <span className="text-xs text-subtle">Pay for the days each person was here, less absences and unpaid leave; half-pay leave counts half.</span>
        </CardContent>
      </Card>

      {view.runs.length > 0 && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Months</CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <tbody>
                {view.runs.map((r) => (
                  <tr key={r.id} className="border-t border-line first:border-0">
                    <td className="py-1.5">
                      <button type="button" className="text-text hover:underline" onClick={() => load(r.id)}>
                        {r.label}
                      </button>
                    </td>
                    <td className="py-1.5 text-muted">{STATUS[r.status] ?? r.status}</td>
                    <td className="py-1.5 text-right text-muted">{r.people} people</td>
                    <td className="py-1.5 text-right tabular-nums text-text">{formatCurrency(r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {open && (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-text">
              {open.label} · {STATUS[open.status] ?? open.status} · {formatCurrency(open.total)}
            </span>
            <div className="flex flex-wrap gap-2">
              {open.status === "DRAFT" ? (
                <>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => { const [y, m] = [Number(open.slips[0]?.payStart.slice(0, 4) || year), Number(open.slips[0]?.payStart.slice(5, 7) || month)]; work(m, y); }}>
                    <RefreshCw className="mr-1 h-4 w-4" aria-hidden /> Work out again
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={remove}>
                    <Trash2 className="mr-1 h-4 w-4" aria-hidden /> Remove
                  </Button>
                  <Button size="sm" disabled={pending} onClick={() => lock(true)}>
                    <Lock className="mr-1 h-4 w-4" aria-hidden /> Lock
                  </Button>
                </>
              ) : (
                <>
                  {open.status === "LOCKED" && (
                    <>
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => lock(false)}>
                        <Unlock className="mr-1 h-4 w-4" aria-hidden /> Unlock
                      </Button>
                      <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className="h-8 w-36" aria-label="Day the salaries were paid" />
                      <Button size="sm" variant="secondary" disabled={pending} onClick={paid}>
                        <CheckCircle2 className="mr-1 h-4 w-4" aria-hidden /> Mark paid
                      </Button>
                    </>
                  )}
                  <Button size="sm" disabled={pending} onClick={file}>
                    <Download className="mr-1 h-4 w-4" aria-hidden /> WPS salary file (.SIF)
                  </Button>
                </>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {problems && <p className="rounded-base bg-danger-bg px-3 py-2 text-sm text-danger">{problems}</p>}
            {open.slips.length === 0 ? (
              <p className="text-sm text-subtle">Nobody to pay — set people&apos;s UAE pay on the People tab.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th className="py-1">Person</th>
                      <th className="py-1 text-right">Monthly</th>
                      <th className="py-1 text-right">Unpaid days</th>
                      <th className="py-1 text-right">Deductions</th>
                      <th className="py-1 text-right">Overtime</th>
                      <th className="py-1 text-right">Bonus</th>
                      <th className="py-1 text-right">Net</th>
                      <th className="py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {open.slips.map((s) => (
                      <SlipRow key={s.id} slip={s} draft={open.status === "DRAFT"} mine={s.userId === view.me} onSaved={() => load(open.id)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SlipRow({ slip, draft, mine, onSaved }: { slip: UaeSlip; draft: boolean; mine: boolean; onSaved: () => void }) {
  const [pending, start] = useTransition();
  const [f, setF] = useState({ unpaidDays: String(slip.unpaidDays), deductions: String(slip.deductions), overtime: String(slip.overtime), bonus: String(slip.bonus) });
  const changed = f.unpaidDays !== String(slip.unpaidDays) || f.deductions !== String(slip.deductions) || f.overtime !== String(slip.overtime) || f.bonus !== String(slip.bonus);
  const save = () =>
    start(async () => {
      const r = await adjustUaePayslip(slip.id, { ...f, note: slip.note });
      if (!r.ok) return void toast.error(r.error);
      onSaved();
    });
  const cell = (k: keyof typeof f) =>
    draft && !mine ? <Input inputMode="decimal" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} className="ml-auto h-8 w-24 text-right" aria-label={`${slip.name} ${k}`} /> : <span className="tabular-nums">{f[k]}</span>;
  return (
    <tr className="border-t border-line align-middle">
      <td className="py-1.5">
        <div className="text-text">{slip.name}</div>
        <div className="text-xs text-subtle">
          {slip.payStart.slice(8)}–{slip.payEnd.slice(8)} of {slip.monthDays} days · {slip.bankName ?? "bank not known"}
          {slip.missing.length > 0 && <span className="text-danger"> · missing {slip.missing.join(", ")}</span>}
        </div>
      </td>
      <td className="py-1.5 text-right tabular-nums">{formatCurrency(slip.monthly)}</td>
      <td className="py-1.5 text-right">{cell("unpaidDays")}</td>
      <td className="py-1.5 text-right">{cell("deductions")}</td>
      <td className="py-1.5 text-right">{cell("overtime")}</td>
      <td className="py-1.5 text-right">{cell("bonus")}</td>
      <td className="py-1.5 text-right font-medium tabular-nums text-text">{formatCurrency(slip.net)}</td>
      <td className="py-1.5 text-right">
        {draft && changed ? (
          <Button size="sm" variant="secondary" disabled={pending} onClick={save}>
            Save
          </Button>
        ) : (
          <a href={`/payslips/uae/${slip.id}/print`} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">
            Payslip
          </a>
        )}
      </td>
    </tr>
  );
}

// ─── People ─────────────────────────────────────────────────────────────────────────────────────────

function PeopleTab({ view }: { view: UaeView }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const shown = view.people.filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-text">Monthly pay in AED, the MOHRE person ID and IBAN the salary file needs, and their documents</span>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find somebody" className="w-48" />
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1">Person</th>
              <th className="py-1">Bank</th>
              <th className="py-1 text-right">Monthly</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <PersonRows key={p.userId} person={p} mine={p.userId === view.me} open={editing === p.userId} onToggle={() => setEditing(editing === p.userId ? null : p.userId)} />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function PersonRows({ person, mine, open, onToggle }: { person: UaePerson; mine: boolean; open: boolean; onToggle: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState(person);
  const monthly = person.basic + person.housing + person.transport + person.otherAllowance;
  const missing = [!person.mohrePersonId && "MOHRE ID", !person.iban && "IBAN"].filter(Boolean);
  const save = () =>
    start(async () => {
      const r = await saveUaePerson(person.userId, f);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${person.name} saved.`);
      onToggle();
      router.refresh();
    });
  const field = (k: keyof UaePerson, label: string, type: "text" | "date" | "money" = "text") => (
    <label className="text-xs text-muted">
      {label}
      <Input type={type === "date" ? "date" : "text"} inputMode={type === "money" ? "decimal" : undefined} value={String(f[k] ?? "")} onChange={(e) => setF({ ...f, [k]: e.target.value } as UaePerson)} className="mt-1" />
    </label>
  );
  return (
    <>
      <tr className="border-t border-line">
        <td className="py-1.5">
          <div className="text-text">{person.name}</div>
          <div className="text-xs text-subtle">
            {person.code ? `${person.code} · ` : ""}
            {person.exitedOn ? `left ${person.exitedOn}` : person.joinedOn ? `joined ${person.joinedOn}` : "no joining day"}
            {monthly > 0 && missing.length > 0 && <span className="text-danger"> · missing {missing.join(", ")}</span>}
          </div>
        </td>
        <td className="py-1.5 text-muted">{person.bankName ?? "—"}</td>
        <td className="py-1.5 text-right tabular-nums">{monthly > 0 ? formatCurrency(monthly) : "—"}</td>
        <td className="py-1.5 text-right">
          {mine ? (
            <span className="text-xs text-subtle">Somebody else sets yours</span>
          ) : (
            <Button size="sm" variant="ghost" onClick={onToggle}>
              {open ? "Close" : "Edit"}
            </Button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} className="pb-4">
            <div className="grid grid-cols-2 gap-3 rounded-base border border-line bg-surface-sunken p-3 md:grid-cols-4">
              {field("basic", "Basic (AED a month)", "money")}
              {field("housing", "Housing", "money")}
              {field("transport", "Transport", "money")}
              {field("otherAllowance", "Other allowances", "money")}
              {field("mohrePersonId", "MOHRE person ID (14 digits)")}
              {field("iban", "IBAN")}
              {field("routingCode", "Routing code (blank: from the IBAN)")}
              <div className="self-end text-xs text-subtle">The salary file sends the IBAN&apos;s bank code unless you type one.</div>
              {field("passportNumber", "Passport number")}
              {field("passportExpiry", "Passport expiry", "date")}
              {field("visaExpiry", "Residence visa expiry", "date")}
              {field("emiratesId", "Emirates ID")}
              {field("emiratesIdExpiry", "Emirates ID expiry", "date")}
              {field("labourCardNumber", "Labour card / work permit")}
              {field("labourCardExpiry", "Labour card expiry", "date")}
              {field("insuranceExpiry", "Health insurance expiry", "date")}
              <div className="col-span-full flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={onToggle}>
                  Cancel
                </Button>
                <Button size="sm" disabled={pending} onClick={save}>
                  Save
                </Button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── WPS setup ──────────────────────────────────────────────────────────────────────────────────────

function SetupTab({ view }: { view: UaeView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState(view.setup);
  const save = () =>
    start(async () => {
      const r = await saveWpsSetup(f);
      if (!r.ok) return void toast.error(r.error);
      toast.success("WPS setup saved.");
      router.refresh();
    });
  const leave = () =>
    start(async () => {
      const r = await addUaeLeave();
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.data.length ? `Added: ${r.data.join(", ")}.` : "The UAE leave types are already there.");
    });
  const top = view.banks.filter((b) => b.top);
  const rest = view.banks.filter((b) => !b.top);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="text-sm font-medium text-text">WPS salary file</CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-2">
          <p className="text-muted md:col-span-2">
            Every UAE bank takes the same salary file (SIF), set by the Central Bank and MOHRE. Your bank decides only the routing code on its last line; each employee&apos;s bank is read from their IBAN.
          </p>
          <div>
            <Label htmlFor="wps-bank">Bank that pays the salaries</Label>
            <Select id="wps-bank" value={f.payingRoutingCode} onChange={(e) => setF({ ...f, payingRoutingCode: e.target.value })} className="mt-1">
              <option value="">Pick the bank</option>
              <optgroup label="Top 10 banks">
                {top.map((b) => (
                  <option key={b.routingCode + b.name} value={b.routingCode}>
                    {b.name} — {b.routingCode}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Other banks and exchange houses">
                {rest.map((b) => (
                  <option key={b.routingCode + b.name} value={b.routingCode}>
                    {b.name} — {b.routingCode}
                  </option>
                ))}
              </optgroup>
            </Select>
          </div>
          <div>
            <Label htmlFor="wps-est">MOHRE establishment ID (13 digits)</Label>
            <Input id="wps-est" value={f.establishmentId} onChange={(e) => setF({ ...f, establishmentId: e.target.value })} className="mt-1" placeholder="From your MOHRE establishment card" />
          </div>
          <div>
            <Label htmlFor="wps-iban">The company&apos;s salary account IBAN</Label>
            <Input id="wps-iban" value={f.payingIban} onChange={(e) => setF({ ...f, payingIban: e.target.value })} className="mt-1" placeholder="AE.." />
          </div>
          <div>
            <Label htmlFor="wps-ref">Reference on the file (optional)</Label>
            <Input id="wps-ref" value={f.employerReference} onChange={(e) => setF({ ...f, employerReference: e.target.value })} className="mt-1" maxLength={35} />
          </div>
          <p className="text-xs text-subtle md:col-span-2">Routing codes are the Central Bank&apos;s head-office codes. If your bank gives you a different one, ask it once and choose the matching bank — or tell us and we&apos;ll add it.</p>
          <div className="md:col-span-2">
            <Button disabled={pending} onClick={save}>
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="text-sm font-medium text-text">UAE leave</CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted">
            Adds the Labour Law&apos;s leave to People › Leave: annual 30 days; sick 15 full pay, 30 half pay, 45 unpaid; maternity 45 full and 15 half pay; parental 5; bereavement 5; study 10. Half-pay days take half a day&apos;s pay in the monthly run. Types already there are left alone.
          </p>
          <Button variant="secondary" disabled={pending} onClick={leave}>
            Add UAE leave types
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Gratuity ───────────────────────────────────────────────────────────────────────────────────────

function GratuityTab({ view }: { view: UaeView }) {
  const [pending, start] = useTransition();
  const [userId, setUserId] = useState("");
  const [lastDay, setLastDay] = useState(new Date().toISOString().slice(0, 10));
  const [result, setResult] = useState<Awaited<ReturnType<typeof uaeGratuityFor>> | null>(null);
  const people = view.people.filter((p) => p.basic > 0);
  const work = () => start(async () => setResult(await uaeGratuityFor(userId, lastDay)));
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">End-of-service gratuity</CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">Under the UAE Labour Law: nothing under a year; 21 days&apos; basic pay a year for the first five years, 30 days&apos; after; unpaid days left out; never more than two years&apos; basic. A day is basic ÷ 30.</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted">
            Person
            <Select value={userId} onChange={(e) => setUserId(e.target.value)} className="mt-1 w-56">
              <option value="">Pick somebody</option>
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-xs text-muted">
            Last working day
            <Input type="date" value={lastDay} onChange={(e) => setLastDay(e.target.value)} className="mt-1" />
          </label>
          <Button disabled={pending || !userId} onClick={work}>
            Work it out
          </Button>
        </div>
        {result && !result.ok && <p className="text-danger">{result.error}</p>}
        {result?.ok && (
          <div className="rounded-base border border-line p-3">
            <p className="text-lg font-semibold text-text">{formatCurrency(result.data.amount)}</p>
            <p className="text-muted">
              Joined {result.data.joinedOn} · {result.data.serviceDays} days&apos; service ({result.data.years.toFixed(2)} years)
              {result.data.unpaidDays > 0 ? ` after ${result.data.unpaidDays} unpaid days` : ""} · basic {formatCurrency(result.data.basic)} a month, {formatCurrency(result.data.dailyBasic)} a day
            </p>
            {result.data.amount > 0 && (
              <p className="text-muted">
                {result.data.firstFiveDays.toFixed(1)} days at 21 a year{result.data.afterFiveDays > 0 ? ` + ${result.data.afterFiveDays.toFixed(1)} days at 30 a year` : ""}
              </p>
            )}
            {result.data.note && <p className="text-xs text-subtle">{result.data.note}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Document expiries ──────────────────────────────────────────────────────────────────────────────

function ExpiriesTab({ view }: { view: UaeView }) {
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Expired, or expiring in the next 60 days</CardHeader>
      <CardContent>
        {view.expiries.length === 0 ? (
          <p className="text-sm text-subtle">Nothing expiring. Expiry dates are kept on the People tab.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {view.expiries.map((e) => (
                <tr key={`${e.userId}${e.document}`} className="border-t border-line first:border-0">
                  <td className="py-1.5 text-text">{e.name}</td>
                  <td className="py-1.5 text-muted">{e.document}</td>
                  <td className="py-1.5 text-muted">{e.on}</td>
                  <td className={`py-1.5 text-right ${e.daysLeft < 0 ? "text-danger" : e.daysLeft <= 30 ? "text-warning" : "text-muted"}`}>
                    {e.daysLeft < 0 ? `expired ${-e.daysLeft} days ago` : e.daysLeft === 0 ? "expires today" : `${e.daysLeft} days left`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
