"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Copy, Link2, Mail, Paperclip } from "lucide-react";
import { assignQuoteRequest, declineQuoteRequest, revokeQuoteRequestLink, sendQuoteRequestLink } from "@/actions/quote-requests";
import type { LinkView, RequestView } from "@/lib/quote-requests";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";

/**
 * A reseller's quote requests, on their page (src/lib/quote-requests.ts): each with its lines matched to the catalogue
 * at their prices, and Create quote, Assign, Decline; and their links — sent, or switched off.
 */

type Person = { id: string; name: string };

const STATE: Record<RequestView["state"], { label: string; tone: "amber" | "green" | "default" }> = {
  new: { label: "New", tone: "amber" },
  quoted: { label: "Quoted", tone: "green" },
  declined: { label: "Declined", tone: "default" },
};

const SOURCE = { special: "special price", tier: "tier discount", catalog: "list price" } as const;

export function ResellerQuoteRequests({
  resellerId,
  requests,
  links,
  contacts,
  maySend,
  people,
}: {
  resellerId: string;
  requests: RequestView[];
  links: LinkView[];
  contacts: { id: string; name: string; email: string | null }[];
  maySend: boolean;
  people: Person[];
}) {
  const router = useRouter();
  const clock = useClock();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [contactId, setContactId] = useState(contacts[0]?.id ?? "");
  const [made, setMade] = useState<{ url: string; emailed: boolean; to: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [declining, setDeclining] = useState<{ id: string; reason: string } | null>(null);
  const money = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function run(task: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) {
    setError(null);
    start(async () => {
      const out = await task();
      if (!out.ok) setError(out.error);
      else {
        after?.();
        router.refresh();
      }
    });
  }

  /** A new link for the chosen person: emailed to them, or shown to copy. Shown once — only its hash is kept. */
  function send(email: boolean) {
    const to = contacts.find((c) => c.id === contactId);
    if (!to) return;
    setError(null);
    setCopied(false);
    start(async () => {
      const out = await sendQuoteRequestLink({ resellerId, contactId, email });
      if (!out.ok) {
        setError(out.error);
        return;
      }
      setMade({ ...out.data, to: to.name });
      router.refresh();
    });
  }

  async function copy() {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.url);
      setCopied(true);
    } catch {
      setError("Couldn't copy — select the link and copy it.");
    }
  }

  return (
    <Card id="quote-requests">
      <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
        <span>Quote requests</span>
        {maySend && contacts.length > 0 && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setSending((v) => !v)}>
            <Link2 aria-hidden="true" className="h-4 w-4" /> Send link
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-danger">
            {error}
          </p>
        )}
        {sending && (
          <div className="space-y-2 rounded-md border border-line p-3">
            <p className="text-xs text-muted">Their own link to ask for quotations. It works until you switch it off.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label="Who at the reseller" className="h-8 w-56 text-xs" value={contactId} onChange={(e) => setContactId(e.target.value)}>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.email ? "" : " (no email)"}
                  </option>
                ))}
              </Select>
              <Button type="button" size="sm" disabled={pending || !contacts.find((c) => c.id === contactId)?.email} onClick={() => send(true)}>
                <Mail aria-hidden="true" className="h-4 w-4" /> Email it
              </Button>
              <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => send(false)}>
                <Link2 aria-hidden="true" className="h-4 w-4" /> Make a link to copy
              </Button>
            </div>
            {made && (
              <div className="space-y-1">
                <p className="text-xs text-success">{made.emailed ? `Emailed to ${made.to}.` : `A link for ${made.to} — copy it now; it isn't shown again.`}</p>
                {!made.emailed && (
                  <div className="flex items-center gap-2">
                    <Input readOnly aria-label="The link" className="h-8 flex-1 font-mono text-xs" value={made.url} onFocus={(e) => e.currentTarget.select()} />
                    <Button type="button" variant="secondary" size="sm" onClick={copy}>
                      {copied ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {links.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted">Live links</p>
            {links.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-text">
                  {l.contactName}
                  <span className="ml-1.5 text-subtle">
                    sent {clock.date(l.createdAt)}
                    {l.lastUsedAt ? ` · last used ${clock.date(l.lastUsedAt)}` : " · not used yet"}
                  </span>
                </span>
                <button type="button" className="text-muted underline hover:text-text" disabled={pending} onClick={() => run(() => revokeQuoteRequestLink(l.id))}>
                  Switch off
                </button>
              </div>
            ))}
          </div>
        )}
        {requests.length === 0 && (
          <p className="text-subtle">
            {links.length ? "No requests yet. They'll show here when the reseller sends one." : "Send someone at this reseller their own link, and their requests for quotations land here."}
          </p>
        )}
        {requests.map((r) => (
          <div key={r.id} className="space-y-2 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-text">{r.reference}</span>
              <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge>
              <span className="text-xs text-muted">
                {r.contactName ? `from ${r.contactName} · ` : ""}
                {clock.dateTimeShort(r.createdAt)}
              </span>
              {r.neededBy && <span className="ml-auto text-xs text-muted">Needed by {formatCalendarDay(r.neededBy)}</span>}
            </div>
            <p className="text-xs text-muted">
              For <span className="text-text">{r.endCustomerName}</span>
              {r.endCustomerCountry ? `, ${r.endCustomerCountry}` : ""} <Badge className="ml-1">Reseller&apos;s customer · no direct contact</Badge>
              {r.dealReference ? ` · Ref ${r.dealReference}` : ""}
              {r.deliveryLocation ? ` · Deliver to ${r.deliveryLocation}` : ""}
              {r.budget ? ` · Budget ${r.budget}` : ""}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-xs">
                <thead className="text-left text-muted">
                  <tr>
                    <th className="py-1 pr-2 font-normal">Asked for</th>
                    <th className="py-1 pr-2 font-normal">Qty</th>
                    <th className="py-1 pr-2 font-normal">Matched item</th>
                    <th className="py-1 text-right font-normal">Partner price</th>
                  </tr>
                </thead>
                <tbody>
                  {r.lines.map((l) => (
                    <tr key={l.id} className="border-t border-line align-top">
                      <td className="py-1.5 pr-2 text-text">
                        {l.description}
                        {(l.brand || l.notes) && <span className="block text-muted">{[l.brand, l.notes].filter(Boolean).join(" · ")}</span>}
                      </td>
                      <td className="py-1.5 pr-2">{l.quantity}</td>
                      <td className="py-1.5 pr-2">{l.item ? l.item.name : <span className="text-subtle">Not in your items · stays as typed</span>}</td>
                      <td className="py-1.5 text-right">
                        {l.price ? (
                          <span title={SOURCE[l.price.source]}>
                            {money.format(l.price.unitPrice)}
                            <span className="block text-subtle">{SOURCE[l.price.source]}</span>
                          </span>
                        ) : (
                          <span className="text-subtle">set on the quote</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {r.notes && <p className="whitespace-pre-line text-xs text-muted">{r.notes}</p>}
            {r.state === "declined" && r.declineReason && <p className="text-xs text-muted">Declined: {r.declineReason}</p>}
            <div className="flex flex-wrap items-center gap-2">
              {r.state !== "declined" && (
                <Link href={`/documents/new?type=PROPOSAL&rfq=${encodeURIComponent(r.id)}`}>
                  <Button type="button" size="sm">
                    {r.quotes.length ? "Create another quote" : "Create quote"}
                  </Button>
                </Link>
              )}
              {r.quotes.map((q) => (
                <Link key={q.id} href={`/documents/${q.id}`} className="text-xs font-medium text-text underline">
                  {q.docNumber}
                </Link>
              ))}
              {r.state !== "declined" && (
                <Select
                  aria-label={`Who quotes ${r.reference}`}
                  className="h-8 w-44 text-xs"
                  value={r.assignedTo?.id ?? ""}
                  disabled={pending}
                  onChange={(e) => run(() => assignQuoteRequest(r.id, e.target.value))}
                >
                  <option value="">Not assigned</option>
                  {r.assignedTo && !people.some((p) => p.id === r.assignedTo!.id) && <option value={r.assignedTo.id}>{r.assignedTo.name}</option>}
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
              {r.state === "new" && declining?.id !== r.id && (
                <Button type="button" variant="secondary" size="sm" onClick={() => setDeclining({ id: r.id, reason: "" })}>
                  Decline
                </Button>
              )}
              {r.file && (
                <a href={`/api/quote-requests/${r.id}/file`} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-muted underline">
                  <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />
                  {r.file.name}
                </a>
              )}
            </div>
            {declining?.id === r.id && (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Why it's declined"
                  className="h-8 flex-1 text-xs"
                  placeholder="Why — e.g. not a product we sell"
                  value={declining.reason}
                  maxLength={300}
                  onChange={(e) => setDeclining({ id: r.id, reason: e.target.value })}
                />
                <Button type="button" size="sm" disabled={pending} onClick={() => run(() => declineQuoteRequest(r.id, declining.reason), () => setDeclining(null))}>
                  Decline it
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => setDeclining(null)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
