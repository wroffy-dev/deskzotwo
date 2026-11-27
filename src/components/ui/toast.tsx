"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { LAYER_TOAST } from "@/components/ui/layers";

/**
 * What happened after a button was pressed, where there is no place on the page to say it:
 * `toast.error(result.error)`, `toast.success("Saved.")`.
 *
 * It replaced the browser's `alert()`, which a couple of dozen buttons used to report a refusal —
 * a pin, a delete, a check-out — and which stopped the whole page until "OK" was pressed, looked like
 * the browser rather than the app, and on a phone came up as a system alert under the site's address.
 *
 * The console's notices (src/components/console/kit/notice.tsx) say no toasts, because a message that
 * slides away on a timer is gone before anyone who looked away has read it. That holds for what
 * matters most, so here it is the rule: **a failure stays until it is closed.** Only a success or a
 * note goes by itself, and not while the pointer or the keyboard is on it. Where a screen has room
 * for an outcome next to its button, ActionNotice there is still the better place.
 *
 * Called as a function, not a hook, like confirmAction: the one `ToastHost` (in the root layout)
 * shows them. Without a host — a page rendered on its own — a failure falls back to the browser's
 * alert, so it is never lost, and anything else to the console.
 */
export type ToastTone = "success" | "error" | "info";
export type ToastOptions = {
  /** A button on the toast — "Undo", "View". Pressing it closes the toast. */
  action?: { label: string; onClick: () => void };
};

type Toast = { id: number; tone: ToastTone; message: string; action?: ToastOptions["action"] };

/** How long a success or a note stays, while nobody is on it. */
const SHOW_MS = 6000;
/** More than this and the oldest goes — a burst of them is one message too many already. */
const MOST = 3;

let toasts: Toast[] = [];
let nextId = 1;
let hosts = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const NONE: Toast[] = [];

function show(tone: ToastTone, message: string, options?: ToastOptions): number {
  if (hosts === 0 || typeof window === "undefined") {
    // eslint-disable-next-line no-restricted-properties -- no host on this page: a failure is never lost
    if (tone === "error" && typeof window !== "undefined") window.alert(message);
    else console.info(message);
    return 0;
  }
  // The same words again (a second failed press) replace the first rather than stack under it.
  const kept = toasts.filter((t) => !(t.tone === tone && t.message === message));
  const id = nextId++;
  toasts = [...kept, { id, tone, message, action: options?.action }].slice(-MOST);
  emit();
  return id;
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (message: string, options?: ToastOptions) => show("success", message, options),
  error: (message: string, options?: ToastOptions) => show("error", message, options),
  info: (message: string, options?: ToastOptions) => show("info", message, options),
};

const STYLES: Record<ToastTone, { icon: typeof Info; className: string }> = {
  success: { icon: CircleCheck, className: "text-success" },
  error: { icon: CircleAlert, className: "text-danger" },
  info: { icon: Info, className: "text-muted" },
};

function ToastCard({ toast: t }: { toast: Toast }) {
  const { icon: Icon, className } = STYLES[t.tone];
  const held = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const start = () => {
    if (t.tone === "error" || held.current) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => dismissToast(t.id), SHOW_MS);
  };
  const hold = (on: boolean) => {
    held.current = on;
    if (on) window.clearTimeout(timer.current);
    else start();
  };

  useEffect(() => {
    start();
    return () => window.clearTimeout(timer.current);
    // Once per toast: its timer is restarted by the pointer and focus leaving, not by re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      onMouseEnter={() => hold(true)}
      onMouseLeave={() => hold(false)}
      onFocus={() => hold(true)}
      onBlur={() => hold(false)}
      className="pointer-events-auto flex w-full animate-fade-rise items-start gap-2.5 rounded-xl border border-line bg-surface-raised px-3.5 py-3 text-sm text-text shadow-lg sm:w-96"
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", className)} />
      <p className="min-w-0 flex-1 whitespace-pre-line break-words">{t.message}</p>
      {t.action && (
        <button
          type="button"
          onClick={() => {
            dismissToast(t.id);
            t.action?.onClick();
          }}
          className="shrink-0 rounded-base px-1.5 text-sm font-medium text-brand hover:underline"
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => dismissToast(t.id)}
        aria-label="Dismiss"
        className="-mr-1 shrink-0 rounded-base p-0.5 text-subtle transition-colors hover:bg-surface-sunken hover:text-text"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * Shows the toasts, newest at the bottom, in the corner on a computer and across the foot of the screen
 * on a phone. Mounted once, in the root layout. The two live regions are always on the page — a region
 * that arrives with its first message is never heard (src/components/ui/action-notice.tsx) — and a
 * failure goes in the assertive one, the one case worth interrupting a screen reader for.
 */
export function ToastHost() {
  const list = useSyncExternalStore(subscribe, () => toasts, () => NONE);

  useEffect(() => {
    hosts += 1;
    return () => {
      hosts -= 1;
    };
  }, []);

  const polite = list.filter((t) => t.tone !== "error");
  const assertive = list.filter((t) => t.tone === "error");
  return (
    <div className={cn("pointer-events-none fixed inset-x-0 bottom-[var(--app-tab-bar,0px)] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end md:bottom-0", LAYER_TOAST)}>
      <div role="alert" aria-live="assertive" className="flex w-full flex-col items-center gap-2 sm:items-end">
        {assertive.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </div>
      <div role="status" aria-live="polite" className="flex w-full flex-col items-center gap-2 sm:items-end">
        {polite.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </div>
    </div>
  );
}
