import { ListPageSkeleton } from "@/components/ui/skeleton";

/**
 * While a page in another module loads — Leads to Orders, Orders to Accounting. Inside the app's own
 * layout, so the menu and header stay where they are and only the page area turns to the outline of
 * a list, the shape most pages arrive in. Moves within a module are answered by the module's own
 * loading.tsx; src/components/ui/skeleton.tsx says which folders have one and why.
 */
export default function DashboardLoading() {
  return <ListPageSkeleton />;
}
