import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/card";
import { formatRequestId, requestPath } from "@/lib/desks/rules";
import type { WaitingApproval } from "@/lib/desks/server";
import type { Clock } from "@/lib/time/zone";

/** Help desk requests waiting for this person's approval, each decided on its own page. Nothing waiting, nothing drawn. */
export function DeskApprovalsList({ waiting, clock }: { waiting: WaitingApproval[]; clock: Clock }) {
  if (waiting.length === 0) return null;
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Help desk requests waiting for your approval</CardHeader>
      <ul className="divide-y divide-line">
        {waiting.map((a) => (
          <li key={a.seq} className="px-5 py-3">
            <Link href={requestPath(a.seq)} className="text-sm font-medium text-brand hover:underline">
              {a.title}
            </Link>
            <p className="text-xs text-muted">
              {formatRequestId(a.seq)} from {a.requester} to {a.desk}, {clock.dateTimeShort(a.createdAt)}
            </p>
            {a.reason && <p className="mt-1 text-sm text-text">{a.reason}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
