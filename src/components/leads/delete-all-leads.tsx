"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteNextLeads, startDeletingAllLeads } from "@/actions/delete-all-leads";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const WORDS = "DELETE ALL LEADS";

/**
 * Type the words, a backup is taken, then batch after batch until none are left (src/lib/leads/delete-all.ts) — each
 * batch its own request, with the count going down on screen. Stopped part way (a closed tab, a lost connection),
 * pressing it again carries on with a fresh backup.
 */
export function DeleteAllLeads({ total }: { total: number }) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<"idle" | "backup" | "deleting" | "done">("idle");
  const [left, setLeft] = useState(total);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    setPhase("backup");
    const start = await startDeletingAllLeads(typed);
    if (!start.ok) {
      setError(start.error);
      setPhase("idle");
      return;
    }
    setPhase("deleting");
    setLeft(start.data.total);
    for (;;) {
      const step = await deleteNextLeads({ confirm: typed, backupId: start.data.backupId });
      if (!step.ok) {
        setError(`${step.error} Press the button again to carry on.`);
        setPhase("idle");
        router.refresh();
        return;
      }
      setLeft(step.data.left);
      if (step.data.left === 0 || step.data.deleted === 0) break;
    }
    setPhase("done");
    router.refresh();
  }

  if (phase === "done") {
    return (
      <Card className="p-4 text-sm text-text">
        Every lead is deleted. The backup taken first is under Settings › Backups for 30 days. Import the fresh file from
        Settings › Data › Import &amp; export › Leads.
      </Card>
    );
  }

  const busy = phase !== "idle";
  return (
    <Card className="space-y-3 p-4 text-sm">
      <p className="text-text">
        <span className="font-semibold">{total.toLocaleString("en-IN")}</span> lead{total === 1 ? "" : "s"} in this workspace.
      </p>
      <label className="block space-y-1.5">
        <span className="text-muted">
          Type <span className="font-mono font-semibold text-text">{WORDS}</span> to confirm
        </span>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} autoComplete="off" className="max-w-xs font-mono" />
      </label>
      {phase === "backup" && <p className="text-xs text-subtle">Taking a backup first — this can take a minute…</p>}
      {phase === "deleting" && (
        <p className="text-xs text-subtle">
          Deleting… {left.toLocaleString("en-IN")} left. Keep this page open.
        </p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button variant="danger" onClick={run} disabled={busy || typed !== WORDS || total === 0}>
        {busy ? "Deleting…" : `Delete all ${total.toLocaleString("en-IN")} leads`}
      </Button>
    </Card>
  );
}
