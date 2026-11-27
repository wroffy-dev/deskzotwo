"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveVerifiable, setVerifiableWithdrawn, verifiableLink, type VerifiableRow } from "@/actions/verifiable";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { CustomFieldBodyCells, CustomFieldHeaderCells, type CustomColumn } from "@/components/custom-fields/custom-field-cells";
import { CustomFieldInputs, type CustomFieldFormValues, type CustomFieldPerson } from "@/components/custom-fields/custom-field-inputs";
import type { CustomFieldDef } from "@/lib/custom-fields/rules";
import { formatCalendarDay } from "@/lib/time/zone";
import { DOCUMENT_TYPES, STANDING_WORDS, type VerifiableStanding } from "@/lib/verifiable/rules";

const TONE: Record<VerifiableStanding, "green" | "amber" | "red"> = { VALID: "green", EXPIRED: "amber", WITHDRAWN: "red" };

/** The workspace's own fields, for the form: src/lib/custom-fields/server.ts `formSetup`. */
export type CustomSetup = { fields: CustomFieldDef[]; values: CustomFieldFormValues; people: CustomFieldPerson[] };

type Blank = { id?: string; docType: string; number: string; title: string; holderName: string; scope: string; companyId: string; issuedOn: string; expiresOn: string; holderIsPerson: boolean; inSearch: boolean };

function DocumentForm({ start, companies, custom, onClose }: { start: Blank; companies: CompanyComboOption[]; custom: CustomSetup; onClose: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState(start);
  const [fields, setFields] = useState<CustomFieldFormValues>(custom.values);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();
  const set = (key: Exclude<keyof Blank, "holderIsPerson" | "inSearch">) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const save = () =>
    run(async () => {
      setError(null);
      const r = await saveVerifiable({ ...form, customFields: fields });
      if (!r.ok) return setError(r.error);
      onClose();
      router.refresh();
    });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="vd-type">Kind of document</Label>
          <Input id="vd-type" list="vd-types" value={form.docType} onChange={set("docType")} />
          <datalist id="vd-types">
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="vd-number">Number</Label>
          <Input id="vd-number" value={form.number} onChange={set("number")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="vd-title">What it&apos;s for</Label>
          <Input id="vd-title" placeholder="ISO 9001:2015" value={form.title} onChange={set("title")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="vd-holder">Issued to</Label>
          <Input id="vd-holder" value={form.holderName} onChange={set("holderName")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="vd-issued">Issued on</Label>
          <Input id="vd-issued" type="date" value={form.issuedOn} onChange={set("issuedOn")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="vd-expires">Valid until (optional)</Label>
          <Input id="vd-expires" type="date" value={form.expiresOn} onChange={set("expiresOn")} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="vd-company">Customer (optional, never shown publicly)</Label>
        <CompanyCombobox id="vd-company" companies={companies} value={form.companyId} onSelect={(c) => setForm((f) => ({ ...f, companyId: c?.id ?? "", holderName: f.holderName || c?.name || "" }))} placeholder="Type to search customers…" autoHighlightFirst="typed" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="vd-scope">Scope (optional, shown publicly)</Label>
        <Textarea id="vd-scope" rows={2} value={form.scope} onChange={set("scope")} />
      </div>
      {custom.fields.length > 0 && <CustomFieldInputs fields={custom.fields} values={fields} people={custom.people} idPrefix="vdcf" onChange={(key, value) => setFields((c) => ({ ...c, [key]: value }))} />}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={form.holderIsPerson} onChange={(e) => setForm((f) => ({ ...f, holderIsPerson: e.target.checked }))} />
        <span>Issued to a person, not a company: a search by name never finds it</span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={form.inSearch} onChange={(e) => setForm((f) => ({ ...f, inSearch: e.target.checked }))} />
        <span>Show in the public search. Its QR code works either way.</span>
      </label>
      <p className="text-xs text-subtle">The details above show on the public page, except the customer and any of your own fields not marked for it. Don&apos;t put phone numbers, ID numbers or anything private here.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={pending} onClick={save}>
          {pending ? "Saving…" : form.id ? "Save" : "Add document"}
        </Button>
      </div>
    </div>
  );
}

const EMPTY: Blank = { docType: "Certificate", number: "", title: "", holderName: "", scope: "", companyId: "", issuedOn: "", expiresOn: "", holderIsPerson: false, inSearch: true };

export function VerifiableAdd({ companies, custom }: { companies: CompanyComboOption[]; custom: CustomSetup }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Add document
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add a verifiable document" large>
        {open && <DocumentForm start={EMPTY} companies={companies} custom={custom} onClose={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function QrDialog({ row, onClose }: { row: VerifiableRow; onClose: () => void }) {
  const [link, setLink] = useState<{ url: string; qrUrl: string; qr: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When it opens, not while it draws: a server action can't be called during a render.
  useEffect(() => {
    let current = true;
    void verifiableLink(row.id)
      .then((r) => {
        if (!current) return;
        if (r.ok) setLink(r.data);
        else setError(r.error);
      })
      .catch(() => {
        if (current) setError("The QR code couldn't be made. Try again.");
      });
    return () => {
      current = false;
    };
  }, [row.id]);
  return (
    <Dialog open onClose={onClose} title={`QR code for ${row.number}`}>
      <div className="space-y-3 text-sm">
        {error && <p className="text-danger">{error}</p>}
        {!link && !error && <p className="text-muted">Getting it ready…</p>}
        {link && (
          <>
            {/* A data address made here, not a remote image. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={link.qr} alt={`QR code for ${row.number}`} className="mx-auto h-56 w-56" />
            <p className="break-all rounded-base bg-surface-sunken px-3 py-2 font-mono text-xs text-text">{link.url}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => void navigator.clipboard.writeText(link.url)}>
                Copy link
              </Button>
              <a href={link.qr} download={`${row.number.replace(/[^A-Za-z0-9_-]+/g, "-")}-qr.png`} className="inline-flex h-8 items-center rounded-base bg-brand px-3 text-sm font-medium text-white">
                Download QR
              </a>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function WithdrawDialog({ row, onClose }: { row: VerifiableRow; onClose: () => void }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();
  const go = () =>
    run(async () => {
      setError(null);
      const r = await setVerifiableWithdrawn(row.id, true, reason);
      if (!r.ok) return setError(r.error);
      onClose();
      router.refresh();
    });
  return (
    <Dialog open onClose={onClose} title={`Withdraw ${row.number}`}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">Its public page says Withdrawn straight away. The reason stays in here and is never shown publicly. You can put it back later.</p>
        <div className="space-y-1.5">
          <Label htmlFor="vd-why">Why</Label>
          <Textarea id="vd-why" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {error && <p className="text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={pending || reason.trim().length < 3} onClick={go}>
            Withdraw
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function VerifiableTable({ rows, mayIssue, mayWithdraw, companies, customColumns, customFor }: { rows: VerifiableRow[]; mayIssue: boolean; mayWithdraw: boolean; companies: CompanyComboOption[]; customColumns: { columns: CustomColumn[]; texts: Record<string, Record<string, string>> }; customFor: Record<string, CustomSetup> }) {
  const router = useRouter();
  const [qr, setQr] = useState<VerifiableRow | null>(null);
  const [edit, setEdit] = useState<VerifiableRow | null>(null);
  const [withdraw, setWithdraw] = useState<VerifiableRow | null>(null);
  const [, run] = useTransition();
  if (rows.length === 0) return <Card className="px-4 py-10 text-center text-sm text-muted">No documents here yet.</Card>;
  return (
    <>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-subtle">
              <th className="px-4 py-2.5">Number</th>
              <th className="px-4 py-2.5">Issued to</th>
              <th className="px-4 py-2.5">For</th>
              <th className="px-4 py-2.5">Valid until</th>
              <CustomFieldHeaderCells columns={customColumns.columns} className="px-4 py-2.5" />
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5">
                  <span className="font-mono text-xs text-text">{r.number}</span>
                  <span className="block text-xs text-subtle">{r.docType}</span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-text">{r.holderName}</span>
                  {r.companyName && r.companyName !== r.holderName && <span className="block text-xs text-subtle">{r.companyName}</span>}
                </td>
                <td className="px-4 py-2.5 text-muted">{r.title}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">{r.expiresOn ? formatCalendarDay(r.expiresOn) : "No end date"}</td>
                <CustomFieldBodyCells columns={customColumns.columns} texts={customColumns.texts[r.id]} className="px-4 py-2.5" />
                <td className="px-4 py-2.5">
                  <Badge tone={TONE[r.standing]}>{STANDING_WORDS[r.standing]}</Badge>
                  {r.withdrawnReason && <span className="block text-xs text-subtle">{r.withdrawnReason}</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                  <span className="inline-flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setQr(r)}>
                      QR
                    </Button>
                    {mayIssue && (
                      <Button size="sm" variant="ghost" onClick={() => setEdit(r)}>
                        Edit
                      </Button>
                    )}
                    {mayWithdraw &&
                      (r.withdrawnAt ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            run(async () => {
                              await setVerifiableWithdrawn(r.id, false);
                              router.refresh();
                            })
                          }
                        >
                          Put back
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setWithdraw(r)}>
                          Withdraw
                        </Button>
                      ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {qr && <QrDialog row={qr} onClose={() => setQr(null)} />}
      {withdraw && <WithdrawDialog row={withdraw} onClose={() => setWithdraw(null)} />}
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit ? `Edit ${edit.number}` : ""} large>
        {edit && (
          <DocumentForm
            start={{ id: edit.id, docType: edit.docType, number: edit.number, title: edit.title, holderName: edit.holderName, scope: edit.scope ?? "", companyId: edit.companyId ?? "", issuedOn: edit.issuedOn, expiresOn: edit.expiresOn ?? "", holderIsPerson: edit.holderIsPerson, inSearch: edit.inSearch }}
            companies={companies}
            custom={customFor[edit.id] ?? { fields: [], values: {}, people: [] }}
            onClose={() => setEdit(null)}
          />
        )}
      </Dialog>
    </>
  );
}
