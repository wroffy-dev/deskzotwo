import { requireAccessViewer } from "@/lib/access-control/guard";
import { notFound } from "next/navigation";
import { compareSubjects } from "@/actions/access-control-tools";
import { AcPage } from "@/components/access-control/ui";
import { CompareView } from "@/components/access-control/tools/compare";

export const metadata = { title: "Permission Comparison" };

/**
 * Settings › Access Control › Compare: two roles or people side by side — every permission, how far
 * each reaches every record type, and what each sees of the sensitive fields — as they resolve after
 * role defaults, what was set on the role and personal exceptions.
 *
 * `a` and `b` name the two sides (`role:KEY` or `user:ID`), so a comparison can be linked.
 */
export default async function ComparePage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  await requireAccessViewer();
  const sp = await searchParams;
  const data = await compareSubjects(typeof sp.a === "string" ? sp.a : undefined, typeof sp.b === "string" ? sp.b : undefined);
  if (!data) notFound();

  return (
    <AcPage
      crumb="Compare"
      title="Permission Comparison"
      description="Two roles or people side by side: effective permissions after role defaults, what was set on the role and personal exceptions."
    >
      <CompareView key={`${data.a.ref}|${data.b.ref}`} data={data} />
    </AcPage>
  );
}
