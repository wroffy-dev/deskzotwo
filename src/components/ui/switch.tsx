"use client";

import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * The app's on/off switch, drawn as Apple draws it (owner, 29 Oct 2026): a green track when on, a soft
 * grey one when off, and a white knob with a light shadow that slides across.
 *
 * One component rather than one per screen: the hand-made ones placed their knob with `absolute` and no
 * `left`, so it started from the middle of the button (a button centres what it holds) and ran off the
 * end of the track when switched on. Here the knob sits in the track's own flow, from its left edge,
 * and moves by exactly the room the track leaves it.
 *
 * Everything else a button takes (`aria-labelledby`, `aria-describedby`, `title`, `aria-busy`) passes
 * through, and `aria-label` names it where no visible label does.
 */
export function Switch({
  checked,
  onChange,
  size = "md",
  className,
  disabled,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "type" | "role" | "aria-checked"> & {
  checked: boolean;
  onChange?: (next: boolean) => void;
  /** "md" for a settings row, "sm" for a dense list or panel. */
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      {...rest}
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors duration-200 ease-out",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-5 w-9" : "h-6 w-11",
        checked ? "bg-switch-on" : "bg-switch-off",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none block rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.18),0_0_0_0.5px_rgba(0,0,0,0.06)]",
          "transition-transform duration-200 ease-[cubic-bezier(0.34,1.36,0.64,1)]",
          size === "sm" ? "h-4 w-4" : "h-5 w-5",
          checked ? (size === "sm" ? "translate-x-4" : "translate-x-5") : "translate-x-0",
        )}
      />
    </button>
  );
}
