"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { confirmAction } from "@/components/ui/confirm";
import { addConnection, inviteGuest, listSharing, setListGuestEmails, setShareColumns, setShareRows, shareListWithGuest, unshareList, type ListSharing } from "@/actions/connect";
import { GuestAllowanceLine } from "@/components/connect/guest-allowance";

/**
 * Sharing a Smart List with guests (owner, 20 Nov 2026 — Deskzo Connect, src/lib/connect): who it's open to and until
 * when, taking it back, sharing with a guest already invited, and — for whoever manages guests — inviting somebody new
 * by work email with this list shared at once. Guests see only the columns marked for them (a column's own menu).
 */
/**
 * Which of the list's guest columns one guest sees (owner, 20 Nov 2026) — every one marked for guests, or a chosen few:
 * the LC team their LC columns, the territory reps their sales ones, on the same list.
 */
function ShareColumns({ share, columns, onSaved }: { share: ListSharing["shares"][number]; columns: ListSharing["guestColumns"]; onSaved: (ids: string[] | null) => void }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(share.columnIds ?? columns.map((c) => c.id));
  const [pending, start] = useTransition();
  const names = share.columnIds === null ? "every column marked for guests" : columns.filter((c) => share.columnIds!.includes(c.id)).map((c) => c.name).join(", ") || "none of the list's own";
  const save = (ids: string[] | null) =>
    start(async () => {
      const r = await setShareColumns(share.id, ids);
      if (!r.ok) return void toast.error(r.error);
      onSaved(ids);
      setOpen(false);
      toast.success(ids === null ? `${share.guestName} sees every guest column.` : `${share.guestName} sees ${ids.length} column${ids.length === 1 ? "" : "s"}.`);
    });
  return (
    <div className="mt-1 text-xs">
      <button type="button" className="text-left text-muted hover:text-text" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Columns: <span className="text-text">{names}</span> <span className="text-brand">· {open ? "close" : "choose"}</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-2 rounded-base border border-line p-2.5">
          {columns.length === 0 ? (
            <p className="text-subtle">No column is marked visible to guests yet — a column&apos;s own menu does that.</p>
          ) : (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {columns.map((c) => (
                <label key={c.id} className="flex items-center gap-1.5 text-sm text-text">
                  <input type="checkbox" className="h-3.5 w-3.5" checked={picked.includes(c.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))} />
                  {c.name}
                </label>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" className="text-brand hover:underline" disabled={pending} onClick={() => save(null)}>
              Every column marked for guests
            </button>
            <Button size="sm" disabled={pending || columns.length === 0} onClick={() => save(columns.filter((c) => picked.includes(c.id)).map((c) => c.id))}>
              {pending ? "Saving…" : "Only these"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ShareListDialog({ workbookId, onClose }: { workbookId: string; onClose: () => void }) {
  const router = useRouter();
  const [data, setData] = useState<ListSharing | null>(null);
  const [pending, start] = useTransition();
  const [guestId, setGuestId] = useState("");
  const [until, setUntil] = useState("");
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState({ connectionId: "", newConnection: "", name: "", email: "" });
  const [error, setError] = useState<string | null>(null);

  const load = () => listSharing(workbookId).then(setData);
  useEffect(() => {
    void listSharing(workbookId).then(setData);
  }, [workbookId]);

  const sharedIds = new Set(data?.shares.map((s) => s.guestId) ?? []);
  const available = data?.guests.filter((g) => !sharedIds.has(g.id)) ?? [];

  const share = () =>
    start(async () => {
      setError(null);
      const r = await shareListWithGuest({ workbookId, guestId, until: until || null });
      if (!r.ok) return setError(r.error);
      toast.success("Shared.");
      setGuestId("");
      await load();
      router.refresh();
    });

  const sendInvite = () =>
    start(async () => {
      setError(null);
      let connectionId = invite.connectionId;
      if (!connectionId) {
        const made = await addConnection({ name: invite.newConnection, kind: "BRAND" });
        if (!made.ok) return setError(made.error);
        connectionId = made.data.id;
      }
      const r = await inviteGuest({ connectionId, name: invite.name, email: invite.email, accessUntil: until || null, workbookId });
      if (!r.ok) {
        await load();
        return setError(r.error);
      }
      toast.success(`Invitation sent to ${invite.email.trim()}.`);
      setInvite({ connectionId: "", newConnection: "", name: "", email: "" });
      setInviting(false);
      await load();
      router.refresh();
    });

  const setRows = (s: ListSharing["shares"][number], propertyId: string) =>
    start(async () => {
      const r = await setShareRows(s.id, propertyId || null);
      if (!r.ok) return void toast.error(r.error);
      setData((d) => (d ? { ...d, shares: d.shares.map((x) => (x.id === s.id ? { ...x, onlyPropertyId: propertyId || null } : x)) } : d));
      toast.success(propertyId ? `${s.guestName} sees only the ticked rows.` : `${s.guestName} sees every row.`);
    });

  const takeBack = async (s: ListSharing["shares"][number]) => {
    if (!(await confirmAction({ title: `Take this list back from ${s.guestName}?`, message: "They lose it on their next click. What they wrote in it stays.", confirmLabel: "Take back" }))) return;
    const r = await unshareList(s.id);
    if (!r.ok) return toast.error(r.error);
    await load();
    router.refresh();
  };

  return (
    <Dialog open onClose={onClose} title="Share with guests">
      {!data ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !data.ready ? (
        <p className="text-sm text-muted">Deskzo Connect arrives with this workspace&apos;s next update.</p>
      ) : !data.canShare ? (
        <p className="text-sm text-muted">Only whoever built this list can share it, and only Smart Lists — not calling activities.</p>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-muted">Guests sign in with a code to their work email and see only this list: its companies and the columns you mark &ldquo;Visible to guests&rdquo;.</p>
          {data.tickColumns.length === 0 && (
            <p className="text-xs text-subtle">
              To show a guest only some accounts — those your sales team nominates for them — add a Checkbox column such as &ldquo;Nominated for LC&rdquo;, tick the accounts, then pick it under &ldquo;Sees&rdquo; here. A guest&apos;s territory is set on the Guests page.
            </p>
          )}
          <GuestAllowanceLine allowance={data.allowance} compact />
          {/* The list's own say over its guests' emails (owner, 20 Nov 2026) — invitations and codes go regardless. */}
          <label className="flex items-start justify-between gap-3 rounded-base border border-line px-3 py-2.5 text-sm">
            <span>
              <span className="font-medium text-text">Email guests when something changes</span>
              <span className="mt-0.5 block text-xs text-muted">A list shared with them, a comment shared with them (at most one email an hour), a suggestion decided. Invitations and sign-in codes always go.</span>
            </span>
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0"
              checked={data.emailGuests}
              disabled={pending}
              onChange={(e) => {
                const on = e.target.checked;
                start(async () => {
                  setData((d) => (d ? { ...d, emailGuests: on } : d));
                  const r = await setListGuestEmails(workbookId, on);
                  if (!r.ok) {
                    setData((d) => (d ? { ...d, emailGuests: !on } : d));
                    return void toast.error(r.error);
                  }
                  toast.success(on ? "Guests will be emailed." : "Guests won't be emailed about this list.");
                });
              }}
            />
          </label>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-text">Shared with</h3>
            {data.shares.length === 0 && <p className="text-sm text-subtle">Nobody yet.</p>}
            <ul className="space-y-1.5">
              {data.shares.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 rounded-base border border-line px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-text">
                      {s.guestName} <span className="font-normal text-muted">· {s.connection}</span>
                    </div>
                    <div className="truncate text-xs text-muted">
                      {s.email}
                      {s.status === "INVITED" ? " · hasn't signed in yet" : ""}
                      {s.until ? ` · until ${new Date(s.until).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}
                    </div>
                    {/* Which rows (owner, 20 Nov 2026): every one, or only those the sales team ticked for them. */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                      <label htmlFor={`rows-${s.id}`} className="text-muted">
                        Sees
                      </label>
                      <Select id={`rows-${s.id}`} value={s.onlyPropertyId ?? ""} disabled={pending} onChange={(e) => setRows(s, e.target.value)} className="h-7 w-auto py-0 text-xs">
                        <option value="">Every row</option>
                        {data.tickColumns.map((c) => (
                          <option key={c.id} value={c.id}>
                            Only rows ticked in “{c.name}”
                          </option>
                        ))}
                        {s.onlyPropertyId && !data.tickColumns.some((c) => c.id === s.onlyPropertyId) && <option value={s.onlyPropertyId}>A column since deleted — no rows</option>}
                      </Select>
                      <span className="text-subtle">{data.ownRows ? "· territory doesn't apply to this list" : s.territory.length ? `· in ${s.territory.join(", ")}` : "· every state"}</span>
                    </div>
                    <ShareColumns share={s} columns={data.guestColumns} onSaved={(ids) => setData((d) => (d ? { ...d, shares: d.shares.map((x) => (x.id === s.id ? { ...x, columnIds: ids } : x)) } : d))} />
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => takeBack(s)} aria-label={`Take back from ${s.guestName}`}>
                    <X className="h-3.5 w-3.5" />
                    Take back
                  </Button>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-3 border-t border-line pt-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <div className="space-y-1.5">
                <Label htmlFor="share-guest">Share with a guest</Label>
                <Select id="share-guest" value={guestId} onChange={(e) => setGuestId(e.target.value)}>
                  <option value="">{available.length ? "Choose…" : "No other guests yet"}</option>
                  {available.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} — {g.connection} ({g.email})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="share-until">Until (optional)</Label>
                <Input id="share-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
              </div>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              {data.canInvite && !inviting && data.allowance.limit !== 0 ? (
                <Button variant="ghost" size="sm" onClick={() => setInviting(true)}>
                  <UserPlus className="h-3.5 w-3.5" />
                  Invite someone new
                </Button>
              ) : (
                <span />
              )}
              <Button onClick={share} disabled={pending || !guestId}>
                {pending ? "Sharing…" : "Share"}
              </Button>
            </div>
          </section>

          {inviting && (
            <form
              className="space-y-3 rounded-base border border-line p-3"
              onSubmit={(e) => {
                e.preventDefault();
                sendInvite();
              }}
            >
              <h3 className="text-sm font-semibold text-text">Invite by work email</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="inv-name">Name</Label>
                  <Input id="inv-name" required value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="inv-email">Work email</Label>
                  <Input id="inv-email" type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} placeholder="name@theircompany.com" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="inv-conn">Their company</Label>
                  <Select id="inv-conn" value={invite.connectionId} onChange={(e) => setInvite({ ...invite, connectionId: e.target.value })}>
                    <option value="">A new one…</option>
                    {data.connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </div>
                {!invite.connectionId && (
                  <div className="space-y-1.5">
                    <Label htmlFor="inv-newconn">New company&apos;s name</Label>
                    <Input id="inv-newconn" required value={invite.newConnection} onChange={(e) => setInvite({ ...invite, newConnection: e.target.value })} placeholder="Autodesk India — Territory Sales" />
                  </div>
                )}
              </div>
              <p className="text-xs text-subtle">Personal mail (gmail.com and the like) is refused. The email names no customer; the invitation works for 7 days. Access ends on the date above, if set.</p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setInviting(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? "Sending…" : "Invite and share"}
                </Button>
              </div>
            </form>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
