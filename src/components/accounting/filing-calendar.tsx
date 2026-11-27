"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, LoaderCircle } from "lucide-react";
import { markFilingDone } from "@/actions/compliance";
import type { FilingRow } from "@/lib/compliance/filings";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

/**
 * Filings due (owner, 29 Oct 2026; src/lib/compliance): what is coming in the next six weeks and what was missed, each
 * marked filed by whoever filed it — the bell stops for it then.
 */
export function FilingCalendar({ today, rows }: { today: string; rows: FilingRow[] }) {
  const open = rows.filter((r) => !r.filed);
  const done = rows.filter((r) => r.filed);
  return (
    <Card className="mt-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text">
          <CalendarClock className="h-4 w-4 text-muted" aria-hidden="true" />
          Filings due
        </h2>
        <span className="text-xs text-muted">The government&apos;s dates; an extension it announces isn&apos;t known here.</span>
      </div>
      {open.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nothing due in the next six weeks that isn&apos;t marked filed.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {open.map((r) => (
            <Row key={r.key} row={r} today={today} />
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted">Marked filed ({done.length})</summary>
          <ul className="mt-1 divide-y divide-line">
            {done.map((r) => (
              <Row key={r.key} row={r} today={today} />
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function Row({ row, today }: { row: FilingRow; today: string }) {
  const router = useRouter();
  const [marking, setMarking] = useState(false);
  const [filedOn, setFiledOn] = useState(today);
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = (on: string | null) =>
    start(async () => {
      setError(null);
      const r = await markFilingDone(row.key, on, on ? reference : null);
      if (!r.ok) return setError(r.error);
      setMarking(false);
      router.refresh();
    });
  const when = row.filed
    ? { tone: "green" as const, text: `Filed ${dayLabel(row.filed.on)}${row.filed.reference ? ` · ${row.filed.reference}` : ""}` }
    : row.daysLeft < 0
      ? { tone: "red" as const, text: `Missed — due ${dayLabel(row.due)}` }
      : row.daysLeft <= 3
        ? { tone: "amber" as const, text: row.daysLeft === 0 ? "Due today" : `Due in ${row.daysLeft} day${row.daysLeft === 1 ? "" : "s"}` }
        : { tone: "default" as const, text: `Due ${dayLabel(row.due)}` };
  return (
    <li className="py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Link href={row.href} className="font-medium text-text hover:underline">
            {row.form}
          </Link>{" "}
          <span className="text-muted">· {row.period}</span>
          <p className="text-xs text-muted">{row.what}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={when.tone}>{when.text}</Badge>
          {row.filed ? (
            <button type="button" disabled={pending} onClick={() => save(null)} className="text-xs text-muted hover:text-text hover:underline">
              Not filed after all
            </button>
          ) : (
            !marking && (
              <Button type="button" size="sm" variant="secondary" onClick={() => setMarking(true)}>
                Mark filed
              </Button>
            )
          )}
        </div>
      </div>
      {marking && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input type="date" value={filedOn} max={today} onChange={(e) => setFiledOn(e.target.value)} className="h-8 w-40" aria-label={`Day ${row.form} for ${row.period} was filed`} />
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="ARN or challan number (optional)" className="h-8 w-64" aria-label="Reference" />
          <Button type="button" size="sm" disabled={pending || !filedOn} onClick={() => save(filedOn)}>
            {pending && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setMarking(false)}>
            Cancel
          </Button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </li>
  );
}
