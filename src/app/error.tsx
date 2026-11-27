"use client";

import { PageError } from "@/components/layout/page-error";

/**
 * A page that failed outside the app's own layout — a sign-in or public page, or the app's layout
 * itself (the menu's reads), which (dashboard)/error.tsx sits inside and so cannot catch. There is no
 * menu to fall back on here, so the way out is the address's home page, which sends a signed-in
 * person on to their dashboard.
 */
export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="w-full px-4 py-6">
      <PageError error={error} retry={retry} back={{ href: "/", label: "the home page" }} />
    </main>
  );
}
