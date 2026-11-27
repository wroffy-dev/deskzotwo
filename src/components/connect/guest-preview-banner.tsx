import Link from "next/link";
import { Eye } from "lucide-react";
import type { GuestPreview } from "@/actions/connect";

/** The strip over an admin's view of a guest's pages (owner, 20 Nov 2026) — whose view it is, and that it's only a view. */
export function GuestPreviewBanner({ guest }: { guest: GuestPreview }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-card border border-warning/40 bg-warning-bg px-4 py-3 text-sm">
      <span className="flex flex-wrap items-center gap-2 text-text">
        <Eye className="h-4 w-4 text-warning" aria-hidden="true" />
        <span>
          You&apos;re seeing what <strong>{guest.name}</strong> ({guest.connection}) sees. View only — nothing here is saved.
        </span>
        <span className="text-muted">
          {guest.territory.length ? `Territory: ${guest.territory.join(", ")}.` : "Every state."}
          {!guest.canSignIn ? " They can't sign in right now." : guest.status === "INVITED" ? " They haven't signed in yet." : ""}
        </span>
      </span>
      <Link href="/smart-lists/guests" className="font-medium text-brand hover:underline">
        Back to Guests
      </Link>
    </div>
  );
}
