"use client";

import { PageError } from "@/components/layout/page-error";

export default function OrdersError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <PageError error={error} retry={retry} back={{ href: "/orders", label: "Orders", term: { key: "order" } }} />;
}
