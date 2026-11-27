import Link from "next/link";
import type { BillingView } from "@/actions/billing";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { COMPANY_NAME } from "@/lib/brand-names";
import { gb } from "@/lib/storage/allowance";
import type { StorageBuy } from "@/lib/storage-view";

/**
 * Settings › Billing: the workspace's storage (storage in the plans, owner, 20 Nov 2026 — src/lib/storage/quota.ts) —
 * what it uses of its limit, when that was measured, what takes the room, and how to add more: Extra storage packs for
 * the whole workspace, on the plan it has, bought through this page's plan form (`buy`), or asked for.
 */
export function StorageCard({ storage, buy, price, measuredAt }: { storage: NonNullable<BillingView["storage"]>; buy: StorageBuy | null; price: string | null; measuredAt: string | null }) {
  const { usedBytes, limitBytes, percent, breakdown, notice, pack } = storage;
  const packText = pack.mbEach ? `Extra storage adds ${gb(pack.mbEach * 1024 * 1024)} a pack for the whole workspace, on the plan you have${price ? ` — ${price}` : ""}.` : "Extra storage adds room for the whole workspace, on the plan you have.";
  const bar = notice?.tone === "danger" ? "bg-danger" : notice ? "bg-warning" : "bg-brand";
  return (
    <Card id="storage">
      <CardHeader className="text-sm font-medium text-text">Storage</CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="space-y-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-text">
              <span className="font-medium tabular-nums">{gb(usedBytes)}</span>
              {limitBytes !== null ? (
                <>
                  {" "}of <span className="tabular-nums">{gb(limitBytes)}</span> used
                </>
              ) : (
                " used · no limit on your plan"
              )}
            </span>
            {percent !== null && <span className={notice?.tone === "danger" ? "font-medium text-danger" : notice ? "font-medium text-warning" : "text-muted"}>{percent}%</span>}
          </div>
          {percent !== null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className={`h-full ${bar}`} style={{ width: `${Math.max(percent > 0 ? 1 : 0, percent)}%` }} />
            </div>
          )}
        </div>
        {notice && (
          <p className={notice.tone === "danger" ? "rounded-base border border-danger/30 bg-danger-bg px-3 py-2 text-danger" : "rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-warning"}>{notice.text}</p>
        )}
        <p className="text-xs text-muted">
          {measuredAt ? `Measured ${measuredAt}, with files saved since added as they are saved.` : "Not measured yet — files are counted as they are saved."} Documents, photos, attachments and call recordings count; backups don&apos;t. One limit for the whole workspace, not per person.
        </p>
        {breakdown.length > 0 && (
          <ul className="divide-y divide-line rounded-base border border-line">
            {breakdown.map((row) => (
              <li key={row.label} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="text-text">{row.label}</span>
                <span className="tabular-nums text-muted">{gb(row.bytes)}</span>
              </li>
            ))}
          </ul>
        )}
        {buy?.kind === "form" && (
          <div className="flex flex-wrap items-center gap-3">
            <Link href={`/settings/billing?add=storage#${buy.anchor}`} className="inline-flex h-9 items-center rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110">
              Add storage
            </Link>
            <span className="text-muted">
              {packText}
              {buy.startsOn ? ` It starts with the next renewal, on ${buy.startsOn}.` : ""}
            </span>
          </div>
        )}
        {buy?.kind === "ask" && (
          <p className="text-muted">
            <span className="font-medium text-text">Ask {COMPANY_NAME} to add storage.</span> {packText}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
