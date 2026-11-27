"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setPersonLeadLimit, setRoleLeadLimit, type PersonLeadLimitView, type RoleLeadLimitView } from "@/actions/lead-limits";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * Lead limits on a role and on one person (owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6.5): how many open
 * leads somebody may hold, and how many may be given to them a day and a month. Drawn the way the daily unmask limit
 * is (src/components/settings/access/field-policy-editor.tsx `RoleLimit`, src/components/settings/people/
 * person-permissions-panel.tsx `UnmaskLimitPanel`): a role's on Settings › Lead assignment, a person's on their Access Control
 * profile beside the unmasking limit. The actions are
 * src/actions/lead-limits.ts; what the numbers do is src/lib/leads/limits.ts.
 *
 * Blank is no limit on that count. Nothing set anywhere is no limit at all — limits are opt-in.
 */

type Numbers = { maxOpen: number | null; maxPerDay: number | null; maxPerMonth: number | null };
type Texts = { maxOpen: string; maxPerDay: string; maxPerMonth: string };

const FIELDS = [
  { key: "maxOpen", label: "Open leads at once", hint: "Leads they own that aren't won, lost or disqualified." },
  { key: "maxPerDay", label: "Leads given a day", hint: "From midnight, on the workspace's clock." },
  { key: "maxPerMonth", label: "Leads given a month", hint: "From the 1st." },
] as const;

const toTexts = (n: Numbers | null): Texts => ({
  maxOpen: n?.maxOpen == null ? "" : String(n.maxOpen),
  maxPerDay: n?.maxPerDay == null ? "" : String(n.maxPerDay),
  maxPerMonth: n?.maxPerMonth == null ? "" : String(n.maxPerMonth),
});
const blank = (t: Texts) => !t.maxOpen && !t.maxPerDay && !t.maxPerMonth;

/** "20 open · 10 a day · 200 a month", or "No limit". */
export function leadLimitWords(n: Numbers | null): string {
  if (!n) return "No limit";
  const parts = [n.maxOpen !== null && `${n.maxOpen} open`, n.maxPerDay !== null && `${n.maxPerDay} a day`, n.maxPerMonth !== null && `${n.maxPerMonth} a month`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No limit";
}

function NumberFields({ idPrefix, value, onChange, disabled }: { idPrefix: string; value: Texts; onChange: (next: Texts) => void; disabled: boolean }) {
  return (
    <>
      {FIELDS.map((f) => (
        <div key={f.key} className="space-y-1">
          <Label htmlFor={`${idPrefix}-${f.key}`} className="text-xs">
            {f.label}
          </Label>
          <Input
            id={`${idPrefix}-${f.key}`}
            inputMode="numeric"
            value={value[f.key]}
            disabled={disabled}
            placeholder="No limit"
            onChange={(e) => onChange({ ...value, [f.key]: e.target.value.replace(/\D/g, "") })}
            className="h-8 w-32 text-sm"
            aria-describedby={`${idPrefix}-${f.key}-hint`}
          />
          <p id={`${idPrefix}-${f.key}-hint`} className="max-w-[9rem] text-[11px] text-subtle">
            {f.hint}
          </p>
        </div>
      ))}
    </>
  );
}

// ─── A role ───────────────────────────────────────────────────────────────────────────────────────

export function RoleLeadLimit({ role, data, title = "Lead limits" }: { role: string; data: RoleLeadLimitView; title?: string }) {
  const router = useRouter();
  const [value, setValue] = useState<Texts>(toTexts(data.stored));
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const result = await setRoleLeadLimit(role, blank(value) ? null : value);
      setNotice(result.ok ? { tone: "success", text: "Saved." } : { tone: "error", text: result.error });
      if (result.ok) router.refresh();
    });
  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold text-text">{title}</h3>
        <p className="mt-0.5 text-xs text-muted">
          How many open leads each person in this role may hold, and how many may be given to them a day and a month — by hand, by the assignment rules, by a
          form or an import. Somebody at a limit is passed over by the assignment rules; a lead nobody can take is kept unassigned and the people who hand out
          leads are told. Leave a box blank for no limit on that count; all blank is no limit at all.
          {data.overridden > 0 && ` ${data.overridden} ${data.overridden === 1 ? "person in this role has" : "people in this role have"} a limit of their own, which wins.`}
        </p>
      </CardHeader>
      <CardContent className="flex flex-wrap items-start gap-3">
        <NumberFields idPrefix="role-lead-limit" value={value} onChange={setValue} disabled={!data.editable} />
        {data.editable && (
          <div className="flex gap-2 pt-5">
            <Button size="sm" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save limits"}
            </Button>
            {!blank(value) && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setValue(toTexts(null))}>
                Clear
              </Button>
            )}
          </div>
        )}
        {!data.editable && data.why && <p className="w-full text-xs text-subtle">{data.why}</p>}
        {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      </CardContent>
    </Card>
  );
}

// ─── One person ───────────────────────────────────────────────────────────────────────────────────

/** Their own limits, "no limit" for them, or their role's. */
type Choice = "role" | "own" | "none";

/**
 * One person's lead limits, saved with their own button, with a reason and, if they should end, an end date — the end
 * date returns them to their role's limits that day.
 */
export function PersonLeadLimitPanel({ userId, name, data, canEdit }: { userId: string; name: string; data: PersonLeadLimitView; canEdit: boolean }) {
  const router = useRouter();
  const saved = data.own && !data.own.expired ? data.own : null;
  const savedChoice: Choice = !saved ? "role" : saved.limited ? "own" : "none";
  const savedTexts = toTexts(saved && saved.limited ? saved : data.role);
  const [choice, setChoice] = useState<Choice>(savedChoice);
  const [value, setValue] = useState<Texts>(savedTexts);
  const [reason, setReason] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = choice !== savedChoice || (choice === "own" && JSON.stringify(value) !== JSON.stringify(savedTexts));
  const save = () =>
    start(async () => {
      const r = await setPersonLeadLimit(userId, choice === "role" ? null : choice === "none" ? { limited: false } : { limited: true, ...value }, {
        reason,
        expiresAt: choice === "role" ? null : endsOn || null,
      });
      setNotice(r.ok ? { tone: "success", text: "Saved." } : { tone: "error", text: r.error });
      if (r.ok) {
        setReason("");
        setEndsOn("");
        router.refresh();
      }
    });
  const discard = () => {
    setChoice(savedChoice);
    setValue(savedTexts);
    setNotice(null);
  };

  const u = data.usage;
  const of = (used: number, max: number | null) => (max === null ? `${used}` : `${used} / ${max}`);
  return (
    <Card className="@container border-brand/30 p-4">
      <h3 className="text-sm font-semibold text-text">Lead limits</h3>
      <p className="mt-0.5 text-xs text-muted">
        How many open leads {name} may hold, and how many may be given to them a day and a month. At a limit they are passed over by the assignment rules, and
        nobody can give them another by hand.
      </p>
      <div className="mt-3 space-y-1">
        <Label htmlFor="person-lead-limit-choice" className="text-xs">
          Limits
        </Label>
        <Select id="person-lead-limit-choice" value={choice} disabled={!canEdit} onChange={(e) => setChoice(e.target.value as Choice)} className="h-9 min-w-[16rem] text-sm">
          <option value="role">Use the role&apos;s ({data.roleName}: {leadLimitWords(data.role)})</option>
          <option value="own">Limits of their own</option>
          <option value="none">No limit for them</option>
        </Select>
      </div>
      {choice === "own" && (
        <div className="mt-3 flex flex-wrap items-start gap-3">
          <NumberFields idPrefix="person-lead-limit" value={value} onChange={setValue} disabled={!canEdit} />
        </div>
      )}
      <p className="mt-3 text-[11px] text-subtle">
        Now: {of(u.open, data.effective.maxOpen)} open · {of(u.today, data.effective.maxPerDay)} given today · {of(u.thisMonth, data.effective.maxPerMonth)} given this month
        {" "}({data.zone})
      </p>
      <p className="text-[11px] text-subtle">{data.why}</p>
      {data.own?.expired && <p className="text-[11px] text-subtle">Their own limits ended; they follow their role again.</p>}
      {saved?.grantedBy && <p className="text-[11px] text-subtle">Set by {saved.grantedBy}.</p>}
      {dirty && canEdit && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="person-lead-limit-reason" className="text-xs">
              Reason
            </Label>
            <Input id="person-lead-limit-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className="h-8 w-60 text-sm" placeholder="Why (optional)" />
          </div>
          {choice !== "role" && (
            <div className="space-y-1">
              <Label htmlFor="person-lead-limit-ends" className="text-xs">
                Ends on
              </Label>
              <Input id="person-lead-limit-ends" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} className="h-8 w-40 text-sm" />
            </div>
          )}
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save limits"}
          </Button>
          <Button size="sm" variant="ghost" onClick={discard} disabled={pending}>
            Discard
          </Button>
        </div>
      )}
      {notice && (
        <div className="mt-2">
          <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>
        </div>
      )}
    </Card>
  );
}
