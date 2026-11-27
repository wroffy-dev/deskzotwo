"use client";

import {
  BarChart3,
  BriefcaseBusiness,
  CircleDollarSign,
  ClipboardList,
  Contact,
  FileSpreadsheet,
  Headset,
  Laptop,
  Megaphone,
  Package,
  ReceiptText,
  Settings,
  ShoppingCart,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ModuleIcon } from "@/lib/staff/access-modules";
import { cn } from "@/lib/utils";
import type { Answer } from "./types";

const ICONS: Record<ModuleIcon, LucideIcon> = {
  crm: Contact,
  sales: ReceiptText,
  purchases: ShoppingCart,
  products: Package,
  projects: BriefcaseBusiness,
  finance: CircleDollarSign,
  support: Headset,
  marketing: Megaphone,
  hr: Users,
  performance: BarChart3,
  assets: Laptop,
  work: ClipboardList,
  data: FileSpreadsheet,
  settings: Settings,
};

/** A module's icon beside its row. */
export function ModuleGlyph({ icon, className }: { icon: ModuleIcon; className?: string }) {
  const Icon = ICONS[icon];
  return <Icon className={className} aria-hidden />;
}

/** How a cell is drawn, by what applies and where it comes from — the same four looks the legend shows. */
function pillLook(on: boolean, explicit: boolean): string {
  if (on && explicit) return "border-success bg-success";
  if (on) return "border-dashed border-success/70 bg-success/50";
  if (explicit) return "border-danger bg-danger/30";
  return "border-dashed border-line-strong bg-line";
}

/**
 * The matrix's cell: a small switch that says what applies (knob right = allowed) and where it comes
 * from (solid = set here, dashed = the default). Clicking it flips the answer; the accent ring marks a
 * change not saved yet, the amber dot a permission whose module is off for the company, and the
 * indigo dot an exception with an end date.
 */
export function AnswerPill({
  on,
  explicit,
  staged = false,
  blocked = false,
  temp = false,
  locked = false,
  label,
  title,
  onClick,
}: {
  on: boolean;
  explicit: boolean;
  staged?: boolean;
  blocked?: boolean;
  temp?: boolean;
  locked?: boolean;
  label: string;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      disabled={locked}
      onClick={onClick}
      className={cn(
        "relative inline-block h-[18px] w-8 rounded-full border-[1.5px] p-0 align-middle transition-colors",
        pillLook(on, explicit),
        staged && "ring-2 ring-brand/40",
        blocked && "opacity-50",
        locked ? "cursor-not-allowed" : "cursor-pointer",
      )}
    >
      <span className={cn("absolute top-px h-[13px] w-[13px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-[left] duration-150", on ? "left-[15px]" : "left-px")} />
      {blocked && <span className="absolute -right-1 -top-1 h-[9px] w-[9px] rounded-full border-[1.5px] border-surface bg-warning" />}
      {temp && <span className="absolute -bottom-1 -right-1 h-[9px] w-[9px] rounded-full border-[1.5px] border-surface bg-brand" />}
    </button>
  );
}

/**
 * The stored answer, all three of them: Default (nothing stored — the registry, or a person's role,
 * decides), Allow and Deny. The switch beside it only flips what applies; this is where an answer is
 * pinned to what the default already says, or put back to Default.
 */
export function TriState({
  value,
  defaultWord,
  name,
  disabled,
  title,
  onChange,
}: {
  value: Answer;
  /** "Default" on a role, "Role" on a person. */
  defaultWord: string;
  name: string;
  disabled?: boolean;
  title?: string;
  onChange: (next: Answer) => void;
}) {
  const options: { v: Answer; word: string; on: string }[] = [
    { v: "default", word: defaultWord, on: "bg-brand-subtle text-brand" },
    { v: "allow", word: "Allow", on: "bg-success-bg text-success" },
    { v: "deny", word: "Deny", on: "bg-danger-bg text-danger" },
  ];
  return (
    <span role="radiogroup" aria-label={name} title={title} className={cn("inline-flex overflow-hidden rounded-md border border-line-strong", disabled && "opacity-50")}>
      {options.map((o, i) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          disabled={disabled}
          onClick={() => onChange(o.v)}
          className={cn(
            "h-6 px-2 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed",
            i > 0 && "border-l border-line",
            value === o.v ? o.on : "bg-surface text-text/80 enabled:hover:bg-surface-sunken",
          )}
        >
          {o.word}
        </button>
      ))}
    </span>
  );
}

/** A column or row's bulk pair: "on / off", "all / none". */
export function BulkPair({ onWord, offWord, onTitle, offTitle, disabled, onPick }: { onWord: string; offWord: string; onTitle: string; offTitle: string; disabled?: boolean; onPick: (allow: boolean) => void }) {
  const base = "h-[18px] rounded-[3px] px-1.5 text-[10px] font-bold normal-case tracking-normal transition-colors disabled:pointer-events-none disabled:opacity-40";
  return (
    <span className="inline-flex gap-px">
      <button type="button" title={onTitle} disabled={disabled} onClick={() => onPick(true)} className={cn(base, "text-success hover:bg-success-bg")}>
        {onWord}
      </button>
      <button type="button" title={offTitle} disabled={disabled} onClick={() => onPick(false)} className={cn(base, "text-danger hover:bg-danger-bg")}>
        {offWord}
      </button>
    </span>
  );
}

/** The strip under the table that says what each look means. */
export function MatrixLegend({ person }: { person: boolean }) {
  const swatch = "inline-block h-3.5 w-6 rounded-full border-[1.5px]";
  const dot = "inline-block h-[9px] w-[9px] rounded-full";
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-line/70 px-3 py-2.5 text-[11px] text-muted">
      <span className="inline-flex items-center gap-1.5">
        <span className={cn(swatch, pillLook(true, true))} />
        {person ? "Allowed for them alone" : "Allowed here"}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cn(swatch, pillLook(true, false))} />
        {person ? "Allowed by their role" : "Allowed by default"}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cn(swatch, pillLook(false, true))} />
        Explicit DENY
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cn(swatch, pillLook(false, false))} />
        Not granted
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cn(dot, "bg-warning")} />
        Does nothing yet (module off or not in the plan)
      </span>
      {person && (
        <span className="inline-flex items-center gap-1.5">
          <span className={cn(dot, "bg-brand")} />
          Temporary exception
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-3.5 w-3.5 rounded-full ring-2 ring-brand/40" />
        Staged
      </span>
    </div>
  );
}
