"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ComponentType } from "react";
import { Briefcase, CalendarCheck, LayoutGrid, MessageCircle, Phone } from "lucide-react";
import { cn } from "@/lib/utils";

/** What the "More" tab asks of the sidebar: open its menu drawer (src/components/layout/sidebar.tsx). */
export const OPEN_MENU_EVENT = "deskzo:open-menu";

type Tab = { key: string; label: string; href?: string; icon: ComponentType<{ className?: string }>; also?: string[]; badge?: number };

/**
 * The tabs along the bottom on a phone (owner, 31 Oct 2026: the PWA "like the native app — the dedicated icons
 * below"): Today, Sales, Chat, Calls and More, as the Android app has them. A tab whose module the person can't
 * open isn't there; More opens the whole menu. Phones only — from `md` the sidebar is the menu.
 */
export function AppTabBar({ sales, chat, calls, chatUnread }: { sales: boolean; chat: boolean; calls: boolean; chatUnread: number }) {
  const pathname = usePathname() ?? "";
  // Toasts, chat windows and wishes pinned to the bottom of a phone sit above the bar while it is there (md:bottom-0
  // puts them back where the bar isn't drawn).
  useEffect(() => {
    document.documentElement.style.setProperty("--app-tab-bar", "calc(3.5rem + env(safe-area-inset-bottom))");
    return () => {
      document.documentElement.style.removeProperty("--app-tab-bar");
    };
  }, []);
  const tabs: Tab[] = [
    { key: "today", label: "Today", href: "/today", icon: CalendarCheck },
    ...(sales ? [{ key: "sales", label: "Sales", href: "/leads", icon: Briefcase, also: ["/companies", "/customers"] }] : []),
    ...(chat ? [{ key: "chat", label: "Chat", href: "/chat", icon: MessageCircle, badge: chatUnread }] : []),
    ...(calls ? [{ key: "calls", label: "Calls", href: "/calls", icon: Phone }] : []),
    { key: "more", label: "More", icon: LayoutGrid },
  ];
  const isActive = (t: Tab) => !!t.href && [t.href, ...(t.also ?? [])].some((p) => pathname === p || pathname.startsWith(`${p}/`));

  return (
    <nav
      aria-label="App"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur-md md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="flex">
        {tabs.map((t) => {
          const active = isActive(t);
          const inner = (
            <>
              <span className="relative">
                <t.icon className="h-5 w-5" />
                {t.badge ? (
                  <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white">
                    {t.badge > 99 ? "99+" : t.badge}
                  </span>
                ) : null}
              </span>
              <span className="text-[11px] font-medium">{t.label}</span>
            </>
          );
          const style = cn("flex h-14 w-full flex-col items-center justify-center gap-0.5 transition-colors", active ? "text-primary" : "text-muted hover:text-text");
          return (
            <li key={t.key} className="flex-1">
              {t.href ? (
                <Link href={t.href} className={style} aria-current={active ? "page" : undefined}>
                  {inner}
                </Link>
              ) : (
                <button type="button" className={style} onClick={() => window.dispatchEvent(new Event(OPEN_MENU_EVENT))}>
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
