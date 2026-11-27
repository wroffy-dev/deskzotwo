"use client";

import { useState, useTransition } from "react";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import { dismissManagerNotice, sendManagerNoticesByEmail, type WaitingNotice } from "@/actions/quick-messages";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { QuickMessageButton } from "@/components/messages/quick-message";
import { companyPath } from "@/lib/record-links";

/** "No need": the reminder goes, nothing is sent. */
export function DismissManagerNotice({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="subtle"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await dismissManagerNotice(companyId);
          router.refresh();
        })
      }
    >
      No need
    </Button>
  );
}

/**
 * Customers › New account managers to introduce: every customer not yet told, one at a time (Email or WhatsApp, read
 * first) or several at once by email — the template as it stands, to each one's main contact, from each one's own new
 * account manager.
 */
export function ManagerNoticesTable({ rows, templates }: { rows: (WaitingNotice & { changed: string })[]; templates: { id: string; name: string }[] }) {
  const router = useRouter();
  const [ticked, setTicked] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [sending, start] = useTransition();
  const mailable = rows.filter((r) => r.hasEmail).map((r) => r.companyId);
  const all = mailable.length > 0 && mailable.every((id) => ticked.includes(id));

  const send = () =>
    start(async () => {
      setNote(null);
      const result = await sendManagerNoticesByEmail({ companyIds: ticked, templateId });
      if (!result.ok) return setNote({ tone: "bad", text: result.error });
      const failed = result.data.failed.map((f) => `${f.name}: ${f.why}`).join(" ");
      setNote({ tone: result.data.failed.length ? "bad" : "ok", text: `Emailed ${result.data.sent} ${result.data.sent === 1 ? "customer" : "customers"}.${failed ? ` Not sent — ${failed}` : ""}` });
      setTicked([]);
      router.refresh();
    });

  if (rows.length === 0) return <p className="px-4 py-10 text-center text-sm text-muted">Every customer with a new account manager has been told.</p>;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-sm text-muted">{ticked.length ? `${ticked.length} ticked` : "Tick customers to email them together"}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select className="h-9 w-56 text-sm" value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Template">
            {templates.length === 0 && <option value="">No template with an email</option>}
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <Button disabled={sending || ticked.length === 0 || !templateId} onClick={send}>
            {sending ? "Sending…" : `Email ${ticked.length || ""} ${ticked.length === 1 ? "customer" : "customers"}`.replace("  ", " ")}
          </Button>
        </div>
      </div>
      {note && <p className={`px-4 py-2 text-sm ${note.tone === "ok" ? "text-success" : "text-danger"}`}>{note.text}</p>}
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[52rem] text-sm">
          <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="w-10 px-4 py-2">
                <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={all} aria-label="Tick every customer who can be emailed" onChange={(e) => setTicked(e.target.checked ? mailable : [])} />
              </th>
              <th className="px-2 py-2">Customer</th>
              <th className="px-2 py-2">New account manager</th>
              <th className="px-2 py-2">Before</th>
              <th className="px-2 py-2">Changed</th>
              <th className="px-4 py-2 text-right">Tell them</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ask = { moment: "MANAGER_CHANGED", companyId: r.companyId };
              const title = `Introduce ${r.toName} to ${r.companyName}`;
              const intro = `From ${r.toName}${r.fromName ? `, with ${r.fromName} copied on the email` : ""}. Nothing goes until you press Send.`;
              return (
                <tr key={r.companyId} className="border-b border-line last:border-0">
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--color-brand)] disabled:opacity-40"
                      checked={ticked.includes(r.companyId)}
                      disabled={!r.hasEmail}
                      title={r.hasEmail ? undefined : "Nobody there has an email address"}
                      aria-label={`Tick ${r.companyName}`}
                      onChange={(e) => setTicked((list) => (e.target.checked ? [...list, r.companyId] : list.filter((id) => id !== r.companyId)))}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <CompanyLink href={companyPath(r.companySeq)} className="text-brand hover:underline">
                      {r.companyName}
                    </CompanyLink>
                    {r.contact && <span className="block text-xs text-muted">{r.contact}</span>}
                  </td>
                  <td className="px-2 py-2 text-text">{r.toName}</td>
                  <td className="px-2 py-2 text-muted">{r.fromName ?? "—"}</td>
                  <td className="px-2 py-2 text-muted">{r.changed}</td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      <QuickMessageButton ask={ask} title={title} label="Email" intro={intro} start="EMAIL" />
                      <QuickMessageButton ask={ask} title={title} label="WhatsApp" intro={intro} start="WHATSAPP" />
                      <DismissManagerNotice companyId={r.companyId} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
