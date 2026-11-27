"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { consoleLookupSuppression, consoleRemoveSuppression, type SuppressionLookup } from "@/actions/platform/console-mail-suppressions";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const day = (d: Date | string | undefined) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—");

/**
 * Mail log › Suppressed: one address looked up — the list keeps hashes, so this is the only way to ask about a person —
 * and taken off it once the customer says their mailbox works again.
 */
export function SuppressionLookupForm() {
  const lookup = useConsoleAction<SuppressionLookup>();
  const remove = useConsoleAction<null>();
  const [address, setAddress] = useState("");
  const [found, setFound] = useState<{ address: string; result: SuppressionLookup } | null>(null);

  const ask = () =>
    !lookup.pending &&
    lookup.run(() => consoleLookupSuppression(address), { success: "", refresh: false, onDone: (result) => setFound({ address: address.trim().toLowerCase(), result }) });

  return (
    <div className="space-y-3">
      <div className="flex max-w-xl flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1 space-y-1.5">
          <label htmlFor="suppression-address" className="text-sm font-medium text-text">
            Look up an address
          </label>
          <Input
            id="suppression-address"
            value={address}
            placeholder="ravi@acme.com"
            onChange={(e) => {
              setAddress(e.target.value);
              setFound(null);
              lookup.reset();
              remove.reset();
            }}
            onKeyDown={(e) => e.key === "Enter" && ask()}
          />
        </div>
        <Button type="button" size="sm" onClick={ask} disabled={!address.trim()} aria-busy={lookup.pending || undefined}>
          {lookup.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Look up
        </Button>
      </div>
      {found && !found.result.on && <p className="text-sm text-muted">{found.address} isn&apos;t on the list — mail goes to it.</p>}
      {found?.result.on && (
        <div className="space-y-2 rounded-md border border-line px-3 py-2.5 text-sm">
          <p className="text-text">
            {found.address} is on the list: {found.result.reason === "COMPLAINT" ? "it marked mail from Deskzo as spam" : "mail to it bounced for good"}, first on{" "}
            {day(found.result.firstAt)}, last on {day(found.result.lastAt)}. Not mailed until {day(found.result.expiresAt)}; {found.result.stopped ?? 0} send(s) stopped so far.
          </p>
          {found.result.detail && <p className="break-words text-xs text-subtle">The server said: {found.result.detail}</p>}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            aria-busy={remove.pending || undefined}
            onClick={() =>
              !remove.pending &&
              remove.run(() => consoleRemoveSuppression(found.address), {
                success: "Taken off the list — mail goes to it again.",
                onDone: () => setFound({ address: found.address, result: { on: false } }),
              })
            }
          >
            {remove.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Take it off the list
          </Button>
        </div>
      )}
      <ActionNoticeRegion notice={lookup.error ?? remove.error ? { tone: "error", message: (lookup.error ?? remove.error)! } : null} className="empty:hidden" />
    </div>
  );
}
