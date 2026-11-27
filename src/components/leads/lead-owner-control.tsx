"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { bulkUpdateLeads } from "@/actions/lead";
import type { LeadOwnership } from "@/actions/lead-owner";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/search-select";
import { useClock } from "@/components/time/clock-provider";

/**
 * Reassigning a lead from the lead itself, and who has had it (owner, 26 Oct 2026). Offered only to whoever
 * the reassign rules let change it (src/actions/lead-owner.ts); the action asks again. `inline` (owner, 20 Nov 2026 —
 * "assign or reassign deal owner from top also"): beside "Deal owner" in the lead's header — Assign or Reassign, the
 * picker opening in the line, without the earlier holders (the panel below lists them).
 */
export function LeadOwnerControl({ leadId, ownerId, ownership, inline = false }: { leadId: string; ownerId: string | null; ownership: LeadOwnership; inline?: boolean }) {
  const router = useRouter();
  const clock = useClock();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(ownerId ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await bulkUpdateLeads({ leadIds: [leadId], ownerUserId: to || "unassign" }).catch(() => ({ ok: false as const, error: "Couldn't reassign it just now — try again." }));
      if (!result.ok) return setError(result.error);
      setOpen(false);
      router.refresh();
    });
  }

  // The earlier holders, newest first, after the current one.
  const before = inline ? [] : ownership.history.filter((h) => h.endedAt);
  if (inline && !ownership.mayChange) return null;
  const Wrap = inline ? "span" : "div";
  return (
    <Wrap className={inline ? "inline-flex flex-wrap items-center gap-2 align-middle" : "mt-1 space-y-1 text-right"}>
      {ownership.mayChange && !open && (
        <button type="button" onClick={() => setOpen(true)} className={`${inline ? "ml-1.5" : ""} text-xs text-brand hover:underline`}>
          {inline && !ownerId ? "Assign" : "Reassign"}
        </button>
      )}
      {open && (
        <span className={`flex flex-wrap items-center gap-2 ${inline ? "ml-1.5" : "justify-end"}`}>
          <SearchSelect aria-label="Give the lead to" searchPlaceholder="Search people…" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-48">
            {ownership.mayUnassign && <option value="">Nobody — unassigned</option>}
            {ownership.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SearchSelect>
          <Button size="sm" disabled={pending || (to === (ownerId ?? "")) || (!to && !ownership.mayUnassign)} onClick={save}>
            {pending ? "Saving…" : !ownerId ? "Assign" : "Reassign"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </span>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      {before.length > 0 && (
        <p className="text-[11px] text-subtle">
          Before:{" "}
          {before
            .map(
              (h) =>
                `${h.name ?? "nobody"} (${clock.dayMonth(h.assignedAt)}${h.timedOut ? ", no response" : h.respondedAt ? "" : ", untouched"})`,
            )
            .join(" ← ")}
        </p>
      )}
    </Wrap>
  );
}
