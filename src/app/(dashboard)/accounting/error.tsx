"use client";

import { PageError } from "@/components/layout/page-error";

export default function AccountingError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <PageError error={error} retry={retry} back={{ href: "/accounting", label: "Accounting" }} />;
}
