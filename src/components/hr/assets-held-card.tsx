import Link from "next/link";
import { Laptop } from "lucide-react";
import type { assetsHeldBy } from "@/actions/it-asset";
import { Card } from "@/components/ui/card";
import { workspaceClock } from "@/lib/time/workspace";

type Held = Awaited<ReturnType<typeof assetsHeldBy>>;

/**
 * What somebody is holding from the asset register, on their HR record (owner, 31 Oct 2026: assets in Deskzo People —
 * issued to people, returned before they leave). Read from the register, so it is never a list somebody forgot to
 * update; issuing and taking back happen on the asset itself.
 */
export async function AssetsHeldCard({ assets, leaving }: { assets: Held; leaving: boolean }) {
  const clock = await workspaceClock();
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Laptop className="h-4 w-4 text-muted" />
          <h3 className="text-sm font-semibold text-text">Assets held</h3>
          {assets.length > 0 && <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-muted">{assets.length}</span>}
        </div>
        <Link href="/assets" className="text-xs font-medium text-primary hover:underline">
          Issue an asset →
        </Link>
      </div>
      {leaving && assets.length > 0 && (
        <p className="mt-2 rounded-base bg-warning-bg px-3 py-2 text-xs text-warning">
          They are leaving: take {assets.length === 1 ? "this" : "these"} back before the full and final — open each and record the return.
        </p>
      )}
      {assets.length === 0 ? (
        <p className="mt-2 text-sm text-subtle">Nothing issued to them on the asset register.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {assets.map((a) => {
            const given = a.movements[0];
            return (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <Link href={`/assets/${a.id}`} className="min-w-0 hover:underline">
                  <span className="font-medium text-text">{a.name}</span>
                  <span className="ml-2 text-xs text-subtle">
                    {a.assetTag}
                    {a.make || a.model ? ` · ${[a.make, a.model].filter(Boolean).join(" ")}` : ""}
                    {a.serialNumber ? ` · S/N ${a.serialNumber}` : ""}
                  </span>
                </Link>
                <span className="text-xs text-muted">
                  {given ? `Since ${clock.date(given.occurredAt)}` : ""}
                  {given && !given.acknowledgedAt ? <span className="ml-1.5 text-warning">· not yet confirmed by them</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
