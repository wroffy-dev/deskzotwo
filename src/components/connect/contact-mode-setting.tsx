"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { saveContactMode } from "@/actions/connect-review";

/**
 * How much of a row's account owner guests see (owner, 20 Nov 2026 — Deskzo Connect phase 3): their name; their name and
 * work email; or name, email and the phone on their profile.
 */
export function ContactModeSetting({ mode }: { mode: string }) {
  const [value, setValue] = useState(mode);
  const [pending, start] = useTransition();
  return (
    <Card className="flex flex-wrap items-end justify-between gap-3 p-4">
      <div className="space-y-1.5">
        <Label htmlFor="contact-mode">On each row, guests see the account owner&apos;s</Label>
        <Select
          id="contact-mode"
          value={value}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.value;
            setValue(next);
            start(async () => {
              const r = await saveContactMode(next);
              if (!r.ok) {
                setValue(mode);
                return void toast.error(r.error);
              }
              toast.success("Saved.");
            });
          }}
        >
          <option value="NAME">name only</option>
          <option value="NAME_EMAIL">name and work email</option>
          <option value="ALL">name, work email and phone</option>
        </Select>
      </div>
      <p className="max-w-sm text-xs text-subtle">From their profile. Only active staff are shown; a company with nobody named shows no one.</p>
    </Card>
  );
}
