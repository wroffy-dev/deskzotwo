import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The app's loading pages — what a `loading.tsx` under src/app/(dashboard) shows the moment a link is
 * clicked, while the page's own queries run on the server.
 *
 * Without one, a click showed nothing at all until the whole next page was ready: the old page sat
 * there, and on a slow report it looked as if the click had been missed, so people clicked again.
 *
 * Where the files go is a rule, not taste — `npm run check:loading` holds every folder to it:
 *   - (dashboard)/loading.tsx answers a move from one module to another;
 *   - every folder with routes inside it has its own, or moving within it (a lead back to the list,
 *     one accounting report to the next) shows nothing — a loading boundary only shows when the
 *     segment directly below it changes;
 *   - a record (`[id]`) and a "new" form have their own, in their own shape.
 *
 * Each shape is the rough outline its pages arrive in, so the real page replaces it without the
 * layout jumping. Nothing here reads data or the workspace's words: a loading page has to draw
 * before anything is known. Reduced motion is clamped globally, so the pulse needs no guard.
 */

const CARD = "rounded-xl border border-line bg-surface shadow-sm";

/** A grey block where something will be. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-surface-sunken", className)} />;
}

/** Announced once to a screen reader; the blocks themselves are hidden from it. */
function Loading({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" className={className}>
      <span className="sr-only">Loading…</span>
      {children}
    </div>
  );
}

/** A page's title and the line under it, with room for its buttons on the right. */
function PageHeader({ actions = 1 }: { actions?: number }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      {actions > 0 && (
        <div className="flex items-center gap-2">
          {Array.from({ length: actions }, (_, i) => (
            <Skeleton key={i} className={cn("h-9", i === actions - 1 ? "w-28" : "w-20")} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A label and its field, as the forms lay them out. */
function Field() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

/** A card of label-and-value lines — a record's details, a summary. */
function DetailsCard({ lines }: { lines: number }) {
  return (
    <div className={CARD}>
      <div className="border-b border-line px-5 py-3.5">
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="space-y-3 px-5 py-4">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className={cn("h-3", i % 2 ? "w-20" : "w-32")} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A list of records — the shape most pages arrive in: the header, a row of filters, and the table.
 * Also the fallback for any page that has no shape of its own.
 */
export function ListPageSkeleton() {
  return (
    <Loading className="space-y-4">
      <PageHeader actions={2} />
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-9 w-64 max-w-full" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className={CARD}>
        <div className="flex items-center gap-4 border-b border-line px-5 py-3">
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="hidden h-3 w-1/5 sm:block" />
          <Skeleton className="ml-auto h-3 w-12" />
        </div>
        <div className="divide-y divide-line">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-3.5">
              <Skeleton className="h-4 w-1/4" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="hidden h-4 w-1/5 sm:block" />
              <Skeleton className="ml-auto h-4 w-12" />
            </div>
          ))}
        </div>
      </div>
    </Loading>
  );
}

/** One record — a lead, an order, a ticket: the way back, its name and status, the body and a side column. */
export function RecordPageSkeleton() {
  return (
    <Loading className="space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-4 w-20" />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-9 w-24" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className={CARD}>
            <div className="border-b border-line px-5 py-3.5">
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-4 w-36 max-w-full" />
                </div>
              ))}
            </div>
          </div>
          <div className={CARD}>
            <div className="border-b border-line px-5 py-3.5">
              <Skeleton className="h-4 w-28" />
            </div>
            <div className="divide-y divide-line">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="flex items-start gap-3 px-5 py-3.5">
                  <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-40" />
                    <Skeleton className="h-3 w-3/4" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <DetailsCard lines={6} />
      </div>
    </Loading>
  );
}

/** A "new" form: the title, then sections of fields, two to a row from small screens up. */
export function FormPageSkeleton() {
  return (
    <Loading>
      <PageHeader actions={0} />
      <div className="mt-6 space-y-6">
        {[4, 4, 2].map((fields, i) => (
          <div key={i} className={CARD}>
            <div className="border-b border-line px-5 py-3.5">
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2">
              {Array.from({ length: fields }, (_, j) => (
                <Field key={j} />
              ))}
            </div>
          </div>
        ))}
        <div className="flex justify-end gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
    </Loading>
  );
}

/**
 * The dashboard's board while its figures are worked out: the controls, the headline tiles and the
 * widgets, in the board's own grid (src/components/dashboard/dashboard-board.tsx).
 */
export function DashboardBoardSkeleton() {
  return (
    <Loading className="@container space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-[38px] w-64 max-w-full" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-[38px] w-28" />
          <Skeleton className="h-[38px] w-28" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 @min-[640px]:gap-4 @min-[1000px]:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex items-start gap-3.5 rounded-xl border border-line bg-surface p-3.5 @min-[640px]:p-[18px]">
            <Skeleton className="hidden h-11 w-11 flex-none rounded-[10px] @min-[640px]:block" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-16" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2 @min-[640px]:gap-4 @min-[1000px]:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className={cn(CARD, "space-y-4 p-4")}>
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-10" />
            </div>
            <Skeleton className="h-[212px] w-full" />
          </div>
        ))}
      </div>
    </Loading>
  );
}

/** A tab's content below the dashboard's header — Getting started, What's new. */
export function SectionSkeleton() {
  return (
    <Loading className="space-y-3">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className={cn(CARD, "flex items-start gap-3 p-4")}>
          <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
      ))}
    </Loading>
  );
}

/** The whole dashboard before even its header is ready — the greeting band, then the board. */
export function DashboardPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-4 w-48" />
        <div className="flex gap-2 pt-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
      <DashboardBoardSkeleton />
    </div>
  );
}
