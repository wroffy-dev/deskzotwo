"use client";

import { PageError } from "@/components/layout/page-error";

export default function VisitsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <PageError error={error} retry={retry} back={{ href: "/visits", label: "Field Visits", term: { key: "visit" } }} />;
}
