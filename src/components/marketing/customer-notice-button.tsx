"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Mail } from "lucide-react";
import type { noticeRecipients } from "@/actions/order-notice";
import { noticeRecipients as loadRecipients, previewNotice, sendCustomerNotice } from "@/actions/order-notice";
import type { NoticePreview } from "@/lib/marketing/order-notice";
import type { NoticeKind } from "@/lib/marketing/customer-notices";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";

type Loaded = NonNullable<Awaited<ReturnType<typeof noticeRecipients>>>;

/** Used only for the split second before the dialog's own copy arrives. */
const label = (kind: NoticeKind) =>
  kind === "FULFILMENT" ? "Tell them the order is done" : kind === "RENEWED" ? "Confirm the renewal" : kind === "PAYMENT" ? "Send a payment reminder" : "Send a renewal reminder";

/**
 * Writing to a customer about one order, by hand — a renewal coming up, a renewal confirmed, or an
 * order just fulfilled.
 *
 * Everybody at the company is listed with whether they can actually be written to, worked out
 * *before* anything is sent — so a bounced address or a spam complaint is visible at the moment of
 * choosing rather than reported afterwards. Nobody is pre-ticked except the primary contact:
 * "send to all" should be a decision, not a default.
 */
export function CustomerNoticeButton({
  companyProductId,
  companyName,
  kind = "RENEWAL",
}: {
  companyProductId: string;
  companyName: string;
  kind?: NoticeKind;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [loaded, setLoaded] = useState<{ id: string; data: Loaded } | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [templateId, setTemplateId] = useState("");
  const [note, setNote] = useState("");
  // Copies (owner, 3 Nov 2026): the account manager by default, so the reply-all reaches them too.
  const [ccManager, setCcManager] = useState(true);
  const [ccMe, setCcMe] = useState(false);
  const [ccOthers, setCcOthers] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The email as it would go (owner, 3 Nov 2026 — "mail preview option here"); cleared by any change to what it says.
  const [shown, setShown] = useState<{ key: string; data: NoticePreview } | null>(null);
  const previewKey = JSON.stringify([templateId, note, [...chosen].sort(), ccManager, ccMe, ccOthers]);
  const preview = shown && shown.key === previewKey ? shown.data : null;
  const setPreview = (data: NoticePreview | null) => setShown(data ? { key: previewKey, data } : null);
  const [result, setResult] = useState<{ sent: number; failed: number; skipped: { name: string; reason: string }[]; copied?: string[] } | null>(
    null,
  );

  const data = loaded?.id === companyProductId ? loaded.data : null;

  useEffect(() => {
    if (!open || data) return;
    let cancelled = false;
    loadRecipients(companyProductId, kind).then((rows) => {
      if (cancelled || !rows) return;
      setLoaded({ id: companyProductId, data: rows });
      // The primary contact, if they can actually receive it. Everyone else is a deliberate tick.
      // Never somebody unconfirmed from the website (R2-14): ticking them is a deliberate choice.
      const primary = rows.contacts.find((c) => c.isPrimary && c.canReceive && !c.unconfirmed) ?? rows.contacts.find((c) => c.canReceive && !c.unconfirmed);
      setChosen(new Set(primary ? [primary.id] : []));
    });
    return () => {
      cancelled = true;
    };
  }, [open, companyProductId, kind, data]);

  const sendable = data?.contacts.filter((c) => c.canReceive) ?? [];
  const blocked = data?.contacts.filter((c) => !c.canReceive) ?? [];
  const allChosen = sendable.length > 0 && sendable.every((c) => chosen.has(c.id));

  const close = () => {
    setOpen(false);
    setResult(null);
    setError(null);
    setNote("");
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`${data?.title ?? label(kind)} — ${companyName}`}
        aria-label={`${data?.title ?? label(kind)} — ${companyName}`}
        className="rounded p-1 text-subtle hover:bg-surface-sunken hover:text-brand"
      >
        <Mail className="h-4 w-4" />
      </button>

      <Dialog open={open} onClose={close} title={data?.title ?? label(kind)}>
        {result ? (
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-sm text-success">
              <Check className="h-4 w-4" />
              Sent to {result.sent} {result.sent === 1 ? "person" : "people"}.
            </p>
            {result.copied && result.copied.length > 0 && <p className="text-xs text-muted">Copied to {result.copied.join(", ")}.</p>}
            {result.failed > 0 && (
              <p className="text-sm text-danger">
                {result.failed} couldn&apos;t be delivered — check the provider is set up in Settings.
              </p>
            )}
            {result.skipped.length > 0 && (
              <Card className="border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
                {result.skipped.map((s) => (
                  <p key={s.name}>
                    <span className="font-medium">{s.name}</span> — {s.reason}
                  </p>
                ))}
              </Card>
            )}
            <Button onClick={close}>Done</Button>
          </div>
        ) : !data ? (
          <p className="py-6 text-sm text-subtle">Looking up who we can write to…</p>
        ) : (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <Card className="bg-surface-sunken px-3 py-2.5">
              <p className="text-sm font-medium text-text">{data.subscription.itemName}</p>
              <p className="mt-0.5 text-xs text-muted">
                {data.subscription.quantity} × · expires{" "}
                {data.subscription.endDate ? formatCalendarDay(data.subscription.endDate) : "—"}
                {data.subscription.renewalValue > 0 && ` · ${formatCurrency(data.subscription.renewalValue)} to renew`}
                {data.subscription.addonCount > 0 && ` · includes ${data.subscription.addonCount} added batch(es)`}
              </p>
            </Card>

            {/* The distinction that matters on a reseller's order. */}
            {data.viaReseller && (
              <Card className="border-info/40 bg-info-bg px-3 py-2.5 text-xs text-info">
                The seats belong to <span className="font-medium">{data.endCustomer?.name}</span>, but this goes to{" "}
                <span className="font-medium">{data.recipientCompany.name}</span> — they own the relationship and the
                renewal. We don&apos;t write to their customer directly.
              </Card>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Who at {data.recipientCompany.name}</Label>
                {sendable.length > 1 && (
                  <button
                    type="button"
                    className="text-xs text-brand hover:underline"
                    onClick={() => setChosen(allChosen ? new Set() : new Set(sendable.map((c) => c.id)))}
                  >
                    {allChosen ? "None" : `All ${sendable.length}`}
                  </button>
                )}
              </div>

              {data.contacts.length === 0 && (
                <p className="text-sm text-warning">
                  Nobody is on file at {data.recipientCompany.name}. Add a contact first.
                </p>
              )}

              {sendable.map((contact) => (
                <label
                  key={contact.id}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3 py-2 hover:bg-surface-sunken"
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(contact.id)}
                    onChange={() =>
                      setChosen((current) => {
                        const next = new Set(current);
                        if (next.has(contact.id)) next.delete(contact.id);
                        else next.add(contact.id);
                        return next;
                      })
                    }
                    className="mt-0.5 h-4 w-4 accent-brand"
                  />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm text-text">{contact.name}</span>
                      {contact.isPrimary && <Badge tone="blue">Primary</Badge>}
                      {/* Security audit round two, 13 Nov 2026 (R2-14): added by a website visitor, nobody has confirmed them. */}
                      {contact.unconfirmed &&<Badge tone="amber">Unconfirmed — came from the website</Badge>}
                      <span className="text-[11px] text-subtle">
                        {contact.designation.toLowerCase().replaceAll("_", " ")}
                      </span>
                    </span>
                    <span className="block text-xs text-muted">{contact.email}</span>
                  </span>
                </label>
              ))}

              {blocked.length > 0 && (
                <div className="space-y-1 rounded-lg bg-surface-sunken px-3 py-2">
                  <p className="text-xs font-medium text-text">Can&apos;t be written to</p>
                  {blocked.map((contact) => (
                    <p key={contact.id} className="flex items-start gap-1.5 text-[11px] text-subtle">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                      <span>
                        <span className="text-muted">{contact.name}</span> — {contact.blockedBecause}
                      </span>
                    </p>
                  ))}
                </div>
              )}
            </div>

            {/* Always there (owner, 3 Nov 2026): with no template of this topic yet, it says where one is designed. */}
            <div className="space-y-1.5">
                <Label htmlFor="rtpl">Wording</Label>
                <Select id="rtpl" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  <option value="">The standard wording</option>
                  {data.templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.format === "HTML" ? " — designed" : ""}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-subtle">
                  Design one in{" "}
                  <a href="/marketing/templates" className="text-brand hover:underline">
                    Marketing › Templates
                  </a>{" "}
                  with the builder, under the topic &ldquo;{kind === "RENEWAL" ? "Renewal reminders" : "Service notices"}&rdquo;, and it&rsquo;s offered here.
                </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rnote">Add a line of your own</Label>
              <Textarea
                id="rnote"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional — goes above the standard wording."
              />
            </div>

            <div className="space-y-1.5">
              <Label>Copy to</Label>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <label className="inline-flex items-center gap-1.5">
                  <input type="checkbox" className="h-4 w-4" checked={ccManager} onChange={(e) => setCcManager(e.target.checked)} />
                  The account manager
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input type="checkbox" className="h-4 w-4" checked={ccMe} onChange={(e) => setCcMe(e.target.checked)} />
                  Me
                </label>
              </div>
              <Input value={ccOthers} onChange={(e) => setCcOthers(e.target.value)} placeholder="Other addresses, commas between — optional" aria-label="Other addresses to copy" />
              <p className="text-[11px] text-subtle">In CC on the email — once, however many people it goes to.</p>
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}
            {data.heldBack && <p className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">{data.heldBack}</p>}

            <p className="text-xs text-subtle">{data.footnote}</p>

            {preview && (
              <div className="space-y-2 rounded-lg border border-line bg-surface-sunken p-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 space-y-0.5 text-xs text-muted">
                    <div>
                      To: <span className="text-text">{preview.to.name}</span> &lt;{preview.to.email}&gt;
                      {preview.others > 0 && ` and ${preview.others} more, each their own`}
                    </div>
                    {preview.cc.length > 0 && <div>Copy: {preview.cc.join(", ")}</div>}
                  </div>
                  <button type="button" className="shrink-0 text-xs text-brand hover:underline" onClick={() => setPreview(null)}>
                    Close preview
                  </button>
                </div>
                <div className="font-medium text-text">{preview.subject}</div>
                {preview.html ? (
                  // The designed email as it will arrive, boxed off from the app's own styles and scripts.
                  <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-96 w-full rounded-md border border-line bg-white" />
                ) : (
                  <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-surface p-3 text-text">{preview.text}</div>
                )}
                {preview.skipped.length > 0 && (
                  <p className="text-xs text-warning">Won&apos;t go to {preview.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}.</p>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                disabled={pending || chosen.size === 0 || !data.canAnnounce}
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    const outcome = await sendCustomerNotice({
                      companyProductId,
                      kind,
                      contactIds: [...chosen],
                      templateId: templateId || undefined,
                      note,
                      cc: { accountManager: ccManager, me: ccMe, emails: ccOthers.split(/[,;\s]+/).filter(Boolean) },
                    });
                    if (!outcome.ok) {
                      setError(outcome.error);
                      return;
                    }
                    setResult(outcome.data);
                    router.refresh();
                  });
                }}
              >
                {pending
                  ? "Sending…"
                  : `Send to ${chosen.size} ${chosen.size === 1 ? "person" : "people"}`}
              </Button>
              <Button
                variant="secondary"
                disabled={pending || chosen.size === 0 || !data.canAnnounce}
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    const shown = await previewNotice({
                      companyProductId,
                      kind,
                      contactIds: [...chosen],
                      templateId: templateId || undefined,
                      note,
                      cc: { accountManager: ccManager, me: ccMe, emails: ccOthers.split(/[,;\s]+/).filter(Boolean) },
                    });
                    if (!shown.ok) {
                      setPreview(null);
                      setError(shown.error);
                      return;
                    }
                    setPreview(shown.data);
                  });
                }}
              >
                Preview
              </Button>
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
