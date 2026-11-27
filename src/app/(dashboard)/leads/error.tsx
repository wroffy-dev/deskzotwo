"use client";

import { PageError } from "@/components/layout/page-error";

export default function LeadsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <PageError error={error} retry={retry} back={{ href: "/leads", label: "Leads", term: { key: "lead" } }} />;
}
