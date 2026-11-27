"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { guestSuggest } from "@/actions/connect-public";

/**
 * A guest suggests a company for the list (owner, 20 Nov 2026 — Deskzo Connect phase 3). It waits for the workspace:
 * it shows to this guest as a grey row, and is in no list, report or company record until somebody there decides.
 */
export function SuggestCompanyDialog({ shareId, onClose }: { shareId: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState({ name: "", city: "", website: "", gstin: "", contactName: "", note: "" });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const send = () =>
    start(async () => {
      setError(null);
      const r = await guestSuggest({ shareId, ...f });
      if (!r.ok) return setError(r.error);
      toast.success("Sent. It shows as waiting until they decide.");
      onClose();
      router.refresh();
    });

  return (
    <Dialog open onClose={onClose} title="Suggest a company for this list">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sg-name">Company name</Label>
            <Input id="sg-name" required maxLength={200} value={f.name} onChange={set("name")} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sg-city">City</Label>
            <Input id="sg-city" maxLength={200} value={f.city} onChange={set("city")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sg-web">Website</Label>
            <Input id="sg-web" maxLength={200} value={f.website} onChange={set("website")} placeholder="theircompany.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sg-gst">GSTIN (if you know it)</Label>
            <Input id="sg-gst" maxLength={20} value={f.gstin} onChange={set("gstin")} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="sg-contact">Who you spoke to</Label>
            <Input id="sg-contact" maxLength={200} value={f.contactName} onChange={set("contactName")} placeholder="Name, role" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sg-note">Why it fits</Label>
          <Textarea id="sg-note" required rows={3} maxLength={1000} value={f.note} onChange={set("note")} placeholder="Met them at the event — 30 designers moving to Revit next year." />
        </div>
        <p className="text-xs text-subtle">They review every suggestion. You&apos;ll see here whether it was added.</p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !f.name.trim() || !f.note.trim()}>
            {pending ? "Sending…" : "Send suggestion"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
