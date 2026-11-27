"use client";

import { workspacePack } from "@/lib/country-pack";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  connectGateway,
  disconnectGateway,
  saveCreditHold,
  saveMsmeDetails,
  saveReminderSettings,
  type GatewayView,
  type PaymentCollectionView,
} from "@/actions/payment-collection";
import type { ReminderStep, ReminderTone } from "@/lib/collect/settings";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { useClock } from "@/components/time/clock-provider";
import { confirmAction } from "@/components/ui/confirm";

/**
 * Settings › Payment collection (owner, 23 Oct 2026 — src/lib/collect): the business's gateways, the reminder
 * schedule, credit hold and the MSME details, each saved on its own.
 */
export function PaymentCollectionSettings({ view }: { view: PaymentCollectionView }) {
  if (!view.config.migrated) {
    return <p className="text-sm text-muted">This workspace is still being updated for payment collection. Come back in a few minutes.</p>;
  }
  return (
    <div className="space-y-6">
      <GatewaysCard view={view} />
      <RemindersCard view={view} />
      <CreditHoldCard view={view} />
      {/* The MSMED Act is India's (owner, 14 Nov 2026). */}
      {workspacePack().india && <MsmeCard view={view} />}
      <RecentCard view={view} />
    </div>
  );
}

function useSave() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) return setError(result.error);
      setNotice(done);
      router.refresh();
    });
  };
  const messages = (
    <>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="text-sm text-success">{notice}</p>}
    </>
  );
  return { pending, run, messages };
}

// ─── Gateways ──────────────────────────────────────────────────────────────────────────────────

function GatewaysCard({ view }: { view: PaymentCollectionView }) {
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Online payments</CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted">
          Connect your own Razorpay or Cashfree account and every invoice can carry a pay-now link — on the invoice, in each reminder and in the customer portal. The money goes straight
          to your account; when a customer pays, the payment is recorded against the invoice by itself.
        </p>
        {(["RAZORPAY", "CASHFREE"] as const).map((provider) => (
          <GatewayForm key={provider} provider={provider} view={view} current={view.gateways.find((g) => g.provider === provider && g.active) ?? null} />
        ))}
      </CardContent>
    </Card>
  );
}

function GatewayForm({ provider, view, current }: { provider: "RAZORPAY" | "CASHFREE"; view: PaymentCollectionView; current: GatewayView | null }) {
  const clock = useClock();
  const { pending, run, messages } = useSave();
  const name = provider === "RAZORPAY" ? "Razorpay" : "Cashfree";
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(current?.mode ?? "TEST");
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [bankAccountId, setBankAccountId] = useState(current?.bankAccountId ?? "");
  const [isDefault, setIsDefault] = useState(current?.isDefault ?? false);
  const [internationalOn, setInternationalOn] = useState(current?.internationalOn ?? false);
  const id = (k: string) => `gw-${provider}-${k}`;

  const save = () =>
    run(
      () => connectGateway({ provider, mode, keyId: keyId.trim(), secret, webhookSecret, bankAccountId, isDefault, internationalOn }).then((r) => (r.ok ? { ok: true as const } : r)),
      current ? `${name} saved.` : `${name} connected. New pay-now links are made in it.`,
    );

  return (
    <div className="rounded-base border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text">{name}</span>
          {current ? (
            <>
              <Badge tone="green">Connected</Badge>
              <Badge tone={current.mode === "LIVE" ? "blue" : "amber"}>{current.mode === "LIVE" ? "Live keys" : "Test keys"}</Badge>
              {current.isDefault && <Badge>New links</Badge>}
              {current.internationalOn && <Badge tone="blue">International</Badge>}
            </>
          ) : (
            <Badge>Not connected</Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {current ? "Change" : "Connect"}
          </Button>
          {current && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={async () => {
                if (!(await confirmAction(`Disconnect ${name}? Its open pay-now links are closed first, and its keys are wiped from Deskzo.`))) return;
                run(() => disconnectGateway(provider).then((r) => (r.ok ? { ok: true as const } : r)), `${name} disconnected.`);
              }}
            >
              Disconnect
            </Button>
          )}
        </div>
      </div>
      {current && (
        <p className="mt-2 text-xs text-muted">
          Key {current.keyHint} · connected {clock.date(current.connectedAt)}
          {current.checkedAt ? ` · last spoke to ${name} ${clock.dateTime(current.checkedAt)}` : ""}
          {current.lastError ? <span className="text-danger"> · {current.lastError}</span> : null}
        </p>
      )}
      {open && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={id("mode")}>Keys</Label>
            <Select id={id("mode")} value={mode} onChange={(e) => setMode(e.target.value as "TEST" | "LIVE")}>
              <option value="TEST">Test keys — no real money</option>
              <option value="LIVE">Live keys</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id("key")}>{provider === "RAZORPAY" ? "Key id" : "Client id (App id)"}</Label>
            <Input id={id("key")} value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder={current ? `Unchanged (${current.keyHint})` : provider === "RAZORPAY" ? "rzp_test_…" : ""} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id("secret")}>{provider === "RAZORPAY" ? "Key secret" : "Client secret"}</Label>
            <Input id={id("secret")} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={current ? "Unchanged" : ""} autoComplete="new-password" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id("bank")}>Record payments in</Label>
            <Select id={id("bank")} value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
              <option value="">The default bank account</option>
              {view.bankAccounts.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>
          {provider === "RAZORPAY" && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={id("webhook")}>Webhook secret (optional)</Label>
              <Input id={id("webhook")} type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder={current?.hasWebhookSecret ? "Unchanged" : ""} autoComplete="new-password" />
              <p className="text-xs text-muted">
                To see payments within a minute, add a webhook in Razorpay&apos;s dashboard (Accounts &amp; Settings › Webhooks) to{" "}
                <span className="break-all font-mono text-text">{view.notices.razorpay}</span> with the <span className="font-mono">payment_link.paid</span> event and a secret of your
                choosing. Without it, payments still show within about ten minutes.
              </p>
            </div>
          )}
          {provider === "CASHFREE" && (
            <p className="text-xs text-muted sm:col-span-2">
              Cashfree is told where to say a link was paid with each link it makes — nothing to set up on its dashboard. Cashfree asks for the customer&apos;s phone, so their contact
              needs one.
            </p>
          )}
          <label className="flex items-center gap-2 text-sm text-text sm:col-span-2">
            <input type="checkbox" className="h-4 w-4" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Make new pay-now links in {name}
          </label>
          {/* Foreign-currency links (owner, 30 Oct 2026): off until the business says the gateway has enabled them. */}
          <div className="space-y-1 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" className="h-4 w-4" checked={internationalOn} onChange={(e) => setInternationalOn(e.target.checked)} />
              International payments are switched on at {name}
            </label>
            <p className="pl-6 text-xs text-muted">
              Lets an invoice in another currency — dollars, euros, yen — get a pay-now link in that currency. {name} must first enable international payments on your
              account; check with {name} which currencies your account accepts. {name} settles to you in rupees, so these payments are recorded in a rupee bank account, at
              the day&apos;s exchange rate.
            </p>
          </div>
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button type="button" size="sm" onClick={save} disabled={pending}>
              {pending ? "Checking the keys…" : current ? "Save" : "Connect"}
            </Button>
            <span className="text-xs text-muted">The keys are tried with {name} before they&apos;re kept, and stored encrypted.</span>
          </div>
        </div>
      )}
      <div className="mt-2">{messages}</div>
    </div>
  );
}

// ─── Reminders ─────────────────────────────────────────────────────────────────────────────────

const TONES: { value: ReminderTone; label: string }[] = [
  { value: "friendly", label: "Friendly" },
  { value: "firm", label: "Firm" },
  { value: "final", label: "Final notice" },
];

/** A step's subject as a customer would read it: each field as its example. */
function sampled(text: string, fields: { key: string; example: string }[]) {
  return text.replace(/\{\{\s*([a-zA-Z.]+)\s*(?:\|([^}]*))?\}\}/g, (whole, key: string, fallback?: string) => fields.find((f) => f.key === key)?.example ?? fallback ?? whole);
}

const whenLabel = (days: number) => (days < 0 ? `${-days} day${days === -1 ? "" : "s"} before it's due` : days === 0 ? "On the due day" : `${days} day${days === 1 ? "" : "s"} overdue`);

function RemindersCard({ view }: { view: PaymentCollectionView }) {
  const { pending, run, messages } = useSave();
  const [on, setOn] = useState(view.config.remindersOn);
  const [sender, setSender] = useState(view.config.senderUserId ?? "");
  const [steps, setSteps] = useState<ReminderStep[]>(view.config.steps);
  const [standard, setStandard] = useState(view.config.standardSteps);
  const [statementOn, setStatementOn] = useState(view.config.statementOn);
  const [threaded, setThreaded] = useState(view.config.reminderThread);
  // Who they come from (owner, 3 Nov 2026 — src/lib/collect/sender.ts).
  const [senderMode, setSenderMode] = useState(view.config.senderMode);
  const [sharedName, setSharedName] = useState(view.config.collectionsFromName ?? "");
  const [sharedEmail, setSharedEmail] = useState(view.config.collectionsEmail ?? "");
  const [whatsapp, setWhatsapp] = useState(view.config.whatsappTemplate ?? "");
  const [editing, setEditing] = useState<string | null>(null);

  const change = (key: string, patch: Partial<ReminderStep>) => {
    setStandard(false);
    setSteps((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  };
  const add = () => {
    setStandard(false);
    const used = new Set(steps.map((s) => s.days));
    let days = 60;
    while (used.has(days)) days += 1;
    const key = `step-${days}`;
    setSteps((all) => [...all, { key, days, tone: "firm" as ReminderTone, on: true, subject: "Invoice {{document.number}} is still unpaid", body: view.defaultSteps[3]!.body }].sort((a, b) => a.days - b.days));
    setEditing(key);
  };
  const save = () =>
    run(
      () => saveReminderSettings({ on, senderUserId: sender, steps: standard ? null : steps, statementOn, whatsappTemplate: whatsapp, reminderThread: threaded, senderMode, collectionsFromName: sharedName, collectionsEmail: sharedEmail }).then((r) => (r.ok ? { ok: true as const } : r)),
      on ? (view.config.remindersOn ? "Saved." : "Reminders are on. Each invoice gets the next step whose day comes from now on — nothing already past is sent.") : "Saved. No reminders go out.",
    );

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Payment reminders</CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted">
          Customers are reminded of open invoices by email, from 9 in the morning, with the invoice attached and the pay-now link in the words. A reminder stops once the invoice is
          paid, while a promise to pay it is open, and for a customer whose reminders are paused (on their Statement tab). Each step goes once per invoice; switching on sends nothing
          for days already past.
        </p>
        <label className="flex items-center gap-2 text-sm font-medium text-text">
          <input type="checkbox" className="h-4 w-4" checked={on} onChange={(e) => setOn(e.target.checked)} />
          Send payment reminders
        </label>
        <div className="space-y-1.5">
          <Label htmlFor="rem-from">Send from</Label>
          <Select id="rem-from" value={senderMode} onChange={(e) => setSenderMode(e.target.value as typeof senderMode)} className="max-w-sm">
            <option value="PERSON">One person</option>
            <option value="ACCOUNT_MANAGER">Each customer&apos;s account manager</option>
            <option value="COLLECTIONS">A shared collections address</option>
          </Select>
          <p className="text-xs text-muted">
            {senderMode === "ACCOUNT_MANAGER"
              ? "From the person who manages each customer — their mailbox or the company's mail, as Settings › Document emails says — so replies land with them. A customer with nobody managing it, or whose manager can't send it, gets it from the person below."
              : senderMode === "COLLECTIONS"
                ? "Through the company's mail server (Settings › Messaging) as a shared address — replies and a copy go to it. Its own From address where the server can send as it (Microsoft 365 or Google signed in as it, or SMTP that allows it)."
                : "From one person, as below."}
          </p>
        </div>
        {senderMode === "COLLECTIONS" && (
          <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="rem-shared-email">Shared address</Label>
              <Input id="rem-shared-email" type="email" value={sharedEmail} onChange={(e) => setSharedEmail(e.target.value)} placeholder="accounts@yourcompany.com" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rem-shared-name">Shown as</Label>
              <Input id="rem-shared-name" value={sharedName} onChange={(e) => setSharedName(e.target.value)} placeholder="Accounts — your company" />
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="rem-sender">{senderMode === "PERSON" ? "Sent as" : senderMode === "ACCOUNT_MANAGER" ? "When there's no account manager" : "Signed and sent by"}</Label>
          <SearchSelect id="rem-sender" searchPlaceholder="Search people…" value={sender} onChange={(e) => setSender(e.target.value)} className="max-w-sm">
            <option value="">Me, when I switch them on</option>
            {view.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SearchSelect>
          <p className="text-xs text-muted">
            Their mailbox, or the company&apos;s mail, as Settings › Document emails says, and their signature. Pick someone who can open every invoice.
            {view.senderSeesAll === false && sender === view.config.senderUserId && (
              <span className="text-danger"> They can&apos;t open every invoice — reminders for the ones they can&apos;t open won&apos;t go.</span>
            )}
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-text">Schedule{standard ? " — the standard one" : ""}</span>
            <div className="flex gap-2">
              {!standard && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSteps(view.defaultSteps);
                    setStandard(true);
                  }}
                >
                  Back to the standard schedule
                </Button>
              )}
              <Button type="button" variant="secondary" size="sm" onClick={add} disabled={steps.length >= 10}>
                Add a step
              </Button>
            </div>
          </div>
          <ul className="divide-y divide-line rounded-base border border-line">
            {steps.map((s) => (
              <li key={s.key} className="px-3 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <input type="checkbox" className="h-4 w-4" checked={s.on} onChange={(e) => change(s.key, { on: e.target.checked })} aria-label={`Send the reminder ${whenLabel(s.days)}`} />
                  <span className="w-44 text-text">{whenLabel(s.days)}</span>
                  <Badge tone={s.tone === "final" ? "red" : s.tone === "firm" ? "amber" : "default"}>{TONES.find((t) => t.value === s.tone)?.label}</Badge>
                  {/* Review first: waits in Receivables › Reminders to send (owner, 3 Nov 2026). */}
                  <label className="inline-flex items-center gap-1 text-xs text-muted" title="Waits in Receivables › Reminders to send for someone to send, edit, skip or snooze">
                    <input type="checkbox" className="h-3.5 w-3.5" checked={!!s.review} onChange={(e) => change(s.key, { review: e.target.checked })} />
                    Review first
                  </label>
                  <span className="min-w-0 flex-1 truncate text-muted" title={s.subject}>
                    {sampled(s.subject, view.fields)}
                  </span>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(editing === s.key ? null : s.key)} aria-expanded={editing === s.key}>
                    {editing === s.key ? "Done" : "Edit"}
                  </Button>
                </div>
                {editing === s.key && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-[10rem_10rem_1fr]">
                    <div className="space-y-1">
                      <Label htmlFor={`days-${s.key}`}>Days from due</Label>
                      <Input id={`days-${s.key}`} type="number" min={-30} max={365} value={s.days} onChange={(e) => change(s.key, { days: Number(e.target.value) })} />
                      <p className="text-xs text-muted">−3 is three days before.</p>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`tone-${s.key}`}>Tone</Label>
                      <Select id={`tone-${s.key}`} value={s.tone} onChange={(e) => change(s.key, { tone: e.target.value as ReminderTone })}>
                        {TONES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`subject-${s.key}`}>Subject</Label>
                      <Input id={`subject-${s.key}`} value={s.subject} onChange={(e) => change(s.key, { subject: e.target.value })} />
                    </div>
                    <div className="space-y-1 sm:col-span-3">
                      <Label htmlFor={`body-${s.key}`}>Message</Label>
                      <Textarea id={`body-${s.key}`} rows={10} value={s.body} onChange={(e) => change(s.key, { body: e.target.value })} className="font-mono text-xs" />
                    </div>
                    <div className="sm:col-span-3">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setStandard(false);
                          setSteps((all) => all.filter((x) => x.key !== s.key));
                          setEditing(null);
                        }}
                      >
                        Remove this step
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Fields you can use</summary>
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {view.fields.map((f) => (
                <li key={f.key}>
                  <span className="font-mono text-text">{`{{${f.key}}}`}</span> — {f.label}
                </li>
              ))}
            </ul>
            <p className="mt-2">Add a fallback after a bar, like {"{{payment.line|}}"} — used when there&apos;s nothing to fill in.</p>
          </details>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="rem-thread">How each reminder arrives</Label>
          <Select id="rem-thread" value={threaded ? "thread" : "separate"} onChange={(e) => setThreaded(e.target.value === "thread")} className="max-w-md">
            <option value="separate">As its own email, with the step&apos;s subject</option>
            <option value="thread">As a reply in the invoice&apos;s email thread</option>
          </Select>
          <p className="text-xs text-muted">
            In the thread, every reminder answers the email the invoice went with — &ldquo;Re: &lt;its subject&gt;&rdquo; — so the customer
            sees one conversation with the invoice at the top. The step&apos;s own subject is used for an invoice never emailed.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" className="h-4 w-4" checked={statementOn} onChange={(e) => setStatementOn(e.target.checked)} />
          On the 1st of each month, email each customer who owes something their statement of account
        </label>

        <div className="space-y-1.5">
          <Label htmlFor="rem-whatsapp">WhatsApp template (optional)</Label>
          <Input id="rem-whatsapp" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="payment_reminder" className="max-w-sm font-mono" />
          <p className="text-xs text-muted">
            Where the workspace has WhatsApp, each reminder also goes as this approved template, with these values in order: {view.whatsappValues.join(", ")}.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button type="button" size="sm" onClick={save} disabled={pending}>
            Save
          </Button>
        </div>
        {messages}
      </CardContent>
    </Card>
  );
}

// ─── Credit hold ───────────────────────────────────────────────────────────────────────────────

function CreditHoldCard({ view }: { view: PaymentCollectionView }) {
  const { pending, run, messages } = useSave();
  const [on, setOn] = useState(view.config.creditHoldOn);
  const [days, setDays] = useState(String(view.config.creditHoldDays));
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Credit hold</CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted">
          A customer with an invoice this many days overdue is on credit hold: their new orders need someone who can override credit to approve them, with a reason. Orders paid in
          advance and quotes aren&apos;t held.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" className="h-4 w-4" checked={on} onChange={(e) => setOn(e.target.checked)} />
            Hold customers who pay late
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="hold-days">Days overdue</Label>
            <Input id="hold-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} className="w-28" disabled={!on} />
          </div>
          <Button type="button" size="sm" disabled={pending} onClick={() => run(() => saveCreditHold({ on, days: Number(days) }).then((r) => (r.ok ? { ok: true as const } : r)), "Saved.")}>
            Save
          </Button>
        </div>
        {messages}
      </CardContent>
    </Card>
  );
}

// ─── MSME ──────────────────────────────────────────────────────────────────────────────────────

function MsmeCard({ view }: { view: PaymentCollectionView }) {
  const { pending, run, messages } = useSave();
  const [udyam, setUdyam] = useState(view.config.udyamNumber ?? "");
  const [category, setCategory] = useState(view.config.msmeCategory ?? "");
  const [rate, setRate] = useState(view.config.bankRate === null ? "" : String(view.config.bankRate));
  const claims = !!udyam && (category === "MICRO" || category === "SMALL") && Number(rate) > 0;
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">MSME late-payment interest</CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted">
          A micro or small enterprise registered under the MSMED Act is owed compound interest, with monthly rests, at three times the RBI&apos;s bank rate on payments made after the
          agreed day (at most 45 days after the invoice). With these filled in, Deskzo works it out for each late invoice — on the customer&apos;s statement, in the final notice and in a
          summary for an MSME Samadhaan complaint. It&apos;s never billed on its own: you charge it with a debit note when you decide to.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="msme-udyam">Udyam registration number</Label>
            <Input id="msme-udyam" value={udyam} onChange={(e) => setUdyam(e.target.value.toUpperCase())} placeholder="UDYAM-MH-26-0123456" className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="msme-category">Category</Label>
            <Select id="msme-category" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Not registered</option>
              <option value="MICRO">Micro</option>
              <option value="SMALL">Small</option>
              <option value="MEDIUM">Medium — the Act&apos;s interest isn&apos;t for medium</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="msme-rate">RBI bank rate, %</Label>
            <Input id="msme-rate" type="number" step="0.01" min={0.01} max={25} value={rate} onChange={(e) => setRate(e.target.value)} placeholder="5.75" className="w-32" />
            <p className="text-xs text-muted">5.75% from 7 Oct 2026. Change it here when the RBI does.</p>
          </div>
        </div>
        <p className="text-sm text-muted">{claims ? `Interest is worked out at ${(Number(rate) * 3).toFixed(2)}% a year.` : "Interest isn't worked out until all three are filled in for a micro or small enterprise."}</p>
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() =>
            run(
              () => saveMsmeDetails({ udyamNumber: udyam, category: (category || null) as "MICRO" | "SMALL" | "MEDIUM" | null, bankRate: rate ? Number(rate) : null }).then((r) => (r.ok ? { ok: true as const } : r)),
              "Saved.",
            )
          }
        >
          Save
        </Button>
        {messages}
      </CardContent>
    </Card>
  );
}

// ─── What went ─────────────────────────────────────────────────────────────────────────────────

const STATUS: Record<string, { tone: "green" | "amber" | "red" | "default"; label: string }> = {
  SENT: { tone: "green", label: "Sent" },
  PENDING: { tone: "amber", label: "Sending" },
  FAILED: { tone: "red", label: "Didn't go" },
  SKIPPED: { tone: "default", label: "Nobody to send to" },
};

function RecentCard({ view }: { view: PaymentCollectionView }) {
  const clock = useClock();
  // The step as its day reads — "7 days overdue", "Final notice" — from the schedule, or the standard one.
  const stepName = (key: string) => {
    const step = view.config.steps.find((s) => s.key === key) ?? view.defaultSteps.find((s) => s.key === key);
    return step ? (step.tone === "final" ? "Final notice" : whenLabel(step.days)) : key;
  };
  if (view.recent.length === 0) return null;
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Latest reminders</CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">What</th>
                <th className="px-4 py-2 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {view.recent.map((r, n) => (
                <tr key={n} className="border-b border-line last:border-0 align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-muted">{clock.dateTimeShort(r.at)}</td>
                  <td className="px-4 py-2 text-text">{r.customer}</td>
                  <td className="px-4 py-2 text-muted">{r.invoice ? `${r.invoice} · ${stepName(r.step)}` : "Monthly statement"}</td>
                  <td className="px-4 py-2">
                    <Badge tone={STATUS[r.status]?.tone ?? "default"}>{STATUS[r.status]?.label ?? r.status}</Badge>
                    {r.sentTo && <div className="mt-0.5 text-xs text-muted">{r.sentTo}</div>}
                    {r.error && <div className="mt-0.5 text-xs text-danger">{r.error}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
