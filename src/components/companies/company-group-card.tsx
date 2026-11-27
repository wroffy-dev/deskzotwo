import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { db } from "@/lib/db";
import { mayAccessAccount } from "@/lib/authz/access";
import { companyGroupSummary } from "@/actions/company-group";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CompanyGroupControls } from "@/components/companies/company-group-controls";
import { formatCurrency } from "@/lib/utils";
import { companyPath } from "@/lib/record-links";

/**
 * Group companies (owner, 17 Nov 2026 — src/lib/companies/groups.ts): other legal entities that are the same customer,
 * any of which may pay this one's invoices. Each one's money beside it, and the group's together.
 */
export async function CompanyGroupCard({ companyId, userId }: { companyId: string; userId: string }) {
  const summary = await companyGroupSummary(companyId);
  if (!summary) return null;
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true, relationshipType: true } });
  const canEdit = !!company && (await mayAccessAccount(userId, "edit", company));
  if (!summary.group && !canEdit) return null;

  const shown = summary.rows.filter((r): r is Extract<typeof r, { balance: number }> => !("hidden" in r));
  const total = (key: "outstanding" | "overdue" | "onAccount") => shown.reduce((t, r) => t + r[key], 0);

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Group companies</CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!summary.group ? (
          <p className="text-xs text-muted">
            Another legal entity that is the same customer — one pays, the other holds the licence? Link it here: either may then pay the other&apos;s invoices,
            and each keeps its own GSTIN, invoices and account.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-1.5 pr-2 font-medium">Company</th>
                  {summary.money && <th className="py-1.5 pr-2 text-right font-medium">Owes</th>}
                  {summary.money && <th className="py-1.5 pr-2 text-right font-medium">Overdue</th>}
                  {summary.money && <th className="py-1.5 text-right font-medium">On account</th>}
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className="py-1.5 pr-2">
                      {r.id === companyId ? (
                        <span className="font-medium text-text">{r.name}</span>
                      ) : (
                        <CompanyLink href={companyPath(r.companySeq)} className="text-brand hover:underline">
                          {r.name}
                        </CompanyLink>
                      )}
                    </td>
                    {summary.money &&
                      ("hidden" in r ? (
                        <td colSpan={3} className="py-1.5 text-right text-xs text-subtle">
                          Not in your accounts
                        </td>
                      ) : (
                        <>
                          <td className="py-1.5 pr-2 text-right tabular-nums">{formatCurrency(r.outstanding)}</td>
                          <td className={`py-1.5 pr-2 text-right tabular-nums ${r.overdue > 0 ? "text-danger" : ""}`}>{formatCurrency(r.overdue)}</td>
                          <td className="py-1.5 text-right tabular-nums">{formatCurrency(r.onAccount)}</td>
                        </>
                      ))}
                  </tr>
                ))}
                {summary.money && shown.length > 1 && (
                  <tr className="font-medium text-text">
                    <td className="pt-2 pr-2">The group</td>
                    <td className="pt-2 pr-2 text-right tabular-nums">{formatCurrency(total("outstanding"))}</td>
                    <td className="pt-2 pr-2 text-right tabular-nums">{formatCurrency(total("overdue"))}</td>
                    <td className="pt-2 text-right tabular-nums">{formatCurrency(total("onAccount"))}</td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted">Any of these may pay the others&apos; invoices — choose who paid under Paid by when recording a payment.</p>
          </div>
        )}
        {canEdit && <CompanyGroupControls companyId={companyId} inGroup={!!summary.group} memberIds={summary.rows.map((r) => r.id)} />}
      </CardContent>
    </Card>
  );
}
