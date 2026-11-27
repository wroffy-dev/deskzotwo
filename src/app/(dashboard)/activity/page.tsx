import type { ActivityKind, ActivitySeverity } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { listActivity, activitySummary, activityUserOptions, type ActivityFilters } from "@/actions/activity";
import { ACTIVITY_GROUPS, ACTIVITY_KINDS, type ActivityGroup } from "@/lib/security/activity-kinds";
import { resolvePage, resolvePageSize, totalPages, PAGE_SIZES } from "@/lib/pagination";
import { Card, CardContent } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { ListHeader } from "@/components/ui/list-header";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListFilter, Users } from "lucide-react";
import { ActivityTable } from "@/components/security/activity-table";
import Link from "next/link";

/**
 * The activity log.
 *
 * Everybody can open this and see their own; only `activity.viewAll` widens it to the company. The
 * scoping happens in the action, not here — a page that decides its own visibility is a page
 * somebody eventually links past.
 */

const GROUP_KEYS = ACTIVITY_GROUPS.map((g) => g.key) as string[];
const KIND_KEYS = ACTIVITY_KINDS.map((k) => k.key) as string[];
const SEVERITIES: ActivitySeverity[] = ["INFO", "NOTICE", "WARNING", "CRITICAL"];

function Figure({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warning" }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div
        className={`mt-0.5 text-xl font-semibold tabular-nums ${
          tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text"
        }`}
      >
        {value.toLocaleString("en-IN")}
      </div>
    </div>
  );
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string) => (Array.isArray(params[key]) ? params[key][0] : params[key]) as string | undefined;

  const user = await requireUser();
  const canSeeAll = await hasEffectivePermission(user.id, "activity.viewAll");
  const canExport = await hasEffectivePermission(user.id, "activity.export");

  const kindParam = one("kind");
  const groupParam = one("group");
  const severityParam = one("severity");

  const filters: ActivityFilters = {
    // Validated against the registry rather than trusted: a hand-edited query string reaching
    // Prisma as an enum value it does not have is a 500, and as a `where` it never asked for is
    // worse.
    kinds: kindParam && KIND_KEYS.includes(kindParam) ? [kindParam as ActivityKind] : undefined,
    group: groupParam && GROUP_KEYS.includes(groupParam) ? (groupParam as ActivityGroup) : undefined,
    minSeverity:
      severityParam && SEVERITIES.includes(severityParam as ActivitySeverity)
        ? (severityParam as ActivitySeverity)
        : undefined,
    userId: one("userId"),
    from: one("from"),
    to: one("to"),
    search: one("q"),
    // Set by the "everything that happened to this record" link in an expanded row, so a single
    // company, order or subscription can be followed on its own without a page per record type.
    entityType: one("entityType"),
    entityId: one("entityId"),
    impersonatedOnly: one("impersonated") === "1",
  };

  const page = resolvePage(one("page"));
  const pageSize = resolvePageSize(one("pageSize"));

  const [result, summary, users] = await Promise.all([
    listActivity({ filters, page, pageSize }),
    activitySummary(filters),
    activityUserOptions(),
  ]);

  return (
    <div>
      <ListHeader
        title="Activity log"
        subtitle={`${result.total} ${result.total === 1 ? "event" : "events"}`}
        search={<ToolbarSearch paramName="q" placeholder="Search" label="Search summary, user, page, address" />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="kind"
              label="Event"
              allLabel="All events"
              options={ACTIVITY_KINDS.map((k) => ({ value: k.key, label: k.label }))}
            />
            {canSeeAll && users.length > 0 && (
              <SelectParamFilter searchable
                variant="pill"
                icon={<Users />}
                paramName="userId"
                label="Who"
                allLabel="Everyone"
                options={users.map((u) => ({ value: u.id, label: u.name }))}
              />
            )}
            <MoreFilters params={["group", "severity", "impersonated", ["from", "to"]]}>
              <SelectParamFilter
                variant="stacked"
                paramName="group"
                label="Area"
                allLabel="All areas"
                options={ACTIVITY_GROUPS.map((g) => ({ value: g.key, label: g.label }))}
              />
              <SelectParamFilter
                variant="stacked"
                paramName="severity"
                label="At least"
                allLabel="Any severity"
                options={SEVERITIES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
              />
              <SelectParamFilter
                variant="stacked"
                paramName="impersonated"
                label="View-as"
                allLabel="Include all"
                options={[{ value: "1", label: "Only while viewing as someone" }]}
              />
              <DateRangePicker variant="stacked" fromParam="from" toParam="to" label="Date" />
            </MoreFilters>
            <ClearFilters params={["q", "group", "kind", "severity", "userId", "impersonated", "from", "to"]} />
          </>
        }
        actions={
          <Link href="/activity/work" className="text-sm text-muted underline-offset-2 hover:text-text hover:underline">
            Work activity
          </Link>
        }
      />
      <p className="mt-2 text-sm text-muted">
        {canSeeAll
          ? "Sign-ins, exports, refused permissions, blocked crawlers and every data-loss-prevention event."
          : "Everything your account has done. Worth a look if you ever see a sign-in you don't recognise."}
      </p>

      <Card className="mt-4">
        <CardContent className="grid grid-cols-2 gap-4 py-3 sm:grid-cols-5">
          <Figure label="Events" value={summary.total} />
          <Figure label="Critical" value={summary.critical} tone="danger" />
          <Figure label="Warning" value={summary.warning} tone="warning" />
          <Figure label="Notice" value={summary.notice} />
          <Figure label="Info" value={summary.info} />
        </CardContent>
      </Card>

      <div className="mt-4">
        <ActivityTable rows={result.rows} filters={filters} canExport={canExport} scoped={result.scoped} />
      </div>

      <div className="mt-4">
        <Pagination
          page={page}
          pageSize={pageSize}
          total={result.total}
          totalPages={totalPages(result.total, pageSize)}
          pageSizes={PAGE_SIZES}
          label="events"
        />
      </div>
    </div>
  );
}
