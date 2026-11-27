import Link from "next/link";
import { db } from "@/lib/db";
import { formatMoneyWhole } from "@/lib/currency";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { isModuleEnabled } from "@/actions/module";
import { companyElsewhere } from "@/actions/elsewhere";
import { viewerHas } from "@/actions/permission";
import { elsewhereCategoryOptions } from "@/lib/customers/elsewhere-categories";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { InstalledElsewhere, type ElsewhereRow } from "@/components/companies/installed-elsewhere";

/**
 * The customer page's "Installed elsewhere" (owner, 2 Nov 2026 — src/lib/customers/elsewhere.ts): the tab itself, and
 * the few renewing soonest under Renewals, beside the ones we sold.
 */

async function rowsFor(companyId: string) {
  const data = await companyElsewhere(companyId);
  if (!data) return null;
  const rows: ElsewhereRow[] = data.rows.map((r) => ({
    id: r.id,
    productName: r.productName,
    category: r.category,
    quantity: r.quantity,
    boughtFrom: r.boughtFrom,
    renewsOn: r.renewsOn ? String(r.renewsOn) : null,
    yearlyValue: r.yearlyValue === null ? null : String(r.yearlyValue),
    valueText: r.yearlyValue === null ? null : formatMoneyWhole(Number(r.yearlyValue)),
    source: r.source,
    notes: r.notes,
    remindDays: r.remindDays,
  }));
  return { ...data, rows };
}

export async function CompanyInstalledElsewhere({ companyId, canMakeLead }: { companyId: string; canMakeLead: boolean }) {
  const data = await rowsFor(companyId);
  if (!data) return null;
  const [items, sellers, leadsOn, today, categories, canEditCategories] = await Promise.all([
    // Our own items' names to pick from as they type, where Items is on.
    (await isModuleEnabled("items")) ? db.item.findMany({ where: { active: true }, select: { name: true }, orderBy: { name: "asc" }, take: 500 }).catch(() => []) : [],
    data.ready ? db.installedElsewhere.findMany({ where: { boughtFrom: { not: null } }, distinct: ["boughtFrom"], select: { boughtFrom: true }, orderBy: { boughtFrom: "asc" }, take: 200 }).catch(() => []) : [],
    isModuleEnabled("leads"),
    workspaceClock().then((c) => c.today()),
    elsewhereCategoryOptions(),
    viewerHas("settings.manage"),
  ]);
  return (
    <InstalledElsewhere
      companyId={companyId}
      rows={data.rows}
      canEdit={data.canEdit}
      canMakeLead={canMakeLead && leadsOn}
      productNames={items.map((i) => i.name)}
      sellers={sellers.map((s) => s.boughtFrom!).filter(Boolean)}
      categories={categories}
      canEditCategories={canEditCategories}
      today={today}
      ready={data.ready}
    />
  );
}

/** Under Renewals: what renews elsewhere in the next twelve months, soonest first — read-only, the tab to change it. */
export async function RenewingElsewhere({ companyId, tabHref }: { companyId: string; tabHref: string }) {
  const data = await rowsFor(companyId);
  const today = (await workspaceClock()).today();
  const yearOut = new Date(Date.parse(today) + 365 * 86_400_000).toISOString().slice(0, 10);
  const soon = (data?.rows ?? []).filter((r) => r.renewsOn && r.renewsOn.slice(0, 10) >= today && r.renewsOn.slice(0, 10) <= yearOut).slice(0, 6);
  if (!data || soon.length === 0) return null;
  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <p className="text-sm font-medium text-text">Renewing elsewhere</p>
        <Link href={tabHref} className="text-xs text-brand hover:underline">
          Installed elsewhere →
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <tbody>
            {soon.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-medium text-text">{r.productName}</td>
                <td className="px-4 py-2 text-muted">{r.quantity ?? "—"}</td>
                <td className="px-4 py-2 text-muted">{r.boughtFrom ?? "—"}</td>
                <td className="px-4 py-2 text-muted">{formatCalendarDay(r.renewsOn)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
