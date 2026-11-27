import Link from "next/link";
import type { GuestAllowance } from "@/lib/connect/activity";

/**
 * The plan's guests (owner, 20 Nov 2026 — Deskzo Connect phase 4): how many count against how many the plan allows — 10
 * a unit of the add-on, 3 on Deskzo One — or, where Connect isn't in the plan, how to add it.
 */
export function GuestAllowanceLine({ allowance, compact = false }: { allowance: GuestAllowance; compact?: boolean }) {
  const { limit, used } = allowance;
  if (limit === null) return compact ? null : <p className="text-xs text-subtle">{used} active guest{used === 1 ? "" : "s"} · no limit on your plan.</p>;
  if (limit === 0) {
    return (
      <p className="rounded-base bg-info-bg px-3 py-2 text-sm text-info">
        Deskzo Connect isn&apos;t in your plan yet — ₹999 a month for 10 guests, who never take a seat.{" "}
        <Link href="/settings/billing" className="font-medium underline">
          Add it under Billing
        </Link>
      </p>
    );
  }
  const full = used >= limit;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className={full ? "font-medium text-warning" : "text-muted"}>
          {used} of {limit} guests in your plan
        </span>
        <Link href="/settings/billing" className="text-brand hover:underline">
          {full ? "Add 10 more" : "Billing"}
        </Link>
      </div>
      {!compact && (
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
          <div className={full ? "h-full bg-warning" : "h-full bg-brand"} style={{ width: `${Math.min(100, Math.round((used / limit) * 100))}%` }} />
        </div>
      )}
    </div>
  );
}
