"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { readBillFromMail, skipBillFromMail } from "@/actions/bill-reader";
import type { MailBill } from "@/lib/mail-reading/arjun";

/**
 * Purchase › Read a bill › Bills that came by email (owner, 23 Nov 2026 — src/lib/mail-reading/arjun.ts): vendor bills in
 * the person's own mailbox, where an admin lets Arjun read it. "Read it" fetches the attachment from the mailbox and opens
 * the reading below, as an upload would; "Skip" takes it off the list.
 */
export function MailBills({ bills }: { bills: MailBill[] }) {
  const router = useRouter();
  const [list, setList] = useState(bills);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();

  const read = (id: string) =>
    start(async () => {
      setBusy(id);
      const r = await readBillFromMail(id);
      setBusy(null);
      if (!r.ok) return void toast.error(r.error);
      router.push(`/purchase/bills/read?reading=${encodeURIComponent(r.data.id)}`);
    });
  const skip = (id: string) =>
    start(async () => {
      const r = await skipBillFromMail(id);
      if (!r.ok) return void toast.error(r.error);
      setList((l) => l.filter((b) => b.id !== id));
    });

  if (!list.length) return null;
  return (
    <section id="by-email" className="rounded-card border border-line bg-surface p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text">
        <Mail className="h-4 w-4 text-muted" aria-hidden="true" />
        Bills that came by email
      </h2>
      <p className="mt-0.5 text-xs text-muted">From vendors, in your mailbox. Arjun fetches the attached bill and reads it into a draft — a Deskzo AI credit or two each.</p>
      <ul className="mt-3 divide-y divide-line">
        {list.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium text-text">{b.vendor}</div>
              <div className="truncate text-xs text-muted">
                {b.subject} · {b.from} · {new Date(b.sentAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
              </div>
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => skip(b.id)}>
                Skip
              </Button>
              <Button size="sm" disabled={!!busy} onClick={() => read(b.id)}>
                {busy === b.id && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                {busy === b.id ? "Reading…" : "Read it"}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
