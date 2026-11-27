"use client";

import { PageError } from "@/components/layout/page-error";

export default function RenewalsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <PageError error={error} retry={retry} back={{ href: "/renewals", label: "Renewals", term: { key: "renewal" } }} />;
}
