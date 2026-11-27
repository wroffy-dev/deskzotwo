import { DashboardPageSkeleton } from "@/components/ui/skeleton";

/**
 * While the dashboard's header is read. It is brief: the page streams its header first and the
 * board's figures after it, under their own outline (page.tsx), so this is only ever seen for the
 * moment before the greeting arrives.
 */
export default function DashboardHomeLoading() {
  return <DashboardPageSkeleton />;
}
