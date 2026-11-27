"use client";

import { PageError } from "@/components/layout/page-error";

export default function CustomersError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <PageError error={error} retry={retry} back={{ href: "/customers", label: "Customers", term: { key: "customer" } }} />;
}
