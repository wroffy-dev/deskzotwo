import { redirect } from "next/navigation";
import { acPath } from "@/lib/access-control/nav";

/**
 * Unmasking logs moved into Settings › Access Control › Unmasking Activity. A saved link keeps its
 * filters: the person, the lead number, the result and the dates. That screen applies the same rule
 * about who may read the log.
 */
export default async function RetiredUnmaskingLogsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (key: string) => (typeof sp[key] === "string" ? (sp[key] as string) : undefined);
  const params = new URLSearchParams({ category: "pii" });
  const carry: [string, string | undefined][] = [
    ["user", one("userId")],
    ["record", one("lead")],
    ["result", one("result")],
    ["from", one("from")],
    ["to", one("to")],
  ];
  for (const [key, value] of carry) if (value) params.set(key, value);
  redirect(`${acPath.audit()}?${params.toString()}`);
}
