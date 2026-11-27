import { Sparkles } from "lucide-react";
import { mailConnectPath, type WorkplaceProvider } from "@/lib/workplace/providers";

/**
 * My profile → Your mailbox: told plainly when an admin lets the AI teammates read this person's mailbox (owner, 23 Nov
 * 2026 — src/lib/mail-reading), which ones, what's kept — and, until the provider allows it, the one reconnect it needs.
 */
export function MailReadingNotice({ readers, needsReconnect, provider }: { readers: string[]; needsReconnect: boolean; provider: WorkplaceProvider | null }) {
  return (
    <div className="mt-4 space-y-1.5 rounded-base border border-line bg-surface-sunken/60 px-3 py-2.5 text-sm">
      <p className="flex items-center gap-1.5 font-medium text-text">
        <Sparkles className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
        Your mailbox is read by {readers.join(", ")}
      </p>
      <p className="text-xs text-muted">
        Your company&apos;s admin turned this on. Only emails to or from a customer, vendor, lead or contact already in Deskzo are kept — internal, personal and
        unknown mail is read past and never kept. Nothing from before it was turned on is read.
      </p>
      {needsReconnect && provider && (
        <p className="text-xs text-warning">
          It needs your permission once more.{" "}
          <a href={mailConnectPath(provider, "/profile")} className="font-medium text-brand hover:underline">
            Connect your mailbox again
          </a>{" "}
          and allow reading.
        </p>
      )}
    </div>
  );
}
