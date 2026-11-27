"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { assignDeskRequest, closeDeskRequest, moveDeskRequest, pickUpDeskRequest, sayOnDeskRequest, setDeskRequestStatus } from "@/actions/desks";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm";
import { Label, Select, Textarea } from "@/components/ui/input";
import { FilePicker } from "@/components/desks/file-picker";
import { BODY_MAX, DESK_STATUSES, statusWords } from "@/lib/desks/rules";
import { cn } from "@/lib/utils";

type Result = { ok: true } | { ok: false; error: string };

export function useWork() {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<Result>, then?: () => void) => {
    setError(null);
    start(async () => {
      const r = await work();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      then?.();
      router.refresh();
    });
  };
  return { busy, error, run, router };
}

export const Problem = ({ error }: { error: string | null }) =>
  error ? (
    <p role="alert" className="text-sm text-danger">
      {error}
    </p>
  ) : null;

/** The desk's side: where it stands, who has it, which desk. */
export function DeskControls({
  request,
  people,
  desks,
  me,
}: {
  request: { id: string; status: string; deskId: string; deskName: string; assignedTo: { id: string; name: string } | null };
  people: { id: string; name: string }[];
  desks: { id: string; name: string }[];
  me: { id: string; name: string };
}) {
  const { busy, error, run, router } = useWork();
  const options = [...people, ...[request.assignedTo, me].filter((p): p is { id: string; name: string } => !!p)].filter((p, i, all) => all.findIndex((x) => x.id === p.id) === i);

  async function move(deskId: string) {
    const to = desks.find((d) => d.id === deskId);
    if (!to || !(await confirmAction({ title: `Move it to ${to.name}?`, message: `Its people see it from then on, notes included, and ${request.deskName}'s don't. Its time starts again there.`, confirmLabel: "Move it", danger: false }))) return;
    run(async () => {
      const r = await moveDeskRequest(request.id, deskId);
      if (r.ok) router.push(r.data.href);
      return r;
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        {!request.assignedTo && request.status !== "RESOLVED" && (
          <Button disabled={busy} onClick={() => run(() => pickUpDeskRequest(request.id))}>
            Pick up
          </Button>
        )}
        <div className="space-y-1">
          <Label htmlFor="status">Status</Label>
          <Select id="status" className="w-44" disabled={busy} value={request.status} onChange={(e) => run(() => setDeskRequestStatus(request.id, e.target.value))}>
            {request.status === "OPEN" && <option value="OPEN">{statusWords("OPEN", "desk")}</option>}
            {request.status === "ASKED" && <option value="ASKED">{statusWords("ASKED", "desk")}</option>}
            {DESK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusWords(s, "desk")}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="with">With</Label>
          <Select id="with" className="w-52" disabled={busy} value={request.assignedTo?.id ?? ""} onChange={(e) => run(() => assignDeskRequest(request.id, e.target.value || null))}>
            <option value="">The whole desk</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
        {desks.length > 0 && request.status !== "RESOLVED" && (
          <div className="space-y-1">
            <Label htmlFor="desk">Desk</Label>
            <Select id="desk" className="w-52" disabled={busy} value="" onChange={(e) => void move(e.target.value)}>
              <option value="">{request.deskName}</option>
              {desks.map((d) => (
                <option key={d.id} value={d.id}>
                  Move to {d.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      <Problem error={error} />
    </div>
  );
}

/** Saying something: a reply either way, or the desk's own note. */
export function SayBox({ id, side, resolved, waiting = false, canReopen, requester, deskName }: { id: string; side: "requester" | "desk"; resolved: boolean; /** Held for approval: whoever asked can only take it back. */ waiting?: boolean; canReopen: boolean; requester: string; deskName: string }) {
  const { busy, error, run } = useWork();
  const [note, setNote] = useState(false);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  if (side === "requester" && resolved && !canReopen) return <p className="text-sm text-muted">This was resolved a while ago. If it&apos;s back, make a new request and say it&apos;s about this one.</p>;

  if (waiting) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted">{deskName} sees it once it&apos;s approved.</p>
        <Problem error={error} />
        <Button type="button" variant="secondary" disabled={busy} onClick={() => run(() => closeDeskRequest(id))}>
          Take it back
        </Button>
      </div>
    );
  }

  function send(resolve: boolean) {
    const form = new FormData();
    form.set("id", id);
    form.set("kind", note ? "note" : "reply");
    form.set("body", body);
    if (resolve) form.set("resolve", "1");
    for (const f of files) form.append("files", f);
    run(
      () => sayOnDeskRequest(form),
      () => {
        setBody("");
        setFiles([]);
      },
    );
  }

  const hint =
    side === "requester"
      ? resolved
        ? `Not sorted after all? A reply opens it again with ${deskName}.`
        : `${deskName} is told.`
      : note
        ? "Only the desk and the super admin see this."
        : `${requester} is told.`;
  const empty = !body.trim() && files.length === 0;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send(false);
      }}
      className="space-y-2.5"
    >
      {side === "desk" && (
        <div className="flex flex-wrap gap-2">
          {[false, true].map((n) => (
            <button key={String(n)} type="button" aria-pressed={note === n} onClick={() => setNote(n)} className={cn("h-9 rounded-base border px-3.5 text-[13px] font-medium", note === n ? "border-brand bg-brand-subtle text-brand" : "border-line-strong bg-surface text-text hover:bg-surface-sunken")}>
              {n ? "Note for the desk" : `Reply to ${requester}`}
            </button>
          ))}
        </div>
      )}
      <Label htmlFor="say">{hint}</Label>
      <Textarea id="say" value={body} onChange={(e) => setBody(e.target.value)} maxLength={BODY_MAX} className={note ? "bg-warning-bg" : undefined} />
      <FilePicker files={files} onChange={setFiles} />
      <Problem error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || empty}>
          {note ? "Save note" : "Send reply"}
        </Button>
        {side === "desk" && !note && !resolved && (
          <Button type="button" variant="secondary" disabled={busy || empty} onClick={() => send(true)}>
            Send and resolve
          </Button>
        )}
        {side === "requester" && !resolved && (
          <Button type="button" variant="secondary" disabled={busy} onClick={() => run(() => closeDeskRequest(id))}>
            It&apos;s sorted, close it
          </Button>
        )}
      </div>
    </form>
  );
}

/** Pick up, from the desk's list. */
export function PickUpButton({ id, title }: { id: string; title: string }) {
  const { busy, error, run } = useWork();
  return (
    <div>
      <Button size="sm" disabled={busy} aria-label={`Pick up ${title}`} onClick={() => run(() => pickUpDeskRequest(id))}>
        Pick up
      </Button>
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
