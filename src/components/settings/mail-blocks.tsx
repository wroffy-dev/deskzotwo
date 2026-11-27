"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MailX, Plus, Trash2 } from "lucide-react";
import { addMailBlock, removeMailBlock, setMailBlockReach, type MailBlockRow } from "@/actions/mail-blocks";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";

const REASON: Record<string, string> = {
  MANUAL: "",
  UNSUBSCRIBED: "They also unsubscribed",
  HARD_BOUNCE: "Mail to it also bounced",
  COMPLAINT: "They also marked us as spam",
};

/**
 * Settings › Blocked addresses (src/lib/mail-blocks.ts): who the workspace never mails. "All mail" stops every email,
 * invoices and documents too; "Marketing & reminders" stops campaigns and reminders and lets a customer's own
 * documents through, as a block on the marketing list always did.
 */
export function MailBlocks({ rows, allMailReady }: { rows: MailBlockRow[]; allMailReady: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState<"DOMAIN" | "EMAIL">("DOMAIN");
  const [value, setValue] = useState("");
  const [allMail, setAllMail] = useState(allMailReady);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {!allMailReady && (
        <Card className="px-4 py-3 text-sm text-muted">
          This workspace is still being updated to block all mail. Until then, a block stops marketing and reminders only.
        </Card>
      )}
      <Card className="px-4 py-3">
        {adding ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="block-scope">Block</Label>
                <Select id="block-scope" value={scope} onChange={(e) => setScope(e.target.value === "EMAIL" ? "EMAIL" : "DOMAIN")}>
                  <option value="DOMAIN">A whole domain</option>
                  <option value="EMAIL">One address</option>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="block-value">{scope === "DOMAIN" ? "Domain" : "Address"}</Label>
                <Input id="block-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder={scope === "DOMAIN" ? "acme.com" : "ravi@acme.com"} />
                {scope === "DOMAIN" && <p className="text-xs text-subtle">Its subdomains too — acme.com covers mail.acme.com.</p>}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="block-reach">Stop</Label>
              <Select id="block-reach" value={allMail ? "all" : "marketing"} onChange={(e) => setAllMail(e.target.value === "all")} disabled={!allMailReady}>
                <option value="all">All mail — invoices, quotes and every other document too</option>
                <option value="marketing">Marketing and reminders only — their own documents still go</option>
              </Select>
              {allMail && <p className="text-xs text-warning">Nothing at all goes to them from this workspace, not even an invoice they&apos;re waiting for.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="block-note">Why</Label>
              <Input id="block-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Asked us to stop by phone; no longer a customer." />
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex gap-2">
              <Button
                disabled={pending || !value.trim()}
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    const result = await addMailBlock({ scope, value, allMail, note });
                    if (!result.ok) {
                      setError(result.error);
                      return;
                    }
                    setAdding(false);
                    setValue("");
                    setNote("");
                    router.refresh();
                  });
                }}
              >
                {pending ? "Blocking…" : "Block"}
              </Button>
              <Button variant="secondary" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1.5 h-3 w-3" />
            Block an address or domain
          </Button>
        )}
      </Card>

      {rows.length === 0 ? (
        <Card className="px-4 py-12 text-center">
          <MailX className="mx-auto mb-2 h-5 w-5 text-subtle" />
          <p className="text-sm text-subtle">Nothing is blocked. Mail goes to anyone with a working address.</p>
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">Blocked</th>
                <th className="px-4 py-2.5">Stops</th>
                <th className="px-4 py-2.5">Since</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <BlockRow key={row.id} row={row} allMailReady={allMailReady} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function BlockRow({ row, allMailReady }: { row: MailBlockRow; allMailReady: boolean }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      router.refresh();
    });
  };

  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-4 py-2.5">
        <span className="font-mono text-xs text-text">{row.value}</span>
        <span className="block text-[11px] text-subtle">
          {row.scope === "DOMAIN" ? "Whole domain, with its subdomains" : "One address"}
          {REASON[row.reason] ? ` · ${REASON[row.reason]}` : ""}
        </span>
        {row.note && <span className="block text-[11px] text-subtle">{row.note}</span>}
        {error && <span className="block text-[11px] text-danger">{error}</span>}
      </td>
      <td className="px-4 py-2.5">
        <Select
          aria-label={`What the block on ${row.value} stops`}
          value={row.allMail ? "all" : "marketing"}
          disabled={pending || !allMailReady}
          onChange={(e) => run(() => setMailBlockReach(row.id, e.target.value === "all"))}
          className="h-8 text-xs"
        >
          <option value="all">All mail</option>
          <option value="marketing">Marketing & reminders</option>
        </Select>
        {row.allMail && <Badge tone="red" className="mt-1">Nothing goes to them</Badge>}
      </td>
      <td className="px-4 py-2.5 text-xs text-muted">
        {clock.date(row.createdAt)}
        {row.by && <span className="block text-[11px] text-subtle">{row.by}</span>}
      </td>
      <td className="px-4 py-2.5 text-right">
        <Button size="sm" variant="ghost" disabled={pending} aria-label={`Unblock ${row.value}`} onClick={() => run(() => removeMailBlock(row.id))}>
          <Trash2 className="h-3 w-3" />
        </Button>
      </td>
    </tr>
  );
}
