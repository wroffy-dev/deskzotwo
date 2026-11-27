"use client";

import { useEffect } from "react";
import Link from "next/link";
import { CircleAlert, Lock, RotateCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useWording } from "@/components/terms/wording-provider";
import { slot, type TermKey } from "@/lib/terms/dictionary";
import { noAccessKind } from "@/lib/no-access";

/**
 * Where a module's error page sends somebody back to: its own list, by the name the menu gives it —
 * in the workspace's own words where the module is one of theirs to rename (Settings → Wording).
 */
export type ErrorBack = { href: string; label: string; term?: { key: TermKey; template?: string } };

/**
 * A page in the app that failed to render — what every error.tsx under src/app/(dashboard) shows.
 *
 * Next draws it in place of the page and nothing else, so the sidebar, the header and a module's own
 * tabs (Accounting's, Settings') stay put and the way out is where it always is. Before there was one,
 * a failed query took the whole app off the screen for Next's bare error page, menu and all.
 *
 * It never shows `error.message`: a server error's text can carry a query, a host or a key, and in
 * production Next replaces it anyway. The digest is what matches the server's log line, so it is the
 * one thing worth reading out to support. "Try again" asks the server for the page afresh (`retry`,
 * Next 16.3) — most failures here are a query that timed out, and the second attempt simply works.
 * Nothing typed elsewhere is lost: this page only failed to draw.
 */
export function PageError({ error, retry, back }: { error: Error & { digest?: string }; retry: () => void; back?: ErrorBack }) {
  const wording = useWording();
  const backLabel = back ? (back.term ? slot(wording, back.label, back.term.key, back.term.template) : back.label) : null;
  // Refused, not broken (owner, 26 Nov 2026 — src/lib/no-access.ts): said so, and with no "Try again", which can't help.
  const refused = noAccessKind(error.digest);

  // The browser's console is where a developer looks first; the server's log has the rest.
  useEffect(() => {
    if (!refused) console.error(error);
  }, [error, refused]);

  const backLink = (
    <Link
      href={back?.href ?? "/dashboard"}
      className="inline-flex h-9 items-center justify-center rounded-base border border-line-strong bg-surface px-3.5 text-sm font-medium text-text shadow-sm transition-colors hover:bg-surface-sunken"
    >
      {backLabel ? `Back to ${backLabel}` : "Go to the dashboard"}
    </Link>
  );

  if (refused) {
    return (
      <Card className="mx-auto mt-10 max-w-md hover:shadow-sm">
        <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
          <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-full bg-surface-sunken text-muted">
            <Lock className="h-5 w-5" />
          </span>
          <div role="alert" className="space-y-1.5">
            <h1 className="text-base font-semibold text-text">
              {refused === "plan" ? "This isn't part of your plan" : "You don't have permission to view this"}
            </h1>
            <p className="text-sm text-muted">
              {refused === "plan"
                ? "Your workspace's plan doesn't include it. Your admin can add it under Settings › Plan & billing."
                : "Your role doesn't give you access to this page. If you need it, ask your admin."}
            </p>
          </div>
          {backLink}
        </div>
      </Card>
    );
  }

  return (
    <Card className="mx-auto mt-10 max-w-md hover:shadow-sm">
      <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
        <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-full bg-danger-bg text-danger">
          <CircleAlert className="h-5 w-5" />
        </span>
        <div role="alert" className="space-y-1.5">
          <h1 className="text-base font-semibold text-text">This page couldn&apos;t be loaded</h1>
          <p className="text-sm text-muted">
            Something went wrong on our side. Try again in a moment — if it keeps happening, contact support with the reference below.
          </p>
          {error.digest && (
            <p className="text-xs text-muted">
              Reference:{" "}
              <span translate="no" className="font-mono text-text select-all">
                {error.digest}
              </span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" onClick={() => retry()}>
            <RotateCw aria-hidden="true" className="h-4 w-4" />
            Try again
          </Button>
          {backLink}
        </div>
      </div>
    </Card>
  );
}
