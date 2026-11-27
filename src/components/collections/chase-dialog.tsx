"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail, RefreshCw, Send, Trash2 } from "lucide-react";
import { discardChaseEmail, draftChaseEmail, openChaseEmail, sendChaseEmail } from "@/actions/collection-chase";
import type { ChaseView } from "@/lib/collections/chase-server";
import { CHASE_TONES, TONE_LABELS, type ChaseTone } from "@/lib/collections/chase";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";

/**
 * A chase email Arjun drafted (src/lib/collections/chase-server.ts), to read, change and send — or write again in another
 * tone, keep for later, or set aside. It goes from the person, as their documents go; the invoices and their pay-now
 * links go where it says {{invoices}}.
 */
export function ChaseDialog({ view, onClose }: { view: ChaseView; onClose: () => void }) {
  const router = useRouter();
  const arjun = useTeammate("arjun");
  const [current, setCurrent] = useState(view);
  const [subject, setSubject] = useState(view.subject);
  const [body, setBody] = useState(view.body);
  const [tone, setTone] = useState<ChaseTone>(view.tone);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(view.recipients.filter((r) => r.ticked).map((r) => r.id)));
  const [attach, setAttach] = useState(view.mayAttachStatement);
  const [busy, setBusy] = useState<"send" | "again" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string[] | null>(null);
  const [, start] = useTransition();

  const again = () =>
    start(async () => {
      setBusy("again");
      setError(null);
      const r = await draftChaseEmail({ companyId: current.companyId, tone });
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setCurrent(r.data);
      setSubject(r.data.subject);
      setBody(r.data.body);
    });
  const send = () =>
    start(async () => {
      setBusy("send");
      setError(null);
      const r = await sendChaseEmail({ id: current.id, subject, body, contactIds: [...ticked], attachStatement: attach });
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setSentTo(r.data.to);
      router.refresh();
    });
  const discard = () =>
    start(async () => {
      setBusy("discard");
      const r = await discardChaseEmail(current.id);
      setBusy(null);
      if (!r.ok) return setError(r.error);
      router.refresh();
      onClose();
    });

  return (
    <Dialog open onClose={onClose} title={`Chase email — ${current.companyName}`} wide>
      {sentTo ? (
        <div className="space-y-3 text-sm">
          <p className="flex items-center gap-2 text-text">
            <Mail className="h-4 w-4 text-success" />
            Sent to {sentTo.join(", ")}. Each invoice in it is noted as followed up.
          </p>
          <p className="text-muted">{current.notes.find((n) => n.startsWith("Replies")) ?? ""}</p>
          <div className="flex justify-end">
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2 rounded-base bg-surface-sunken px-3 py-2">
            <TeammateAvatar teammate="arjun" size="sm" />
            <span className="min-w-0 flex-1 text-muted">
              <span className="font-medium text-text">{arjun.name}</span> drafted this from your books. Check it, change anything, then send — nothing goes until you do.
            </span>
            <span className="flex items-center gap-2">
              <Select aria-label="Tone" value={tone} onChange={(e) => setTone(e.target.value as ChaseTone)} className="h-8 w-auto text-xs">
                {CHASE_TONES.map((t) => (
                  <option key={t} value={t}>
                    {TONE_LABELS[t]}
                  </option>
                ))}
              </Select>
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={again}>
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy === "again" ? "animate-spin" : ""}`} />
                {busy === "again" ? "Writing…" : "Write again"}
              </Button>
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
            <div className="space-y-3">
              <div>
                <Label htmlFor="chase-subject">Subject</Label>
                <Input id="chase-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="chase-body">Email</Label>
                <Textarea id="chase-body" rows={Math.min(16, body.split("\n").length + 2)} value={body} onChange={(e) => setBody(e.target.value)} className="text-sm" />
                <p className="mt-1 text-[11px] text-subtle">
                  {"{{firstName}}"} becomes the first names of the people it goes to, {"{{senderName}}"} yours, and {"{{invoices}}"} the list below — with a Pay now link on each
                  where a payment gateway is connected.
                </p>
              </div>
              {current.lines.length > 0 && (
                <table className="w-full text-xs">
                  <thead className="text-left text-subtle">
                    <tr>
                      <th className="py-1 pr-2 font-medium">Invoice</th>
                      <th className="py-1 pr-2 font-medium">Due</th>
                      <th className="py-1 pr-2 font-medium"></th>
                      <th className="py-1 text-right font-medium">Still to pay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.lines.map((l) => (
                      <tr key={l.number} className="border-t border-line">
                        <td className="py-1 pr-2 font-mono">{l.number}</td>
                        <td className="py-1 pr-2">{l.due}</td>
                        <td className="py-1 pr-2 text-muted">{l.late}</td>
                        <td className="py-1 text-right">{l.balance}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="space-y-3">
              <div>
                <p className="mb-1 text-xs font-medium text-muted">To</p>
                {current.recipients.length === 0 ? (
                  <p className="text-xs text-warning">Nobody at {current.companyName} can be emailed — add a contact with an email address.</p>
                ) : (
                  <ul className="space-y-1">
                    {current.recipients.map((r) => (
                      <li key={r.id}>
                        <label className={`flex items-start gap-2 text-xs ${r.canReceive ? "" : "opacity-60"}`}>
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            disabled={!r.canReceive}
                            checked={ticked.has(r.id)}
                            onChange={(e) =>
                              setTicked((s) => {
                                const next = new Set(s);
                                if (e.target.checked) next.add(r.id);
                                else next.delete(r.id);
                                return next;
                              })
                            }
                          />
                          <span className="min-w-0">
                            <span className="block text-text">{r.name}</span>
                            <span className="block break-all text-subtle">{r.email ?? "no email address"}</span>
                            {r.blockedBecause && <span className="block text-warning">{r.blockedBecause}</span>}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {current.mayAttachStatement && (
                <label className="flex items-center gap-2 text-xs text-text">
                  <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
                  Attach their statement (PDF)
                </label>
              )}
              <div className="text-xs text-muted">
                <p className="font-medium">From</p>
                <p className={current.fromProblem ? "text-warning" : "break-words"}>{current.fromProblem ?? current.from}</p>
              </div>
              {current.notes.length > 0 && (
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
                  {current.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={discard}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {busy === "discard" ? "Setting aside…" : "Set aside"}
            </Button>
            <span className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={onClose}>
                Keep for later
              </Button>
              <Button size="sm" disabled={busy !== null || !!current.fromProblem || ticked.size === 0 || current.lines.length === 0} onClick={send}>
                <Send className="mr-1.5 h-3.5 w-3.5" />
                {busy === "send" ? "Sending…" : "Send"}
              </Button>
            </span>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** "Draft email": Arjun writes one for this customer, and it opens to check. */
export function DraftChaseButton({ companyId, label = "Draft email", variant = "secondary" }: { companyId: string; label?: string; variant?: "primary" | "secondary" | "ghost" | "subtle" }) {
  const [view, setView] = useState<ChaseView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const draft = () =>
    start(async () => {
      setBusy(true);
      setError(null);
      const r = await draftChaseEmail({ companyId });
      setBusy(false);
      if (!r.ok) return setError(r.error);
      setView(r.data);
    });
  return (
    <>
      <Button size="sm" variant={variant} disabled={busy} onClick={draft} title="Arjun drafts a chase email for you to check">
        <Mail className="mr-1.5 h-3.5 w-3.5" />
        {busy ? "Arjun is writing…" : label}
      </Button>
      {error && <span className="block max-w-xs text-xs text-danger">{error}</span>}
      {view && <ChaseDialog view={view} onClose={() => setView(null)} />}
    </>
  );
}

/** A waiting draft, opened again. */
export function OpenChaseButton({ id, label }: { id: string; label: string }) {
  const [view, setView] = useState<ChaseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const open = () =>
    start(async () => {
      const r = await openChaseEmail(id);
      if (!r.ok) return setError(r.error);
      setView(r.data);
    });
  return (
    <>
      <button type="button" onClick={open} className="text-left text-sm text-text hover:underline">
        {label}
      </button>
      {error && <span className="block text-xs text-danger">{error}</span>}
      {view && <ChaseDialog view={view} onClose={() => setView(null)} />}
    </>
  );
}
