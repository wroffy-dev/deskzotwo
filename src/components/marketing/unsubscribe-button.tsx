"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { unsubscribeSubscriber } from "@/actions/marketing-subscribers";

/** Marketing › Subscribers: stop everything to somebody who asked (owner, 1 Nov 2026), after a confirm with their reason. */
export function UnsubscribeButton({ contactId, name }: { contactId: string; name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        disabled={pending}
        className="text-xs text-danger hover:underline disabled:opacity-50"
        onClick={() => {
          const note = window.prompt(`Unsubscribe ${name} from all email? Say how they asked (kept as the record):`, "Asked us by email to stop");
          if (note === null) return;
          setError(null);
          startTransition(async () => {
            const done = await unsubscribeSubscriber({ contactId, note });
            if (!done.ok) return setError(done.error);
            router.refresh();
          });
        }}
      >
        {pending ? "Unsubscribing…" : "Unsubscribe"}
      </button>
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </span>
  );
}
