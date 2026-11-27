import { relativeAgo } from "@/lib/staff/status";

/**
 * "3d ago", the exact moment in its tooltip — a list's Last activity. The server and the browser draw it a moment
 * apart, so a minute's difference in the wording is not a hydration error.
 */
export function Ago({ at, empty = "—" }: { at: string | Date | null | undefined; empty?: string }) {
  if (!at) return <span className="text-subtle">{empty}</span>;
  const when = new Date(at);
  return (
    <time dateTime={when.toISOString()} title={new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(when)} suppressHydrationWarning>
      {relativeAgo(when, new Date())}
    </time>
  );
}
