"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, Gauge, History, Lock, Pencil, RotateCcw, TriangleAlert } from "lucide-react";
import { setPersonUnmaskLimit, type PersonFieldAccess } from "@/actions/field-access";
import { acPath } from "@/lib/access-control/nav";
import { Ago } from "@/components/ui/ago";
import { confirmAction } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { Panel, Pill, acButton, acInput, type PillTone } from "@/components/access-control/ui";
import { Field } from "@/components/access-control/employees/shared";
import { cn } from "@/lib/utils";

const perDay = (limit: number | null) => (limit === null ? "no limit" : `${limit} a day`);

/**
 * One person's daily unmasking quota: the limit that applies to them and where it comes from, how many
 * records they have unmasked today, and the two things an admin can do about it.
 *
 * The quota counts records, not reveals: one unit the first time a lead, contact or company is unmasked
 * in a business day, and nothing for opening it again that day. It starts again at midnight in the
 * workspace's zone. The limit is the person's own if they have one, else their role's, else the
 * workspace default — so there are no credits to add or take away, only a limit of their own to set
 * (`setPersonUnmaskLimit`, with a reason and an optional end date) or to remove. Nobody sets a limit
 * higher than their own, and nobody sets theirs; the action refuses both.
 */
export function PiiQuotaPanel({
  userId,
  name,
  limit,
  usage,
  zone,
  ownEndsOn,
  ownEndsOnText,
  ownLapsed,
  lastReveal,
  maySeeLog,
  maskingOn,
  viewerLimit,
  today,
  canEdit,
  lockedWhy,
}: {
  userId: string;
  name: string;
  limit: PersonFieldAccess["limit"];
  usage: PersonFieldAccess["usage"];
  zone: string;
  /** The last day their own limit applies (`yyyy-mm-dd`, and in words); null when it has no end date or they have none. */
  ownEndsOn: string | null;
  ownEndsOnText: string | null;
  /** Their own limit is past its end date: still stored, no longer applied. */
  ownLapsed: boolean;
  /** ISO of their last counted or repeat reveal; null for never, or when the viewer may not read the log. */
  lastReveal: string | null;
  /** The unmasking log is the super admin's alone. */
  maySeeLog: boolean;
  /** Field masking's master switch. Off: every field shows in the clear and nothing is counted. */
  maskingOn: boolean;
  /** The viewer's own daily limit (null: none) — nobody sets one higher. `"any"` for a super admin. */
  viewerLimit: number | null | "any";
  today: string;
  canEdit: boolean;
  lockedWhy: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, start] = useTransition();
  const first = name.split(" ")[0] ?? name;

  const effective = limit.effective;
  const pct = effective === null ? 0 : effective === 0 ? 100 : Math.min(100, Math.round((usage.used / effective) * 100));
  const atLimit = effective !== null && usage.remaining === 0;
  const status: { text: string; tone: PillTone } = effective === null ? { text: "No limit", tone: "neutral" } : atLimit ? { text: "At limit", tone: "red" } : pct >= 80 ? { text: "Near limit", tone: "amber" } : { text: "Within limit", tone: "green" };
  const ownLive = limit.own !== null && !ownLapsed;
  const source = ownLive ? `Own limit${ownEndsOnText ? ` · until ${ownEndsOnText}` : ""}` : limit.inheritedFrom === "role" ? "Role's limit" : limit.inheritedFrom === "workspaceDefault" ? "Workspace default" : null;
  const inheritedWords =
    limit.inheritedFrom === "role"
      ? `the role's limit (${perDay(limit.inherited)})`
      : limit.inheritedFrom === "workspaceDefault"
        ? `the workspace default (${perDay(limit.inherited)})`
        : "having nothing to count, as they may unmask nothing";

  const stats: { value: React.ReactNode; label: string; tone?: string }[] = [
    { value: effective === null ? "No limit" : effective, label: "daily limit" },
    { value: usage.used, label: "records unmasked today", tone: effective !== null && pct >= 80 ? "text-warning" : undefined },
    { value: usage.remaining === null ? "—" : usage.remaining, label: "remaining today", tone: usage.remaining === null ? undefined : usage.remaining === 0 ? "text-danger" : "text-success" },
    { value: maySeeLog ? <Ago at={lastReveal} empty="Never" /> : "—", label: maySeeLog ? "last reveal" : "last reveal (super admin only)" },
  ];

  const backToInherited = () =>
    start(async () => {
      const yes = await confirmAction({
        title: `Remove ${first}'s own daily limit?`,
        message: `They go back to ${inheritedWords}. What they have unmasked today still counts.`,
        confirmLabel: "Remove own limit",
        danger: true,
      });
      if (!yes) return;
      const r = await setPersonUnmaskLimit(userId, null);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`${first} now follows ${limit.inheritedFrom === "workspaceDefault" ? "the workspace default" : "their role's limit"}.`);
      router.refresh();
    });

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Gauge className="h-[18px] w-[18px] text-brand" aria-hidden />
        <span className="flex-1 font-semibold text-text">Daily unmasking quota</span>
        {ownLapsed && <Pill tone="neutral">Own limit lapsed {ownEndsOnText}</Pill>}
        {source && <Pill tone={ownLive ? "brand" : "neutral"}>{source}</Pill>}
        <Pill tone={status.tone} className="h-[22px] text-[11.5px]">
          {status.text}
        </Pill>
      </div>
      <div className="flex flex-col gap-3.5 p-4">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2">
          {stats.map((s) => (
            <div key={s.label} className="rounded-md bg-surface-sunken px-3 py-2.5">
              <div className={cn("text-[22px] font-bold leading-[1.2] tracking-[-0.02em]", s.tone ?? "text-text")}>{s.value}</div>
              <div className="text-[11.5px] text-muted">{s.label}</div>
            </div>
          ))}
        </div>

        <div>
          <div className="mb-[5px] flex justify-between text-xs text-muted">
            <span>{effective === null ? `${usage.used} ${usage.used === 1 ? "record" : "records"} unmasked today · no limit applies` : `${usage.used} of ${effective} records unmasked today`}</span>
            {effective !== null && <span>{pct}%</span>}
          </div>
          <div className="h-2.5 overflow-hidden rounded-[5px] bg-surface-sunken">
            <div className={cn("h-full rounded-[5px] transition-[width] duration-300", pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-success")} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-[5px] flex flex-wrap justify-between gap-1.5 text-[11.5px] text-subtle">
            <span>Leads, contacts and companies together · 1 per record per day · opening the same record again is free</span>
            <span>Resets at midnight ({zone})</span>
          </div>
        </div>

        <p className="text-xs leading-[1.5] text-muted">{limit.why}</p>

        {!maskingOn && (
          <p className="flex gap-2 rounded-md bg-warning-bg px-3 py-2.5 text-[12.5px] leading-[1.5] text-warning">
            <TriangleAlert className="h-[18px] w-[18px] shrink-0" aria-hidden />
            <span>
              Field masking is switched off for the workspace under{" "}
              <Link href={acPath.masking()} className="font-semibold underline">
                Global PII Masking
              </Link>
              : masked fields show in the clear, so there is nothing to unmask or count until it is back on.
            </span>
          </p>
        )}
        {maskingOn && atLimit && (
          <p className="flex gap-2 rounded-md bg-danger-bg px-3 py-2.5 text-[12.5px] leading-[1.5] text-danger">
            <Ban className="h-[18px] w-[18px] shrink-0" aria-hidden />
            <span>
              {first} has reached today&apos;s limit. Records already unmasked today still open; any other stays masked until midnight ({zone}), or until a higher limit is set for them.
            </span>
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5 border-t border-line/70 pt-3">
          {canEdit && (
            <button type="button" className={cn(acButton.secondary, "h-[30px] px-2.5 text-xs font-semibold")} onClick={() => setEditing(true)} disabled={busy}>
              <Pencil className="h-4 w-4" aria-hidden />
              {limit.own ? "Edit own daily limit" : "Set own daily limit"}
            </button>
          )}
          {canEdit && limit.own && (
            <button type="button" className={cn(acButton.secondary, "h-[30px] px-2.5 text-xs font-semibold")} onClick={backToInherited} disabled={busy}>
              <RotateCcw className="h-4 w-4" aria-hidden />
              {limit.inheritedFrom === "workspaceDefault" ? "Use the workspace default" : "Use the role's limit"}
            </button>
          )}
          <Link href={acPath.audit({ category: "pii", user: userId })} className={cn(acButton.secondary, "h-[30px] px-2.5 text-xs font-semibold")}>
            <History className="h-4 w-4" aria-hidden />
            View unmasking history
          </Link>
          {lockedWhy && (
            <span className="inline-flex items-center gap-1.5 text-xs text-subtle">
              <Lock className="h-3.5 w-3.5" aria-hidden />
              {lockedWhy}
            </span>
          )}
        </div>
      </div>

      {editing && <OwnLimitDialog userId={userId} name={name} limit={limit} ownEndsOn={ownLapsed ? null : ownEndsOn} inheritedWords={inheritedWords} viewerLimit={viewerLimit} today={today} onClose={() => setEditing(false)} />}
    </Panel>
  );
}

/** A daily limit for this person alone: a number of records, or none — with why, and optionally until when. */
function OwnLimitDialog({
  userId,
  name,
  limit,
  ownEndsOn,
  inheritedWords,
  viewerLimit,
  today,
  onClose,
}: {
  userId: string;
  name: string;
  limit: PersonFieldAccess["limit"];
  ownEndsOn: string | null;
  inheritedWords: string;
  viewerLimit: number | null | "any";
  today: string;
  onClose: () => void;
}) {
  const router = useRouter();
  // Start from their own limit, or from what applies to them now.
  const start0 = limit.own ? limit.own : { limited: limit.effective !== null, dailyLimit: limit.effective };
  const [limited, setLimited] = useState(start0.limited);
  const [value, setValue] = useState(start0.dailyLimit !== null ? String(start0.dailyLimit) : "");
  const [reason, setReason] = useState(limit.own?.reason ?? "");
  const [until, setUntil] = useState(ownEndsOn ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const first = name.split(" ")[0] ?? name;
  // Nobody gives a limit above their own; "no limit" is above every number.
  const noLimitBlocked = viewerLimit !== "any" && viewerLimit !== null;
  const ceiling = viewerLimit === "any" || viewerLimit === null ? null : viewerLimit;

  const save = () => {
    if (limited && !value) {
      setError("Enter how many records a day.");
      return;
    }
    setError(null);
    start(async () => {
      const r = await setPersonUnmaskLimit(userId, limited ? { limited: true, dailyLimit: Number(value) } : { limited: false }, { reason: reason.trim() || undefined, expiresAt: until || null });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(limited ? `${first}'s daily limit is ${value}.` : `${first} has no daily limit.`);
      router.refresh();
      onClose();
    });
  };

  return (
    <Dialog open onClose={() => !pending && onClose()} title={`Own daily limit · ${name}`}>
      <div className="flex flex-col gap-3.5 text-[13px]">
        <p className="leading-[1.5] text-muted">
          How many records — leads, contacts and companies together — {first} may unmask in a day. It replaces {inheritedWords} for them alone. Current: {perDay(limit.effective)}.
        </p>
        <label className="flex items-center gap-2 text-text">
          <input type="radio" name="limit-kind" checked={limited} onChange={() => setLimited(true)} className="h-4 w-4 accent-[var(--color-brand)]" />A number of records a day
        </label>
        {limited && (
          <Field label="Daily limit" htmlFor="own-limit" hint={ceiling !== null ? `Your own limit is ${ceiling} a day; you can't set a higher one.` : "A whole number, at least 1."}>
            <input
              id="own-limit"
              inputMode="numeric"
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
              placeholder="25"
              className={cn(acInput, "w-32")}
            />
          </Field>
        )}
        <label className={cn("flex items-center gap-2 text-text", noLimitBlocked && "opacity-50")} title={noLimitBlocked ? "You have a daily limit yourself, so you can't lift somebody else's." : undefined}>
          <input type="radio" name="limit-kind" checked={!limited} disabled={noLimitBlocked} onChange={() => setLimited(false)} className="h-4 w-4 accent-[var(--color-brand)]" />
          No limit
        </label>
        <Field label="Reason" htmlFor="own-limit-reason">
          <textarea id="own-limit-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Recorded in the permission history" className={cn(acInput, "h-auto w-full resize-y py-1.5")} />
        </Field>
        <Field label="Ends on (optional)" htmlFor="own-limit-until" hint={`Through the end of that day; after it ${first} goes back to ${inheritedWords}.`}>
          <input id="own-limit-until" type="date" min={today} value={until} onChange={(e) => setUntil(e.target.value)} className={cn(acInput, "w-48")} />
        </Field>
        {error && <p className="text-xs font-medium text-danger">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <button type="button" className={acButton.secondary} onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" className={acButton.primary} onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save limit"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
