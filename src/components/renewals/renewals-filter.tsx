"use client";

import { useState, type ReactNode } from "react";

/** Where a subscription on a customer's Renewals tab stands — worked out on the server (company-detail.tsx). */
export type RenewalStanding = "active" | "expiring" | "expired" | "renewed";
type View = "active" | "expiring" | "expired" | "renewed" | "all";

const VIEWS: { key: View; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "expiring", label: "Expiring soon" },
  { key: "expired", label: "Expired" },
  { key: "renewed", label: "Renewed" },
  { key: "all", label: "All" },
];

const inView = (s: RenewalStanding, v: View) => v === "all" || s === v || (v === "active" && s === "expiring");

/**
 * A customer's Renewals tab a view at a time (owner, 14 Nov 2026): Active by default — running or ending within 30
 * days — with Expiring soon, Expired (not renewed), Renewed (taken on by a later order) and All, each with its count.
 * Years of history brought across from an old system showed every past term as "Expired" above the live one.
 * The rows are drawn on the server; this only chooses which show.
 */
export function RenewalsFilter({ head, rows, empty, columns }: { head: ReactNode; rows: { key: string; standing: RenewalStanding; node: ReactNode }[]; empty: ReactNode; columns: number }) {
  const counts = Object.fromEntries(VIEWS.map((v) => [v.key, rows.filter((r) => inView(r.standing, v.key)).length])) as Record<View, number>;
  const [view, setView] = useState<View>(() => (counts.active > 0 ? "active" : counts.expired > 0 ? "expired" : "all"));
  const shown = rows.filter((r) => inView(r.standing, view));

  return (
    <div>
      {rows.length > 0 && (
        <div className="px-4 pb-3 pt-1">
          <div role="tablist" aria-label="Show" className="inline-flex flex-wrap gap-0.5 rounded-base bg-surface-sunken p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={view === v.key}
                onClick={() => setView(v.key)}
                className={`inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-sm transition-colors ${
                  view === v.key ? "bg-surface font-medium text-text shadow-sm" : "text-muted hover:text-text"
                }`}
              >
                {v.label}
                <span className="text-[11px] tabular-nums text-subtle">{counts[v.key]}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <table className="w-full text-sm">
        {head}
        <tbody>
          {shown.map((r) => r.node)}
          {rows.length === 0 && empty}
          {rows.length > 0 && shown.length === 0 && (
            <tr>
              <td colSpan={columns} className="px-4 py-6 text-center text-subtle">
                None here.{" "}
                <button type="button" onClick={() => setView("all")} className="text-brand hover:underline">
                  Show all {rows.length}
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
