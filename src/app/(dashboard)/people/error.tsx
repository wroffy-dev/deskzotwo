"use client";

import { PageError } from "@/components/layout/page-error";

export default function PeopleError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <PageError error={error} retry={retry} back={{ href: "/people", label: "People" }} />;
}
