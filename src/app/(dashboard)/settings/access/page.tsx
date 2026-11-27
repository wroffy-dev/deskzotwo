import { requireAccessViewer } from "@/lib/access-control/guard";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, ChevronRight, History, Plus, Settings, Timer, UserPlus } from "lucide-react";
import { permissionChangeHistory } from "@/actions/access";
import { can } from "@/lib/authz/resolve";
import { getPermissionDefinition } from "@/lib/permissions";
import { accessControlOverview } from "@/lib/access-control/overview";
import { acPath } from "@/lib/access-control/nav";
import { Ago } from "@/components/ui/ago";
import { AcPage, EmptyNote, InitialsAvatar, Panel, PanelHeader, acButton, acToneOf, panelLinkClass, rowHoverClass, tdClass, thClass } from "@/components/access-control/ui";
import { cn } from "@/lib/utils";

export const metadata = { title: "Access Control" };

/**
 * Settings › Access Control › Overview: the counts an access review starts from, what changed
 * lately, who holds the doors that take data out, and what needs a look.
 *
 * The old Staff & roles screen lived at this address with `?tab=`; a saved link still lands on the
 * screen that replaced its tab.
 */
export default async function AccessControlOverviewPage({ searchParams }: { searchParams: Promise<{ tab?: string; view?: string; role?: string }> }) {
  const sp = await searchParams;
  if (sp.tab === "roles") redirect(sp.view === "compare" ? acPath.compare() : sp.role ? acPath.modules({ role: sp.role }) : acPath.roles());
  // Both moved to Employee Permissions, under the list, with the ids they had.
  if (sp.tab === "exceptions") redirect(`${acPath.employees()}#exceptions`);
  if (sp.tab === "who") redirect(`${acPath.employees()}#who-can`);
  if (sp.tab === "staff" || sp.tab === "people") redirect(acPath.employees());

  const viewer = await requireAccessViewer();
  const [data, history, mayManage, mayAddUsers] = await Promise.all([
    accessControlOverview(),
    permissionChangeHistory({ limit: 8 }),
    can(viewer.id, "permissions.manage"),
    can(viewer.id, "users.manage"),
  ]);
  const { kpis } = data;

  const cards: { label: string; value: number; hint: string; href: string; tone?: "warn" }[] = [
    { label: "Employees", value: kpis.employees, hint: "Active accounts", href: acPath.employees() },
    { label: "Active roles", value: kpis.activeRoles, hint: `${kpis.customRoles} custom`, href: acPath.roles() },
    { label: "Custom roles", value: kpis.customRoles, hint: "Created in this workspace", href: acPath.roles() },
    { label: "With overrides", value: kpis.withOverrides, hint: "People with exceptions", href: acPath.employees() },
    { label: "Unmasks today", value: kpis.unmasksToday, hint: `${kpis.peopleUnmaskingToday} ${kpis.peopleUnmaskingToday === 1 ? "person" : "people"}`, href: acPath.limits() },
    { label: "Expiring soon", value: kpis.expiringSoon, hint: "Exceptions ending in 7 days", href: acPath.employees(), tone: kpis.expiringSoon ? "warn" : undefined },
  ];
  const maxCount = Math.max(1, ...data.distribution.map((d) => d.count));
  const attention = data.expiring.length + data.recentRoles.length;

  return (
    <AcPage
      crumb="Overview"
      title="Access Control Overview"
      description="Who can do what across the workspace, and what changed recently."
      actions={
        <>
          {mayManage && (
            <Link href={acPath.wizard()} className={acButton.primary}>
              <Plus className="h-[18px] w-[18px]" aria-hidden />
              Create role
            </Link>
          )}
          {mayAddUsers && (
            <Link href="/settings/users/new" className={acButton.secondary}>
              <UserPlus className="h-[18px] w-[18px]" aria-hidden />
              Add employee
            </Link>
          )}
          <Link href={acPath.security()} title="Security settings" aria-label="Security settings" className={acButton.icon}>
            <Settings className="h-[18px] w-[18px]" aria-hidden />
          </Link>
        </>
      }
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(125px,1fr))] gap-3">
        {cards.map((k) => (
          <Link key={k.label} href={k.href} className="block rounded-lg border border-line bg-surface px-4 py-3.5 transition-colors hover:border-line-strong">
            <div className="text-xs font-medium text-muted">{k.label}</div>
            <div className={cn("mt-1 text-[26px] font-bold leading-[1.1] tracking-[-0.02em]", k.tone === "warn" ? "text-warning" : "text-text")}>{k.value}</div>
            <div className="mt-1 text-xs text-subtle">{k.hint}</div>
          </Link>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel>
            <PanelHeader
              title="Recent permission changes"
              action={
                <Link href={acPath.audit()} className={panelLinkClass}>
                  View audit log
                </Link>
              }
            />
            {history.length === 0 ? (
              <EmptyNote>No permission has been changed yet.</EmptyNote>
            ) : (
              <div className="overflow-auto">
                <table className="w-full min-w-[720px] border-collapse">
                  <thead>
                    <tr>
                      {["Target", "Changed by", "Permission", "Previous → New", "When"].map((h) => (
                        <th key={h} className={thClass}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => {
                      const target = h.subjectType === "USER" ? (h.subjectUser?.name ?? "A removed account") : `Role · ${data.roleName[h.subjectRole ?? ""] ?? h.subjectRole ?? "—"}`;
                      const perm = h.permission ? (getPermissionDefinition(h.permission)?.label ?? h.permission) : (h.detail ?? h.changeKind.toLowerCase().replaceAll("_", " "));
                      return (
                        <tr key={h.id} className={rowHoverClass}>
                          <td className={cn(tdClass, "whitespace-nowrap font-medium")}>
                            <Link href={h.subjectType === "USER" && h.subjectUser ? acPath.employee(h.subjectUser.id) : h.subjectRole ? acPath.modules({ role: h.subjectRole }) : acPath.audit()} className="hover:text-brand">
                              {target}
                            </Link>
                          </td>
                          <td className={cn(tdClass, "whitespace-nowrap text-text/80")}>{h.actor?.name ?? "—"}</td>
                          <td className={cn(tdClass, "text-text/80")}>{perm}</td>
                          <td className={cn(tdClass, "whitespace-nowrap")}>
                            <span className="font-mono text-[11px] text-muted">{answer(h.fromAllowed)}</span>
                            <ArrowRight className="mx-1 inline h-3.5 w-3.5 align-middle text-subtle" aria-hidden />
                            <span className={cn("font-mono text-[11px] font-medium", h.toAllowed === true ? "text-success" : h.toAllowed === false ? "text-danger" : "text-muted")}>{answer(h.toAllowed)}</span>
                          </td>
                          <td className={cn(tdClass, "whitespace-nowrap text-muted")}>
                            <Ago at={h.createdAt} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel>
            <PanelHeader
              title="Who can see sensitive data"
              action={
                <Link href={acPath.sensitive()} className={panelLinkClass}>
                  Manage
                </Link>
              }
            />
            <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-px bg-line/70">
              {data.sensitive.map((s) => (
                <div key={s.key} className="bg-surface px-4 py-3">
                  <div className="text-xs font-semibold text-text/80">{s.label}</div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <div className="flex pl-1.5">
                      {s.holders.slice(0, 4).map((p) => (
                        <InitialsAvatar key={p.id} name={p.name} seed={p.id} size={24} className="-ml-1.5 border-2 border-surface" />
                      ))}
                    </div>
                    <span className="text-xs text-muted">{s.holders.length === 0 ? "Nobody" : `${s.holders.length} ${s.holders.length === 1 ? "person" : "people"}`}</span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel>
            <PanelHeader title="Needs attention" meta={<span className="text-xs text-subtle">{attention}</span>} />
            {attention === 0 ? (
              <EmptyNote>Nothing needs a look right now.</EmptyNote>
            ) : (
              <div className="flex flex-col">
                {data.expiring.map((e) => (
                  <Link key={`${e.userId}:${e.permission}`} href={acPath.employee(e.userId, "overrides")} className={cn("flex items-start gap-2.5 border-b border-line/70 px-4 py-2.5 last:border-0", rowHoverClass)}>
                    <Timer className="mt-px h-[18px] w-[18px] shrink-0 text-warning" aria-hidden />
                    <span className="flex-1 text-[12.5px] leading-[1.45] text-text/80">
                      {e.name}&apos;s exception for {e.permission} ends <Ago at={e.expiresAt} />.
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
                  </Link>
                ))}
                {data.recentRoles.map((r) => (
                  <Link key={r.role} href={acPath.modules({ role: r.role })} className={cn("flex items-start gap-2.5 border-b border-line/70 px-4 py-2.5 last:border-0", rowHoverClass)}>
                    <History className="mt-px h-[18px] w-[18px] shrink-0 text-info" aria-hidden />
                    <span className="flex-1 text-[12.5px] leading-[1.45] text-text/80">
                      Role {r.name} was modified <Ago at={r.at} /> by {r.by}.
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
                  </Link>
                ))}
              </div>
            )}
          </Panel>

          <Panel>
            <PanelHeader
              title="Employees by role"
              action={
                <Link href={acPath.roles()} className={panelLinkClass}>
                  All roles
                </Link>
              }
            />
            <div className="flex flex-col gap-2 px-4 pb-3 pt-2">
              {data.distribution.length === 0 && <p className="py-2 text-xs text-subtle">Nobody holds a role yet.</p>}
              {data.distribution.map((d) => (
                <Link key={d.key} href={acPath.modules({ role: d.key })} className="grid grid-cols-[130px_1fr_24px] items-center gap-2.5 py-0.5 transition-opacity hover:opacity-80">
                  <span className="truncate text-xs text-text/80">{d.name}</span>
                  <span className="block h-2 overflow-hidden rounded bg-surface-sunken">
                    <span className={cn("block h-full rounded", acToneOf(d.key))} style={{ width: `${Math.round((d.count / maxCount) * 100)}%` }} />
                  </span>
                  <span className="text-right text-xs font-semibold">{d.count}</span>
                </Link>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </AcPage>
  );
}

function answer(allowed: boolean | null): string {
  return allowed === true ? "ALLOW" : allowed === false ? "DENY" : "DEFAULT";
}
