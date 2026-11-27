"use client";

import { EXPORT_MODES, type ExportMode } from "@/lib/authz/field-policy";
import { cn } from "@/lib/utils";
import { EXPORT_HELP } from "@/components/access-control/fields/model";

/**
 * The matrix's switch, as the design draws it: a 32×18 track whose border says where the answer comes
 * from — solid where it is set on this role or employee, dashed where it is inherited — and a ring while
 * the change is staged and not yet saved.
 *
 * `tone` is what "on" means: View and Reveal grant something (green; View set off here is red, an
 * explicit restriction), a Mask switch narrows it (amber).
 */
export function PolicySwitch({
  on,
  own,
  staged = false,
  tone,
  disabled = false,
  label,
  title,
  onChange,
  demo = false,
}: {
  on: boolean;
  own: boolean;
  staged?: boolean;
  tone: "view" | "mask" | "reveal";
  disabled?: boolean;
  label: string;
  title?: string;
  onChange?: (next: boolean) => void;
  /** A legend's sample: drawn, not pressed. */
  demo?: boolean;
}) {
  const track = on
    ? tone === "mask"
      ? own
        ? "border-warning bg-warning"
        : "border-dashed border-warning bg-warning/55"
      : own
        ? "border-success bg-success"
        : "border-dashed border-success bg-success/55"
    : own
      ? tone === "view"
        ? "border-danger bg-danger/30"
        : "border-line-strong bg-line-strong"
      : "border-dashed border-line-strong bg-line";
  const className = cn(
    "relative inline-block h-[18px] w-8 shrink-0 rounded-full border-[1.5px] align-middle transition-colors",
    track,
    staged && "ring-2 ring-brand/40",
    demo ? "pointer-events-none" : disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
  );
  const knob = <span aria-hidden className={cn("absolute top-px h-[13px] w-[13px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-[left] duration-150", on ? "left-[15px]" : "left-px")} />;
  if (demo) return <span className={className}>{knob}</span>;
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={title ?? label} disabled={disabled} onClick={() => onChange?.(!on)} className={className}>
      {knob}
    </button>
  );
}

const SEGMENT: Record<ExportMode, { text: string; on: string }> = {
  none: { text: "None", on: "bg-danger-bg text-danger" },
  masked: { text: "Mask", on: "bg-warning-bg text-warning" },
  clear: { text: "Clear", on: "bg-success-bg text-success" },
};

/**
 * How a field is exported: left out, masked, or in the clear. None of the three chosen is the column's
 * default — "as the list shows it" — so pressing the chosen one again goes back to that.
 */
export function ExportControl({
  value,
  staged = false,
  disabled = false,
  label,
  onChange,
}: {
  value: ExportMode | null;
  staged?: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: ExportMode | null) => void;
}) {
  return (
    <span
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex h-[22px] overflow-hidden rounded-md border align-middle",
        value === null ? "border-dashed border-line-strong" : "border-line-strong",
        staged && "ring-2 ring-brand/40",
        disabled && "opacity-40",
      )}
    >
      {EXPORT_MODES.map((mode, i) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          disabled={disabled}
          title={value === mode ? `${EXPORT_HELP[mode]} Press again to export it as the list shows it.` : EXPORT_HELP[mode]}
          onClick={() => onChange(value === mode ? null : mode)}
          className={cn(
            "px-[7px] text-[10.5px] font-semibold transition-colors",
            i > 0 && "border-l border-line-strong",
            value === mode ? SEGMENT[mode].on : "bg-surface text-subtle hover:bg-surface-sunken hover:text-text",
            disabled ? "cursor-not-allowed" : "cursor-pointer",
          )}
        >
          {SEGMENT[mode].text}
        </button>
      ))}
    </span>
  );
}
