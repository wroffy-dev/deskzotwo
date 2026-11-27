"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { endCustomerChoices, setOrderEndCustomer } from "@/actions/order";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * A reseller's order's end customer, set or changed after it was placed (owner, 30 Oct 2026): the reseller's own end
 * customer, or one of ours it sold to — found by name. The action decides which companies may be named.
 *
 * Since 1 Nov 2026 the reseller's own end customers are listed as it opens (the general customer search left them all
 * out, so none could be found), and typing narrows them, with ours under them.
 */
export function EndCustomerControl({ orderId, current }: { orderId: string; current: { id: string; name: string } | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ theirs: { id: string; name: string }[]; ours: { id: string; name: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(
      () => {
        endCustomerChoices(orderId, query)
          .then((rows) => live && setFound(rows))
          .catch(() => live && setFound({ theirs: [], ours: [] }));
      },
      query ? 250 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, query, orderId]);

  const theirs = found?.theirs ?? [];
  const ours = found?.ours ?? [];
  const row = (c: { id: string; name: string }) => (
    <li key={c.id}>
      <button type="button" disabled={pending || c.id === current?.id} onClick={() => choose(c.id)} className="block w-full px-3 py-2 text-left text-sm text-text hover:bg-surface-sunken disabled:text-muted">
        {c.name}
        {c.id === current?.id ? " — chosen" : ""}
      </button>
    </li>
  );

  const choose = (id: string | null) =>
    start(async () => {
      setError(null);
      const r = await setOrderEndCustomer(orderId, id);
      if (!r.ok) return setError(r.error);
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <button type="button" className="font-medium underline" onClick={() => (setError(null), setQuery(""), setFound(null), setOpen(true))}>
        {current ? "Change end customer" : "Set end customer"}
      </button>
      <Dialog open={open} onClose={() => !pending && setOpen(false)} title="End customer">
        <div className="space-y-3">
          <p className="text-xs text-muted">
            Who this order is for: the reseller&apos;s own end customer, or one of your customers it sold to — they stay yours. Its add-on seats follow.
          </p>
          <Input autoFocus placeholder="Search customers by name…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search customers" />
          {found === null && <p className="text-xs text-muted">Loading…</p>}
          {theirs.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted">The reseller&apos;s customers</p>
              <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-base border border-line">{theirs.map(row)}</ul>
            </div>
          )}
          {ours.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted">Your customers</p>
              <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-base border border-line">{ours.map(row)}</ul>
            </div>
          )}
          {found !== null && theirs.length === 0 && ours.length === 0 && (
            <p className="text-xs text-muted">
              {query.trim()
                ? query.trim().length < 2
                  ? "Type a little more to search your customers too."
                  : "No customer of that name — add them as an end customer from the reseller's page, then choose them here."
                : "This reseller has no end customers on file yet. Type to search your customers, or add one from the reseller's page."}
            </p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-between gap-2">
            {current ? (
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => choose(null)}>
                Take off {current.name}
              </Button>
            ) : (
              <span />
            )}
            <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
