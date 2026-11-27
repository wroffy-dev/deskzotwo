"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveRecordingSettings, type RecordingSetup } from "@/actions/call-recordings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/input";

const CHOICES: { value: string; label: string }[] = [
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "6 months" },
  { value: "365", label: "1 year" },
  { value: "730", label: "2 years" },
  { value: "", label: "For good" },
];

const size = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/**
 * Call recordings from the phones (owner, 9 Nov 2026 — src/lib/calls/recordings.ts): on or off for the workspace, and
 * how long they're kept. The phone app sends the file its own call recorder made, where the phone has one.
 */
export function RecordingSettings({ setup }: { setup: RecordingSetup }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [enabled, setEnabled] = useState(setup.enabled);
  const [keep, setKeep] = useState(setup.retentionDays === null ? "" : String(setup.retentionDays));
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const changed = enabled !== setup.enabled || keep !== (setup.retentionDays === null ? "" : String(setup.retentionDays));

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Call recordings</CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          Android doesn&apos;t let apps record calls, but many phones&apos; own dialers do (Samsung, Xiaomi, OnePlus, Vivo, Oppo). With this on, the Deskzo app
          finds the recording the phone made for each call it logs and sends it here, where whoever can see the call — and holds &quot;Listen to call
          recordings&quot;, for others&apos; calls — can play it. Phones without a recorder, and iPhones, send none. Recording calls may need the other person&apos;s
          consent where you are.
        </p>
        {!setup.storeReady && <p className="rounded-md bg-warning-bg px-3 py-2 text-warning">This server has nowhere to keep recordings yet: Deskzo&apos;s Azure Blob container isn&apos;t set up. Until it is, they can&apos;t be switched on.</p>}
        <label className="flex items-center gap-2 text-text">
          <input type="checkbox" checked={enabled} disabled={!setup.storeReady && !setup.enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Send call recordings from the Deskzo app
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">Keep them for</span>
          <Select aria-label="Keep recordings for" value={keep} onChange={(e) => setKeep(e.target.value)} className="w-40">
            {CHOICES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </Select>
          <span className="text-xs text-muted">then they&apos;re deleted. A change applies to recordings from now on.</span>
        </div>
        <p className="text-xs text-muted">{setup.count.toLocaleString("en-IN")} recordings kept now{setup.count ? `, ${size(setup.bytes)}` : ""}.</p>
        {note && <p className={note.tone === "error" ? "text-xs text-danger" : "text-xs text-muted"}>{note.text}</p>}
        <Button
          type="button"
          size="sm"
          disabled={pending || !changed}
          onClick={() =>
            start(async () => {
              const r = await saveRecordingSettings({ enabled, retentionDays: keep === "" ? null : Number(keep) });
              if (!r.ok) return setNote({ tone: "error", text: r.error });
              setNote({ tone: "ok", text: "Saved. Phones pick it up the next time the app opens." });
              router.refresh();
            })
          }
        >
          Save
        </Button>
      </CardContent>
    </Card>
  );
}
