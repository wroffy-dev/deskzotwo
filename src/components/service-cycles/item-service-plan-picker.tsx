"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setItemServicePlan } from "@/actions/service-cycles";
import { Select } from "@/components/ui/input";

/** Choosing the plan an item's approved orders start (owner, 9 Nov 2026). Saved as it's chosen. */
export function ItemServicePlanPicker({ itemId, templateId, templates }: { itemId: string; templateId: string | null; templates: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState(templateId ?? "");
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  return (
    <div className="space-y-1">
      <Select
        aria-label="Service plan"
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          start(async () => {
            const r = await setItemServicePlan(itemId, next || null);
            if (!r.ok) {
              setValue(templateId ?? "");
              return setNote({ tone: "error", text: r.error });
            }
            setNote({ tone: "ok", text: next ? "Saved. Orders approved from now on start it." : "Saved. Its orders start no cycle." });
            router.refresh();
          });
        }}
      >
        <option value="">None</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </Select>
      {note && <p className={note.tone === "error" ? "text-xs text-danger" : "text-xs text-muted"}>{note.text}</p>}
    </div>
  );
}
