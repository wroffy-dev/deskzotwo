"use client";

import { useEffect, useMemo } from "react";
import type { AccessLevel } from "@prisma/client";
import { Lock } from "lucide-react";
import { AnchoredPopover, insideAnchoredPopover } from "@/components/ui/anchored-popover";
import { LEVEL_WORDS } from "@/lib/authz/level-order";
import { CHIP_LABEL, LEVEL_ORDER, levelMeans } from "@/components/access-control/scope/reach";
import { cn } from "@/lib/utils";

/**
 * The design's reach chip and the menu behind it: a 26px chip coloured by how far it reaches, dashed
 * where nothing is set and the answer comes from underneath (a role's permissions, a person's role),
 * ringed while a change to it is staged. A click moves it on; the menu picks an answer directly.
 */

/** A record level, or a permission's plain answer. */
export type ChipTone = AccessLevel | "ALLOW" | "DENY";

const TONE: Record<ChipTone, string> = {
  NONE: "border-line-strong bg-surface text-subtle",
  OWN: "border-success/40 bg-success-bg text-success",
  TEAM: "border-info/40 bg-info-bg text-info",
  BRANCH: "border-line-strong bg-surface-sunken text-text",
  FOLLOW: "border-warning/40 bg-warning-bg text-warning",
  ALL: "border-brand/40 bg-brand-subtle text-brand",
  ALLOW: "border-success/40 bg-success-bg text-success",
  DENY: "border-danger/40 bg-danger-bg text-danger",
};

export function Chip({
  tone,
  label,
  dashed,
  staged,
  dimmed,
  locked,
  title,
  ariaLabel,
  onClick,
  onMenu,
  className,
}: {
  tone: ChipTone;
  label: string;
  /** Nothing is set here: the answer comes from underneath. */
  dashed?: boolean;
  staged?: boolean;
  dimmed?: boolean;
  /** Not this viewer's to change; the title says why. */
  locked?: boolean;
  title?: string;
  ariaLabel?: string;
  onClick?: () => void;
  /** Right-click (or the keyboard's menu key): pick an answer directly. */
  onMenu?: (anchor: HTMLElement) => void;
  className?: string;
}) {
  const interactive = !locked && (onClick || onMenu);
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      aria-disabled={locked || undefined}
      onClick={locked ? undefined : onClick}
      onContextMenu={(e) => {
        if (!onMenu) return;
        e.preventDefault();
        if (!locked) onMenu(e.currentTarget);
      }}
      className={cn(
        "inline-flex h-[26px] min-w-[66px] items-center justify-center whitespace-nowrap rounded-md px-2.5 text-xs font-semibold transition-shadow",
        TONE[tone],
        dashed ? "border-[1.5px] border-dashed" : "border",
        staged && "ring-2 ring-brand/40",
        dimmed && "opacity-45",
        interactive ? "cursor-pointer hover:brightness-[0.97]" : locked ? "cursor-not-allowed" : "cursor-default",
        className,
      )}
    >
      {label}
    </button>
  );
}

/** A chip for a record level, in the chip's short words. */
export function LevelChip({ level, ...rest }: { level: AccessLevel } & Omit<React.ComponentProps<typeof Chip>, "tone" | "label">) {
  return <Chip tone={level} label={CHIP_LABEL[level]} {...rest} />;
}

/** A level shown, not changed: inside a button, a table of what is stored, a tile's corner. */
export function LevelTag({ level, dashed, staged, className }: { level: AccessLevel; dashed?: boolean; staged?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] min-w-[56px] items-center justify-center whitespace-nowrap rounded-md px-2 text-[11.5px] font-semibold",
        TONE[level],
        dashed ? "border-[1.5px] border-dashed" : "border",
        staged && "ring-2 ring-brand/40",
        className,
      )}
    >
      {CHIP_LABEL[level]}
    </span>
  );
}

/** The legend beside the subject: every level, narrow to wide, then what dashed means. */
export function ReachLegend({ inheritedMeans, extra }: { inheritedMeans: string; extra?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11.5px] text-muted">
      <span className="mr-0.5">Reach</span>
      {LEVEL_ORDER.map((level) => (
        <span key={level} title={`${LEVEL_WORDS[level]} — ${levelMeans(level)}`} className={cn("inline-flex h-5 items-center rounded-[5px] border px-2 text-[11px] font-semibold", TONE[level])}>
          {CHIP_LABEL[level]}
        </span>
      ))}
      {extra}
      <span title={inheritedMeans} className="inline-flex h-5 items-center rounded-[5px] border-[1.5px] border-dashed border-line-strong bg-surface px-2 text-[11px] font-semibold text-subtle">
        Inherited
      </span>
    </div>
  );
}

/** A legend entry for a plain answer ("Allow", "Deny"). */
export function LegendTag({ tone, label, title }: { tone: ChipTone; label: string; title: string }) {
  return (
    <span title={title} className={cn("inline-flex h-5 items-center rounded-[5px] border px-2 text-[11px] font-semibold", TONE[tone])}>
      {label}
    </span>
  );
}

/** Why nothing on the screen (or one part of it) can be changed — the server's own reason. */
export function LockNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 rounded-md bg-info-bg px-3 py-2 text-xs leading-[1.5] text-info", className)}>
      <Lock className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

// ─── The menu ─────────────────────────────────────────────────────────────────────────────────────

export type Choice = {
  key: string;
  label: string;
  hint?: string;
  tone: ChipTone;
  dashed?: boolean;
  /** Why this answer isn't on offer here ("Can't be wider than View"). */
  disabledWhy?: string | null;
  onPick: () => void;
};

export type OpenMenu = { anchor: HTMLElement; title: string; choices: Choice[] };

const MENU_WIDTH = 272;

/** One menu for the whole screen, opened against whichever chip, column heading or row button asked. */
export function ChoiceMenu({ menu, onClose }: { menu: OpenMenu | null; onClose: () => void }) {
  // The popover wants a ref; the anchor is whichever element opened the menu.
  const anchorRef = useMemo(() => ({ current: menu?.anchor ?? null }), [menu]);

  useEffect(() => {
    if (!menu) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node | null;
      // The anchor toggles the menu itself; the panel is portalled, so it is asked for by its marker.
      if (menu?.anchor.contains(target) || insideAnchoredPopover(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  // Opened from a chip near the right edge, the panel hangs from the chip's right side instead.
  const align = menu.anchor.getBoundingClientRect().left + MENU_WIDTH + 8 > window.innerWidth ? "end" : "start";
  return (
    <AnchoredPopover anchorRef={anchorRef} open width={MENU_WIDTH} maxHeight={380} align={align}>
      <div role="menu" aria-label={menu.title} className="p-1.5">
        <div className="px-2 pb-1.5 pt-1 text-[11px] font-bold uppercase tracking-[0.04em] text-subtle">{menu.title}</div>
        {menu.choices.map((c) => (
          <button
            key={c.key}
            type="button"
            role="menuitem"
            disabled={!!c.disabledWhy}
            title={c.disabledWhy ?? undefined}
            onClick={() => {
              c.onPick();
              onClose();
            }}
            className="flex w-full items-start gap-2 rounded-[5px] px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
          >
            <span className={cn("mt-[3px] h-2.5 w-2.5 shrink-0 rounded-[3px]", TONE[c.tone], c.dashed ? "border-[1.5px] border-dashed" : "border")} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-text">{c.label}</span>
              {(c.disabledWhy ?? c.hint) && <span className="block text-[11px] leading-[1.4] text-subtle">{c.disabledWhy ?? c.hint}</span>}
            </span>
          </button>
        ))}
      </div>
    </AnchoredPopover>
  );
}
