import { requireAccessViewer } from "@/lib/access-control/guard";
import Link from "next/link";
import { Lock, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import { auditLogCounts, listPermissionChanges, type PermissionChangeFilters } from "@/actions/access-control-audit";
import { listUnmaskEvents, mayReadUnmaskLog, unmaskLogIntegrity, type UnmaskLogFilters } from "@/actions/unmask-log";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { acPath } from "@/lib/access-control/nav";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { PERMISSION_GROUP_ORDER, PERMISSIONS, permissionGroup } from "@/lib/permissions";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Pagination } from "@/components/ui/pagination";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { AcPage, Panel, Pill, acInput, panelLinkClass } from "@/components/access-control/ui";
import { AuditClearFilters, AuditExportButton } from "@/components/access-control/audit/audit-toolbar";
import { PERMISSION_CHANGE_KIND_LABEL, PERMISSION_CHANGE_KINDS } from "@/components/access-control/audit/kinds";
import { PermissionChangeTable } from "@/components/access-control/audit/permission-change-table";
import { UnmaskEventTable } from "@/components/access-control/audit/unmask-event-table";
import { cn } from "@/lib/utils";

export const metadata = { title: "Access Audit Logs" };

/** The unmasking log's four results, as its filter has always worded them. */
const RESULTS = [
  { value: "ALLOWED", label: "Unmasked" },
  { value: "REPEAT", label: "Shown again (no unit used)" },
  { value: "QUOTA_EXHAUSTED", label: "Daily limit reached" },
  { value: "DENIED", label: "Refused" },
];

/** The registry's sections that hold at least one key, in the order the permission screens list them. */
const MODULES = (() => {
  const used = new Set(PERMISSIONS.map((def) => permissionGroup(def)));
  return PERMISSION_GROUP_ORDER.filter((group) => used.has(group)).map((group) => ({ value: group as string, label: group as string }));
})();

/** `acPath.audit`, with the filters a link carries across (the dates, a result) added to its query. */
function auditHref(base: { category?: "pii"; user?: string }, extra: Record<string, string | undefined> = {}): string {
  const path = acPath.audit(base);
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) if (value) sp.set(key, value);
  const query = sp.toString();
  return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
}

function KpiCard({ href, label, value, hint, active, tone }: { href: string; label: string; value: string; hint: string; active: boolean; tone?: "warning" | "danger" }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={cn("block rounded-lg border bg-surface px-4 py-3 transition-colors", active ? "border-brand" : "border-line hover:border-line-strong")}>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={cn("mt-0.5 text-2xl font-bold tracking-[-0.02em]", tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : "text-text")}>{value}</div>
      <div className="text-[11.5px] text-subtle">{hint}</div>
    </Link>
  );
}

const count = (n: number) => n.toLocaleString("en-IN");

/**
 * Settings › Access Control › Audit Logs — and, with `?category=pii`, Sensitive Data › Unmasking Activity.
 *
 * Two logs behind one screen. The permission-change log (every grant, revoke, reset, preset, role and
 * account change) opens with the area, on `permissions.view`. The unmasking log (every press of Show on a
 * masked record, allowed or not) is the workspace's super admin's alone, acting as themselves — decided by
 * `mayReadUnmaskLog` here and again by every action that reads it; anybody else is told so instead of
 * shown a table. Neither log can be changed from here or anywhere, and the unmasking log's hash chain is
 * checked each time the page is drawn.
 *
 * The filters live in the URL, so a filtered view is a link: `user` is the person (changed, or unmasking),
 * `role` the role changed, `actor` who made the change.
 */
export default async function AccessAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAccessViewer();
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) || undefined;
  };
  const pii = one("category") === "pii";
  const span = { from: one("from"), to: one("to") };
  const page = resolvePage(one("page"));
  const pageSize = resolvePageSize(one("pageSize"));
  const user = one("user");
  const result = one("result");

  const changeFilters: PermissionChangeFilters = { q: one("q"), actorId: one("actor"), subjectUserId: user, role: one("role"), kind: one("kind"), group: one("module"), ...span };
  const unmaskFilters: UnmaskLogFilters = { ...span, userId: user, lead: one("record"), result };

  const viewer = await currentUser();
  const [counts, mayReadUnmasks, mayExportChanges] = await Promise.all([auditLogCounts(span), mayReadUnmaskLog(), viewer ? can(viewer.id, "activity.export") : false]);
  const [changes, unmasks, integrity] = await Promise.all([
    pii ? null : listPermissionChanges({ ...changeFilters, page, pageSize }),
    pii && mayReadUnmasks ? listUnmaskEvents(unmaskFilters, { page, pageSize }) : null,
    pii && mayReadUnmasks ? unmaskLogIntegrity() : null,
  ]);
  const unmaskData = unmasks?.ok ? unmasks.data : { rows: [], total: 0, people: [] };
  const chain = integrity?.ok ? integrity.data : null;
  const total = pii ? unmaskData.total : (changes?.total ?? 0);

  // The person filter offers who is in the log. A link that names somebody who isn't (they have never
  // unmasked anything) still has to say whose empty list this is.
  let unmaskPeople = unmaskData.people;
  if (pii && mayReadUnmasks && user && !unmaskPeople.some((p) => p.id === user)) {
    const named = await db.user.findUnique({ where: { id: user }, select: { id: true, name: true } });
    if (named) unmaskPeople = [...unmaskPeople, named];
  }

  // Switching log keeps the dates, the person and the page size; the rest of a log's filters are its own.
  const carried = { ...span, pageSize: one("pageSize") };
  const changesHref = auditHref({ user }, carried);
  const unmasksHref = auditHref({ category: "pii", user }, carried);
  const u = counts.unmask;

  return (
    <AcPage
      crumb={pii ? "Unmasking Activity" : "Audit Logs"}
      title="Access Audit Logs"
      description="Every permission change — grants, revokes, role and account changes — and every attempt to unmask a masked field. Nobody can change a row; export for compliance."
      actions={
        pii ? (
          mayReadUnmasks && <AuditExportButton source={{ log: "pii", filters: unmaskFilters }} total={total} />
        ) : (
          <AuditExportButton
            source={{ log: "permissions", filters: changeFilters }}
            total={total}
            blocked={mayExportChanges ? undefined : "Exporting this log needs the “Export the activity log” permission."}
          />
        )
      }
    >
      <div className="flex min-w-0 flex-col gap-3.5">
        {/* The design's counters, each one a view of the log. They count the chosen dates — all time until some are. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
          <KpiCard href={changesHref} label="Permission changes" value={count(counts.permissionChanges)} hint="grants, roles, account changes" active={!pii} />
          <KpiCard
            href={unmasksHref}
            label="PII unmasking"
            value={u ? count(u.ALLOWED + u.REPEAT) : "—"}
            hint={u ? `${count(u.ALLOWED)} used a unit · ${count(u.REPEAT)} opened again` : "Super admin only"}
            active={pii && !result}
            tone={u ? "warning" : undefined}
          />
          {u && (
            <>
              <KpiCard
                href={auditHref({ category: "pii", user }, { ...carried, result: "DENIED" })}
                label="Refused attempts"
                value={count(u.DENIED)}
                hint="no permission, no reach, or viewing as"
                active={pii && result === "DENIED"}
                tone="danger"
              />
              <KpiCard
                href={auditHref({ category: "pii", user }, { ...carried, result: "QUOTA_EXHAUSTED" })}
                label="Limit reached"
                value={count(u.QUOTA_EXHAUSTED)}
                hint="stopped by the daily limit"
                active={pii && result === "QUOTA_EXHAUSTED"}
              />
            </>
          )}
        </div>

        {/* Not a Panel: the filters' lists open below the bar, and a Panel clips what leaves it. */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2.5">
          <nav aria-label="Log" className="inline-flex h-8 shrink-0 items-center rounded-md border border-line-strong bg-surface p-0.5">
            {[
              { label: "Permission changes", href: changesHref, on: !pii },
              { label: "Unmasking activity", href: unmasksHref, on: pii },
            ].map((tab) => (
              <Link
                key={tab.label}
                href={tab.href}
                aria-current={tab.on ? "page" : undefined}
                className={cn("inline-flex h-full items-center rounded px-2.5 text-xs font-semibold transition-colors", tab.on ? "bg-brand-subtle text-brand" : "text-muted hover:text-text")}
              >
                {tab.label}
              </Link>
            ))}
          </nav>

          {!pii && changes && (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-[7px] h-[18px] w-[18px] text-subtle" aria-hidden />
                <SearchParamInput paramName="q" placeholder="Search permission, role, person, detail" className={cn(acInput, "w-[260px] pl-[30px]")} />
              </div>
              <SelectParamFilter searchable variant="pill" paramName="actor" label="Changed by" allLabel="Anyone" options={changes.actors.map((p) => ({ value: p.id, label: p.name }))} />
              <SelectParamFilter searchable variant="pill" paramName="user" label="Person" allLabel="All people" options={changes.people.map((p) => ({ value: p.id, label: p.name }))} />
              <SelectParamFilter variant="pill" paramName="role" label="Role" allLabel="All roles" options={changes.roles.map((r) => ({ value: r.key, label: r.name }))} />
              <SelectParamFilter variant="pill" paramName="kind" label="Action" allLabel="All actions" options={PERMISSION_CHANGE_KINDS.map((kind) => ({ value: kind, label: PERMISSION_CHANGE_KIND_LABEL[kind] }))} />
              <SelectParamFilter variant="pill" paramName="module" label="Module" allLabel="All modules" options={MODULES} />
              <DateRangePicker fromParam="from" toParam="to" label="Date" />
            </>
          )}

          {pii && mayReadUnmasks && (
            <>
              <SearchParamInput paramName="record" label="Lead number" placeholder="Record ID (e.g. LEAD-000123)" className={cn(acInput, "w-[210px] font-mono text-xs")} />
              {unmaskPeople.length > 0 && (
                <SelectParamFilter searchable variant="pill" paramName="user" label="Employee" allLabel="All employees" options={unmaskPeople.map((p) => ({ value: p.id, label: p.name }))} />
              )}
              <SelectParamFilter variant="pill" paramName="result" label="Result" allLabel="Every result" options={RESULTS} />
              <DateRangePicker fromParam="from" toParam="to" label="Date" />
              <Pill tone="brand">Super Admin only</Pill>
            </>
          )}

          {(!pii || mayReadUnmasks) && (
            <>
              <span className="ml-auto text-xs text-muted">{pii ? `${count(total)} ${total === 1 ? "attempt" : "attempts"}` : `${count(total)} ${total === 1 ? "entry" : "entries"}`}</span>
              <AuditClearFilters />
            </>
          )}
        </div>

        {pii && !mayReadUnmasks && (
          <Panel className="flex flex-col items-center px-6 py-10 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-sunken text-muted">
              <Lock className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <p className="mt-3 font-semibold text-text">Only the workspace&apos;s super admin can read this log</p>
            <p className="mt-1 max-w-md text-[13px] leading-[1.5] text-muted">
              The unmasking log — who pressed Show on which masked record, and whether it was allowed — opens for the super admin alone, and only as themselves: not while viewing as
              somebody, and not for platform support.
            </p>
            <Link href={changesHref} className={cn(panelLinkClass, "mt-3")}>
              View permission changes
            </Link>
          </Panel>
        )}

        {pii && mayReadUnmasks && (
          <>
            <p className="max-w-4xl text-xs leading-[1.5] text-muted">
              Every time somebody pressed Show on a record whose fields are masked for them: whether it was unmasked, opened again the same day, stopped by the daily limit, or refused — with the
              fields concerned and any reason they gave, never what the fields held. Nobody can change or remove a row. Masking is switched under{" "}
              <Link href={acPath.masking()} className="font-semibold text-brand hover:underline">
                Global PII Masking
              </Link>
              ; daily limits are set under{" "}
              <Link href={acPath.limits()} className="font-semibold text-brand hover:underline">
                Unmasking Limits
              </Link>
              .
            </p>

            {/* The hash chain, checked as the page is drawn (src/lib/authz/unmask.ts verifyUnmaskChain). */}
            {chain && (
              <div role="status" className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]", chain.intact ? "border-success/30 bg-success-bg" : "border-danger/30 bg-danger-bg")}>
                {chain.intact ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden /> : <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />}
                <span className="text-text">
                  {chain.intact ? (
                    <>
                      <span className="font-medium">Log intact.</span>{" "}
                      <span className="text-muted">{chain.rows === 1 ? "Its one row checks out" : `All ${count(chain.rows)} rows check out`} against the chain.</span>
                    </>
                  ) : (
                    <>
                      <span className="font-medium">The log has been tampered with.</span>{" "}
                      <span className="text-muted">
                        Row {chain.broken?.seq} ({chain.broken?.atText}, {chain.broken?.userName}) is the first that doesn&apos;t check out: {chain.broken?.why} The {count(chain.rows)} rows before it
                        do.
                      </span>
                    </>
                  )}
                </span>
              </div>
            )}

            <Panel>{unmasks && !unmasks.ok ? <p className="px-4 py-8 text-center text-[13px] text-danger">{unmasks.error}</p> : <UnmaskEventTable rows={unmaskData.rows} />}</Panel>
          </>
        )}

        {!pii && changes && (
          <Panel>
            <PermissionChangeTable rows={changes.rows} />
          </Panel>
        )}

        {total > 0 && (!pii || mayReadUnmasks) && (
          <Pagination page={page} pageSize={pageSize} total={total} totalPages={totalPages(total, pageSize)} pageSizes={PAGE_SIZES} label={pii ? "attempts" : "entries"} />
        )}
      </div>
    </AcPage>
  );
}
