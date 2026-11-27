"use client";

import { workspacePack } from "@/lib/country-pack";
import { useState, useTransition } from "react";
import { Download, Eye, EyeOff, FileText, Mail, Printer } from "lucide-react";
import { sendStatement, statementEmailSetup } from "@/actions/statement-send";
import { CcField } from "@/components/mail/cc-field";
import type { StatementSide } from "@/lib/statements/paths";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

type Preset = "this-month" | "last-month" | "this-quarter" | "this-fy" | "last-fy" | "all" | "custom";

const PRESETS: { value: Preset; label: string }[] = [
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "this-quarter", label: "This quarter" },
  { value: "this-fy", label: "This financial year" },
  { value: "last-fy", label: "Last financial year" },
  { value: "all", label: "All transactions" },
  { value: "custom", label: "Custom dates" },
];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The period a preset names, on this computer's calendar — India's financial year runs April to March. */
function rangeOf(preset: Preset, today: Date): { from: string; to: string } | null {
  const y = today.getFullYear();
  const m = today.getMonth();
  const fm = workspacePack().fyStartMonth;
  const fyStart = m >= fm ? y : y - 1;
  switch (preset) {
    case "this-month":
      return { from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 0)) };
    case "last-month":
      return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
    case "this-quarter": {
      const q = Math.floor(m / 3) * 3;
      return { from: ymd(new Date(y, q, 1)), to: ymd(new Date(y, q + 3, 0)) };
    }
    case "this-fy":
      return { from: ymd(new Date(fyStart, fm, 1)), to: ymd(new Date(fyStart + 1, fm, 0)) };
    case "last-fy":
      return { from: ymd(new Date(fyStart - 1, fm, 1)), to: ymd(new Date(fyStart, fm, 0)) };
    default:
      return null;
  }
}

type Recipient = { id: string; name: string; email: string | null; designation: string | null; receivesDocuments: boolean; isPrimary: boolean; canReceive: boolean; blockedBecause: string | null };

/**
 * A statement of accounts as the customer (or vendor) gets it (owner, 31 Oct 2026): the period and the view chosen here,
 * and Print, Download PDF and Send email for exactly that. The printed statement is previewed only when asked for, at
 * its own height (owner, 31 Oct 2026: "the pdf is blocking the view of the important info below").
 */
export function StatementToolbar({ side, companyId }: { side: StatementSide; companyId: string }) {
  const [preset, setPreset] = useState<Preset>("this-fy");
  const [custom, setCustom] = useState(() => rangeOf("this-month", new Date())!);
  const [show, setShow] = useState<"all" | "outstanding">("all");
  const range = preset === "custom" ? custom : rangeOf(preset, new Date());
  const params = new URLSearchParams();
  if (range?.from) params.set("from", range.from);
  if (range?.to) params.set("to", range.to);
  if (show === "outstanding") params.set("show", "outstanding");
  const query = params.toString();
  const printUrl = `/statements/${side}/${companyId}/print${query ? `?${query}` : ""}`;
  const pdfUrl = `/api/statements/${side}/${companyId}/pdf${query ? `?${query}` : ""}`;

  const [open, setOpen] = useState(false);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [cc, setCc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState(false);
  const view = { from: range?.from ?? null, to: range?.to ?? null, show };
  const periodWords = preset === "custom" ? (range?.from && range.to ? `${range.from} to ${range.to}` : "Custom dates") : PRESETS.find((p) => p.value === preset)!.label;
  const button = "inline-flex h-9 items-center gap-1.5 rounded-base border border-line-strong bg-surface px-3 text-sm font-medium text-text hover:bg-surface-sunken";

  function openSend() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const setup = await statementEmailSetup(side, companyId, view);
      if (!setup.ok) return setError(setup.error);
      setRecipients(setup.data.recipients);
      // Those who receive documents, else the primary contact — whoever can take mail.
      const able = setup.data.recipients.filter((r) => r.canReceive && r.email);
      const preferred = able.filter((r) => r.receivesDocuments);
      setTicked(new Set((preferred.length ? preferred : able.filter((r) => r.isPrimary)).map((r) => r.id)));
      setSubject(setup.data.subject);
      setBody(setup.data.body);
      setOpen(true);
    });
  }

  function send() {
    setError(null);
    startTransition(async () => {
      const done = await sendStatement({ side, companyId, view, contactIds: [...ticked], subject, body, cc });
      if (!done.ok) return setError(done.error);
      setOpen(false);
      setNotice(`Sent to ${done.data.sentTo.join(", ")} from ${done.data.from}.`);
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-base bg-brand/10 text-brand">
          <FileText className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text">{side === "AP" ? "Statement for the vendor" : "Statement for the customer"}</h3>
          <p className="text-xs text-muted">
            {periodWords} · {show === "outstanding" ? "outstanding only" : "all transactions"} — print it, download the PDF or email it.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor={`st-period-${side}`}>Period</Label>
          <Select id={`st-period-${side}`} value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className="h-9 w-48">
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>
        {preset === "custom" && (
          <>
            <div>
              <Label htmlFor={`st-from-${side}`}>From</Label>
              <Input id={`st-from-${side}`} type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="h-9 w-40" />
            </div>
            <div>
              <Label htmlFor={`st-to-${side}`}>To</Label>
              <Input id={`st-to-${side}`} type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="h-9 w-40" />
            </div>
          </>
        )}
        <div>
          <Label htmlFor={`st-show-${side}`}>Show</Label>
          <Select id={`st-show-${side}`} value={show} onChange={(e) => setShow(e.target.value === "outstanding" ? "outstanding" : "all")} className="h-9 w-48">
            <option value="all">All transactions</option>
            <option value="outstanding">Outstanding only</option>
          </Select>
        </div>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <button type="button" onClick={() => setPreview((p) => !p)} aria-expanded={preview} className={button}>
            {preview ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {preview ? "Hide preview" : "Preview"}
          </button>
          <a href={printUrl} target="_blank" rel="noopener" className={button}>
            <Printer className="h-4 w-4" />
            Print
          </a>
          <a href={pdfUrl} className={button}>
            <Download className="h-4 w-4" />
            Download PDF
          </a>
          <Button type="button" size="sm" className="h-9" onClick={openSend} disabled={pending}>
            <Mail className="h-4 w-4" />
            {pending && !open ? "Opening…" : "Send email"}
          </Button>
        </div>
      </div>
      {notice && <p className="text-sm text-success">{notice}</p>}
      {error && !open && <p role="alert" className="text-sm text-danger">{error}</p>}

      {/* The statement exactly as it prints and as the PDF carries it — when asked for, and as tall as it is, so it never
          stands between the page and the figures below it. Same origin, so its height can be read once it loads. */}
      {preview && (
        <iframe
          key={printUrl}
          src={`${printUrl}${query ? "&" : "?"}embed=1`}
          title="Statement preview"
          className="h-[480px] w-full rounded-base border border-line bg-neutral-100"
          onLoad={(e) => {
            const doc = e.currentTarget.contentDocument;
            if (doc?.documentElement) e.currentTarget.style.height = `${Math.min(Math.max(doc.documentElement.scrollHeight + 8, 320), 1400)}px`;
          }}
        />
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title="Email the statement" wide>
        <div className="space-y-3">
          <div>
            <Label>To</Label>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-base border border-line p-2">
              {recipients.length === 0 && <p className="text-sm text-subtle">No contacts on this company yet — add one with an email address first.</p>}
              {recipients.map((r) => (
                <label key={r.id} className={`flex items-start gap-2 text-sm ${r.canReceive && r.email ? "" : "opacity-60"}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    disabled={!r.canReceive || !r.email}
                    checked={ticked.has(r.id)}
                    onChange={() =>
                      setTicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      })
                    }
                  />
                  <span>
                    <span className="text-text">{r.name}</span> <span className="text-muted">{r.email ?? "no email"}</span>
                    {!r.canReceive && r.blockedBecause && <span className="block text-xs text-warning">{r.blockedBecause}</span>}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <CcField id="st-cc" value={cc} onChange={setCc} disabled={pending} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="st-subject">Subject</Label>
            <Input id="st-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="st-body">Message</Label>
            <Textarea id="st-body" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <p className="text-xs text-subtle">The statement goes attached as a PDF, for the period and view above.</p>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={send} disabled={pending || ticked.size === 0}>
              {pending ? "Sending…" : `Send to ${ticked.size}`}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
