"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { bulkUpdateUsers, type BulkUserOp, type BulkUserResult } from "@/actions/user";
import { BulkBar } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { confirmAction } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";

/** What the bulk bar needs to offer: the same choices the single edit offers (owner, 31 Oct 2026). */
export type BulkChoices = {
  roles: { key: string; name: string }[];
  departments: { id: string; name: string }[];
  /** Active people, for "Set manager". */
  people: { id: string; name: string }[];
};

const OPS: { key: BulkUserOp; label: string; done: string }[] = [
  { key: "role", label: "Change role", done: "role changed" },
  { key: "activate", label: "Mark active", done: "marked active" },
  { key: "deactivate", label: "Mark inactive", done: "marked inactive" },
  { key: "department", label: "Set department", done: "department set" },
  { key: "manager", label: "Set manager", done: "manager set" },
  { key: "resendSetup", label: "Resend setup email", done: "setup email sent" },
];

/**
 * The bar over the Users list once somebody is ticked — admins only (owner, 31 Oct 2026). Every change
 * goes through `bulkUpdateUsers`, which applies the single action's rules to each person and answers per
 * person; the refusals stay listed here (name — reason) until the next change or Clear.
 */
export function UsersBulkBar({
  ids,
  selected,
  onClear,
  choices,
}: {
  ids: string[];
  /** The ticked rows, for what applies to them ("Resend setup email" only to those not set up yet). */
  selected: { id: string; active: boolean; setupPending: boolean }[];
  onClear: () => void;
  choices: BulkChoices;
}) {
  const router = useRouter();
  const [op, setOp] = useState<BulkUserOp | "">("");
  const [value, setValue] = useState("");
  const [result, setResult] = useState<{ op: BulkUserOp; data: BulkUserResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const awaiting = selected.filter((s) => s.active && s.setupPending).map((s) => s.id);
  const needsValue = op === "role";
  const ready = op !== "" && (!needsValue || value !== "") && (op !== "resendSetup" || awaiting.length > 0);

  const apply = () => {
    if (!op) return;
    start(async () => {
      setError(null);
      setResult(null);
      const target = op === "resendSetup" ? awaiting : ids;
      if (op === "deactivate") {
        const yes = await confirmAction({
          message: `Mark ${target.length} ${target.length === 1 ? "person" : "people"} inactive? They're signed out straight away and their seats are freed. Nothing they own is deleted.`,
          confirmLabel: "Mark inactive",
        });
        if (!yes) return;
      }
      const res = await bulkUpdateUsers({ ids: target, op, value: value || null });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const { done, refused, unchanged } = res.data;
      const label = OPS.find((o) => o.key === op)?.done ?? "changed";
      const parts = [`${done.length} ${label}`];
      if (unchanged.length) parts.push(`${unchanged.length} already so`);
      if (refused.length) parts.push(`${refused.length} refused`);
      (refused.length && !done.length ? toast.error : toast.success)(parts.join(" · "));
      setResult({ op, data: res.data });
      if (done.length) {
        onClear();
        router.refresh();
      }
    });
  };

  const notes = result?.data.done.filter((d) => d.note) ?? [];

  return (
    <>
      <BulkBar count={ids.length} onClear={onClear} error={error}>
        <Select
          value={op}
          onChange={(e) => {
            setOp(e.target.value as BulkUserOp | "");
            setValue("");
          }}
          aria-label="Change for the selected people"
          className="h-8 min-w-0 pl-2.5 pr-7 text-xs"
        >
          <option value="">Choose a change…</option>
          {OPS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.key === "resendSetup" ? `${o.label} (${awaiting.length})` : o.label}
            </option>
          ))}
        </Select>
        {op === "role" && (
          <Select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Role to give them" className="h-8 min-w-0 pl-2.5 pr-7 text-xs">
            <option value="">Choose a role…</option>
            {choices.roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </Select>
        )}
        {op === "department" && (
          <Select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Department to set" className="h-8 min-w-0 pl-2.5 pr-7 text-xs">
            <option value="">No department</option>
            {choices.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        )}
        {op === "manager" && (
          <Select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Reporting manager to set" className="h-8 min-w-0 pl-2.5 pr-7 text-xs">
            <option value="">No manager</option>
            {choices.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        <Button type="button" size="sm" onClick={apply} disabled={!ready || pending}>
          {pending ? "Applying…" : "Apply"}
        </Button>
        {op === "resendSetup" && awaiting.length === 0 && <p className="w-full text-xs text-subtle">Everybody ticked has set up their account, or is switched off.</p>}
      </BulkBar>
      {result && (result.data.refused.length > 0 || notes.length > 0) && (
        <div role="status" className="mb-3 rounded-lg border border-line bg-surface px-4 py-3 text-xs">
          {result.data.refused.length > 0 && (
            <>
              <p className="font-medium text-text">Refused</p>
              <ul className="mt-1 space-y-0.5 text-muted">
                {result.data.refused.map((r) => (
                  <li key={r.id}>
                    <span className="text-text">{r.name}</span> — {r.reason}
                  </li>
                ))}
              </ul>
              {result.op === "activate" && result.data.seatsLeft !== undefined && result.data.seatsLeft !== null && (
                <p className="mt-1 text-muted">
                  {result.data.seatsLeft} {result.data.seatsLeft === 1 ? "seat" : "seats"} left on the plan.
                </p>
              )}
            </>
          )}
          {notes.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-muted">
              {notes.map((n) => (
                <li key={n.id}>
                  <span className="text-text">{n.name}</span> — {n.note}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="mt-2 text-muted hover:text-text" onClick={() => setResult(null)}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
