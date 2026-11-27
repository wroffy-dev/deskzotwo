"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setServiceRenews } from "@/actions/item";
import { Button } from "@/components/ui/button";

/**
 * Items › Services that renew: the two answers for one service (owner, 11 Nov 2026 — src/lib/renewals-unwatched-rules.ts).
 * Either takes it off the list; "Watch for renewal" is the item's own "Manage as a subscription" tick.
 */
export function ServiceRenewsButtons({ itemId, name }: { itemId: string; name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function answer(renews: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setServiceRenews(itemId, renews);
      if (!result.ok) return setError(result.error);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={() => answer(true)} aria-label={`Watch ${name} for renewal`}>
          Watch for renewal
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => answer(false)} aria-label={`${name} doesn't renew`}>
          It doesn&apos;t renew
        </Button>
      </div>
      {error && (
        <p role="alert" className="max-w-xs text-right text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
