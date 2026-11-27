"use client";

import { useState, useTransition } from "react";
import { MonitorSmartphone, ShieldCheck, Wrench, MonitorCog } from "lucide-react";
import { raisePortalAssetRequest, type PortalAsset } from "@/actions/portal-public";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { formatCalendarDay } from "@/lib/time/zone";

type Ask = "problem" | "change" | "cover";

/** Days until a cover ends — negative when it has — or null without one. */
function daysTo(day: Date | string | null): number | null {
  if (!day) return null;
  const end = new Date(day).getTime();
  return Math.floor((end - Date.now()) / 86_400_000) + 1;
}

/** "Warranty to 12 Mar 2027", in red when it has ended, amber in its last 60 days. */
function Cover({ label, day }: { label: string; day: Date | string | null }) {
  const left = daysTo(day);
  if (left === null) return null;
  const tone = left < 0 ? "text-danger" : left <= 60 ? "text-warning" : "text-muted";
  return (
    <span className={tone}>
      {label} {left < 0 ? "ended" : "to"} {formatCalendarDay(day)}
    </span>
  );
}

/** A cover ended or ending within 60 days — the machines "Extend cover" is offered on first. */
const coverRunningOut = (a: PortalAsset) => [a.warrantyEndsOn, a.amcEndsOn].some((d) => {
  const left = daysTo(d);
  return left !== null && left <= 60;
});

/**
 * The customer's machines in their portal (owner, 15 Nov 2026 — src/lib/portal/assets.ts): theirs we look after and ours
 * at their site, with warranty and AMC cover. They don't edit the register; from a machine they report a problem, tell us
 * of a change, or ask for more cover — each lands with their account manager.
 */
export function PortalAssets({ token, assets, ticketsShown }: { token: string; assets: PortalAsset[]; ticketsShown: boolean }) {
  const [, startTransition] = useTransition();
  const [asking, setAsking] = useState<{ id: string; kind: Ask } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);

  const send = () => {
    if (!asking) return;
    setBusy(true);
    setNotice(null);
    startTransition(async () => {
      const result = await raisePortalAssetRequest(token, { assetId: asking.id, kind: asking.kind, message: text });
      setBusy(false);
      if (!result.ok) return setNotice({ text: result.error, bad: true });
      setNotice({
        text: result.data.ticket
          ? `Thanks — we've opened ticket ${result.data.ticket} and our support team will be in touch.${ticketsShown ? " You'll see it under your support tickets." : ""}`
          : asking.kind === "cover"
            ? "Thanks — your account manager will send you a quote for more cover."
            : "Thanks — we've passed that to your account manager.",
      });
      setAsking(null);
      setText("");
    });
  };

  const sorted = [...assets].sort((a, b) => Number(coverRunningOut(b)) - Number(coverRunningOut(a)));

  return (
    <Card>
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <MonitorSmartphone className="h-4 w-4 text-muted" />
        Your equipment
      </CardHeader>
      <CardContent className="space-y-3">
        {notice && <p className={`rounded-base px-3 py-2 text-sm ${notice.bad ? "bg-danger-bg text-danger" : "bg-success-bg text-success"}`}>{notice.text}</p>}
        {sorted.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Nothing on record yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {sorted.map((a) => {
              const open = asking?.id === a.id ? asking.kind : null;
              return (
                <li key={a.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text">
                        {a.name} <span className="font-mono text-xs font-normal text-muted">{a.tag}</span>
                      </p>
                      <p className="text-xs text-muted">
                        {[a.model, a.serialNumber ? `S/N ${a.serialNumber}` : null, a.location].filter(Boolean).join(" · ")}
                      </p>
                      <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
                        <Cover label="Warranty" day={a.warrantyEndsOn} />
                        <Cover label="AMC" day={a.amcEndsOn} />
                        {!a.warrantyEndsOn && !a.amcEndsOn && <span className="text-muted">No warranty or AMC on record</span>}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={a.state === "Under repair" ? "amber" : a.state === "On its way" ? "blue" : "default"}>{a.state}</Badge>
                      {a.ours && <Badge tone="default">Ours, at your site</Badge>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => (setNotice(null), setText(""), setAsking({ id: a.id, kind: "problem" }))}>
                      <Wrench className="h-3.5 w-3.5" /> Report a problem
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => (setNotice(null), setText(""), setAsking({ id: a.id, kind: "change" }))}>
                      <MonitorCog className="h-3.5 w-3.5" /> Something changed
                    </Button>
                    {(a.warrantyEndsOn || a.amcEndsOn || coverRunningOut(a)) && (
                      <Button size="sm" variant="ghost" onClick={() => (setNotice(null), setText(""), setAsking({ id: a.id, kind: "cover" }))}>
                        <ShieldCheck className="h-3.5 w-3.5" /> Extend cover
                      </Button>
                    )}
                  </div>
                  {open && (
                    <div className="space-y-2 rounded-base border border-line bg-surface-sunken p-3">
                      <Textarea
                        rows={3}
                        autoFocus
                        aria-label={open === "problem" ? "What's wrong with it" : open === "change" ? "What has changed" : "Anything we should know"}
                        placeholder={
                          open === "problem"
                            ? "It won't turn on since this morning."
                            : open === "change"
                              ? "Moved to our Gurugram office / replaced by a new one / no longer used."
                              : "Another year of AMC, please. (Optional)"
                        }
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                      />
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setAsking(null)} disabled={busy}>
                          Cancel
                        </Button>
                        <Button size="sm" onClick={send} disabled={busy || (open !== "cover" && !text.trim())}>
                          {busy ? "Sending…" : open === "problem" ? "Report it" : "Send"}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
