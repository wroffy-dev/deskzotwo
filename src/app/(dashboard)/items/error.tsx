"use client";

import { PageError } from "@/components/layout/page-error";

export default function ItemsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <PageError error={error} retry={retry} back={{ href: "/items", label: "Items & Inventory", term: { key: "item", template: "{many} & Inventory" } }} />;
}
