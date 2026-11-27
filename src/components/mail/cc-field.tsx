"use client";

import { Input, Label } from "@/components/ui/input";
import { splitCc } from "@/lib/mail/cc";

/**
 * The Cc box on every email a person writes and sends (owner, 16 Nov 2026: "where ever there is mail button and
 * person is sending mail add cc"). Addresses separated by commas; the line under it says who will be copied.
 */
export function CcField({ id, value, onChange, disabled, note }: { id: string; value: string; onChange: (value: string) => void; disabled?: boolean; note?: string }) {
  const copied = splitCc(value);
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Cc</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Other addresses, separated by commas" maxLength={1000} disabled={disabled} autoComplete="off" />
      {(copied.length > 0 || note) && <p className="text-xs text-muted">{[copied.length > 0 ? `Copied: ${copied.join(", ")}` : "", note ?? ""].filter(Boolean).join(" ")}</p>}
    </div>
  );
}
