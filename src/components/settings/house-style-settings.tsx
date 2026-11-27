"use client";

import { useState, useTransition } from "react";
import { Feather } from "lucide-react";
import { saveHouseStyleAction } from "@/actions/ai-quality";
import type { HouseStyle } from "@/lib/ai/house-style";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";

const FIELDS: { key: keyof HouseStyle; label: string; placeholder: string; long?: boolean }[] = [
  { key: "tone", label: "Tone", placeholder: "Warm and short; formal with government customers" },
  { key: "signOff", label: "Sign-off (emails)", placeholder: "Warm regards, {{senderName}} — Team Wroffy" },
  { key: "alwaysMention", label: "Always mention, where it fits", placeholder: "Our 24×7 support line; we're a Microsoft Solutions Partner" },
  { key: "neverSay", label: "Never say or promise", placeholder: "Discounts, delivery dates, “cheapest”" },
  { key: "notes", label: "Anything else", placeholder: "Write in British English; no emojis", long: true },
];

/**
 * The house style (owner, 20 Nov 2026 — step 2; src/lib/ai/house-style.ts): how the workspace's AI teammates write —
 * Tara's emails, Arjun's chase emails, Kabir's chat answers, Priya's HR answers. Their own rules still come first.
 */
export function HouseStyleSettings({ style }: { style: HouseStyle }) {
  const [form, setForm] = useState(style);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      setError(null);
      setSaved(false);
      const r = await saveHouseStyleAction(form);
      if (!r.ok) return setError(r.error);
      setForm(r.data);
      setSaved(true);
    });
  return (
    <Card>
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <Feather className="h-4 w-4 text-brand" aria-hidden="true" />
        House style
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          How your AI teammates write — Tara&apos;s follow-ups, Arjun&apos;s chase emails, Kabir&apos;s chat answers and Priya&apos;s HR answers. Their own rules still
          come first: no prices they weren&apos;t given, no promises. Leave a line empty to say nothing about it.
        </p>
        {FIELDS.map((f) => (
          <div key={f.key} className="space-y-1">
            <Label htmlFor={`style-${f.key}`}>{f.label}</Label>
            {f.long ? (
              <Textarea id={`style-${f.key}`} rows={2} maxLength={400} value={form[f.key]} placeholder={f.placeholder} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            ) : (
              <Input id={`style-${f.key}`} maxLength={400} value={form[f.key]} placeholder={f.placeholder} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            )}
          </div>
        ))}
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
          {saved && <span className="text-xs text-success">Saved — the next drafts and answers follow it.</span>}
        </div>
      </CardContent>
    </Card>
  );
}
