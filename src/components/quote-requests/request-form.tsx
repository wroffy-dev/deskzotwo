"use client";

import { useRef, useState, useTransition } from "react";
import { Check, Lock, Paperclip, Plus, X } from "lucide-react";
import { sendQuoteRequest, type QuoteRequestPage } from "@/actions/quote-request-public";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { LIMITS, RFQ_FILE_ACCEPT } from "@/lib/quote-requests-shared";

/**
 * A reseller asking for a quotation through their own link (/rfq/<token>, src/lib/quote-requests.ts). Who they are comes
 * from the link and can't be changed here; what they need, for whom, by when and where is theirs to say.
 */

type Line = { key: number; description: string; quantity: string; brand: string; notes: string };
const blank = (key: number): Line => ({ key, description: "", quantity: "", brand: "", notes: "" });

export function QuoteRequestForm({ token, page }: { token: string; page: QuoteRequestPage }) {
  const [lines, setLines] = useState<Line[]>([blank(1)]);
  const nextKey = useRef(2);
  const [fields, setFields] = useState({ endCustomerName: "", endCustomerCountry: "", dealReference: "", neededBy: "", deliveryLocation: "", budget: "", notes: "" });
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const set = (k: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setFields((f) => ({ ...f, [k]: e.target.value }));
  const setLine = (key: number, k: keyof Omit<Line, "key">, v: string) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [k]: v } : l)));

  function send() {
    setError(null);
    setErrors({});
    if (file && file.size > LIMITS.fileBytes) {
      setErrors({ file: `${file.name} is over ${LIMITS.fileBytes / 1024 / 1024} MB — attach a smaller copy.` });
      return;
    }
    const form = new FormData();
    form.set("token", token);
    form.set("request", JSON.stringify({ ...fields, lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, brand: l.brand, notes: l.notes })) }));
    if (file) form.set("file", file);
    start(async () => {
      const out = await sendQuoteRequest(form).catch(() => ({ ok: false as const, error: "It didn't go through — check your connection and send it again." }));
      if (out.ok) {
        setSent(out.reference);
        return;
      }
      setError(out.error);
      if ("errors" in out && out.errors) setErrors(out.errors);
    });
  }

  if (sent) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <span aria-hidden="true" className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-success-bg text-success">
          <Check className="h-5 w-5" />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-text">Request sent — {sent}</h1>
        <p className="mt-2 text-sm text-muted">
          {page.ourName || "We"} will send the quotation{page.contactEmail ? ` to ${page.contactEmail}` : ""}. Keep this link — it works for your next request too.
        </p>
        <Button
          type="button"
          variant="secondary"
          className="mt-5"
          onClick={() => {
            setSent(null);
            setLines([blank(nextKey.current++)]);
            setFields({ endCustomerName: "", endCustomerCountry: "", dealReference: "", neededBy: "", deliveryLocation: "", budget: "", notes: "" });
            setFile(null);
          }}
        >
          Ask for another
        </Button>
      </Card>
    );
  }

  const fieldError = (k: string) => (errors[k] ? <p className="text-xs text-danger">{errors[k]}</p> : null);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        {page.ourName && <p className="text-sm font-medium text-muted">{page.ourName}</p>}
        <h1 className="text-xl font-semibold text-text">Request a quotation</h1>
        <p className="mt-1 text-sm text-muted">Tell us what your customer needs and we&apos;ll send you a quotation at your partner prices. No sign-in needed.</p>
      </div>

      <Card className="space-y-3 p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Locked label="Reseller" value={page.resellerName} />
          <Locked label="Your name" value={page.contactName} />
          <Locked label="Email" value={page.contactEmail || "—"} />
        </div>
        <p className="flex items-center gap-1.5 text-xs text-subtle">
          <Lock aria-hidden="true" className="h-3.5 w-3.5" /> Filled in from your link. Wrong person? Ask your account manager for a new one.
        </p>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="text-sm font-semibold text-text">End customer</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="endCustomerName">Company *</Label>
            <Input id="endCustomerName" value={fields.endCustomerName} onChange={set("endCustomerName")} maxLength={200} aria-invalid={!!errors.endCustomerName} />
            {fieldError("endCustomerName")}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="endCustomerCountry">Country</Label>
            <Input id="endCustomerCountry" value={fields.endCustomerCountry} onChange={set("endCustomerCountry")} maxLength={80} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dealReference">Deal or tender reference</Label>
            <Input id="dealReference" value={fields.dealReference} onChange={set("dealReference")} maxLength={120} placeholder="Optional" />
          </div>
        </div>
        <p className="text-xs text-subtle">Kept as your customer. We never contact them directly.</p>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="text-sm font-semibold text-text">Items</h2>
        {lines.map((l, i) => (
          <div key={l.key} className="space-y-1">
            <div className="grid grid-cols-[minmax(0,2.2fr)_70px_minmax(0,1.3fr)_minmax(0,1.3fr)_36px] gap-2">
              <Input aria-label={`Item ${i + 1}: what it is`} placeholder="Item / description *" value={l.description} onChange={(e) => setLine(l.key, "description", e.target.value)} maxLength={LIMITS.text} />
              <Input aria-label={`Item ${i + 1}: quantity`} placeholder="Qty" inputMode="numeric" value={l.quantity} onChange={(e) => setLine(l.key, "quantity", e.target.value.replace(/[^\d]/g, ""))} />
              <Input aria-label={`Item ${i + 1}: brand or model`} placeholder="Brand / model" value={l.brand} onChange={(e) => setLine(l.key, "brand", e.target.value)} maxLength={LIMITS.text} />
              <Input aria-label={`Item ${i + 1}: notes`} placeholder="Notes" value={l.notes} onChange={(e) => setLine(l.key, "notes", e.target.value)} maxLength={LIMITS.text} />
              <Button type="button" variant="secondary" aria-label={`Remove item ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="px-0">
                <X aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
            {fieldError(`lines.${i}`)}
          </div>
        ))}
        {fieldError("lines")}
        {lines.length < LIMITS.lines && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, blank(nextKey.current++)])}>
            <Plus aria-hidden="true" className="h-4 w-4" /> Add item
          </Button>
        )}
      </Card>

      <Card className="space-y-3 p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="neededBy">Needed by</Label>
            <Input id="neededBy" type="date" min={page.today} value={fields.neededBy} onChange={set("neededBy")} />
            {fieldError("neededBy")}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="deliveryLocation">Delivery location</Label>
            <Input id="deliveryLocation" value={fields.deliveryLocation} onChange={set("deliveryLocation")} maxLength={200} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="budget">Budget (optional)</Label>
            <Input id="budget" value={fields.budget} onChange={set("budget")} maxLength={80} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="notes">Notes</Label>
          <Textarea id="notes" value={fields.notes} onChange={set("notes")} maxLength={LIMITS.notes} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-base border border-line-strong px-3 py-1.5 text-sm text-text hover:bg-surface-sunken">
            <Paperclip aria-hidden="true" className="h-4 w-4" />
            {file ? file.name : "Attach RFQ or specification"}
            <input type="file" accept={RFQ_FILE_ACCEPT} className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          {file && (
            <button type="button" className="text-xs text-muted underline" onClick={() => setFile(null)}>
              Remove
            </button>
          )}
          <span className="text-xs text-subtle">PDF, picture, Excel, Word or CSV · up to {LIMITS.fileBytes / 1024 / 1024} MB</span>
        </div>
        {fieldError("file")}
      </Card>

      {error && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="button" onClick={send} disabled={pending}>
          {pending ? "Sending…" : "Send request"}
        </Button>
      </div>
    </div>
  );
}

function Locked({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="truncate rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm text-muted">{value}</p>
    </div>
  );
}
