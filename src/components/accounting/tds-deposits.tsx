"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Trash2, X } from "lucide-react";
import { deleteTdsChallan, linkTdsDeductions, recordTdsChallan, unlinkTdsDeduction } from "@/actions/tds-challans";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Select } from "@/components/ui/input";
import { TDS_SECTIONS } from "@/lib/tds/sections";
import {
  bsrCodeOf,
  challanCin,
  challanSectionLabel,
  challanSectionNumber,
  challanSerialOf,
  lateDepositInterest,
  MAJOR_HEADS,
  MINOR_HEADS,
  SALARY_SECTION,
  type DepositGroup,
  type MajorHead,
  type TdsDeduction,
} from "@/lib/tds/challan-rules";
import type { ChallanRow } from "@/lib/tds/challans";
import { confirmAction } from "@/components/ui/confirm";

const money = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const headName = (h: string) => (h === "0020" ? "0020 · companies" : "0021 · others");
/** The CIN as the counterfoil groups it: BSR code, date, serial. */
const spacedCin = (cin: string) => `${cin.slice(0, 7)} ${cin.slice(7, 15)} ${cin.slice(15)}`;

type Result = { ok: true } | { ok: false; error: string };

/**
 * The TDS page's deposits (src/lib/tds/challans.ts): a month's deductions by what a challan pays — section and
 * head — with what is deposited and left, its challans, and the form that records one. The form starts from a
 * row: its section, its head, its deductions ticked, the tax their total, and interest worked out once the
 * day it was paid is past the due date — each of which can be changed.
 */
export function TdsDeposits({
  month,
  monthLabel,
  dueOn,
  today,
  groups,
  challans,
  linkedByChallan,
  bankAccounts,
}: {
  month: string;
  monthLabel: string;
  dueOn: string;
  today: string;
  groups: DepositGroup[];
  challans: ChallanRow[];
  linkedByChallan: Record<string, TdsDeduction[]>;
  bankAccounts: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ sectionKey: string; majorHead: MajorHead } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const openDeductions = useMemo(() => groups.flatMap((g) => g.open), [groups]);

  const run = (work: () => Promise<Result>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await work();
      if (!r.ok) return setError(r.error);
      after?.();
      router.refresh();
    });

  // A challan pays its own section's deductions, and a bill whose typed section isn't one from the list.
  const fits = (d: TdsDeduction, sectionKey: string, majorHead: string) =>
    d.challanId === null &&
    (d.sectionKey === sectionKey || (d.sectionKey === null && sectionKey !== SALARY_SECTION.key)) &&
    (d.majorHead === majorHead || !d.headKnown);

  return (
    <Card className="mt-4 overflow-hidden p-0">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-text">Deposits</h2>
          <p className="mt-0.5 text-xs text-muted">
            {monthLabel}&apos;s TDS — vendors&apos; and salary&apos;s — by the challan (ITNS 281) each is paid on: one a section and head. Due {dueOn}.
          </p>
        </div>
        {!form && (
          <Button type="button" size="sm" variant="secondary" onClick={() => setForm({ sectionKey: groups[0]?.sectionKey ?? TDS_SECTIONS[0]!.key, majorHead: groups[0]?.majorHead ?? "0021" })}>
            + Record a challan
          </Button>
        )}
      </div>

      {error && <p className="border-b border-line bg-danger-bg px-4 py-2 text-xs text-danger">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Section</th>
              <th className="px-4 py-2.5">Head</th>
              <th className="px-4 py-2.5 text-right">Deducted</th>
              <th className="px-4 py-2.5 text-right">Deposited</th>
              <th className="px-4 py-2.5 text-right">Left</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={`${g.sectionKey}|${g.majorHead}`} className="border-b border-line last:border-0">
                <td className="px-4 py-2 text-text">{g.sectionKey ? challanSectionLabel(g.sectionKey) : <span className="text-warning">A section not from the list</span>}</td>
                <td className="px-4 py-2 text-xs text-muted">{headName(g.majorHead)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(g.deducted)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-muted">{money(g.deposited)}</td>
                <td className={`px-4 py-2 text-right tabular-nums ${g.left > 0 ? "font-medium text-text" : "text-subtle"}`}>{money(g.left)}</td>
                <td className="px-4 py-2 text-right">
                  {g.left > 0 && g.sectionKey && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setForm({ sectionKey: g.sectionKey!, majorHead: g.majorHead })}>
                      Record challan
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {groups.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-subtle">
                  No TDS deducted in {monthLabel} — no bill deducted any, and no locked payroll took income tax.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {form && (
        <ChallanForm
          key={`${form.sectionKey}|${form.majorHead}`}
          month={month}
          monthLabel={monthLabel}
          today={today}
          initial={form}
          bankAccounts={bankAccounts}
          deductionsFor={(sectionKey, majorHead) => openDeductions.filter((d) => fits(d, sectionKey, majorHead))}
          pending={pending}
          onCancel={() => setForm(null)}
          onSave={(input) => run(() => recordTdsChallan(input), () => setForm(null))}
        />
      )}

      {challans.length > 0 && (
        <div className="border-t border-line">
          <p className="px-4 pt-3 text-xs font-medium text-muted">Challans</p>
          <ul className="divide-y divide-line">
            {challans.map((c) => {
              const linked = linkedByChallan[c.id] ?? [];
              const addable = openDeductions.filter((d) => fits(d, c.sectionKey, c.majorHead));
              const expanded = open === c.id;
              return (
                <li key={c.id} className="px-4 py-2.5 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <button type="button" className="flex items-start gap-1.5 text-left" onClick={() => setOpen(expanded ? null : c.id)} aria-expanded={expanded}>
                      {expanded ? <ChevronDown className="mt-0.5 h-4 w-4 text-subtle" /> : <ChevronRight className="mt-0.5 h-4 w-4 text-subtle" />}
                      <span>
                        <span className="font-medium text-text">{challanSectionNumber(c.sectionKey)}</span>{" "}
                        <span className="text-xs text-muted">
                          {c.majorHead}/{c.minorHead} · paid {c.paidOn}
                          {c.bankName ? ` from ${c.bankName}` : ""}
                        </span>
                        <span className="block font-mono text-xs text-muted">CIN {spacedCin(c.cin)}{c.crn ? ` · CRN ${c.crn}` : ""}</span>
                      </span>
                    </button>
                    <div className="flex items-start gap-2">
                      <div className="text-right text-xs">
                        <p className="text-sm font-medium tabular-nums text-text">{money(c.total)}</p>
                        <p className="text-muted">
                          tax {money(c.tax)}
                          {c.interest > 0 && ` · interest ${money(c.interest)}`}
                          {c.fee > 0 && ` · fee ${money(c.fee)}`}
                          {c.others > 0 && ` · others ${money(c.others)}`}
                        </p>
                        {c.linked < c.tax && <p className="text-warning">{money(c.tax - c.linked)} of its tax is matched to no deduction</p>}
                      </div>
                      <IconButton
                        icon={Trash2}
                        label="Delete challan"
                        tone="danger"
                        disabled={pending}
                        onClick={async () => {
                          if (await confirmAction(`Delete challan ${spacedCin(c.cin)}? Its entry is reversed and its deductions are left to deposit.`)) run(() => deleteTdsChallan(c.id));
                        }}
                      />
                    </div>
                  </div>
                  {expanded && (
                    <div className="ml-6 mt-2 space-y-1.5 text-xs">
                      {linked.length === 0 && <p className="text-subtle">No deduction from {monthLabel} is linked to it.</p>}
                      {linked.map((d) => (
                        <div key={d.ref} className="flex items-center justify-between gap-2">
                          <span className="text-muted">
                            {d.docNumber && <span className="font-mono">{d.docNumber} · </span>}
                            {d.party} · {d.deductedOn}
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="tabular-nums text-text">{money(d.amount)}</span>
                            <IconButton icon={X} label="Take off this challan" disabled={pending} onClick={() => run(() => unlinkTdsDeduction(c.id, d.ref.split(":").slice(0, 2).join(":")))} />
                          </span>
                        </div>
                      ))}
                      {addable.length > 0 && <AddDeductions deductions={addable} pending={pending} onAdd={(refs) => run(() => linkTdsDeductions(c.id, refs))} />}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

function AddDeductions({ deductions, pending, onAdd }: { deductions: TdsDeduction[]; pending: boolean; onAdd: (refs: string[]) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div className="space-y-1 rounded-base border border-line bg-surface-sunken p-2">
      <p className="font-medium text-muted">Also paid by it</p>
      {deductions.map((d) => (
        <label key={d.ref} className="flex items-center gap-2">
          <input type="checkbox" checked={picked.includes(d.ref)} onChange={(e) => setPicked(e.target.checked ? [...picked, d.ref] : picked.filter((r) => r !== d.ref))} />
          <span className="flex-1 text-muted">
            {d.docNumber && <span className="font-mono">{d.docNumber} · </span>}
            {d.party}
          </span>
          <span className="tabular-nums">{money(d.amount)}</span>
        </label>
      ))}
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="secondary" disabled={pending || picked.length === 0} onClick={() => onAdd(picked)}>
          Link {picked.length || ""} to this challan
        </Button>
      </div>
    </div>
  );
}

type ChallanDraft = {
  sectionKey: string;
  majorHead: string;
  minorHead: string;
  paidOn: string;
  bsrCode: string;
  challanSerial: string;
  crn: string;
  tax: string;
  interest: string;
  fee: string;
  others: string;
  bankAccountId: string;
  note: string;
  /** The tax and the interest follow the deductions and the day until somebody types one. */
  taxTyped: boolean;
  interestTyped: boolean;
};

function ChallanForm({
  month,
  monthLabel,
  today,
  initial,
  bankAccounts,
  deductionsFor,
  pending,
  onCancel,
  onSave,
}: {
  month: string;
  monthLabel: string;
  today: string;
  initial: { sectionKey: string; majorHead: MajorHead };
  bankAccounts: { id: string; name: string }[];
  deductionsFor: (sectionKey: string, majorHead: string) => TdsDeduction[];
  pending: boolean;
  onCancel: () => void;
  onSave: (input: ChallanDraft & { month: string; refs: string[] }) => void;
}) {
  const [draft, setDraft] = useState<ChallanDraft>({
    sectionKey: initial.sectionKey,
    majorHead: initial.majorHead,
    minorHead: "200",
    paidOn: today,
    bsrCode: "",
    challanSerial: "",
    crn: "",
    tax: "",
    interest: "",
    fee: "",
    others: "",
    bankAccountId: bankAccounts[0]?.id ?? "",
    note: "",
    taxTyped: false,
    interestTyped: false,
  });
  const candidates = deductionsFor(draft.sectionKey, draft.majorHead);
  const [picked, setPicked] = useState<string[]>(() => candidates.map((d) => d.ref));
  const chosen = candidates.filter((d) => picked.includes(d.ref));
  const chosenTotal = Math.round(chosen.reduce((t, d) => t + d.amount, 0) * 100) / 100;
  const late = lateDepositInterest(chosen, draft.paidOn || today);
  // A challan is paid in whole rupees: the deductions' total, rounded up.
  const tax = draft.taxTyped ? draft.tax : chosenTotal ? String(Math.ceil(chosenTotal)) : "";
  const interest = draft.interestTyped ? draft.interest : late.interest ? String(late.interest) : "";
  const total = [tax, interest, draft.fee, draft.others].reduce((t, v) => t + (Number(v) || 0), 0);
  const bsr = bsrCodeOf(draft.bsrCode);
  const serial = challanSerialOf(draft.challanSerial);
  const set = (patch: Partial<ChallanDraft>) => setDraft({ ...draft, ...patch });
  const isSalary = draft.sectionKey === SALARY_SECTION.key;

  return (
    <div className="space-y-3 border-t border-line bg-surface-sunken px-4 py-3 text-sm">
      <p className="text-xs font-medium text-muted">Record a challan, as its counterfoil reads</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="challan-section" className="text-xs">
            Nature of payment
          </Label>
          <Select
            id="challan-section"
            value={draft.sectionKey}
            onChange={(e) => {
              const sectionKey = e.target.value;
              const majorHead = sectionKey === SALARY_SECTION.key ? "0021" : draft.majorHead;
              set({ sectionKey, majorHead });
              setPicked(deductionsFor(sectionKey, majorHead).map((d) => d.ref));
            }}
          >
            {TDS_SECTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.oldSection} — {s.label}
              </option>
            ))}
            <option value={SALARY_SECTION.key}>
              {SALARY_SECTION.oldSection} — {SALARY_SECTION.label}
            </option>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="challan-major" className="text-xs">
            Major head
          </Label>
          <Select
            id="challan-major"
            value={draft.majorHead}
            disabled={isSalary}
            onChange={(e) => {
              set({ majorHead: e.target.value });
              setPicked(deductionsFor(draft.sectionKey, e.target.value).map((d) => d.ref));
            }}
          >
            {Object.entries(MAJOR_HEADS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="challan-minor" className="text-xs">
            Minor head
          </Label>
          <Select id="challan-minor" value={draft.minorHead} onChange={(e) => set({ minorHead: e.target.value })}>
            {Object.entries(MINOR_HEADS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="challan-paid" className="text-xs">
            Paid on
          </Label>
          <Input id="challan-paid" type="date" max={today} value={draft.paidOn} onChange={(e) => set({ paidOn: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="challan-bsr" className="text-xs">
            BSR code
          </Label>
          <Input id="challan-bsr" inputMode="numeric" maxLength={7} placeholder="7 digits" value={draft.bsrCode} onChange={(e) => set({ bsrCode: e.target.value })} className="font-mono" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="challan-serial" className="text-xs">
            Challan serial
          </Label>
          <Input id="challan-serial" inputMode="numeric" maxLength={5} placeholder="Up to 5 digits" value={draft.challanSerial} onChange={(e) => set({ challanSerial: e.target.value })} className="font-mono" />
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium text-muted">Deductions it paid</p>
        {candidates.length === 0 && <p className="text-xs text-subtle">None of {monthLabel}&apos;s deductions under this section and head are left to deposit. A challan can still be recorded and linked later.</p>}
        {candidates.map((d) => (
          <label key={d.ref} className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={picked.includes(d.ref)} onChange={(e) => setPicked(e.target.checked ? [...picked, d.ref] : picked.filter((r) => r !== d.ref))} />
            <span className="flex-1 text-muted">
              {d.docNumber && <span className="font-mono">{d.docNumber} · </span>}
              {d.party} · {d.deductedOn}
              {!d.headKnown && <span className="text-warning"> · no PAN, so its head isn&apos;t known</span>}
              {d.sectionKey === null && <span className="text-warning"> · its section isn&apos;t one from the list</span>}
            </span>
            <span className="tabular-nums text-text">{money(d.amount)}</span>
          </label>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="challan-tax" className="text-xs">
            Tax
          </Label>
          <Input
            id="challan-tax"
            type="number"
            step="1"
            min="0"
            value={tax}
            onChange={(e) => set({ tax: e.target.value, taxTyped: true })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="challan-interest" className="text-xs">
            Interest
          </Label>
          <Input
            id="challan-interest"
            type="number"
            step="1"
            min="0"
            value={interest}
            onChange={(e) => set({ interest: e.target.value, interestTyped: true })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="challan-fee" className="text-xs">
            Fee (late statement)
          </Label>
          <Input id="challan-fee" type="number" step="1" min="0" value={draft.fee} onChange={(e) => set({ fee: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="challan-others" className="text-xs">
            Others
          </Label>
          <Input id="challan-others" type="number" step="1" min="0" value={draft.others} onChange={(e) => set({ others: e.target.value })} />
        </div>
      </div>
      {late.late.length > 0 && (
        <p className="text-xs text-warning">
          Paid after {late.late[0]!.dueOn}: interest at 1.5% a month, counted from the month each was deducted — {money(late.interest)}
          {draft.interestTyped && Number(interest) !== late.interest && (
            <>
              {" "}
              <button type="button" className="text-brand hover:underline" onClick={() => set({ interest: "", interestTyped: false })}>
                Use it
              </button>
            </>
          )}
        </p>
      )}
      {draft.taxTyped && Number(tax) !== Math.ceil(chosenTotal) && chosen.length > 0 && (
        <p className="text-xs text-muted">
          The deductions ticked come to {money(chosenTotal)}{chosenTotal % 1 ? `, ${money(Math.ceil(chosenTotal))} in whole rupees` : ""}.{" "}
          <button type="button" className="text-brand hover:underline" onClick={() => set({ tax: "", taxTyped: false })}>
            Use that
          </button>
        </p>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="challan-bank" className="text-xs">
            Paid from
          </Label>
          <Select id="challan-bank" value={draft.bankAccountId} onChange={(e) => set({ bankAccountId: e.target.value })}>
            {bankAccounts.length === 0 && <option value="">The bank account</option>}
            {bankAccounts.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="challan-crn" className="text-xs">
            CRN (paid online)
          </Label>
          <Input id="challan-crn" value={draft.crn} onChange={(e) => set({ crn: e.target.value })} className="font-mono uppercase" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="challan-note" className="text-xs">
            Note
          </Label>
          <Input id="challan-note" value={draft.note} onChange={(e) => set({ note: e.target.value })} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {bsr && serial && draft.paidOn ? (
            <>
              CIN <span className="font-mono">{spacedCin(challanCin({ bsrCode: bsr, paidOn: draft.paidOn, challanSerial: serial }))}</span> ·{" "}
            </>
          ) : null}
          Total <span className="font-medium tabular-nums text-text">{money(total)}</span>, posted to TDS Payable{Number(interest) || Number(draft.fee) || Number(draft.others) ? " and Interest & Fees on Taxes" : ""}.
        </p>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={pending} onClick={() => onSave({ ...draft, tax, interest, month, refs: chosen.map((d) => d.ref) })}>
            Save challan
          </Button>
        </div>
      </div>
    </div>
  );
}
