import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { AC_ROOT } from "@/lib/access-control/nav";
import { cn } from "@/lib/utils";

/**
 * The pieces every Access Control screen is built from, drawn once so the screens agree: the
 * breadcrumb and title, the bordered panel and its header, the compact table, the small pills.
 *
 * Sizes are the design's (13px body, 8px panel radius, 32px controls); colours are Deskzo's tokens,
 * so the area follows dark mode and a workspace's own brand colour like the rest of the app.
 */

/** Settings › Access Control › {crumb}, then the title row with its actions. */
export function AcPage({
  crumb,
  title,
  description,
  actions,
  children,
}: {
  crumb: string;
  title?: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="animate-fade-rise flex min-w-0 flex-col">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-muted">
        <Link href="/settings" className="hover:text-text">
          Settings
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-subtle" aria-hidden />
        <Link href={AC_ROOT} className="hover:text-text">
          Access Control
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-subtle" aria-hidden />
        <span className="font-medium text-text">{crumb}</span>
      </nav>
      {title && (
        <div className="flex flex-wrap items-start gap-4 pb-4 pt-2">
          <div className="min-w-[240px] flex-1">
            <h1 className="text-xl font-bold leading-[1.3] tracking-[-0.015em] text-text">{title}</h1>
            {description && <p className="mt-[3px] text-[13px] text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("flex min-w-0 flex-1 flex-col", !title && "pt-3")}>{children}</div>
    </div>
  );
}

/**
 * A bordered white panel — the design's card: 8px radius, hairline border, no shadow.
 *
 * Positioned, so anything absolutely placed inside it (a visually hidden checkbox in a wide table's
 * far column) belongs to the panel and scrolls or clips with it. Unpositioned, such an element sits
 * outside the panel's scroll box and widens the whole page on a phone.
 */
export function Panel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("relative overflow-hidden rounded-lg border border-line bg-surface", className)} {...props} />;
}

/** A panel's title strip: title, anything beside it, then the action pushed right. */
export function PanelHeader({ title, meta, action, className }: { title: React.ReactNode; meta?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 border-b border-line px-4 py-3", className)}>
      <span className="font-semibold text-text">{title}</span>
      {meta}
      <div className="flex-1" />
      {action}
    </div>
  );
}

/** The quiet text link a panel header ends with ("View audit log", "Manage"). */
export const panelLinkClass = "text-xs font-semibold text-brand hover:underline";

/** Compact enterprise table cells. */
export const thClass = "whitespace-nowrap border-b border-line bg-surface-sunken/60 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted";
export const tdClass = "border-b border-line/70 px-3 py-[9px] align-middle";
export const rowHoverClass = "transition-colors hover:bg-surface-sunken/60";

/** 32px controls, as the design draws them. */
export const acButton = {
  primary: "inline-flex h-8 items-center gap-1.5 rounded-md border border-brand bg-brand px-3 text-[13px] font-semibold text-brand-contrast transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-45",
  secondary: "inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-[13px] font-medium text-text transition-colors hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-45",
  danger: "inline-flex h-8 items-center gap-1.5 rounded-md border border-danger bg-danger px-3 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-45",
  icon: "inline-flex h-8 w-8 items-center justify-center rounded-md border border-line-strong bg-surface text-text/80 transition-colors hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-45",
  ghostIcon: "inline-flex h-8 w-8 items-center justify-center rounded-md text-text/80 transition-colors hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-45",
};
export const acInput = "h-8 rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-text outline-none placeholder:text-subtle focus:border-brand focus:ring-brand";

export type PillTone = "neutral" | "brand" | "green" | "amber" | "red" | "blue";
const PILL: Record<PillTone, string> = {
  neutral: "bg-surface-sunken text-muted",
  brand: "bg-brand-subtle text-brand",
  green: "bg-success-bg text-success",
  amber: "bg-warning-bg text-warning",
  red: "bg-danger-bg text-danger",
  blue: "bg-info-bg text-info",
};

/** A 20px status pill: "System", "Custom", "Active", "At limit". */
export function Pill({ tone = "neutral", className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: PillTone }) {
  return <span className={cn("inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-semibold", PILL[tone], className)} {...props} />;
}

/** A permission answer in mono capitals: ALLOW, DENY, DEFAULT, OWN, TEAM… */
export function StateTag({ tone = "neutral", className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: PillTone }) {
  return <span className={cn("inline-flex h-5 items-center rounded px-1.5 font-mono text-[11px] font-medium uppercase", PILL[tone], className)} {...props} />;
}

/** Initials on a coloured disc; the colour is picked from the name so a person keeps theirs everywhere. */
const AVATAR_TONES = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5", "bg-chart-6"];
export function acInitials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((p) => p[0] ?? "")
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}
export function acToneOf(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}
export function InitialsAvatar({ name, seed, size = 28, className }: { name: string; seed?: string; size?: number; className?: string }) {
  return (
    <span
      title={name}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) }}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white", acToneOf(seed ?? name), className)}
    >
      {acInitials(name)}
    </span>
  );
}

/** A usage bar: 8px track, the fill coloured by how full it is unless told otherwise. */
export function Meter({ value, max, tone, className }: { value: number; max: number; tone?: "brand" | "green" | "amber" | "red"; className?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const t = tone ?? (pct >= 100 ? "red" : pct >= 70 ? "amber" : "brand");
  const fill = t === "red" ? "bg-danger" : t === "amber" ? "bg-warning" : t === "green" ? "bg-success" : "bg-brand";
  return (
    <span className={cn("block h-2 overflow-hidden rounded bg-surface-sunken", className)}>
      <span className={cn("block h-full rounded", fill)} style={{ width: `${pct}%` }} />
    </span>
  );
}

/** An empty panel's message. */
export function EmptyNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("px-4 py-6 text-center text-[13px] text-subtle", className)}>{children}</p>;
}

/** The amber "why it works this way" note the design scatters about; shown inline here, always on. */
export function HintNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("rounded-md bg-warning-bg px-3 py-2 text-xs leading-[1.5] text-warning", className)}>{children}</p>;
}
