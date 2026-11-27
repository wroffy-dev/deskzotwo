"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A from–to amount in the URL, for a list's "More filters" (owner, 17 Nov 2026 — the customer list's Lifetime value and
 * Last 12 months): two boxes, applied when you leave one or press Enter; blank is no bound. Back to the first page,
 * as the other filters do.
 */
export function AmountRangeFilter({ label, minParam, maxParam, resetParams = ["page"] }: { label: string; minParam: string; maxParam: string; resetParams?: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const id = useId();
  const [min, setMin] = useState(searchParams.get(minParam) ?? "");
  const [max, setMax] = useState(searchParams.get(maxParam) ?? "");

  const apply = (nextMin = min, nextMax = max) => {
    const params = new URLSearchParams(searchParams.toString());
    const tidy = (v: string) => v.replace(/[,₹\s]/g, "");
    for (const [key, value] of [[minParam, tidy(nextMin)], [maxParam, tidy(nextMax)]] as const) {
      if (value && Number.isFinite(Number(value))) params.set(key, value);
      else params.delete(key);
    }
    if (params.toString() === searchParams.toString()) return;
    for (const key of resetParams) params.delete(key);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };
  const box = (value: string, set: (v: string) => void, placeholder: string, which: "min" | "max") => (
    <input
      id={which === "min" ? id : undefined}
      inputMode="decimal"
      value={value}
      onChange={(e) => set(e.target.value)}
      onBlur={() => apply()}
      onKeyDown={(e) => e.key === "Enter" && apply()}
      placeholder={placeholder}
      aria-label={`${label} ${which === "min" ? "from" : "to"}`}
      className={cn("h-9 w-full min-w-0 rounded-lg border bg-surface px-2.5 text-[13px] text-text", value ? "border-brand/50" : "border-line-strong")}
    />
  );
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor={id} className="block text-[12.5px] font-medium text-muted">
        {label} (₹)
      </label>
      <div className="flex items-center gap-1.5">
        {box(min, setMin, "From", "min")}
        <span className="text-subtle">–</span>
        {box(max, setMax, "To", "max")}
      </div>
    </div>
  );
}
