"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { readCallsNow } from "@/actions/telephony";
import { useClock } from "@/components/time/clock-provider";

/**
 * "Read calls now" on the Calls pages (owner, 31 Oct 2026 — src/actions/telephony.ts `readCallsNow`): CallerDesk's
 * calls fetched without waiting for the five-minute read, with when they were last read beside it.
 */
export function ReadCallsNow({ lastRead }: { lastRead: Date | string | null }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [said, setSaid] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setSaid(null);
          startTransition(async () => {
            const r = await readCallsNow();
            if (!r.ok) {
              setSaid({ tone: "error", text: r.error });
              return;
            }
            const { calls, logged, done, note } = r.data;
            setSaid({ tone: "ok", text: `${logged} new call${logged === 1 ? "" : "s"} logged, ${calls} read${done ? "" : " — the rest on the next read"}${note ? ` (${note})` : ""}.` });
            router.refresh();
          });
        }}
        className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text disabled:opacity-60"
      >
        <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />
        {pending ? "Reading CallerDesk…" : "Read calls now"}
      </button>
      {said ? (
        <span role="status" className={`text-xs ${said.tone === "error" ? "text-danger" : "text-subtle"}`}>
          {said.text}
        </span>
      ) : (
        <span className="text-xs text-subtle">{lastRead ? `Last read ${clock.dateTime(lastRead)}` : "Not read yet"}</span>
      )}
    </span>
  );
}
