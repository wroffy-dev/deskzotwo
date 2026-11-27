"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { importKredily, previewKredily, type AttendancePlan, type KredilyPreview, type KredilyResult, type StepPlan } from "@/actions/kredily-import";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

type Upload = { filename: string; base64: string };

/** "2026-10" as "October 2026". */
const monthName = (key: string) => {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
};

async function toUpload(file: File): Promise<Upload> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { filename: file.name, base64: btoa(binary) };
}

function Step({ title, plan, extra }: { title: string; plan: StepPlan; extra?: string }) {
  return (
    <div className="rounded-base border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-text">{title}</span>
        <span className="text-xs text-muted">
          {plan.creates} new · {plan.updates} updated{plan.pending ? ` · ${plan.pending} once their account is made` : ""}
          {plan.skips ? ` · ${plan.skips} unchanged` : ""}
          {plan.errors.length ? <span className="text-danger"> · {plan.errors.length} can&apos;t come in</span> : null}
        </span>
      </div>
      {extra && <p className="mt-1 text-xs text-subtle">{extra}</p>}
      {plan.errors.length > 0 && (
        <ul className="mt-2 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-danger">
          {plan.errors.slice(0, 50).map((e) => (
            <li key={`${e.line}-${e.error}`}>
              <span className="text-text">{e.who}</span>: {e.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "2025-01-01" as "1 Jan 2025". */
const dayName = (key: string) => new Date(`${key}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function AttendanceCard({ plan, masterToo, onAbsent, disabled }: { plan: AttendancePlan; masterToo: boolean; onAbsent: (on: boolean) => void; disabled: boolean }) {
  const unknown = plan.marks.filter((m) => !m.known);
  return (
    <div className="rounded-base border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-text">Attendance history</span>
        <span className="text-xs text-muted">
          {dayName(plan.from)} – {dayName(plan.to)} · {plan.days.toLocaleString("en-IN")} days for {plan.people} people
          {plan.kept ? ` · ${plan.kept.toLocaleString("en-IN")} already in Deskzo, kept` : ""}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">
        Kredily&apos;s marks: {plan.marks.filter((m) => m.known).map((m) => `${m.mark} ${m.days.toLocaleString("en-IN")}`).join(" · ")}. Only the day&apos;s mark comes across — this report has no in- or out-times.
      </p>
      <label className="mt-2 flex items-center gap-1.5 text-xs text-text">
        <input type="checkbox" checked={plan.withAbsent} disabled={disabled} onChange={(e) => onAbsent(e.target.checked)} />
        Bring absent days (A, LOP) too
      </label>
      {plan.presentDays <= plan.absentDays && (
        <p className="mt-1 text-xs text-warning">
          Only {plan.presentDays.toLocaleString("en-IN")} days are marked present against {plan.absentDays.toLocaleString("en-IN")} absent — it looks as if nobody punched in on Kredily, so its absent marks aren&apos;t real absences. They&apos;re left out unless you tick the box.
        </p>
      )}
      {unknown.length > 0 && <p className="mt-1 text-xs text-subtle">Not known to Deskzo, left out: {unknown.map((m) => `${m.mark} (${m.days} days)`).join(", ")}.</p>}
      {plan.notHere.length > 0 && (
        <p className="mt-1 text-xs text-warning">
          {plan.notHere.length} employee code{plan.notHere.length === 1 ? "" : "s"} with no Deskzo employee record{masterToo ? " yet — people this import brings are found once their records are made" : ""}: {plan.notHere.slice(0, 20).join(", ")}
          {plan.notHere.length > 20 ? "…" : ""}
        </p>
      )}
    </div>
  );
}

/**
 * People › Payroll › Import from Kredily (owner, 31 Oct 2026): Kredily's ZIP or files as they come, a preview of every
 * step, then the import (src/actions/kredily-import.ts).
 */
export function KredilyImport() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [leavers, setLeavers] = useState(true);
  const [role, setRole] = useState<string>("");
  const [withAbsent, setWithAbsent] = useState<boolean | undefined>(undefined);
  const [preview, setPreview] = useState<KredilyPreview | null>(null);
  const [result, setResult] = useState<KredilyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function pick(files: FileList | null) {
    setPreview(null);
    setResult(null);
    setError(null);
    setWithAbsent(undefined);
    setUploads(files ? await Promise.all([...files].map(toUpload)) : []);
  }

  function check(withLeavers = leavers, withRole = role, absent = withAbsent) {
    setError(null);
    startTransition(async () => {
      const done = await previewKredily({ files: uploads, includeLeavers: withLeavers, role: withRole || undefined, withAbsent: absent });
      if (!done.ok) return setError(done.error);
      setPreview(done.data);
      setRole(done.data.role);
      setWithAbsent(done.data.attendance?.withAbsent);
    });
  }

  function run() {
    setError(null);
    startTransition(async () => {
      const done = await importKredily({ files: uploads, includeLeavers: leavers, role: role || undefined, withAbsent });
      if (!done.ok) return setError(done.error);
      setResult(done.data);
      setPreview(null);
      router.refresh();
    });
  }

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Import from Kredily
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Bring your people across from Kredily" wide>
        <div className="space-y-4 text-sm">
          <div className="space-y-1 text-muted">
            <p>Upload Kredily&apos;s exports as they come — the ZIP, or the Excel files. Deskzo reads:</p>
            <ul className="list-disc space-y-0.5 pl-5 text-xs">
              <li><strong className="text-text">Directory › Employee Master Export</strong> — accounts and employee records, PAN and bank details</li>
              <li><strong className="text-text">Payroll › Assigned Salary Structures</strong> — each salary, yearly amounts made monthly</li>
              <li><strong className="text-text">Payroll › Yearly Consolidated Pay Register</strong> — gross, TDS, PT and PF paid so far this year</li>
              <li><strong className="text-text">Leave › Leave Balance Report</strong> — opening balances</li>
              <li><strong className="text-text">Payroll › PF Register</strong> — UANs, and the month&apos;s gross and PF</li>
              <li><strong className="text-text">Reports › Consolidated TDS Report</strong> and <strong className="text-text">PT Report</strong> — tax deducted month by month, including a month the pay register doesn&apos;t reach yet</li>
              <li><strong className="text-text">Expenses › Pending Expenses</strong> — claims still waiting, brought across awaiting approval</li>
              <li><strong className="text-text">Attendance › Consolidated Attendance Report</strong> — each day&apos;s mark (present, absent, week off, holiday, leave, half day), matched by employee code; it can come on its own for people already here</li>
            </ul>
            <p className="text-xs">Accounts are made without sending invitations — invite people from Staff when you&apos;re ready.</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input type="file" multiple accept=".zip,.xlsx" onChange={(e) => pick(e.target.files)} className="text-sm" />
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={leavers}
                onChange={(e) => {
                  setLeavers(e.target.checked);
                  if (preview) check(e.target.checked);
                }}
              />
              Also bring those who have left, as switched-off records
            </label>
            {preview && preview.roles.length > 0 && (
              <label className="flex items-center gap-1.5 text-sm">
                Role for new accounts
                <select
                  value={role}
                  onChange={(e) => {
                    setRole(e.target.value);
                    check(leavers, e.target.value);
                  }}
                  className="h-8 rounded-base border border-line-strong bg-surface px-2 text-sm"
                >
                  {preview.roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {error && <p role="alert" className="text-danger">{error}</p>}

          {preview && preview.people.inFile > 0 && (
            <div className="space-y-2">
              <p className="text-text">
                {preview.people.inFile} people in Kredily — {preview.people.active} active, {preview.people.leavers} who have left. Bringing{" "}
                <strong>{preview.people.bringing}</strong>.
                {preview.people.noAddress > 0 && <span className="text-warning"> {preview.people.noAddress} have no email address and are left out.</span>}
              </p>
              <p className="text-xs text-subtle">
                Read: {preview.read.map((r) => r.as).join(", ")}.{preview.ignored.length ? ` Not needed: ${preview.ignored.length} file(s).` : ""}
              </p>
              <Step title="Accounts" plan={preview.accounts} extra={`${preview.managers} reporting managers are set once every account exists.`} />
              <Step title="Employee records" plan={preview.records} />
              <Step
                title="Pay"
                plan={preview.pay}
                extra={`${preview.pay.salaries} salaries · ${preview.pay.bank} bank accounts · ${preview.pay.payToDate} with pay so far${preview.pay.through ? `, through ${monthName(preview.pay.through)}` : preview.paySpan ? ` (${preview.paySpan})` : ""}${preview.pay.later.length ? ` — ${preview.pay.later.map(monthName).join(", ")} from the TDS and PF registers, as Kredily paid it` : ""}${preview.pay.estimated ? `; for ${preview.pay.estimated} with no register for that month, its gross is the salary structure's` : ""}. Run the next month's payroll in Deskzo.`}
              />
              <div className="rounded-base border border-line p-3">
                <div className="text-sm font-medium text-text">Leave opening balances</div>
                <p className="mt-1 text-xs text-muted">
                  {preview.leave.balances - preview.leave.nil} balances for {preview.leave.people} people{preview.leave.nil ? `, and ${preview.leave.nil} at nil` : ""}.{" "}
                  {preview.leave.matched.length > 0 && <>Matched: {preview.leave.matched.map((m) => (m.kredily === m.deskzo ? m.deskzo : `${m.kredily} → ${m.deskzo}`)).join(", ")}. </>}
                  {preview.leave.create.length > 0 && <>Made here, by Kredily&apos;s name: {preview.leave.create.join(", ")} — set their yearly days in Settings › Leave. </>}
                  {preview.leave.empty.length > 0 && <span className="text-subtle">Nobody holds a day of {preview.leave.empty.join(", ")} — not made. </span>}
                  {preview.leave.notBalances.length > 0 && <span className="text-subtle">Not a balance, left out: {preview.leave.notBalances.join(", ")}.</span>}
                </p>
              </div>
              <div className="rounded-base border border-line p-3">
                <div className="text-sm font-medium text-text">Pending expense claims</div>
                <p className="mt-1 text-xs text-muted">
                  {preview.expenses.claims === 0
                    ? "None to bring."
                    : `${preview.expenses.claims} claims from ${preview.expenses.people} people, ${preview.expenses.amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })} in all — they arrive awaiting approval, with each person's approver, who is told once.`}
                  {preview.expenses.notHere > 0 && <span className="text-warning"> {preview.expenses.notHere} belong to people not being brought, and are left out.</span>}
                </p>
              </div>
            </div>
          )}

          {preview && preview.people.inFile === 0 && (
            <p className="text-xs text-subtle">Read: {preview.read.map((r) => r.as).join(", ")}. No employee master — only attendance comes across, for people whose employee records are already here.</p>
          )}

          {preview?.attendance && <AttendanceCard plan={preview.attendance} masterToo={preview.people.inFile > 0} onAbsent={(on) => check(leavers, role, on)} disabled={pending} />}

          {result && (
            <div className="space-y-1 rounded-base border border-success/40 bg-success/5 p-3 text-sm">
              <p className="font-medium text-success">Brought across.</p>
              <p>Accounts: {result.accounts.created} made, {result.accounts.updated} updated · Managers set: {result.managers.updated + result.managers.created}</p>
              <p>
                Employee records: {result.records.created + result.records.updated} · Pay: {result.pay.created + result.pay.updated} · Leave balances: {result.leave.saved - result.leave.nil}
                {result.leave.nil ? ` (and ${result.leave.nil} at nil)` : ""}
                {result.leave.saved > 0 && (
                  <>
                    {" "}
                    — see everyone&apos;s in{" "}
                    <Link href="/people/leave/opening" className="text-primary underline-offset-2 hover:underline">
                      Opening balances
                    </Link>
                  </>
                )}
              </p>
              {result.leave.typesMade.length > 0 && <p>Leave types made: {result.leave.typesMade.join(", ")}</p>}
              <p>
                Expense claims awaiting approval: {result.expenses.created}
                {result.expenses.skipped ? ` · ${result.expenses.skipped} already here` : ""}
                {result.expenses.notHere ? ` · ${result.expenses.notHere} left out (their person isn't here)` : ""}
              </p>
              {[...result.accounts.failed, ...result.managers.failed, ...result.records.failed, ...result.pay.failed].length > 0 && (
                <ul className="list-disc pl-5 text-xs text-danger">
                  {[...result.accounts.failed, ...result.managers.failed, ...result.records.failed, ...result.pay.failed].slice(0, 50).map((f, i) => (
                    <li key={`${f.line}-${i}`}>Row {f.line}: {f.error}</li>
                  ))}
                </ul>
              )}
              {result.leave.error && <p className="text-xs text-danger">Leave: {result.leave.error}</p>}
              {result.attendance && (
                <p>
                  Attendance days: {result.attendance.created.toLocaleString("en-IN")}
                  {result.attendance.kept ? ` · ${result.attendance.kept.toLocaleString("en-IN")} already in Deskzo, kept` : ""}
                  {result.attendance.notHere ? ` · ${result.attendance.notHere} employee codes not found` : ""}
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Close
            </Button>
            {!result && (
              <Button type="button" variant="secondary" onClick={() => check()} disabled={pending || uploads.length === 0}>
                {pending && !preview ? "Reading…" : "Preview"}
              </Button>
            )}
            {preview && !result && (
              <Button type="button" onClick={run} disabled={pending}>
                {pending ? "Bringing across…" : preview.people.inFile === 0 ? "Bring attendance across" : `Bring ${preview.people.bringing} people across`}
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
