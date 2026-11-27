import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { spendStatementGrant } from "@/lib/statements/render";
import { statementForPrint } from "@/lib/statements/print-data";
import { workspaceClock } from "@/lib/time/workspace";
import { StatementPrint } from "@/components/statements/statement-print";
import { PrintButton } from "@/components/billing/print-button";
import type { StatementSide } from "@/lib/statements/paths";

export const metadata = { title: "Statement of accounts" };

/**
 * A customer's (AR) or vendor's (AP) statement on paper (owner, 31 Oct 2026), for the period and view the Statement tab
 * had. Normally for the person signed in; when the server's own browser prints it for an email it carries a one-time
 * pass instead (src/lib/statements/render.ts), spent here, naming who pressed send — and who may see it is checked
 * again for them now.
 */
export default async function StatementPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ side: string; companyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { side: rawSide, companyId } = await params;
  if (rawSide !== "AR" && rawSide !== "AP") notFound();
  const side = rawSide as StatementSide;
  const query = await searchParams;
  const one = (key: string) => (Array.isArray(query[key]) ? query[key][0] : query[key]) as string | undefined;
  const render = one("render");
  const viewerId = render ? await spendStatementGrant(render, side, companyId) : (await currentUser())?.id;
  if (!viewerId) notFound();
  const [data, clock] = await Promise.all([statementForPrint(viewerId, side, companyId, { from: one("from"), to: one("to"), show: one("show") }), workspaceClock()]);
  if (!data) notFound();
  return (
    <div>
      {/* Not in the Statement tab's preview (embed), nor in the PDF the server prints. */}
      {!render && !one("embed") && (
        <div className="mx-auto mb-4 flex w-[190mm] justify-end print:hidden">
          <PrintButton />
        </div>
      )}
      <StatementPrint data={data} printedOn={clock.date(new Date())} />
    </div>
  );
}
