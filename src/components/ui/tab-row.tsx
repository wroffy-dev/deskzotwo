"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pin, PinOff, RotateCcw } from "lucide-react";
import { Menu, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { MAX_PINNED_TABS } from "@/lib/tab-pins";

/**
 * A record's tabs in one row — the pinned ones — and the rest under More (owner, 13 Nov 2026: a customer's 22 tabs
 * ran to two rows). The open tab always shows in the row, pinned or not. Each person pins their own, kept in a
 * cookie for this browser (`cookieName`); "Reset" goes back to the defaults.
 */
export function TabRow({
  tabs,
  activeKey,
  pinned,
  cookieName,
  paramName = "tab",
  basePath,
  otherParams = {},
  defaultKey = tabs[0]?.key,
}: {
  tabs: { key: string; label: string; count?: number }[];
  activeKey: string;
  /** From `pinnedTabs` (src/lib/tab-pins.ts), on the server. */
  pinned: string[];
  cookieName: string;
  paramName?: string;
  basePath: string;
  otherParams?: Record<string, string | undefined>;
  defaultKey?: string;
}) {
  const router = useRouter();
  const baseQuery = Object.fromEntries(Object.entries(otherParams).filter(([, v]) => v)) as Record<string, string>;
  const href = (key: string) => ({ pathname: basePath, query: key === defaultKey ? baseQuery : { ...baseQuery, [paramName]: key } });
  const pinnedSet = new Set(pinned);
  const inRow = tabs.filter((t) => pinnedSet.has(t.key) || t.key === activeKey);
  const rest = tabs.filter((t) => !pinnedSet.has(t.key));
  const restOutOfRow = rest.filter((t) => t.key !== activeKey);

  function save(keys: string[] | null) {
    document.cookie = keys
      ? `${cookieName}=${encodeURIComponent(keys.join(","))}; path=/; max-age=31536000; samesite=lax`
      : `${cookieName}=; path=/; max-age=0; samesite=lax`;
    router.refresh();
  }
  const pin = (key: string) => save(tabs.map((t) => t.key).filter((k) => pinnedSet.has(k) || k === key));
  const unpin = (key: string) => save(pinned.filter((k) => k !== key));

  return (
    <div className="flex items-end gap-2 border-b border-line">
      <div className="flex min-w-0 flex-1 flex-wrap gap-x-1">
        {inRow.map((t) => {
          const active = activeKey === t.key;
          return (
            <Link
              key={t.key}
              href={href(t.key)}
              className={cn(
                "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
                active ? "border-brand text-text" : "border-transparent text-muted hover:text-text",
              )}
            >
              {t.label}
              {t.count !== undefined && (
                <>
                  <span className="sr-only">, </span>
                  <span
                    className={cn(
                      "ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold leading-5 tabular-nums",
                      active ? "bg-brand-subtle text-brand" : "bg-surface-sunken text-muted",
                    )}
                  >
                    {t.count}
                  </span>
                </>
              )}
            </Link>
          );
        })}
      </div>
      {/* Only when some tab is left out of the row: with every tab in it, there is nothing for More to hold. */}
      {tabs.length > 1 && rest.length > 0 && (
        <div className="mb-1.5 shrink-0">
          <Menu label={restOutOfRow.length ? `More ${restOutOfRow.length}` : "Tabs"} width={280}>
            {(close) => (
              <div className="max-h-[70vh] overflow-y-auto">
                {rest.length > 0 && <MenuLabel>More</MenuLabel>}
                {rest.map((t) => (
                  <TabMenuRow
                    key={t.key}
                    label={t.label}
                    count={t.count}
                    active={t.key === activeKey}
                    href={href(t.key)}
                    onOpen={close}
                    action={
                      pinned.length < MAX_PINNED_TABS
                        ? { icon: Pin, label: `Pin ${t.label} to the row`, run: () => pin(t.key) }
                        : null
                    }
                  />
                ))}
                {rest.length > 0 && <MenuSeparator />}
                <MenuLabel>In the row</MenuLabel>
                {tabs
                  .filter((t) => pinnedSet.has(t.key))
                  .map((t) => (
                    <TabMenuRow
                      key={t.key}
                      label={t.label}
                      count={t.count}
                      active={t.key === activeKey}
                      href={href(t.key)}
                      onOpen={close}
                      action={pinned.length > 1 ? { icon: PinOff, label: `Take ${t.label} off the row`, run: () => unpin(t.key) } : null}
                    />
                  ))}
                <MenuSeparator />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    save(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted transition-colors hover:bg-surface-sunken hover:text-text"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Reset to the usual tabs
                </button>
              </div>
            )}
          </Menu>
        </div>
      )}
    </div>
  );
}

function TabMenuRow({
  label,
  count,
  active,
  href,
  onOpen,
  action,
}: {
  label: string;
  count?: number;
  active: boolean;
  href: { pathname: string; query: Record<string, string> };
  onOpen: () => void;
  action: { icon: typeof Pin; label: string; run: () => void } | null;
}) {
  const Icon = action?.icon;
  return (
    <div className="group flex items-center hover:bg-surface-sunken">
      <Link
        href={href}
        role="menuitem"
        onClick={onOpen}
        className={cn("flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2 text-sm", active ? "font-medium text-brand" : "text-text")}
      >
        <span className="truncate">{label}</span>
        {count !== undefined && <span className="text-[11px] tabular-nums text-subtle">{count}</span>}
      </Link>
      {action && Icon && (
        <button
          type="button"
          aria-label={action.label}
          title={action.label}
          onClick={action.run}
          className="mr-1.5 inline-grid h-7 w-7 shrink-0 place-items-center rounded-base text-subtle transition-colors hover:bg-surface hover:text-brand"
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
