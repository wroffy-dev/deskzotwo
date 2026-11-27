"use client";

import { Suspense, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  ArrowLeftRight,
  ArrowUpDown,
  Columns3,
  Eye,
  FileText,
  Filter,
  Grid3x3,
  History,
  LayoutDashboard,
  Lock,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Shield,
  User,
  type LucideIcon,
} from "lucide-react";
import { AC_NAV, AC_ROOT, AC_TOOLS, type AcIcon, type AcNavItem } from "@/lib/access-control/nav";
import { cn } from "@/lib/utils";

const ICONS: Record<AcIcon, LucideIcon> = {
  overview: LayoutDashboard,
  roles: Shield,
  modules: Grid3x3,
  fields: Columns3,
  documents: FileText,
  employees: User,
  scope: Filter,
  sensitive: Lock,
  io: ArrowUpDown,
  audit: History,
  security: Settings,
  simulator: Eye,
  compare: ArrowLeftRight,
};

type Badges = Partial<Record<string, number>>;

const COLLAPSED_KEY = "deskzo-access-control-nav-collapsed";

/** Folded or not, remembered in this browser — read as the settings menu reads its own (settings-nav.tsx). */
const collapsedStore = {
  subscribe(onChange: () => void) {
    window.addEventListener("storage", onChange);
    window.addEventListener(COLLAPSED_KEY, onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener(COLLAPSED_KEY, onChange);
    };
  },
  get(): boolean {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "true";
    } catch {
      // Private windows and blocked site data: the menu stays open.
      return false;
    }
  },
  server: () => false,
  set(collapsed: boolean) {
    try {
      localStorage.setItem(COLLAPSED_KEY, String(collapsed));
    } catch {
      // ignore — the choice just won't be remembered
    }
    window.dispatchEvent(new Event(COLLAPSED_KEY));
  },
};

/**
 * The Access Control area: its own sidebar beside the screen, inside Deskzo's shell.
 *
 * The sidebar is the map of the area — every screen one click away, the open one marked — so the
 * general settings menu steps aside here (`WIDE` in settings-nav.tsx). Below `lg` it folds behind a
 * menu button, as the design's does. From `lg` up it folds to a strip of icons, for a screen that
 * wants the width (the matrix, the field manager); the phone's drawer always shows the labels.
 */
export function AccessControlShell({ badges, hidden, children }: { badges?: Badges; /** Keys of entries this viewer may not open. */ hidden?: string[]; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const collapsed = useSyncExternalStore(collapsedStore.subscribe, collapsedStore.get, collapsedStore.server);
  return (
    <div className="flex min-w-0 flex-1 items-start gap-6 text-[13px]">
      {open && <div className="fixed inset-0 z-30 bg-black/35 lg:hidden" onClick={() => setOpen(false)} aria-hidden />}
      <aside
        className={cn(
          "w-[232px] shrink-0 flex-col overflow-y-auto border-line bg-surface",
          collapsed && "lg:w-12",
          "lg:sticky lg:top-20 lg:flex lg:max-h-[calc(100vh-6rem)] lg:rounded-lg lg:border",
          open ? "fixed inset-y-0 left-0 z-40 flex border-r shadow-lg" : "hidden",
        )}
      >
        {/* It reads the URL's search params, which suspends where a page is rendered ahead of time. */}
        <Suspense fallback={null}>
          <SideNav badges={badges} hidden={hidden} collapsed={collapsed} onNavigate={() => setOpen(false)} />
        </Suspense>
      </aside>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mb-3 inline-flex h-8 items-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-[13px] font-medium text-text hover:bg-surface-sunken lg:hidden"
        >
          <MenuIcon className="h-[18px] w-[18px]" aria-hidden />
          Access control menu
        </button>
        {children}
      </div>
    </div>
  );
}

function SideNav({ badges, hidden, collapsed, onNavigate }: { badges?: Badges; hidden?: string[]; collapsed: boolean; onNavigate: () => void }) {
  const pathname = usePathname();
  const params = useSearchParams();

  const isActive = (item: Pick<AcNavItem, "href" | "also" | "param">) => {
    const path = item.href.split("?")[0];
    const onPath = path === AC_ROOT ? pathname === AC_ROOT : pathname === path || pathname.startsWith(`${path}/`) || (item.also ?? []).some((p) => pathname.startsWith(p));
    if (!onPath) return false;
    if (item.param) return (params.get(item.param.name) ?? null) === item.param.value;
    return true;
  };
  // A parent with children is lit only on its own page, not on a child's.
  // Folded, its children aren't drawn, so the parent stands for them too.
  const parentActive = (item: AcNavItem) => (item.children ? pathname === item.href || (collapsed && item.children.some(isActive)) : isActive(item));
  /** Drawn only while the labels are: always on a phone's drawer, and from `lg` up unless folded. */
  const labelled = collapsed ? "lg:hidden" : "";

  const row = (item: AcNavItem) => {
    const Icon = ICONS[item.icon];
    const active = parentActive(item);
    const badge = badges?.[item.key] ?? 0;
    return (
      <li key={item.key}>
        <Link
          href={item.href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          title={collapsed ? item.label : undefined}
          className={cn(
            "mx-2 my-px flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors",
            collapsed && "lg:mx-1.5 lg:justify-center lg:px-0",
            active ? "bg-brand-subtle font-semibold text-brand" : "font-medium text-text/80 hover:bg-surface-sunken",
          )}
        >
          <Icon className={cn("h-[18px] w-[18px] shrink-0", active ? "text-brand" : "text-muted")} strokeWidth={1.75} aria-hidden />
          <span className={cn("min-w-0 flex-1 truncate", labelled)}>{item.label}</span>
          {badge > 0 && <span className={cn(labelled, "inline-flex")}><span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-[5px] text-[11px] font-bold text-white">{badge}</span></span>}
        </Link>
        {item.children && (
          <ul className={labelled}>
            {item.children.filter((c) => !hidden?.includes(c.key)).map((c) => {
              const on = isActive(c);
              const b = badges?.[c.key] ?? 0;
              return (
                <li key={c.key}>
                  <Link
                    href={c.href}
                    onClick={onNavigate}
                    aria-current={on ? "page" : undefined}
                    className={cn(
                      "mx-2 my-px flex h-7 items-center gap-2 rounded-md pl-[38px] pr-2.5 text-[12.5px] transition-colors",
                      on ? "bg-brand-subtle font-semibold text-brand" : "font-medium text-text/80 hover:bg-surface-sunken",
                    )}
                  >
                    <span className={cn("h-1 w-1 shrink-0 rounded-full", on ? "bg-brand" : "bg-muted")} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    {b > 0 && <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warning-bg px-[5px] text-[11px] font-bold text-warning">{b}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  };

  return (
    <nav aria-label="Access control" className="flex min-h-0 flex-1 flex-col pb-3">
      <div className={cn("flex items-center justify-between pl-4 pr-2 pt-2.5", collapsed && "lg:justify-center lg:px-0")}>
        <p className={cn("text-[11px] font-bold uppercase tracking-[0.06em] text-subtle", labelled)}>Access control</p>
        <button
          type="button"
          onClick={() => collapsedStore.set(!collapsed)}
          className="hidden h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface-sunken hover:text-text lg:flex"
          title={collapsed ? "Show the access control menu" : "Hide the access control menu"}
          aria-label={collapsed ? "Show the access control menu" : "Hide the access control menu"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" aria-hidden /> : <PanelLeftClose className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      <ul className="mt-1">{AC_NAV.map(row)}</ul>
      <p className={cn("px-4 pb-1.5 pt-4 text-[11px] font-bold uppercase tracking-[0.06em] text-subtle", labelled)}>Tools</p>
      {/* Folded, a rule stands where the "Tools" heading was. */}
      {collapsed && <div className="mx-2.5 my-2 hidden border-t border-line lg:block" aria-hidden />}
      <ul>{AC_TOOLS.map(row)}</ul>
    </nav>
  );
}
