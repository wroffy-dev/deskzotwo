"use client";

import { PageError } from "@/components/layout/page-error";

export default function TicketsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <PageError error={error} retry={retry} back={{ href: "/tickets", label: "Tickets", term: { key: "ticket" } }} />;
}
