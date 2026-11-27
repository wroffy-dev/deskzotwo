import Link from "next/link";
import type { UnmaskQuotaSummary } from "@/actions/access-control-sensitive";
import { acPath } from "@/lib/access-control/nav";
import { cn } from "@/lib/utils";

/**
 * The pieces the three Sensitive Data screens share: the master switch's state as a pill, the four
 * quota tiles, and the words a limit is said in — so "25 a day" reads the same on each of them.
 */

/** A limit in words: "25 a day", "No limit". */
export function limitText(limit: number | null): string {
  return limit === null ? "No limit" : `${limit} a day`;
}

/** The Unmasking Limits screen, opened on one usage status. */
export function limitsHref(status?: "at" | "near" | "access" | "unlimited"): string {
  return status ? `${acPath.limits()}?status=${status}` : acPath.limits();
}

/** "Masking on · 3 record types" in green, "Masking off" in red — the design's state pill. */
export function MaskingStatePill({ on, recordTypes }: { on: boolean; recordTypes: number }) {
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11.5px] font-semibold", on ? "bg-success-bg text-success" : "bg-danger-bg text-danger")}>
      <span className={cn("h-[7px] w-[7px] rounded-full", on ? "bg-success" : "bg-danger")} aria-hidden />
      {on ? `Masking on · ${recordTypes} record types` : "Masking off"}
    </span>
  );
}

/** Today's unmasking at a glance; each tile opens the screen that explains its number. */
export function QuotaCards({ summary, className }: { summary: UnmaskQuotaSummary; className?: string }) {
  const cards: { value: string; label: string; href: string; tone?: "warn" | "danger" }[] = [
    { value: String(summary.unmaskedToday), label: "records unmasked today", href: acPath.audit({ category: "pii" }), tone: summary.unmaskedToday ? "warn" : undefined },
    { value: String(summary.atLimit), label: "employees at limit", href: limitsHref("at"), tone: summary.atLimit ? "danger" : undefined },
    { value: String(summary.canUnmask), label: "can unmask", href: limitsHref("access") },
    { value: summary.defaultLimit === null ? "None" : String(summary.defaultLimit), label: "default limit a day", href: limitsHref() },
  ];
  return (
    <div className={cn("grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] items-stretch gap-2", className)}>
      {cards.map((k) => (
        <Link key={k.label} href={k.href} className="rounded-md bg-surface-sunken p-2.5 text-left transition-colors hover:bg-line/60">
          <div className={cn("text-lg font-bold leading-[1.3] tracking-[-0.02em]", k.tone === "danger" ? "text-danger" : k.tone === "warn" ? "text-warning" : "text-text")}>{k.value}</div>
          <div className="text-[11px] leading-[1.35] text-muted">{k.label}</div>
        </Link>
      ))}
    </div>
  );
}

/** A number tile as the design draws its KPI rows: label, 24px value, hint. */
export function KpiTile({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint: string; tone?: "warn" | "danger" | "success" }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={cn("mt-0.5 text-2xl font-bold tracking-[-0.02em]", tone === "danger" ? "text-danger" : tone === "warn" ? "text-warning" : tone === "success" ? "text-success" : "text-text")}>{value}</div>
      <div className="text-[11.5px] text-subtle">{hint}</div>
    </div>
  );
}
