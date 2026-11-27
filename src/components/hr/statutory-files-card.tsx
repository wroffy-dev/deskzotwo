import Link from "next/link";
import { Download, FileText } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import type { StatutoryFiles } from "@/lib/hr/statutory-data";

/**
 * A payroll month's files for the bank, EPFO and ESIC (owner, 31 Oct 2026) — on a locked month only, each with who it
 * had to leave out and why, so a missing UAN or account is fixed before the upload rather than found after it.
 */
export function StatutoryFilesCard({ files }: { files: StatutoryFiles & { ready: boolean } }) {
  if (!files.ready) {
    return (
      <Card className="p-4 text-sm text-muted">
        Lock the month to download the bank advice, the PF ECR and the ESI return — a draft&apos;s figures can still change.
      </Card>
    );
  }
  const base = `/api/payroll/${files.run.id}/files`;
  const items = [
    { title: "Bank transfer", hint: `${files.bank.included} payment(s), ${formatCurrency(files.bank.total)}`, href: `${base}/bank`, file: "CSV", problems: files.bank.problems, advice: true },
    { title: "PF ECR", hint: `${files.ecr.included} member(s) — upload on the EPFO portal`, href: `${base}/ecr`, file: "TXT", problems: files.ecr.problems },
    { title: "ESI return", hint: `${files.esi.included} insured person(s) — save as Excel 97-2003 (.xls) before uploading`, href: `${base}/esi`, file: "XLSX", problems: files.esi.problems },
  ];
  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold text-text">Statutory and bank files</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {items.map((it) => (
          <div key={it.title} className="rounded-base border border-line p-3">
            <p className="text-sm font-medium text-text">{it.title}</p>
            <p className="mt-0.5 text-xs text-muted">{it.hint}</p>
            <div className="mt-2 flex flex-wrap gap-3 text-sm">
              <a href={it.href} className="inline-flex items-center gap-1 text-brand hover:underline">
                <Download className="h-3.5 w-3.5" /> {it.file}
              </a>
              {it.advice && (
                <Link href={`/payroll-advice/${files.run.id}`} target="_blank" className="inline-flex items-center gap-1 text-brand hover:underline">
                  <FileText className="h-3.5 w-3.5" /> Advice letter
                </Link>
              )}
            </div>
            {it.problems.length > 0 && (
              <div className="mt-2 rounded-base bg-warning-bg p-2 text-xs text-warning">
                <p className="font-medium">Left out ({it.problems.length}):</p>
                <ul className="mt-0.5 list-disc pl-4">
                  {it.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
