import Link from "next/link";
import { TableProperties } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { currentUser } from "@/lib/session";
import { isModuleEnabled } from "@/actions/module";
import { listsLinking } from "@/lib/smart-lists/links";

/**
 * "In these lists" on a company's or a lead's page (owner, 20 Nov 2026 — Smart Lists phase 2): the rows of Smart Lists
 * that link to this record — a site survey for this customer, a tender for this lead — in lists the person may open.
 * Nothing when there are none. Server component.
 */
export async function InTheseLists({ kind, recordId }: { kind: "COMPANY" | "LEAD" | "CONTACT"; recordId: string }) {
  const user = await currentUser();
  if (!user || !(await isModuleEnabled("workspace").catch(() => false))) return null;
  const lists = await listsLinking(kind, recordId, user.id).catch(() => []);
  if (!lists.length) return null;
  return (
    <Card>
      <CardHeader className="flex items-center gap-1.5 text-sm font-medium text-text">
        <TableProperties className="h-4 w-4 text-subtle" aria-hidden="true" />
        In these lists
      </CardHeader>
      <CardContent className="space-y-3">
        {lists.map((l) => (
          <div key={l.listId} className="space-y-1">
            <Link href={`/smart-lists/${l.listId}`} className="text-sm font-medium text-brand hover:underline">
              {l.listName}
            </Link>
            <ul className="space-y-0.5">
              {l.rows.slice(0, 5).map((r) => (
                <li key={r.id} className="truncate text-xs text-muted">
                  <Link href={`/smart-lists/${l.listId}?q=${encodeURIComponent(r.title)}`} className="hover:text-text hover:underline">
                    {r.title}
                  </Link>
                </li>
              ))}
              {l.rows.length > 5 && <li className="text-xs text-subtle">and {l.rows.length - 5} more</li>}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
