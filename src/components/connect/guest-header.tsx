"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOutConnect } from "@/actions/connect-public";

/** A guest's header (owner, 20 Nov 2026 — src/lib/connect): no menu — what is shared with them is all there is. */
export function GuestHeader({ name, connection, business, preview }: { name: string; connection: string; business: string; preview?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <header className="mx-auto mb-6 flex max-w-6xl flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
      <Link href="/connect" className="text-lg font-bold tracking-tight text-brand">
        Deskzo <span className="text-text">Connect</span>
        <span className="ml-2 text-sm font-normal text-muted">with {business}</span>
      </Link>
      <div className="flex items-center gap-2 text-sm">
        <span className="rounded bg-text px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-surface">GUEST</span>
        <span className="font-medium text-text">{name}</span>
        <span className="hidden text-muted sm:inline">· {connection}</span>
        {!preview && (
        <button
          type="button"
          disabled={pending}
          className="ml-2 text-brand hover:underline"
          onClick={() =>
            start(async () => {
              await signOutConnect();
              router.refresh();
            })
          }
        >
          Sign out
        </button>
        )}
      </div>
    </header>
  );
}
