"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  connectCallerdesk,
  disconnectTelephony,
  newWebhookAddress,
  saveMissedCallsPerson,
  saveTelephonyAgent,
  syncTelephonyNow,
  telephonyMembers,
  type TelephonyView,
} from "@/actions/telephony";
import type { TelephonyMember } from "@/lib/telephony/types";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { useClock } from "@/components/time/clock-provider";
import { confirmAction } from "@/components/ui/confirm";

/**
 * Settings › Cloud calling (owner, 26 Oct 2026 — src/lib/telephony): the CallerDesk account, its webhook's
 * address, which CallerDesk member each person is, and who a missed call nobody owns goes to — each saved on its own.
 */
export function TelephonySettings({ view }: { view: TelephonyView }) {
  if (!view.migrated) {
    return <p className="text-sm text-muted">This workspace is still being updated for cloud calling. Come back in a few minutes.</p>;
  }
  return (
    <div className="space-y-6">
      <AccountCard view={view} />
      {view.connection && (
        <>
          <WebhookCard url={view.connection.webhookUrl} />
          <MembersCard view={view} />
          <MissedCallsCard view={view} />
        </>
      )}
    </div>
  );
}

function useSave() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = (work: () => Promise<{ ok: true; done?: string } | { ok: false; error: string }>, done: string) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) return setError(result.error);
      setNotice(result.done ?? done);
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

const keyOf = (n: string | null | undefined) => {
  const d = (n ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

// ─── The account ─────────────────────────────────────────────────────────────────────────────

function AccountCard({ view }: { view: TelephonyView }) {
  const clock = useClock();
  const { pending, run, messages } = useSave();
  const current = view.connection;
  const [open, setOpen] = useState(!current);
  const [authCode, setAuthCode] = useState("");
  const [deskphone, setDeskphone] = useState(current?.deskphone ?? "");
  // What it does here (owner, 30 Oct 2026): calls and recordings always; outgoing and incoming as chosen.
  const [outgoing, setOutgoing] = useState(!current || !!current.deskphone);
  const [incoming, setIncoming] = useState(current?.incomingCallbacks ?? true);

  const save = () =>
    run(
      () =>
        connectCallerdesk({ authCode: authCode.trim(), deskphone: outgoing ? deskphone.trim() : "", outgoing, incomingCallbacks: incoming }).then((r) => {
          if (!r.ok) return r;
          setAuthCode("");
          setOpen(false);
          return { ok: true as const };
        }),
      current ? "CallerDesk saved." : "CallerDesk connected. Its last 30 days of calls are read in over the next few minutes.",
    );

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">CallerDesk</CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted">
          Connect your CallerDesk account and a Call button can ring through your business number: CallerDesk rings your phone first, then the customer, who sees the business number. Every
          call on your CallerDesk numbers — made here, made in CallerDesk, or a customer ringing in — comes back: calls to people on file are logged on Calls as whoever took them, and a
          missed one becomes a callback.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-base border border-line p-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text">{current?.accountName ?? "CallerDesk"}</span>
              {current ? <Badge tone="green">Connected</Badge> : <Badge>Not connected</Badge>}
            </div>
            {current && (
              <p className="text-xs text-muted">
                {current.deskphone ? (
                  <>
                    Outgoing from <span className="font-mono">{current.deskphone}</span>
                  </>
                ) : (
                  "No outgoing"
                )}
                {current.incomingCallbacks ? " · missed calls become callbacks" : " · no callbacks"} · calls and recordings · connected {clock.date(current.connectedAt)} · {current.callsKept} calls kept
                {current.lastSyncAt ? ` · calls last read ${clock.dateTime(current.lastSyncAt)}` : " · calls not read yet"}
                {current.lastError ? <span className="text-danger"> · {current.lastError}</span> : null}
              </p>
            )}
            {current?.balance && (
              <p className="text-xs text-muted">
                {[
                  current.balance.calls && `${current.balance.calls.left} call credits left${current.balance.calls.total ? ` of ${current.balance.calls.total}` : ""}`,
                  current.balance.clickToCall && `${current.balance.clickToCall.left} click-to-call${current.balance.clickToCall.total ? ` of ${current.balance.clickToCall.total}` : ""}`,
                  current.balance.endsAt && `plan ends ${clock.date(current.balance.endsAt)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            {current?.balance?.warning && (
              <p role="alert" className="text-sm text-warning">
                {current.balance.warning}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {current && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(
                    () => syncTelephonyNow().then((r) => (r.ok ? { ok: true as const, done: `${r.data.calls} calls read, ${r.data.logged} logged${r.data.done ? "." : " — the rest on the next read."}${r.data.note ? ` (${r.data.note})` : ""}` } : r)),
                    "Read.",
                  )
                }
              >
                Read calls now
              </Button>
            )}
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
                  if (!(await confirmAction("Disconnect CallerDesk? Its key is wiped, Call buttons stop ringing through it and new calls stop coming in. The calls already logged stay."))) return;
                  run(() => disconnectTelephony().then((r) => (r.ok ? { ok: true as const } : r)), "CallerDesk disconnected.");
                }}
              >
                Disconnect
              </Button>
            )}
          </div>
        </div>
        {open && (
          <div className="grid gap-4 sm:grid-cols-2">
            <fieldset className="space-y-2 sm:col-span-2">
              <legend className="mb-1 text-sm font-medium text-text">What CallerDesk does here</legend>
              <label className="flex items-start gap-2 text-sm text-text">
                <input type="checkbox" checked disabled className="mt-0.5 h-4 w-4" />
                <span>
                  Calls and recordings
                  <span className="block text-xs text-muted">Always: every call on your CallerDesk numbers, in and out, comes to Calls with its recording.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-text">
                <input type="checkbox" checked={outgoing} onChange={(e) => setOutgoing(e.target.checked)} className="mt-0.5 h-4 w-4" />
                <span>
                  Outgoing — Call buttons ring through CallerDesk
                  <span className="block text-xs text-muted">CallerDesk rings your phone, then the customer, who sees the business number. Off, Call buttons stay as they are.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-text">
                <input type="checkbox" checked={incoming} onChange={(e) => setIncoming(e.target.checked)} className="mt-0.5 h-4 w-4" />
                <span>
                  Incoming — a customer&apos;s missed call becomes a callback
                  <span className="block text-xs text-muted">For the company&apos;s owner, due at once. Off, missed calls are only logged.</span>
                </span>
              </label>
              <p className="text-xs text-subtle">Both off is reports only.</p>
            </fieldset>
            <div className="space-y-1.5">
              <Label htmlFor="cd-key">API key</Label>
              <Input id="cd-key" type="password" value={authCode} onChange={(e) => setAuthCode(e.target.value)} placeholder={current ? "Unchanged" : ""} autoComplete="new-password" />
              <p className="text-xs text-muted">In CallerDesk: API &amp; Integration › API key. It&apos;s kept encrypted and never shown again.</p>
            </div>
            <div className={outgoing ? "space-y-1.5" : "hidden"}>
              <Label htmlFor="cd-number">Business number to call from</Label>
              <Input id="cd-number" value={deskphone} onChange={(e) => setDeskphone(e.target.value)} placeholder="The account's first number" className="font-mono" autoComplete="off" />
              <p className="text-xs text-muted">One of your CallerDesk virtual numbers (its &quot;deskphone&quot;). Left empty, the first one on the account.</p>
            </div>
            <div className="sm:col-span-2">
              <Button type="button" disabled={pending} onClick={save}>
                {pending ? "Trying the key…" : current ? "Save" : "Connect CallerDesk"}
              </Button>
            </div>
          </div>
        )}
        {messages}
      </CardContent>
    </Card>
  );
}

// ─── The webhook ─────────────────────────────────────────────────────────────────────────────

function WebhookCard({ url }: { url: string }) {
  const { pending, run, messages } = useSave();
  const [copied, setCopied] = useState(false);
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Calls as they happen</CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted">
          Without anything more, calls are read from CallerDesk every five minutes. To have each one here the moment it ends, add this address in CallerDesk: API &amp; Integration ›
          Webhooks › Create Webhook, and tick <strong>Call Report</strong> and <strong>Live Call</strong>. CallerDesk&apos;s webhooks are a paid add-on — ask your CallerDesk account
          manager if you don&apos;t see them.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input readOnly value={url} className="min-w-0 flex-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="Webhook address" />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={async () => {
              if (!(await confirmAction("Make a new address? The old one stops working at once — put the new one in CallerDesk straight after."))) return;
              run(() => newWebhookAddress().then((r) => (r.ok ? { ok: true as const } : r)), "New address made. Put it in CallerDesk in place of the old one.");
            }}
          >
            New address
          </Button>
        </div>
        <p className="text-xs text-muted">
          The address is a secret: anybody holding it could send call notices. They&apos;d log nothing — every call is checked against CallerDesk&apos;s own call list before it&apos;s
          believed — but make a new one if it gets out.
        </p>
        {messages}
      </CardContent>
    </Card>
  );
}

// ─── Who is who ──────────────────────────────────────────────────────────────────────────────

function MembersCard({ view }: { view: TelephonyView }) {
  const { pending, run, messages } = useSave();
  const [members, setMembers] = useState<TelephonyMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const personOf = new Map(view.agents.map((a) => [a.memberId, a]));
  const byPhone = new Map(view.people.map((p) => [keyOf(p.phone), p]).filter(([k]) => !!k) as [string, (typeof view.people)[number]][]);

  const load = () =>
    startLoading(async () => {
      setLoadError(null);
      const r = await telephonyMembers();
      if (!r.ok) return setLoadError(r.error);
      setMembers(r.data);
    });

  const assign = (memberId: string, userId: string) => {
    const before = personOf.get(memberId);
    run(async () => {
      if (before && before.userId !== userId) {
        const cleared = await saveTelephonyAgent({ userId: before.userId, memberId: "" });
        if (!cleared.ok) return cleared;
      }
      if (!userId) return { ok: true as const };
      const r = await saveTelephonyAgent({ userId, memberId });
      return r.ok ? { ok: true as const } : r;
    }, "Saved.");
  };

  // Members known here already, until CallerDesk's list is loaded.
  const rows: TelephonyMember[] = members ?? view.agents.map((a) => ({ memberId: a.memberId, name: a.memberName, number: a.memberNumber, active: true }));

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Who is who</CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted">
          Match each CallerDesk member to the person here. A member&apos;s calls are logged as that person&apos;s, and only people matched get &quot;Call through CallerDesk&quot; in a call dialog.
        </p>
        <Button type="button" variant="secondary" size="sm" disabled={loading} onClick={load}>
          {loading ? "Asking CallerDesk…" : members ? "Load again" : "Load CallerDesk members"}
        </Button>
        {loadError && <p role="alert" className="text-sm text-danger">{loadError}</p>}
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{members ? "This CallerDesk account has no members yet." : "Nobody is matched yet."}</p>
        ) : (
          <div className="divide-y divide-line rounded-base border border-line">
            {rows.map((m) => {
              const current = personOf.get(m.memberId);
              const suggestion = !current ? byPhone.get(keyOf(m.number) ?? "") : undefined;
              return (
                <div key={m.memberId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">
                      {m.name} {!m.active && <Badge>Inactive</Badge>}
                    </p>
                    <p className="font-mono text-xs text-muted">{m.number}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {suggestion && (
                      <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => assign(m.memberId, suggestion.id)}>
                        Is {suggestion.name}?
                      </Button>
                    )}
                    <SearchSelect aria-label={`Who ${m.name} is`} searchPlaceholder="Search people…" value={current?.userId ?? ""} disabled={pending} onChange={(e) => assign(m.memberId, e.target.value)} className="w-56">
                      <option value="">Nobody here</option>
                      {view.people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </SearchSelect>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {messages}
      </CardContent>
    </Card>
  );
}

// ─── Missed calls ────────────────────────────────────────────────────────────────────────────

function MissedCallsCard({ view }: { view: TelephonyView }) {
  const { pending, run, messages } = useSave();
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Missed calls</CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted">
          A customer on file who rings and gets nobody is a callback for the company&apos;s owner. Where the company has no owner, it goes to the person picked here. Calls from numbers
          that aren&apos;t on file wait on Calls › Business line, to become leads.
        </p>
        <div className="max-w-sm space-y-1.5">
          <Label htmlFor="cd-missed">When nobody owns the company</Label>
          <SearchSelect
            id="cd-missed"
            searchPlaceholder="Search people…"
            value={view.connection?.missedCallsUserId ?? ""}
            disabled={pending}
            onChange={(e) => run(() => saveMissedCallsPerson(e.target.value || null).then((r) => (r.ok ? { ok: true as const } : r)), "Saved.")}
          >
            <option value="">Leave it on the business line&apos;s list</option>
            {view.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SearchSelect>
        </div>
        {messages}
      </CardContent>
    </Card>
  );
}
