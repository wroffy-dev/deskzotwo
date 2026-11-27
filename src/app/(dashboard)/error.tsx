"use client";

import { PageError } from "@/components/layout/page-error";

/**
 * Any page in the app that failed to render, where its module has no error page of its own. Inside
 * the app's layout, so the menu and header stay and only the page area says what happened — see
 * src/components/layout/page-error.tsx. A failure in the layout itself is src/app/error.tsx's.
 */
export default function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <PageError error={error} retry={retry} />;
}
