"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, Eye, Mail, MapPin, Trash2 } from "lucide-react";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { confirmAction } from "@/components/ui/confirm";
import { addConnection, removeGuest, resendGuestInvite, restoreGuest, setGuestTerritory, suspendGuest, type ConnectionView, type GuestRowView } from "@/actions/connect";

/**
 * Deskzo Connect's guests (owner, 20 Nov 2026 — src/lib/connect): every outside company, its guests, where each stands
 * and which lists they see — with resend, stop (signed out everywhere at once), let back in and remove. Inviting and
 * sharing happen from a Smart List's Share button, so a guest is always invited to something.
 */

const KIND_LABEL: Record<string, string> = { BRAND: "Brand", SUBCONTRACTOR: "Subcontractor", CLIENT: "Client", ADVISER: "Adviser", OTHER: "Other" };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");

function status(g: GuestRowView): { label: string; tone: "green" | "amber" | "red" | "default" } {
  const now = Date.now();
  if (g.status === "SUSPENDED") return { label: "Stopped", tone: "red" };
  if (g.accessUntil && Date.parse(g.accessUntil) <= now) return { label: "Access ended", tone: "default" };
  if (g.status === "INVITED") return Date.parse(g.inviteExpiresAt) <= now ? { label: "Invitation ran out", tone: "default" } : { label: "Invited", tone: "amber" };
  return { label: "Active", tone: "green" };
}

/**
 * A guest's territory (owner, 20 Nov 2026: "external users record view by their territory"): the states whose companies
 * they see, in every list shared with them. None ticked — every state.
 */
function Territory({ guest, states }: { guest: GuestRowView; states: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(guest.territory);
  const [q, setQ] = useState("");
  const [pending, start] = useTransition();
  const choices = [...new Set([...states, ...guest.territory])].sort((a, b) => a.localeCompare(b)).filter((s) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase()));
  const save = () =>
    start(async () => {
      const r = await setGuestTerritory(guest.id, picked);
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.data.states.length ? `${guest.name} sees companies in ${r.data.states.length} state${r.data.states.length === 1 ? "" : "s"}.` : `${guest.name} sees every state.`);
      setOpen(false);
      router.refresh();
    });
  return (
    <div className="text-xs">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-muted hover:text-text" aria-expanded={open}>
        <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
        {guest.territory.length ? <>Territory: <span className="text-text">{guest.territory.join(", ")}</span></> : "Territory: every state"}
        <span className="text-brand">· {open ? "close" : "change"}</span>
      </button>
      {open && (
        <div className="mt-2 w-full max-w-xl space-y-2 rounded-base border border-line p-3">
          <div className="flex items-center gap-2">
            <Input aria-label="Find a state" placeholder="Find a state…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8" />
            {picked.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setPicked([])}>
                Clear
              </Button>
            )}
          </div>
          <div className="grid max-h-56 grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto sm:grid-cols-3">
            {choices.map((s) => (
              <label key={s} className="flex items-center gap-1.5 text-sm text-text">
                <input type="checkbox" className="h-3.5 w-3.5" checked={picked.includes(s)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s] : p.filter((x) => x !== s)))} />
                {s}
              </label>
            ))}
            {choices.length === 0 && <span className="text-subtle">No state matches.</span>}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-subtle">{picked.length ? `Only companies with an address in these ${picked.length}.` : "Nothing ticked: companies in every state."}</span>
            <Button size="sm" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save territory"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function GuestsManager({ connections, states }: { connections: ConnectionView[]; states: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("BRAND");

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error ?? "That didn't work.");
      toast.success(done);
      router.refresh();
    });

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              const r = await addConnection({ name, kind });
              if (r.ok) setName("");
              return r;
            }, "Connection added.");
          }}
        >
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="conn-name">Add a company you work alongside</Label>
            <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Autodesk India — Territory Sales" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="conn-kind">Kind</Label>
            <Select id="conn-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={pending || !name.trim()}>
            Add
          </Button>
        </form>
        <p className="mt-2 text-xs text-subtle">To invite a person, open a Smart List and use Share — so every guest is invited to something.</p>
      </Card>

      {connections.length === 0 && <p className="text-sm text-muted">No connections yet.</p>}

      {connections.map((c) => (
        <Card key={c.id} className="overflow-hidden p-0">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Building2 className="h-4 w-4 text-muted" aria-hidden="true" />
            <h2 className="font-semibold text-text">{c.name}</h2>
            <span className="text-xs text-muted">
              {KIND_LABEL[c.kind]} · {c.guests.length} guest{c.guests.length === 1 ? "" : "s"}
            </span>
          </div>
          {c.guests.length === 0 ? (
            <p className="px-4 py-4 text-sm text-subtle">No guests yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {c.guests.map((g) => {
                const s = status(g);
                return (
                  <li key={g.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-text">{g.name}</span>
                        <Badge tone={s.tone}>{s.label}</Badge>
                      </div>
                      <div className="text-xs text-muted">
                        {g.email}
                        {g.lastSignInAt ? ` · last signed in ${day(g.lastSignInAt)}` : ` · invited ${day(g.invitedAt)}`}
                        {g.accessUntil ? ` · access until ${day(g.accessUntil)}` : ""}
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-xs">
                        {g.lists.length === 0 ? (
                          <span className="text-subtle">No lists shared</span>
                        ) : (
                          g.lists.map((l) => (
                            <Link key={l.shareId} href={`/smart-lists/${l.workbookId}`} className="rounded bg-surface-sunken px-1.5 py-0.5 text-text hover:underline">
                              {l.name}
                            </Link>
                          ))
                        )}
                      </div>
                      <Territory guest={g} states={states} />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Link href={`/smart-lists/guests/view/${g.id}`}>
                        <Button variant="ghost" size="sm">
                          <Eye className="h-3.5 w-3.5" />
                          See their view
                        </Button>
                      </Link>
                      {g.status !== "SUSPENDED" && !g.lastSignInAt && (
                        <Button variant="ghost" size="sm" disabled={pending} onClick={() => act(() => resendGuestInvite(g.id), `Invitation sent again to ${g.email}.`)}>
                          <Mail className="h-3.5 w-3.5" />
                          Resend
                        </Button>
                      )}
                      {g.status === "SUSPENDED" ? (
                        <Button variant="ghost" size="sm" disabled={pending} onClick={() => act(() => restoreGuest(g.id), `${g.name} can sign in again.`)}>
                          Let back in
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={async () => {
                            if (await confirmAction({ title: `Stop ${g.name}?`, message: "They're signed out everywhere at once, and no code works until you let them back in.", confirmLabel: "Stop", danger: true })) act(() => suspendGuest(g.id), `${g.name} is stopped.`);
                          }}
                        >
                          Stop
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        aria-label={`Remove ${g.name}`}
                        onClick={async () => {
                          if (await confirmAction({ title: `Remove ${g.name}?`, message: "They and everything shared with them go. What they wrote in lists stays.", confirmLabel: "Remove", danger: true })) act(() => removeGuest(g.id), `${g.name} removed.`);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}
